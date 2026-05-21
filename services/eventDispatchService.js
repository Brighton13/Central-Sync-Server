const SageOrdersService = require('./sage/createSageOrder');
const SageCreditNoteService = require('./sage/createSageCreditNote');
const SyncSaleExportService = require('./syncSaleExportService');

const DOCUMENT_TYPES = {
  ORDER: 'oe_order',
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
    const saleIds = sales.map((sale) => String(sale.id)).filter(Boolean);
    const existingExports = await this.syncSaleExportService.findExportsBySales(syncEvent.store_id, saleIds, documentType);
    const exportedSaleIds = new Set(existingExports.map((record) => String(record.sale_id)));
    const pendingSales = sales.filter((sale) => !exportedSaleIds.has(String(sale.id)));

    return {
      payload,
      sales,
      existingExports,
      pendingSales,
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
          reconcileExisting: (syncEvent.retry_count || 0) > 0,
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
}

module.exports = EventDispatchService;
