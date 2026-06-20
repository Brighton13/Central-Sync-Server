const { Op } = require('sequelize');

const PROJECTION_NAME = 'reconciliation-v1';
const PROJECTED_EVENT_TYPES = ['day_end.ready', 'credit_note.created', 'credit_note_batch.ready'];

function toPlain(value) {
  return value?.toJSON ? value.toJSON() : value;
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function validDate(value, fallback) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(fallback);
}

function identityKey(storeId, receiptNumber, localId) {
  return receiptNumber
    ? `rcp:${String(receiptNumber)}`
    : `sid:${storeId}:${String(localId)}`;
}

function customerName(record) {
  return record?.customer?.legal_name || record?.customer?.name || null;
}

function cashierName(record) {
  return record?.cashier?.full_name || record?.cashier?.name || null;
}

function extractCreditNotes(event, payload) {
  if (Array.isArray(payload.credit_notes)) return payload.credit_notes;
  if (Array.isArray(payload.creditNotes)) return payload.creditNotes;
  if (Array.isArray(payload.returns)) return payload.returns;
  if (event.event_type === 'credit_note.created' && payload.credit_note) {
    return [{ ...payload.credit_note, items: payload.credit_note.items || payload.items || [] }];
  }
  return [];
}

function buildProjectionRows(syncEvent) {
  const event = toPlain(syncEvent);
  const payload = event.payload || {};
  const sales = Array.isArray(payload.sales) ? payload.sales : [];
  const creditNotes = extractCreditNotes(event, payload);
  const branchId = payload.branch_id == null ? null : String(payload.branch_id);
  const terminalValue = payload.terminal_id ?? payload.branch_id;
  const terminalId = terminalValue == null ? null : String(terminalValue);
  const receivedAt = validDate(event.received_at, new Date());

  const saleRows = sales.filter((sale) => sale?.id != null).map((sale) => ({
    identity_key: identityKey(event.store_id, sale.receipt_number, sale.id),
    sync_event_id: event.id,
    sale_id: String(sale.id),
    receipt_number: sale.receipt_number || null,
    store_id: event.store_id,
    branch_id: branchId,
    terminal_id: terminalId,
    sale_date: validDate(sale.sale_date || sale.date || payload.date, receivedAt),
    subtotal: numberValue(sale.subtotal),
    discount_amount: numberValue(sale.discount_amount),
    tax_amount: numberValue(sale.tax_amount),
    total_amount: numberValue(sale.total_amount),
    payment_method: sale.payment_method || null,
    invoice_number: sale.invoice_no || sale.invnumber || null,
    customer_name: customerName(sale),
    cashier_name: cashierName(sale),
  }));

  const creditNoteRows = creditNotes.filter((note) => note?.id != null).map((note) => ({
    identity_key: identityKey(event.store_id, note.receipt_number, note.id),
    sync_event_id: event.id,
    credit_note_id: String(note.id),
    receipt_number: note.receipt_number || null,
    original_sale_id: note.original_sale_id == null ? null : String(note.original_sale_id),
    store_id: event.store_id,
    branch_id: branchId,
    terminal_id: terminalId,
    credit_note_date: validDate(note.credit_note_date || note.date || payload.date, receivedAt),
    subtotal: numberValue(note.subtotal),
    tax_amount: numberValue(note.tax_amount),
    total_amount: numberValue(note.total_amount),
    payment_method: note.payment_method || null,
    reason: note.reason || null,
    customer_name: customerName(note),
  }));

  const salesTotal = saleRows.reduce((sum, row) => sum + numberValue(row.total_amount), 0);
  const creditNoteTotal = creditNoteRows.reduce((sum, row) => sum + numberValue(row.total_amount), 0);
  const transactionCount = sales.length > 0
    ? numberValue(payload.sales_count || sales.length)
    : numberValue(payload.credit_notes_count || creditNotes.length);

  return {
    batch: {
      sync_event_id: event.id,
      event_type: event.event_type,
      store_id: event.store_id,
      branch_id: branchId,
      terminal_id: terminalId,
      transaction_count: transactionCount,
      total_amount: sales.length > 0 ? salesTotal : creditNoteTotal,
      credit_note_count: creditNotes.length,
      credit_note_total: creditNoteTotal,
      received_at: receivedAt,
    },
    sales: saleRows,
    creditNotes: creditNoteRows,
  };
}

