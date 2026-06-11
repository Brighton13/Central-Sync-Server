const SageOrdersService = require('./sage/createSageOrder');
const SageCreditNoteService = require('./sage/createSageCreditNote');
const SyncSaleExportService = require('./syncSaleExportService');

const DOCUMENT_TYPES = {
  ORDER: 'oe_order',
  CREDIT_NOTE: 'oe_credit_note',
};

class EventDispatchService {
  constructor(models) {
    this.models = models;
    this.sageOrdersService = new SageOrdersService();
    this.sageCreditNoteService = new SageCreditNoteService();
    this.syncSaleExportService = new SyncSaleExportService(models);
  }

  resolveBranchId(payload, user) {
    return String(
      payload.branch_id
      || user?.store?.branch_id
      || process.env.ZRA_BHF_ID
      || '000'
    ).trim() || '000';
  }

  resolveTerminalId(payload, user) {
    return String(
      payload.terminal_id
      || user?.store?.terminal_id
      || process.env.TERMINAL_ID
      || process.env.ZRA_TERMINAL_ID
      || '000'
    ).trim() || '000';
  }

  buildSalesDataArray(sales) {
    return (sales || []).map((sale) => ({
      saleReference: `SALE-${String(sale.receipt_number || sale.id)}-${String(sale.id)}`,
      items: (sale.items || []).map((item) => ({
        product_id: item.product_id,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        total_price: Number(item.total_price),
        product: item.product || null,
        product_code: item.product_code || item.product?.product_code || null,
      })),
      salesData: {
        id: sale.id,
        receipt_number: sale.receipt_number,
        sale_reference: `SALE-${String(sale.receipt_number || sale.id)}-${String(sale.id)}`,
        subtotal: Number(sale.subtotal),
        discount_amount: Number(sale.discount_amount || 0),
        tax_amount: Number(sale.tax_amount || 0),
        total_amount: Number(sale.total_amount),
        tax_rate: 16,
        payment_method: sale.payment_method,
        amount_paid: Number(sale.amount_paid),
        change_amount: Number(sale.change_amount || 0),
        notes: sale.notes,
        customer: sale.customer || null,
        discount: sale.discount || null,
        currency: sale.cashier?.store?.currency || 'ZMW',
      },
      receiptNumber: sale.receipt_number,
      saleReference: `SALE-${String(sale.receipt_number || sale.id)}-${String(sale.id)}`,
    }));
  }

  buildUserContextFromSales(sales) {
    const firstSale = (sales || [])[0] || {};
    return firstSale.cashier || null;
  }

  async resolvePendingSales(syncEvent, documentType) {
    const payload = syncEvent.payload || {};
    const sales = payload.sales || [];
    const existingExports = await this.syncSaleExportService.findExportsForSales(syncEvent.store_id, sales, documentType);
    const exportedKeys = new Set(
      existingExports.map((record) => this.syncSaleExportService.buildIdentityKey(
        syncEvent.store_id,
        record.receipt_number,
        record.sale_id
      ))
    );
    const pendingSales = sales.filter((sale) => !exportedKeys.has(
      this.syncSaleExportService.buildIdentityKey(syncEvent.store_id, sale.receipt_number, sale.id)
    ));

    return {
      payload,
      sales,
      existingExports,
      pendingSales,
    };
  }

  // Mirrors resolvePendingSales but for the daily credit-note batch. Dedupe is keyed on the
  // (globally unique) credit-note receipt number via syncSaleExport rows, so a re-posted or
  // re-queued batch never creates a duplicate Sage credit-note document.
  async resolvePendingCreditNotes(syncEvent, documentType) {
    const payload = syncEvent.payload || {};
    const creditNotes = payload.credit_notes || [];
    const existingExports = await this.syncSaleExportService.findExportsForSales(syncEvent.store_id, creditNotes, documentType);
    const exportedKeys = new Set(
      existingExports.map((record) => this.syncSaleExportService.buildIdentityKey(
        syncEvent.store_id,
        record.receipt_number,
        record.sale_id
      ))
    );
    const pendingCreditNotes = creditNotes.filter((creditNote) => !exportedKeys.has(
      this.syncSaleExportService.buildIdentityKey(syncEvent.store_id, creditNote.receipt_number, creditNote.id)
    ));

    return {
      payload,
      creditNotes,
      existingExports,
      pendingCreditNotes,
    };
  }

