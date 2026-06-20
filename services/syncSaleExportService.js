const { Op } = require('sequelize');

class SyncSaleExportService {
  constructor(models) {
    this.models = models;
  }

  // Receipt numbers are globally unique across clients; store_id + sale_id are not.
  buildIdentityKey(storeId, receiptNumber, saleId) {
    if (receiptNumber) {
      return `rcp:${String(receiptNumber)}`;
    }

    return `sid:${storeId}:${String(saleId)}`;
  }

  resolveDispatchDocument(dispatchResult) {
    return {
      document_number: dispatchResult.documentNumber || dispatchResult.orderNumber || null,
      document_uniquifier: dispatchResult.documentUniquifier || dispatchResult.orderUniquifier || null,
      sage_reference: dispatchResult.documentReference || dispatchResult.orderReference || null,
    };
  }

  async findExportsForSales(storeId, sales, documentType) {
    if (!sales || sales.length === 0) {
      return [];
    }

    const receiptNumbers = [];
    const fallbackSaleIds = [];

    for (const sale of sales) {
      if (sale.receipt_number) {
        receiptNumbers.push(String(sale.receipt_number));
      } else if (sale.id != null) {
        fallbackSaleIds.push(String(sale.id));
      }
    }

    const orConditions = [];
    if (receiptNumbers.length > 0) {
      orConditions.push({ receipt_number: { [Op.in]: receiptNumbers } });
    }
    if (fallbackSaleIds.length > 0 && storeId != null) {
      orConditions.push({ store_id: storeId, sale_id: { [Op.in]: fallbackSaleIds } });
    }

    if (orConditions.length === 0) {
      return [];
    }

    return this.models.syncSaleExport.findAll({
      where: {
        document_type: documentType,
        [Op.or]: orConditions,
      },
      order: [['id', 'ASC']],
    });
  }

  buildSharedDocumentMap(sales, dispatchResult) {
    const sharedDocument = this.resolveDispatchDocument(dispatchResult);

    return new Map(sales.map((sale) => [String(sale.id), {
      sale_id: String(sale.id),
      receipt_number: sale.receipt_number || null,
      document_number: sharedDocument.document_number,
      document_uniquifier: sharedDocument.document_uniquifier,
      sage_reference: sharedDocument.sage_reference,
    }]));
  }

  buildPerSaleDocumentMap(dispatchResult) {
    const documents = dispatchResult.perSaleDocuments || [];
    return new Map(documents.map((document) => [String(document.sale_id), {
      sale_id: String(document.sale_id),
      receipt_number: document.receipt_number || null,
      document_number: document.document_number,
      document_uniquifier: document.document_uniquifier || null,
      sage_reference: document.sage_reference || null,
    }]));
  }

  async updateReconciliationProjection(documentType, records) {
    const projectionModel = documentType === 'oe_order'
      ? this.models.reconSale
      : this.models.reconCreditNote;
    if (!projectionModel || records.length === 0) return;

    const groups = new Map();
    for (const value of records) {
      const record = value.toJSON ? value.toJSON() : value;
      const groupKey = JSON.stringify([
        record.sage_document_number,
        record.sage_reference,
        record.exported_at,
      ]);
      const group = groups.get(groupKey) || { record, identities: [] };
      group.identities.push(this.buildIdentityKey(record.store_id, record.receipt_number, record.sale_id));
      groups.set(groupKey, group);
    }

    await Promise.all(Array.from(groups.values()).map(({ record, identities }) => projectionModel.update({
      posted_to_sage: true,
      sage_document_number: record.sage_document_number,
      sage_reference: record.sage_reference,
      exported_at: record.exported_at,
    }, {
      where: { identity_key: { [Op.in]: identities } },
    })));
  }

  async persistExports(syncEvent, sales, dispatchResult, documentType) {
    if (!syncEvent || sales.length === 0 || !documentType) {
      return [];
    }

    const documentMap = dispatchResult.perSaleDocuments?.length
      ? this.buildPerSaleDocumentMap(dispatchResult)
      : this.buildSharedDocumentMap(sales, dispatchResult);

    const persisted = [];

    for (const sale of sales) {
      const saleId = String(sale.id);
      const document = documentMap.get(saleId);
      if (!document?.document_number) {
        continue;
      }

      const defaults = {
        sync_event_id: syncEvent.id,
        store_id: syncEvent.store_id,
        sale_id: saleId,
        receipt_number: document.receipt_number,
        document_type: documentType,
        day_end_idempotency_key: syncEvent.idempotency_key,
        sage_document_number: document.document_number,
        sage_document_uniquifier: document.document_uniquifier,
        sage_reference: document.sage_reference,
        exported_at: new Date(),
      };

      const where = document.receipt_number
        ? { receipt_number: document.receipt_number, document_type: documentType }
        : { store_id: syncEvent.store_id, sale_id: saleId, document_type: documentType };

      const [record] = await this.models.syncSaleExport.findOrCreate({
        where,
        defaults,
      });

      if (!record.exported_at || !record.sage_document_number || !record.day_end_idempotency_key) {
        await record.update(defaults);
      }

      persisted.push(record);
    }

    await this.updateReconciliationProjection(documentType, persisted);

    return persisted;
  }
}

module.exports = SyncSaleExportService;