async function applyExistingExports(models, rows, documentType, localIdField) {
  if (rows.length === 0) return;
  const receipts = rows.map((row) => row.receipt_number).filter(Boolean);
  const fallbackConditions = rows
    .filter((row) => !row.receipt_number)
    .map((row) => ({ store_id: row.store_id, sale_id: String(row[localIdField]) }));
  const orConditions = [...fallbackConditions];
  if (receipts.length > 0) orConditions.push({ receipt_number: { [Op.in]: receipts } });
  if (orConditions.length === 0) return;

  const exports = await models.syncSaleExport.findAll({
    where: { document_type: documentType, [Op.or]: orConditions },
    raw: true,
  });
  const exportsByIdentity = new Map(exports.map((row) => [
    identityKey(row.store_id, row.receipt_number, row.sale_id),
    row,
  ]));
  for (const row of rows) {
    const document = exportsByIdentity.get(row.identity_key);
    if (!document) continue;
    row.posted_to_sage = true;
    row.sage_document_number = document.sage_document_number;
    row.sage_reference = document.sage_reference;
    row.exported_at = document.exported_at;
  }
}

async function materializeSyncEvent(models, syncEvent, options = {}) {
  const event = toPlain(syncEvent);
  if (!event || !PROJECTED_EVENT_TYPES.includes(event.event_type)) {
    return { projected: false, sales: 0, creditNotes: 0 };
  }

  const rows = buildProjectionRows(event);
  const transaction = options.transaction;
  await Promise.all([
    applyExistingExports(models, rows.sales, 'oe_order', 'sale_id'),
    applyExistingExports(models, rows.creditNotes, 'oe_credit_note', 'credit_note_id'),
  ]);
  await models.reconBatch.upsert(rows.batch, { transaction });

  if (rows.sales.length > 0) {
    await models.reconSale.bulkCreate(rows.sales, {
      transaction,
      updateOnDuplicate: [
        'sync_event_id', 'sale_id', 'receipt_number', 'store_id', 'branch_id', 'terminal_id',
        'sale_date', 'subtotal', 'discount_amount', 'tax_amount', 'total_amount',
        'payment_method', 'invoice_number', 'customer_name', 'cashier_name', 'posted_to_sage',
        'sage_document_number', 'sage_reference', 'exported_at', 'updatedAt',
      ],
    });
  }

  if (rows.creditNotes.length > 0) {
    await models.reconCreditNote.bulkCreate(rows.creditNotes, {
      transaction,
      updateOnDuplicate: [
        'sync_event_id', 'credit_note_id', 'receipt_number', 'original_sale_id', 'store_id',
        'branch_id', 'terminal_id', 'credit_note_date', 'subtotal', 'tax_amount', 'total_amount',
        'payment_method', 'reason', 'customer_name', 'posted_to_sage', 'sage_document_number',
        'sage_reference', 'exported_at', 'updatedAt',
      ],
    });
  }

  if (options.advanceState) {
    await models.reconProjectionState.update({ last_event_id: event.id }, {
      transaction,
      where: {
        projection_name: PROJECTION_NAME,
        is_backfilled: true,
        last_event_id: { [Op.lt]: event.id },
      },
    });
  }

  return { projected: true, sales: rows.sales.length, creditNotes: rows.creditNotes.length };
}

async function backfillReconciliationProjection(models, options = {}) {
  const batchSize = Math.min(Math.max(Number(options.batchSize || process.env.RECON_BACKFILL_BATCH_SIZE || 25), 1), 250);
  const [state] = await models.reconProjectionState.findOrCreate({
    where: { projection_name: PROJECTION_NAME },
    defaults: { last_event_id: 0, is_backfilled: false },
  });
  let lastEventId = Number(state.last_event_id || 0);
  let projectedEvents = 0;
  let projectedSales = 0;
  let projectedCreditNotes = 0;

  while (true) {
    const events = await models.syncEvent.findAll({
      where: {
        id: { [Op.gt]: lastEventId },
        event_type: { [Op.in]: PROJECTED_EVENT_TYPES },
      },
      attributes: { exclude: ['response_payload'] },
      order: [['id', 'ASC']],
      limit: batchSize,
    });
    if (events.length === 0) break;

    for (const event of events) {
      const result = await materializeSyncEvent(models, event);
      lastEventId = event.id;
      projectedEvents += result.projected ? 1 : 0;
      projectedSales += result.sales;
      projectedCreditNotes += result.creditNotes;
    }

    await state.update({ last_event_id: lastEventId });
    console.log(
      `[reconProjection] through event ${lastEventId}: ${projectedEvents} batches, `
      + `${projectedSales} sales, ${projectedCreditNotes} credit notes`
    );
    await new Promise((resolve) => setImmediate(resolve));
  }

  await state.update({ last_event_id: lastEventId, is_backfilled: true });

  return { lastEventId, projectedEvents, projectedSales, projectedCreditNotes };
}

module.exports = {
  PROJECTED_EVENT_TYPES,
  backfillReconciliationProjection,
  buildProjectionRows,
  identityKey,
  materializeSyncEvent,
};