  async dispatch(syncEvent) {
    if (syncEvent.event_type === 'credit_note.created') {
      const payload = syncEvent.payload || {};
      const creditNote = payload.credit_note || {};
      const items = payload.items || [];
      const user = { store: payload.store || null };
      const branchId = this.resolveBranchId(payload, user);
      const terminalId = this.resolveTerminalId(payload, user);

      const result = await this.sageCreditNoteService.createCreditNoteReturn(
        creditNote,
        items,
        user,
        payload.original_sale || null,
        {
          reconcileExisting: (syncEvent.retry_count || 0) > 0,
          orderReference: payload.credit_note?.reference || creditNote.reference || undefined,
          branchId,
          terminalId,
        }
      );

      return {
        ...result,
        creditNoteReference: creditNote.reference || creditNote.receipt_number || null,
      };
    }

    if (syncEvent.event_type === 'credit_note_batch.ready') {
      const { existingExports, pendingCreditNotes } = await this.resolvePendingCreditNotes(syncEvent, DOCUMENT_TYPES.CREDIT_NOTE);

      if (pendingCreditNotes.length === 0) {
        return {
          success: true,
          message: existingExports.length > 0
            ? 'All credit notes in batch were already exported to Sage'
            : 'No credit notes present in batch payload',
          deduplicated: existingExports.length > 0,
          staged: existingExports.length === 0,
          skippedCreditNotesCount: existingExports.length,
          orderNumber: existingExports[0]?.sage_document_number || null,
          orderUniquifier: existingExports[0]?.sage_document_uniquifier || null,
        };
      }

      const payload = syncEvent.payload || {};
      const user = pendingCreditNotes[0]?.cashier || null;
      const branchId = this.resolveBranchId(payload, user);
      const terminalId = this.resolveTerminalId(payload, user);
      const result = await this.sageCreditNoteService.createConsolidatedCreditNoteReturn(
        pendingCreditNotes,
        user,
        payload.date,
        {
          orderReference: syncEvent.idempotency_key,
          branchId,
          terminalId,
        }
      );

      const persistedExports = await this.syncSaleExportService.persistExports(
        syncEvent,
        pendingCreditNotes,
        result,
        DOCUMENT_TYPES.CREDIT_NOTE
      );

      return {
        ...result,
        skippedCreditNotesCount: existingExports.length,
        persistedCreditNotesCount: persistedExports.length,
      };
    }

    if (syncEvent.event_type === 'sale.created') {
      return {
        success: true,
        message: 'Sale event staged successfully',
        staged: true,
      };
    }

    if (syncEvent.event_type === 'day_end.ready') {
      const { payload, existingExports, pendingSales } = await this.resolvePendingSales(syncEvent, DOCUMENT_TYPES.ORDER);
      const salesDataArray = this.buildSalesDataArray(pendingSales);

      if (salesDataArray.length === 0) {
        return {
          success: true,
          message: existingExports.length > 0
            ? 'All sales in day-end payload were already exported to Sage'
            : 'No sales present in day-end payload',
          deduplicated: existingExports.length > 0,
          staged: existingExports.length === 0,
          skippedSalesCount: existingExports.length,
          orderNumber: existingExports[0]?.sage_document_number || null,
          orderUniquifier: existingExports[0]?.sage_document_uniquifier || null,
        };
      }

      const user = this.buildUserContextFromSales(pendingSales);
      const branchId = this.resolveBranchId(payload, user);
      const terminalId = this.resolveTerminalId(payload, user);
      const result = await this.sageOrdersService.createConsolidatedOrder(
        salesDataArray,
        user,
        payload.date,
        terminalId,
        {
          branchId,
          orderReference: syncEvent.idempotency_key,
        }
      );

      const persistedOrderExports = await this.syncSaleExportService.persistExports(syncEvent, pendingSales, result, DOCUMENT_TYPES.ORDER);

      return {
        ...result,
        skippedSalesCount: existingExports.length,
        persistedSalesCount: persistedOrderExports.length,
      };
    }

    return {
      success: true,
      message: `No dispatch handler required for ${syncEvent.event_type}`,
      staged: true,
    };
  }

