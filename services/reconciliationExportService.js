const { Op } = require('sequelize');

const DEFAULT_EXPORT_BATCH_SIZE = 1000;

function getExportBatchSize() {
  const configured = Number(process.env.RECON_EXPORT_BATCH_SIZE || DEFAULT_EXPORT_BATCH_SIZE);
  if (!Number.isFinite(configured)) return DEFAULT_EXPORT_BATCH_SIZE;
  return Math.min(Math.max(Math.trunc(configured), 100), 5000);
}

function projectionExportWhere(dateField, dateRange, filters, afterId) {
  const where = {
    [dateField]: { [Op.between]: [dateRange.since, dateRange.until] },
  };
  if (filters.branchId) where.branch_id = String(filters.branchId);
  if (filters.terminalId) where.terminal_id = String(filters.terminalId);
  if (afterId != null) where.id = { [Op.gt]: afterId };
  return where;
}

async function loadProjectionRowsInBatches(model, dateField, dateRange, filters = {}, options = {}) {
  const batchSize = options.batchSize || getExportBatchSize();
  const rows = [];
  let afterId = null;

  for (;;) {
    const batch = await model.findAll({
      where: projectionExportWhere(dateField, dateRange, filters, afterId),
      order: [['id', 'ASC']],
      limit: batchSize,
      raw: true,
    });

    if (batch.length === 0) break;
    rows.push(...batch);
    afterId = batch[batch.length - 1].id;
    if (batch.length < batchSize) break;
  }

  return rows;
}

function salesProjectionToExportRow(sale) {
  return {
    saleDate: sale.sale_date,
    branchId: sale.branch_id || 'Unassigned',
    terminalId: sale.terminal_id || 'Unassigned',
    storeId: sale.store_id,
    receiptNumber: sale.receipt_number || null,
    invoiceNo: sale.invoice_number || null,
    customer: sale.customer_name || null,
    cashier: sale.cashier_name || null,
    paymentMethod: sale.payment_method || null,
    subtotal: Number(sale.subtotal || 0),
    discount: Number(sale.discount_amount || 0),
    tax: Number(sale.tax_amount || 0),
    total: Number(sale.total_amount || 0),
    postedToSage: Boolean(sale.posted_to_sage),
    sageOrderNumber: sale.sage_document_number || null,
    sageReference: sale.sage_reference || null,
  };
}

function creditNoteProjectionToExportRow(note) {
  return {
    creditNoteDate: note.credit_note_date,
    branchId: note.branch_id || 'Unassigned',
    terminalId: note.terminal_id || 'Unassigned',
    storeId: note.store_id,
    receiptNumber: note.receipt_number || null,
    originalSaleId: note.original_sale_id || null,
    customer: note.customer_name || null,
    reason: note.reason || null,
    paymentMethod: note.payment_method || null,
    subtotal: Number(note.subtotal || 0),
    tax: Number(note.tax_amount || 0),
    total: Number(note.total_amount || 0),
    postedToSage: Boolean(note.posted_to_sage),
    sageDocumentNumber: note.sage_document_number || null,
  };
}

module.exports = {
  getExportBatchSize,
  loadProjectionRowsInBatches,
  salesProjectionToExportRow,
  creditNoteProjectionToExportRow,
};