  async reconcileDayEndExports(syncEvent, options = {}) {
    if (syncEvent.event_type !== 'day_end.ready') {
      throw new Error('Reconcile is only supported for day-end (OE order) batches');
    }

    const { existingExports, pendingSales } = await this.resolvePendingSales(syncEvent, DOCUMENT_TYPES.ORDER);

    if (pendingSales.length === 0) {
      return {
        success: true,
        found: true,
        message: 'All sales in this batch already have an OE order export record.',
        reconciledCount: 0,
        skippedCount: existingExports.length,
        orderNumber: existingExports[0]?.sage_document_number || null,
        orderUniquifier: existingExports[0]?.sage_document_uniquifier || null,
        orderReference: existingExports[0]?.sage_reference || syncEvent.idempotency_key || null,
      };
    }

    const orderReference = syncEvent.idempotency_key;

    // Correction path 1: operator supplies the Sage order number directly (looked up
    // in Sage), used when the order exists under a different/variant reference.
    if (options.sageOrderNumber) {
      let orderEntity = null;
      try {
        orderEntity = await this.sageOrdersService.findOrderByNumber(options.sageOrderNumber);
      } catch (lookupError) {
        orderEntity = null;
      }

      const verified = Boolean(orderEntity && orderEntity.OrderNumber);
      const dispatchResult = {
        orderNumber: verified ? orderEntity.OrderNumber : options.sageOrderNumber,
        orderUniquifier: verified
          ? (orderEntity.OrderUniquifier == null ? null : String(orderEntity.OrderUniquifier))
          : (options.sageOrderUniquifier || null),
        orderReference: verified
          ? (orderEntity.OrderReference || options.sageReference || orderReference)
          : (options.sageReference || orderReference),
      };

      const persisted = await this.syncSaleExportService.persistExports(
        syncEvent,
        pendingSales,
        dispatchResult,
        DOCUMENT_TYPES.ORDER
      );

      return {
        success: true,
        found: true,
        manual: true,
        verified,
        message: verified
          ? `Linked ${persisted.length} sale(s) to Sage order ${dispatchResult.orderNumber}.`
          : `Linked ${persisted.length} sale(s) to order ${dispatchResult.orderNumber} as provided (could not verify it in Sage).`,
        reconciledCount: persisted.length,
        skippedCount: existingExports.length,
        orderNumber: dispatchResult.orderNumber,
        orderUniquifier: dispatchResult.orderUniquifier,
        orderReference: dispatchResult.orderReference,
      };
    }

    // Correction path 2: re-post the batch to Sage (creates the order if it never posted).
    if (options.repost) {
      const result = await this.dispatch(syncEvent);
      return {
        success: true,
        found: true,
        reposted: true,
        message: result.message
          ? `Re-posted batch to Sage: ${result.message}`
          : `Re-posted batch to Sage as order ${result.orderNumber || 'created'}.`,
        reconciledCount: result.persistedSalesCount || 0,
        skippedCount: result.skippedSalesCount || existingExports.length,
        orderNumber: result.orderNumber || null,
        orderUniquifier: result.orderUniquifier || null,
        orderReference: result.orderReference || orderReference,
      };
    }

    // Default path: auto lookup by exact OrderReference.
    const order = await this.sageOrdersService.findOrderByReference(orderReference);

    if (!order || !order.OrderNumber) {
      return {
        success: false,
        found: false,
        message: `No matching Sage OE order was found for reference "${orderReference}". Either re-post the batch (if it never posted) or link it to an existing Sage order number.`,
        reconciledCount: 0,
        skippedCount: existingExports.length,
        orderReference,
        canRepost: true,
        canLinkManually: true,
      };
    }

    const dispatchResult = {
      orderNumber: order.OrderNumber,
      orderUniquifier: order.OrderUniquifier == null ? null : String(order.OrderUniquifier),
      orderReference: order.OrderReference || orderReference,
    };

    const persisted = await this.syncSaleExportService.persistExports(
      syncEvent,
      pendingSales,
      dispatchResult,
      DOCUMENT_TYPES.ORDER
    );

    return {
      success: true,
      found: true,
      message: `Backfilled ${persisted.length} sale(s) from Sage order ${dispatchResult.orderNumber}.`,
      reconciledCount: persisted.length,
      skippedCount: existingExports.length,
      orderNumber: dispatchResult.orderNumber,
      orderUniquifier: dispatchResult.orderUniquifier,
      orderReference: dispatchResult.orderReference,
    };
  }
}

module.exports = EventDispatchService;
