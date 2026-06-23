const express = require('express');
const { Op, col, fn } = require('sequelize');
const ExcelJS = require('exceljs');

const { reconAuth, requireReconRole } = require('../middleware/reconAuth');
const { queueSyncEvent } = require('../services/syncEventQueueService');
const EventDispatchService = require('../services/eventDispatchService');

const router = express.Router();

const RELEVANT_EVENT_TYPES = ['day_end.ready', 'credit_note.created', 'credit_note_batch.ready'];
const SALES_EVENT_TYPE = 'day_end.ready';
const CREDIT_NOTE_BATCH_EVENT_TYPE = 'credit_note_batch.ready';
// ZRA compliance is measured from day-end batch sales (same pool as the dashboard summary).
const EVENT_TYPE_LABELS = {
  'day_end.ready': 'OE Order Batch',
  'sale.created': 'Sale Created',
  'sale.updated': 'Sale Updated',
  'credit_note.created': 'Credit Note Return',
  'credit_note_batch.ready': 'Credit Note Batch',
};
const STATUS_BUCKETS = {
  completed: 'completed',
  failed: 'failed',
  dead_letter: 'failed',
  processing: 'pending',
  queued: 'pending',
  received: 'pending',
};
const RECON_PROJECTION_NAME = 'reconciliation-v1';
const DEFAULT_MAX_RECON_PAYLOAD_BYTES = 64 * 1024 * 1024;

function getMaxReconPayloadBytes() {
  const configured = Number(process.env.RECON_MAX_PAYLOAD_BYTES || DEFAULT_MAX_RECON_PAYLOAD_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_RECON_PAYLOAD_BYTES;
}

function createPayloadBudgetError(payloadBytes, eventCount, maxPayloadBytes) {
  const error = new Error(
    `Requested range contains ${eventCount} batches and ${Math.ceil(payloadBytes / 1024 / 1024)} MB of raw payload data. `
      + 'Choose a shorter date range while historical reporting is being optimized.'
  );
  error.statusCode = 413;
  error.code = 'RECON_PAYLOAD_LIMIT_EXCEEDED';
  error.details = { payloadBytes, eventCount, maxPayloadBytes };
  return error;
}

async function assertEventPayloadWithinBudget(models, eventTypes, dateRange) {
  const where = {
    event_type: Array.isArray(eventTypes) ? { [Op.in]: eventTypes } : eventTypes,
    received_at: buildRangeWhere(dateRange),
  };
  const totals = await models.syncEvent.findOne({
    attributes: [
      [fn('COUNT', col('id')), 'eventCount'],
      [fn('COALESCE', fn('SUM', fn('OCTET_LENGTH', col('payload'))), 0), 'payloadBytes'],
    ],
    where,
    raw: true,
  });
  const eventCount = Number(totals?.eventCount || 0);
  const payloadBytes = Number(totals?.payloadBytes || 0);
  const maxPayloadBytes = getMaxReconPayloadBytes();

  if (payloadBytes > maxPayloadBytes) {
    throw createPayloadBudgetError(payloadBytes, eventCount, maxPayloadBytes);
  }
}

async function assertProjectionReady(models) {
  const state = await models.reconProjectionState.findByPk(RECON_PROJECTION_NAME, { raw: true });
  if (state?.is_backfilled) return;

  const error = new Error('Reconciliation history is being prepared. Please retry shortly.');
  error.statusCode = 503;
  error.code = 'RECON_PROJECTION_BACKFILL_IN_PROGRESS';
  error.details = { lastEventId: Number(state?.last_event_id || 0) };
  throw error;
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundCurrency(value) {
  return Number(parseNumber(value).toFixed(2));
}

function parseDays(rawValue) {
  const days = Number(rawValue || 14);
  if (!Number.isFinite(days)) {
    return 14;
  }

  return Math.min(Math.max(Math.trunc(days), 1), 90);
}

function parseLimit(rawValue) {
  const limit = Number(rawValue || 20);
  if (!Number.isFinite(limit)) {
    return 20;
  }

  return Math.min(Math.max(Math.trunc(limit), 5), 100);
}

function parsePage(rawValue) {
  const page = Number(rawValue || 1);
  if (!Number.isFinite(page)) {
    return 1;
  }

  return Math.max(Math.trunc(page), 1);
}

function parseDateValue(rawValue, endOfDay = false) {
  if (!rawValue) {
    return null;
  }

  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  if (endOfDay) {
    parsed.setHours(23, 59, 59, 999);
  } else {
    parsed.setHours(0, 0, 0, 0);
  }

  return parsed;
}

function buildDefaultSinceDate(days) {
  const sinceDate = new Date();
  sinceDate.setHours(0, 0, 0, 0);
  sinceDate.setDate(sinceDate.getDate() - (days - 1));
  return sinceDate;
}

function buildDateRange(query) {
  const days = parseDays(query.days);
  const startDate = parseDateValue(query.startDate);
  const endDate = parseDateValue(query.endDate, true);

  if (!startDate && !endDate) {
    const since = buildDefaultSinceDate(days);
    const until = new Date();
    until.setHours(23, 59, 59, 999);

    return {
      since,
      until,
      days,
      startDate: since.toISOString(),
      endDate: until.toISOString(),
    };
  }

  const resolvedStartDate = startDate || buildDefaultSinceDate(days);
  const resolvedEndDate = endDate || (() => {
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    return today;
  })();

  return {
    since: resolvedStartDate,
    until: resolvedEndDate,
    days,
    startDate: resolvedStartDate.toISOString(),
    endDate: resolvedEndDate.toISOString(),
  };
}

function buildRangeWhere(dateRange) {
  const where = { [Op.gte]: dateRange.since };

  if (dateRange.until) {
    where[Op.lte] = dateRange.until;
  }

  return where;
}

function isDateInRange(rawDate, dateRange) {
  if (!rawDate) {
    return false;
  }

  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  if (dateRange.since && date < dateRange.since) {
    return false;
  }

  if (dateRange.until && date > dateRange.until) {
    return false;
  }

  return true;
}

function getPayload(syncEvent) {
  return syncEvent.payload || {};
}

function getBranchId(syncEvent) {
  const payload = getPayload(syncEvent);
  return payload.branch_id || null;
}

function getTerminalId(syncEvent) {
  const payload = getPayload(syncEvent);
  return payload.terminal_id || payload.branch_id || null;
}

function serializeSyncEvent(syncEvent) {
  const plain = syncEvent.toJSON ? syncEvent.toJSON() : syncEvent;
  return {
    ...plain,
    branch_id: plain.payload?.branch_id || null,
    terminal_id: getTerminalId(plain),
    response_body: plain.response_payload || null,
    sage_response: plain.response_payload?.sageResponse || plain.response_payload?.responseBody || plain.response_payload?.data || null,
  };
}

function getSales(syncEvent) {
  const payload = getPayload(syncEvent);
  return Array.isArray(payload.sales) ? payload.sales : [];
}

function getCreditNotes(syncEvent) {
  const payload = getPayload(syncEvent);
  if (Array.isArray(payload.credit_notes)) {
    return payload.credit_notes;
  }

  if (Array.isArray(payload.creditNotes)) {
    return payload.creditNotes;
  }

  if (Array.isArray(payload.returns)) {
    return payload.returns;
  }

  return [];
}

function getTransactionCount(syncEvent) {
  const payload = getPayload(syncEvent);
  if (Number.isFinite(Number(payload.sales_count))) {
    return Number(payload.sales_count);
  }

  const salesCount = getSales(syncEvent).length;
  if (salesCount > 0) {
    return salesCount;
  }

  // Credit-note-only batches (credit_note_batch.ready) carry no sales; report the
  // credit-note count so the batch register shows the real transaction volume.
  if (Number.isFinite(Number(payload.credit_notes_count))) {
    return Number(payload.credit_notes_count);
  }

  return getCreditNotes(syncEvent).length;
}

function getTotalAmount(syncEvent) {
  const sales = getSales(syncEvent);
  if (sales.length > 0) {
    return roundCurrency(sales.reduce((sum, sale) => sum + parseNumber(sale.total_amount), 0));
  }

  // Credit-note-only batches: report the credit-note total instead of zero.
  return getCreditNoteTotal(syncEvent);
}

function getCreditNoteCount(syncEvent) {
  return getCreditNotes(syncEvent).length;
}

function getCreditNoteTotal(syncEvent) {
  return roundCurrency(
    getCreditNotes(syncEvent).reduce((sum, creditNote) => sum + parseNumber(creditNote.total_amount), 0)
  );
}

// Globally-unique sale identity across all client POS backends.
// store_id and sale.id are LOCAL to each client (many clients reuse store_id=1 and
// overlapping sale ids), so they cannot identify a sale on their own. The receipt
// number (e.g. RCP8212-1277) is prefixed with the store number and is globally
// unique, so we key on it whenever it is present and only fall back to store+sale.
function saleIdentityKey(storeId, receiptNumber, saleId) {
  if (receiptNumber) {
    return `rcp:${String(receiptNumber)}`;
  }

  return `sid:${storeId}:${String(saleId)}`;
}

function toStatusBucket(status) {
  return STATUS_BUCKETS[status] || 'pending';
}

function incrementDocumentCounter(target, documentType, count = 1) {
  if (!target[documentType]) {
    target[documentType] = 0;
  }

  target[documentType] += count;
}

function upsertPerformanceBucket(collection, key, label) {
  if (!collection.has(key)) {
    collection.set(key, {
      key,
      label,
      branchId: null,
      terminalId: null,
      batches: 0,
      completedBatches: 0,
      pendingBatches: 0,
      failedBatches: 0,
      salesCount: 0,
      postedSalesCount: 0,
      pendingSalesCount: 0,
      totalAmount: 0,
    });
  }

  return collection.get(key);
}

function upsertComplianceBucket(collection, key, label) {
  if (!collection.has(key)) {
    collection.set(key, {
      key,
      label,
      branchId: null,
      terminalId: null,
      totalSalesCount: 0,
      submittedCount: 0,
      pendingCount: 0,
      failedCount: 0,
      missingSdcCount: 0,
      receiptPrintedCount: 0,
      qrArtifactCount: 0,
      lastSaleAt: null,
    });
  }

  return collection.get(key);
}

function saleLookupFromPayload(syncEvent) {
  const lookup = new Map();

  for (const sale of getSales(syncEvent)) {
    lookup.set(String(sale.id), sale);
  }

  return lookup;
}

function groupExportsByEventId(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const exportRow = row.toJSON ? row.toJSON() : row;
    const eventId = exportRow.sync_event_id;

    if (!grouped.has(eventId)) {
      grouped.set(eventId, []);
    }

    grouped.get(eventId).push(exportRow);
  }

  return grouped;
}

function groupExportsBySaleId(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const saleId = String(row.sale_id);

    if (!grouped.has(saleId)) {
      grouped.set(saleId, []);
    }

    grouped.get(saleId).push(row);
  }

  return grouped;
}

function sortByIdDesc(rows) {
  return [...rows].sort((left, right) => right.id - left.id);
}

function paginateRows(rows, page, pageSize) {
  const total = rows.length;
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * pageSize;

  return {
    rows: rows.slice(startIndex, startIndex + pageSize),
    pagination: {
      page: currentPage,
      pageSize,
      total,
      totalPages,
    },
  };
}

function calculateComplianceRate(submittedCount, totalSalesCount) {
  if (!totalSalesCount) {
    return 0;
  }

  return Number(((submittedCount / totalSalesCount) * 100).toFixed(2));
}

function collectOptions(values) {
  return Array.from(new Set(values.filter(Boolean).map((value) => String(value)))).sort((left, right) => left.localeCompare(right));
}

function eventMatchesFilters(syncEvent, filters) {
  const branchId = String(getBranchId(syncEvent) || '');
  const terminalId = String(getTerminalId(syncEvent) || '');
  const statusBucket = toStatusBucket(syncEvent.status);

  if (filters.branchId && branchId !== String(filters.branchId)) {
    return false;
  }

  if (filters.terminalId && terminalId !== String(filters.terminalId)) {
    return false;
  }

  if (filters.status && statusBucket !== filters.status) {
    return false;
  }

  return true;
}

function buildBatchRow(syncEvent) {
  const saleExports = syncEvent.saleExports || [];
  const references = Array.from(new Set(saleExports.map((item) => item.sage_reference).filter(Boolean)));

  return {
    id: syncEvent.id,
    eventType: syncEvent.event_type,
    label: EVENT_TYPE_LABELS[syncEvent.event_type] || syncEvent.event_type,
    status: syncEvent.status,
    statusBucket: toStatusBucket(syncEvent.status),
    storeId: syncEvent.store_id,
    branchId: getBranchId(syncEvent) || 'Unassigned',
    terminalId: getTerminalId(syncEvent) || 'Unassigned',
    transactionCount: getTransactionCount(syncEvent),
    totalAmount: getTotalAmount(syncEvent),
    creditNoteCount: getCreditNoteCount(syncEvent),
    creditNoteTotal: getCreditNoteTotal(syncEvent),
    exportedCount: saleExports.length,
    receivedAt: syncEvent.received_at,
    processedAt: syncEvent.processed_at,
    lastAttemptAt: syncEvent.last_attempt_at,
    retryCount: syncEvent.retry_count,
    idempotencyKey: syncEvent.idempotency_key,
    sageReferences: references.slice(0, 3),
    lastError: syncEvent.last_error,
  };
}

function buildSalePendingReason(syncEvent, documents) {
  if (documents.oe_order) {
    return 'Posted to Sage successfully as an OE order.';
  }

  if (syncEvent.last_error) {
    return syncEvent.last_error;
  }

  switch (syncEvent.status) {
    case 'failed':
    case 'dead_letter':
      return 'The day-end batch failed before this sale could be posted to Sage.';
    case 'processing':
      return 'The day-end batch is currently being processed.';
    case 'queued':
    case 'received':
      return 'The day-end batch is queued and waiting to be processed.';
    case 'completed':
      return 'The batch completed, but no OE order export record was found for this sale.';
    default:
      return 'This sale has not been posted to Sage yet.';
  }
}

function buildSaleRow(syncEvent, sale, saleExportRows) {
  const documents = {
    oe_order: saleExportRows.find((row) => row.document_type === 'oe_order') || null,
  };

  return {
    id: `${syncEvent.id}:${sale.id}`,
    syncEventId: syncEvent.id,
    saleId: String(sale.id),
    receiptNumber: sale.receipt_number || null,
    branchId: getBranchId(syncEvent) || 'Unassigned',
    terminalId: getTerminalId(syncEvent) || 'Unassigned',
    storeId: syncEvent.store_id,
    saleDate: sale.sale_date || sale.date || getPayload(syncEvent).date || syncEvent.received_at,
    batchReceivedAt: syncEvent.received_at,
    amount: roundCurrency(sale.total_amount),
    paymentMethod: sale.payment_method || null,
    batchStatus: syncEvent.status,
    batchStatusBucket: toStatusBucket(syncEvent.status),
    oeOrderNumber: documents.oe_order?.sage_document_number || null,
    sageReference: documents.oe_order?.sage_reference || null,
    documentsPosted: saleExportRows.length,
    postedToSage: Boolean(documents.oe_order),
    pendingReason: buildSalePendingReason(syncEvent, documents),
    batchProcessedAt: syncEvent.processed_at,
    batchLastAttemptAt: syncEvent.last_attempt_at,
    batchRetryCount: syncEvent.retry_count,
    batchIdempotencyKey: syncEvent.idempotency_key,
    batchLastError: syncEvent.last_error || null,
  };
}

function buildCreditNotePendingReason(syncEvent, posted) {
  if (posted) {
    return 'Posted to Sage successfully as a credit-note document.';
  }

  if (syncEvent.last_error) {
    return syncEvent.last_error;
  }

  switch (syncEvent.status) {
    case 'failed':
    case 'dead_letter':
      return 'The credit-note batch failed before this credit note could be posted to Sage.';
    case 'processing':
      return 'The credit-note batch is currently being processed.';
    case 'queued':
    case 'received':
      return 'The credit-note batch is queued and waiting to be processed.';
    case 'completed':
      return 'The batch completed, but no credit-note export record was found for this credit note.';
    default:
      return 'This credit note has not been posted to Sage yet.';
  }
}

function buildCreditNoteRow(syncEvent, creditNote, creditNoteExportRows) {
  const document = creditNoteExportRows.find((row) => row.document_type === 'oe_credit_note') || null;
  const posted = Boolean(document);

  return {
    id: `${syncEvent.id}:${creditNote.id}`,
    syncEventId: syncEvent.id,
    creditNoteId: String(creditNote.id),
    receiptNumber: creditNote.receipt_number || null,
    originalSaleId: creditNote.original_sale_id != null ? String(creditNote.original_sale_id) : null,
    branchId: getBranchId(syncEvent) || 'Unassigned',
    terminalId: getTerminalId(syncEvent) || 'Unassigned',
    storeId: syncEvent.store_id,
    creditNoteDate: creditNote.credit_note_date || creditNote.date || getPayload(syncEvent).date || syncEvent.received_at,
    batchReceivedAt: syncEvent.received_at,
    subtotal: roundCurrency(creditNote.subtotal),
    taxAmount: roundCurrency(creditNote.tax_amount),
    amount: roundCurrency(creditNote.total_amount),
    paymentMethod: creditNote.payment_method || null,
    reason: creditNote.reason || null,
    customerName: creditNote.customer?.legal_name || creditNote.customer?.name || null,
    batchStatus: syncEvent.status,
    batchStatusBucket: toStatusBucket(syncEvent.status),
    sageDocumentNumber: document?.sage_document_number || null,
    sageReference: document?.sage_reference || null,
    postedToSage: posted,
    pendingReason: buildCreditNotePendingReason(syncEvent, posted),
    batchProcessedAt: syncEvent.processed_at,
    batchLastAttemptAt: syncEvent.last_attempt_at,
    batchRetryCount: syncEvent.retry_count,
    batchIdempotencyKey: syncEvent.idempotency_key,
    batchLastError: syncEvent.last_error || null,
  };
}

async function loadEventsWithExports(models, eventTypes, dateRange, options = {}) {
  console.log('[reconciliation] loadEventsWithExports start', {
    eventTypes,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
  });

  await assertEventPayloadWithinBudget(models, eventTypes, dateRange);

  const events = await models.syncEvent.findAll({
    where: {
      event_type: Array.isArray(eventTypes) ? { [Op.in]: eventTypes } : eventTypes,
      received_at: buildRangeWhere(dateRange),
    },
    attributes: { exclude: ['response_payload'] },
  });

  const plainEvents = events.map((event) => (event.toJSON ? event.toJSON() : event));
  const exportEvents = options.exportEventLimit
    ? sortByIdDesc(plainEvents).slice(0, options.exportEventLimit)
    : plainEvents;
  const eventIds = exportEvents.map((event) => event.id);
  const saleExports = eventIds.length > 0
    ? await models.syncSaleExport.findAll({
        where: { sync_event_id: { [Op.in]: eventIds } },
      })
    : [];

  console.log('[reconciliation] loadEventsWithExports loaded', {
    eventCount: plainEvents.length,
    exportCount: saleExports.length,
  });

  const saleExportsByEventId = groupExportsByEventId(saleExports);

  return plainEvents.map((event) => ({
    ...event,
    saleExports: saleExportsByEventId.get(event.id) || [],
  }));
}

async function loadExportsForSales(models, events) {
  const receiptNumbers = new Set();
  const saleIdsByStore = new Map();

  for (const event of events) {
    const storeId = event.store_id;
    for (const sale of getSales(event)) {
      if (!sale) {
        continue;
      }

      if (sale.receipt_number) {
        receiptNumbers.add(String(sale.receipt_number));
      } else if (sale.id != null && storeId != null) {
        const idSet = saleIdsByStore.get(storeId) || new Set();
        idSet.add(String(sale.id));
        saleIdsByStore.set(storeId, idSet);
      }
    }
  }

  const lookup = new Map();

  const addExportRow = (row) => {
    const plain = row.toJSON ? row.toJSON() : row;
    lookup.set(saleIdentityKey(plain.store_id, plain.receipt_number, plain.sale_id), plain);
  };

  // Primary match: by globally-unique receipt number (works across clients/branches).
  if (receiptNumbers.size > 0) {
    const exports = await models.syncSaleExport.findAll({
      where: {
        document_type: 'oe_order',
        receipt_number: { [Op.in]: Array.from(receiptNumbers) },
      },
      order: [['id', 'ASC']],
    });

    exports.forEach(addExportRow);
  }

  // Fallback only for sales that never carried a receipt number.
  for (const [storeId, idSet] of saleIdsByStore.entries()) {
    const saleIds = Array.from(idSet);
    if (saleIds.length === 0) {
      continue;
    }

    const exports = await models.syncSaleExport.findAll({
      where: {
        store_id: storeId,
        document_type: 'oe_order',
        sale_id: { [Op.in]: saleIds },
      },
      order: [['id', 'ASC']],
    });

    exports.forEach(addExportRow);
  }

  console.log('[reconciliation] loadExportsForSales loaded', {
    receiptCount: receiptNumbers.size,
    fallbackStoreCount: saleIdsByStore.size,
    exportCount: lookup.size,
  });

  return lookup;
}

// Mirrors loadExportsForSales but for credit notes: matches `oe_credit_note` export rows by
// the globally-unique credit-note receipt number (with store+id fallback for legacy rows).
async function loadCreditNoteExports(models, events) {
  const receiptNumbers = new Set();
  const idsByStore = new Map();

  for (const event of events) {
    const storeId = event.store_id;
    for (const creditNote of getCreditNotes(event)) {
      if (!creditNote) {
        continue;
      }

      if (creditNote.receipt_number) {
        receiptNumbers.add(String(creditNote.receipt_number));
      } else if (creditNote.id != null && storeId != null) {
        const idSet = idsByStore.get(storeId) || new Set();
        idSet.add(String(creditNote.id));
        idsByStore.set(storeId, idSet);
      }
    }
  }

  const lookup = new Map();
  const addExportRow = (row) => {
    const plain = row.toJSON ? row.toJSON() : row;
    lookup.set(saleIdentityKey(plain.store_id, plain.receipt_number, plain.sale_id), plain);
  };

  if (receiptNumbers.size > 0) {
    const exports = await models.syncSaleExport.findAll({
      where: {
        document_type: 'oe_credit_note',
        receipt_number: { [Op.in]: Array.from(receiptNumbers) },
      },
      order: [['id', 'ASC']],
    });

    exports.forEach(addExportRow);
  }

  for (const [storeId, idSet] of idsByStore.entries()) {
    const ids = Array.from(idSet);
    if (ids.length === 0) {
      continue;
    }

    const exports = await models.syncSaleExport.findAll({
      where: {
        store_id: storeId,
        document_type: 'oe_credit_note',
        sale_id: { [Op.in]: ids },
      },
      order: [['id', 'ASC']],
    });

    exports.forEach(addExportRow);
  }

  return lookup;
}

async function loadExportsWithEvents(models, dateRange, limit) {
  console.log('[reconciliation] loadExportsWithEvents start', {
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
  });

  const where = {
    document_type: 'oe_order',
    exported_at: buildRangeWhere(dateRange),
  };
  const [exportCount, exports] = await Promise.all([
    models.syncSaleExport.count({ where }),
    models.syncSaleExport.findAll({
      where,
      order: [['id', 'DESC']],
      limit,
      raw: true,
    }),
  ]);

  const plainExports = exports.map((row) => (row.toJSON ? row.toJSON() : row));
  const eventIds = Array.from(new Set(plainExports.map((row) => row.sync_event_id).filter(Boolean)));
  const events = eventIds.length > 0
    ? await models.syncEvent.findAll({
        where: { id: { [Op.in]: eventIds } },
        attributes: ['id', 'store_id', 'payload', 'received_at'],
        raw: true,
      })
    : [];

  console.log('[reconciliation] loadExportsWithEvents loaded', {
    exportCount,
    loadedExportCount: plainExports.length,
    linkedEventCount: events.length,
  });

  const eventMap = new Map(
    events.map((event) => {
      const plainEvent = event.toJSON ? event.toJSON() : event;
      return [plainEvent.id, plainEvent];
    })
  );

  return {
    exports: plainExports,
    exportCount,
    eventMap,
  };
}

router.get('/summary', reconAuth, async (req, res) => {
  const models = req.app.locals.models;
  await assertProjectionReady(models);
  const limit = parseLimit(req.query.limit);
  const dateRange = buildDateRange(req.query);
  const batchWhere = {
    event_type: { [Op.in]: RELEVANT_EVENT_TYPES },
    received_at: projectionDateWhere(dateRange),
  };
  const batchRecords = await models.reconBatch.findAll({
    where: batchWhere,
    include: [{
      model: models.syncEvent,
      as: 'syncEvent',
      attributes: PROJECTION_EVENT_ATTRIBUTES,
      required: true,
    }],
    order: [['received_at', 'DESC'], ['sync_event_id', 'DESC']],
  });
  const eventIds = batchRecords.map((record) => record.sync_event_id);
  // The main dashboard describes what central sync RECEIVED in the selected window.
  // Day-end payloads commonly arrive today for yesterday's business date, so filtering
  // these rows by sale_date made the Today preset incorrectly show zero activity.
  const saleWhere = { sync_event_id: { [Op.in]: eventIds } };
  const creditWhere = { sync_event_id: { [Op.in]: eventIds } };

  const [totalSalesCount, postedSalesCount, totalSalesValue, totalCreditNotesCount,
    totalCreditNotesValue, saleGroups, recentProjectionExports] = await Promise.all([
    models.reconSale.count({ where: saleWhere }),
    models.reconSale.count({ where: { ...saleWhere, posted_to_sage: true } }),
    models.reconSale.sum('total_amount', { where: saleWhere }),
    models.reconCreditNote.count({ where: creditWhere }),
    models.reconCreditNote.sum('total_amount', { where: creditWhere }),
    models.reconSale.findAll({
      attributes: [
        'branch_id',
        'terminal_id',
        [fn('COUNT', col('id')), 'sales_count'],
        [fn('SUM', col('total_amount')), 'total_amount'],
        [fn('SUM', col('posted_to_sage')), 'posted_count'],
      ],
      where: saleWhere,
      group: ['branch_id', 'terminal_id'],
      raw: true,
    }),
    models.reconSale.findAll({
      where: {
        posted_to_sage: true,
        exported_at: projectionDateWhere(dateRange),
      },
      order: [['exported_at', 'DESC'], ['id', 'DESC']],
      limit: limit * 2,
      raw: true,
    }),
  ]);

  const batches = batchRecords.map((record) => record.toJSON());
  const recentBatches = batches.slice(0, limit);
  const recentEventIds = recentBatches.map((batch) => batch.sync_event_id);
  const recentBatchExports = recentEventIds.length > 0
    ? await models.syncSaleExport.findAll({
        where: { sync_event_id: { [Op.in]: recentEventIds } },
        raw: true,
      })
    : [];
  const exportsByEvent = groupExportsByEventId(recentBatchExports);
  const branchPerformance = new Map();
  const terminalPerformance = new Map();
  const documentSummary = {};
  let completedBatches = 0;
  let pendingBatches = 0;
  let failedBatches = 0;

  for (const batch of batches) {
    const syncEvent = projectionEvent(batch);
    const bucket = toStatusBucket(syncEvent.status);
    if (bucket === 'completed') completedBatches += 1;
    else if (bucket === 'failed') failedBatches += 1;
    else pendingBatches += 1;
    incrementDocumentCounter(documentSummary, batch.event_type, Number(batch.transaction_count || 0));

    const branchId = batch.branch_id || 'Unassigned';
    const terminalId = batch.terminal_id || 'Unassigned';
    const branch = upsertPerformanceBucket(branchPerformance, String(branchId), `Branch ${branchId}`);
    const terminal = upsertPerformanceBucket(terminalPerformance, `${branchId}:${terminalId}`, `Terminal ${terminalId}`);
    branch.branchId = String(branchId);
    terminal.branchId = String(branchId);
    terminal.terminalId = String(terminalId);
    branch.batches += 1;
    terminal.batches += 1;
    if (bucket === 'completed') {
      branch.completedBatches += 1;
      terminal.completedBatches += 1;
    } else if (bucket === 'failed') {
      branch.failedBatches += 1;
      terminal.failedBatches += 1;
    } else {
      branch.pendingBatches += 1;
      terminal.pendingBatches += 1;
    }
  }

  for (const group of saleGroups) {
    const branchId = group.branch_id || 'Unassigned';
    const terminalId = group.terminal_id || 'Unassigned';
    const salesCount = Number(group.sales_count || 0);
    const postedCount = Number(group.posted_count || 0);
    const amount = roundCurrency(group.total_amount);
    const branch = upsertPerformanceBucket(branchPerformance, String(branchId), `Branch ${branchId}`);
    const terminal = upsertPerformanceBucket(terminalPerformance, `${branchId}:${terminalId}`, `Terminal ${terminalId}`);
    branch.branchId = String(branchId);
    terminal.branchId = String(branchId);
    terminal.terminalId = String(terminalId);
    for (const target of [branch, terminal]) {
      target.salesCount += salesCount;
      target.postedSalesCount += postedCount;
      target.pendingSalesCount += Math.max(salesCount - postedCount, 0);
      target.totalAmount = roundCurrency(target.totalAmount + amount);
    }
  }

  documentSummary.oe_order = postedSalesCount;
  const batchRows = recentBatches.map((batch) => {
    const syncEvent = projectionEvent(batch);
    const eventExports = exportsByEvent.get(batch.sync_event_id) || [];
    const references = Array.from(new Set(eventExports.map((row) => row.sage_reference).filter(Boolean)));
    return {
      id: batch.sync_event_id,
      eventType: batch.event_type,
      label: EVENT_TYPE_LABELS[batch.event_type] || batch.event_type,
      status: syncEvent.status,
      statusBucket: toStatusBucket(syncEvent.status),
      storeId: batch.store_id,
      branchId: batch.branch_id || 'Unassigned',
      terminalId: batch.terminal_id || 'Unassigned',
      transactionCount: Number(batch.transaction_count || 0),
      totalAmount: roundCurrency(batch.total_amount),
      creditNoteCount: Number(batch.credit_note_count || 0),
      creditNoteTotal: roundCurrency(batch.credit_note_total),
      exportedCount: eventExports.length,
      receivedAt: batch.received_at,
      processedAt: syncEvent.processed_at,
      lastAttemptAt: syncEvent.last_attempt_at,
      retryCount: syncEvent.retry_count,
      idempotencyKey: syncEvent.idempotency_key,
      sageReferences: references.slice(0, 3),
      lastError: syncEvent.last_error,
    };
  });

  return res.json({
    success: true,
    generatedAt: new Date().toISOString(),
    filters: {
      days: dateRange.days,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      limit,
      branchOptions: collectOptions(batches.map((batch) => batch.branch_id)),
      terminalOptions: collectOptions(batches.map((batch) => batch.terminal_id)),
    },
    summary: {
      totalBatches: batches.length,
      completedBatches,
      pendingBatches,
      failedBatches,
      totalSalesCount,
      postedSalesCount,
      pendingSalesCount: Math.max(totalSalesCount - postedSalesCount, 0),
      totalSalesValue: roundCurrency(totalSalesValue),
      totalCreditNotesCount,
      totalCreditNotesValue: roundCurrency(totalCreditNotesValue),
      documentSummary,
    },
    branchPerformance: Array.from(branchPerformance.values()).sort((left, right) => right.totalAmount - left.totalAmount),
    terminalPerformance: Array.from(terminalPerformance.values()).sort((left, right) => right.totalAmount - left.totalAmount),
    recentBatches: batchRows,
    recentExports: recentProjectionExports.map((sale) => ({
      id: sale.id,
      saleId: String(sale.sale_id),
      receiptNumber: sale.receipt_number || null,
      branchId: sale.branch_id || 'Unassigned',
      terminalId: sale.terminal_id || 'Unassigned',
      documentType: 'oe_order',
      sageDocumentNumber: sale.sage_document_number,
      sageDocumentUniquifier: null,
      sageReference: sale.sage_reference,
      saleAmount: roundCurrency(sale.total_amount),
      paymentMethod: sale.payment_method || null,
      exportedAt: sale.exported_at,
    })),
  });
});

router.get('/summary-legacy', reconAuth, async (req, res) => {
  const models = req.app.locals.models;
  const limit = parseLimit(req.query.limit);
  const dateRange = buildDateRange(req.query);
  console.log('[reconciliation] /summary request', {
    query: req.query,
    dateRange,
    limit,
  });
  const events = await loadEventsWithExports(models, RELEVANT_EVENT_TYPES, dateRange, {
    exportEventLimit: limit,
  });
  const recentBatchRows = sortByIdDesc(events).slice(0, limit);
  const exportBundle = await loadExportsWithEvents(models, dateRange, limit * 2);
  const recentExports = exportBundle.exports;
  const exportLookup = await loadExportsForSales(models, events);

  const branchPerformance = new Map();
  const terminalPerformance = new Map();
  const documentSummary = {};
  const uniqueSales = new Map();
  const uniqueCreditNotes = new Map();
  const postedSales = new Set();
  const recentExportRows = [];

  let totalBatches = 0;
  let completedBatches = 0;
  let pendingBatches = 0;
  let failedBatches = 0;
  let totalSalesValue = 0;

  for (const syncEvent of events) {
    const statusBucket = toStatusBucket(syncEvent.status);
    totalBatches += 1;

    if (statusBucket === 'completed') {
      completedBatches += 1;
    } else if (statusBucket === 'failed') {
      failedBatches += 1;
    } else {
      pendingBatches += 1;
    }

    incrementDocumentCounter(documentSummary, syncEvent.event_type, getTransactionCount(syncEvent));

    // Credit-note totals come from the dedicated credit-note batches so the dashboard card,
    // the batch register, and the credit-note ledger all read from the same source. Deduped
    // by globally-unique receipt number so a credit note re-queued in a later batch is counted once.
    if (syncEvent.event_type === CREDIT_NOTE_BATCH_EVENT_TYPE) {
      for (const creditNote of getCreditNotes(syncEvent)) {
        const creditNoteKey = saleIdentityKey(syncEvent.store_id, creditNote.receipt_number, creditNote.id);
        uniqueCreditNotes.set(creditNoteKey, roundCurrency(creditNote.total_amount));
      }
      continue;
    }

    if (syncEvent.event_type !== SALES_EVENT_TYPE) {
      continue;
    }

    const branchId = getBranchId(syncEvent) || 'Unassigned';
    const terminalId = getTerminalId(syncEvent) || 'Unassigned';
    const branchBucket = upsertPerformanceBucket(branchPerformance, String(branchId), `Branch ${branchId}`);
  const terminalBucket = upsertPerformanceBucket(terminalPerformance, `${branchId}:${terminalId}`, `Terminal ${terminalId}`);
  branchBucket.branchId = String(branchId);
  terminalBucket.branchId = String(branchId);
  terminalBucket.terminalId = String(terminalId);

    totalSalesValue += getTotalAmount(syncEvent);
    branchBucket.batches += 1;
    terminalBucket.batches += 1;

    if (statusBucket === 'completed') {
      branchBucket.completedBatches += 1;
      terminalBucket.completedBatches += 1;
    } else if (statusBucket === 'failed') {
      branchBucket.failedBatches += 1;
      terminalBucket.failedBatches += 1;
    } else {
      branchBucket.pendingBatches += 1;
      terminalBucket.pendingBatches += 1;
    }

    for (const sale of getSales(syncEvent)) {
      const saleKey = saleIdentityKey(syncEvent.store_id, sale.receipt_number, sale.id);
      const amount = roundCurrency(sale.total_amount);

      if (!uniqueSales.has(saleKey)) {
        uniqueSales.set(saleKey, {
          saleId: String(sale.id),
          receiptNumber: sale.receipt_number || null,
          amount,
          branchId,
          terminalId,
          paymentMethod: sale.payment_method || null,
        });
      }

      branchBucket.salesCount += 1;
      branchBucket.totalAmount = roundCurrency(branchBucket.totalAmount + amount);
      terminalBucket.salesCount += 1;
      terminalBucket.totalAmount = roundCurrency(terminalBucket.totalAmount + amount);

      if (exportLookup.has(saleKey)) {
        postedSales.add(saleKey);
        branchBucket.postedSalesCount += 1;
        terminalBucket.postedSalesCount += 1;
      } else {
        branchBucket.pendingSalesCount += 1;
        terminalBucket.pendingSalesCount += 1;
      }
    }
  }

  for (const exportRow of recentExports) {
    const sourceEvent = exportBundle.eventMap.get(exportRow.sync_event_id) || {};
    const branchId = getBranchId(sourceEvent) || 'Unassigned';
    const terminalId = getTerminalId(sourceEvent) || 'Unassigned';
    const saleLookup = saleLookupFromPayload(sourceEvent);
    const sale = saleLookup.get(String(exportRow.sale_id)) || {};

    recentExportRows.push({
      id: exportRow.id,
      saleId: String(exportRow.sale_id),
      receiptNumber: exportRow.receipt_number || sale.receipt_number || null,
      branchId,
      terminalId,
      documentType: exportRow.document_type,
      sageDocumentNumber: exportRow.sage_document_number,
      sageDocumentUniquifier: exportRow.sage_document_uniquifier,
      sageReference: exportRow.sage_reference,
      saleAmount: roundCurrency(sale.total_amount),
      paymentMethod: sale.payment_method || null,
      exportedAt: exportRow.exported_at,
    });
  }

  if (exportBundle.exportCount > 0) {
    documentSummary.oe_order = exportBundle.exportCount;
  }

  const totalSalesCount = uniqueSales.size;
  const postedSalesCount = postedSales.size;
  const pendingSalesCount = Math.max(totalSalesCount - postedSalesCount, 0);
  const totalCreditNotesCount = uniqueCreditNotes.size;
  const totalCreditNotesValue = Array.from(uniqueCreditNotes.values())
    .reduce((sum, amount) => sum + parseNumber(amount), 0);

  console.log('[reconciliation] /summary result', {
    totalBatches,
    completedBatches,
    pendingBatches,
    failedBatches,
    totalSalesCount,
    postedSalesCount,
    pendingSalesCount,
    totalCreditNotesCount,
    totalCreditNotesValue,
  });

  return res.json({
    success: true,
    generatedAt: new Date().toISOString(),
    filters: {
      days: dateRange.days,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      limit,
      branchOptions: collectOptions(events.map((event) => getBranchId(event))),
      terminalOptions: collectOptions(events.map((event) => getTerminalId(event))),
    },
    summary: {
      totalBatches,
      completedBatches,
      pendingBatches,
      failedBatches,
      totalSalesCount,
      postedSalesCount,
      pendingSalesCount,
      totalSalesValue: roundCurrency(totalSalesValue),
      totalCreditNotesCount,
      totalCreditNotesValue: roundCurrency(totalCreditNotesValue),
      documentSummary,
    },
    branchPerformance: Array.from(branchPerformance.values()).sort((left, right) => right.totalAmount - left.totalAmount),
    terminalPerformance: Array.from(terminalPerformance.values()).sort((left, right) => right.totalAmount - left.totalAmount),
    recentBatches: recentBatchRows.map(buildBatchRow),
    recentExports: recentExportRows,
  });
});

router.get('/zra-compliance', reconAuth, async (req, res) => {
  const models = req.app.locals.models;
  await assertProjectionReady(models);
  const limit = parseLimit(req.query.limit);
  const dateRange = buildDateRange(req.query);
  console.log('[reconciliation] /zra-compliance request', {
    query: req.query,
    dateRange,
    limit,
  });

  const batchRecords = await models.reconBatch.findAll({
    where: {
      event_type: SALES_EVENT_TYPE,
      received_at: projectionDateWhere(dateRange),
    },
    attributes: ['sync_event_id'],
    raw: true,
  });
  const eventIds = batchRecords.map((record) => record.sync_event_id);
  const complianceSales = eventIds.length > 0
    ? await models.reconSale.findAll({
        where: { sync_event_id: { [Op.in]: eventIds } },
        attributes: [
          'id',
          'branch_id',
          'terminal_id',
          'sale_date',
          'zra_status',
          'receipt_printed',
          'has_sdc_data',
          'has_qr_artifact',
        ],
        raw: true,
      })
    : [];

  const terminalCompliance = new Map();
  const branchCompliance = new Map();
  let totalSalesCount = 0;
  let submittedCount = 0;
  let pendingCount = 0;
  let failedCount = 0;
  let missingSdcCount = 0;
  let receiptPrintedCount = 0;
  let qrArtifactCount = 0;

  for (const sale of complianceSales) {
    const branchId = String(sale.branch_id || 'Unassigned');
    const terminalId = String(sale.terminal_id || 'Unassigned');
    const saleDate = sale.sale_date;
    const key = `${branchId}:${terminalId}`;
    const terminalBucket = upsertComplianceBucket(terminalCompliance, key, `Terminal ${terminalId}`);
    const branchBucket = upsertComplianceBucket(branchCompliance, branchId, `Branch ${branchId}`);

    terminalBucket.branchId = branchId;
    terminalBucket.terminalId = terminalId;
    branchBucket.branchId = branchId;

    totalSalesCount += 1;
    terminalBucket.totalSalesCount += 1;
    branchBucket.totalSalesCount += 1;

    const hasSdc = Boolean(sale.has_sdc_data);
    const zraStatus = String(sale.zra_status || 'pending').toLowerCase();
    const printed = Boolean(sale.receipt_printed);
    const hasQr = Boolean(sale.has_qr_artifact);

    if (hasSdc) {
      submittedCount += 1;
      terminalBucket.submittedCount += 1;
      branchBucket.submittedCount += 1;
    } else {
      missingSdcCount += 1;
      terminalBucket.missingSdcCount = (terminalBucket.missingSdcCount || 0) + 1;
      branchBucket.missingSdcCount = (branchBucket.missingSdcCount || 0) + 1;

      if (zraStatus === 'failed') {
        failedCount += 1;
        terminalBucket.failedCount += 1;
        branchBucket.failedCount += 1;
      } else {
        pendingCount += 1;
        terminalBucket.pendingCount += 1;
        branchBucket.pendingCount += 1;
      }
    }

    if (printed) {
      receiptPrintedCount += 1;
      terminalBucket.receiptPrintedCount += 1;
      branchBucket.receiptPrintedCount += 1;
    }

    if (hasQr) {
      qrArtifactCount += 1;
      terminalBucket.qrArtifactCount += 1;
      branchBucket.qrArtifactCount += 1;
    }

    if (!terminalBucket.lastSaleAt || new Date(saleDate) > new Date(terminalBucket.lastSaleAt)) {
      terminalBucket.lastSaleAt = saleDate || null;
    }

    if (!branchBucket.lastSaleAt || new Date(saleDate) > new Date(branchBucket.lastSaleAt)) {
      branchBucket.lastSaleAt = saleDate || null;
    }
  }

  console.log('[reconciliation] /zra-compliance result', {
    totalSalesCount,
    submittedCount,
    missingSdcCount,
    pendingCount,
    failedCount,
    source: 'recon_sales',
  });

  const terminalRows = Array.from(terminalCompliance.values())
    .map((row) => ({
      ...row,
      complianceRate: calculateComplianceRate(row.submittedCount, row.totalSalesCount),
      printedRate: calculateComplianceRate(row.receiptPrintedCount, row.totalSalesCount),
      qrRate: calculateComplianceRate(row.qrArtifactCount, row.totalSalesCount),
    }))
    .sort((left, right) => {
      if (right.complianceRate !== left.complianceRate) {
        return right.complianceRate - left.complianceRate;
      }

      return right.totalSalesCount - left.totalSalesCount;
    })
    .slice(0, limit);

  const branchRows = Array.from(branchCompliance.values())
    .map((row) => ({
      ...row,
      complianceRate: calculateComplianceRate(row.submittedCount, row.totalSalesCount),
      printedRate: calculateComplianceRate(row.receiptPrintedCount, row.totalSalesCount),
      qrRate: calculateComplianceRate(row.qrArtifactCount, row.totalSalesCount),
    }))
    .sort((left, right) => {
      if (right.complianceRate !== left.complianceRate) {
        return right.complianceRate - left.complianceRate;
      }

      return right.totalSalesCount - left.totalSalesCount;
    });

  return res.json({
    success: true,
    generatedAt: new Date().toISOString(),
    filters: {
      days: dateRange.days,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      limit,
    },
    summary: {
      totalSalesCount,
      submittedCount,
      pendingCount,
      failedCount,
      missingSdcCount,
      receiptPrintedCount,
      qrArtifactCount,
      complianceRate: calculateComplianceRate(submittedCount, totalSalesCount),
      printedRate: calculateComplianceRate(receiptPrintedCount, totalSalesCount),
      qrRate: calculateComplianceRate(qrArtifactCount, totalSalesCount),
      source: 'recon_sales',
    },
    branchCompliance: branchRows,
    terminalCompliance: terminalRows,
  });
});

// Excel sheet names are limited to 31 chars and cannot contain : \ / ? * [ ]
function sanitizeSheetName(name, fallback = 'Sheet') {
  const cleaned = String(name == null ? '' : name).replace(/[\\/?*\[\]:]/g, ' ').trim();
  return (cleaned || fallback).slice(0, 31);
}

function getSaleCustomerName(sale) {
  const customer = sale.customer || null;
  if (!customer) {
    return null;
  }
  return customer.legal_name || customer.name || null;
}

function getSaleCashierName(sale) {
  return sale.cashier?.full_name || sale.cashier?.fullName || null;
}

// Builds one finance-facing sale row. Reuses buildSaleRow so branch/terminal/date/
// Sage-posting values match the dashboard exactly, and adds the financial breakdown
// (subtotal/discount/tax/total) finance needs.
function buildSalesExportRow(syncEvent, sale, saleExportRows) {
  const base = buildSaleRow(syncEvent, sale, saleExportRows);
  return {
    saleDate: base.saleDate,
    branchId: base.branchId,
    terminalId: base.terminalId,
    storeId: base.storeId,
    receiptNumber: base.receiptNumber,
    invoiceNo: sale.invoice_no || sale.invnumber || null,
    customer: getSaleCustomerName(sale),
    cashier: getSaleCashierName(sale),
    paymentMethod: base.paymentMethod,
    subtotal: roundCurrency(sale.subtotal),
    discount: roundCurrency(sale.discount_amount),
    tax: roundCurrency(sale.tax_amount),
    total: roundCurrency(sale.total_amount),
    postedToSage: base.postedToSage,
    sageOrderNumber: base.oeOrderNumber,
    sageReference: base.sageReference,
  };
}

// Collects deduped sale rows for the finance export. Sales are deduped by their
// globally-unique identity (receipt number) so a sale that appears in more than one
// day-end batch (e.g. a re-queued batch) is never double-counted in finance totals.
// The latest batch (highest sync event id) wins.
function collectSalesExportRows(events, exportLookup, filters, dateRange) {
  const rowsByKey = new Map();
  const orderedEvents = [...events].sort((left, right) => left.id - right.id);

  for (const syncEvent of orderedEvents) {
    if (!eventMatchesFilters(syncEvent, filters)) {
      continue;
    }

    const saleExportsBySaleId = groupExportsBySaleId(syncEvent.saleExports || []);

    for (const sale of getSales(syncEvent)) {
      const key = saleIdentityKey(syncEvent.store_id, sale.receipt_number, sale.id);
      const globalExport = exportLookup.get(key);
      const eventScopedExports = saleExportsBySaleId.get(String(sale.id)) || [];
      const saleExportRows = globalExport ? [globalExport] : eventScopedExports;
      const row = buildSalesExportRow(syncEvent, sale, saleExportRows);

      if (!isDateInRange(row.saleDate, dateRange)) {
        continue;
      }

      rowsByKey.set(key, row);
    }
  }

  return Array.from(rowsByKey.values());
}

const CURRENCY_FORMAT = '#,##0.00';
const SALES_EXPORT_COLUMNS = [
  { header: 'Sale Date', key: 'saleDate', width: 20 },
  { header: 'Branch', key: 'branchId', width: 12 },
  { header: 'Terminal', key: 'terminalId', width: 12 },
  { header: 'Receipt #', key: 'receiptNumber', width: 20 },
  { header: 'Invoice #', key: 'invoiceNo', width: 20 },
  { header: 'Customer', key: 'customer', width: 24 },
  { header: 'Cashier', key: 'cashier', width: 20 },
  { header: 'Payment Method', key: 'paymentMethod', width: 16 },
  { header: 'Subtotal', key: 'subtotal', width: 14, money: true },
  { header: 'Discount', key: 'discount', width: 14, money: true },
  { header: 'Tax', key: 'tax', width: 14, money: true },
  { header: 'Total', key: 'total', width: 14, money: true },
  { header: 'Posted to Sage', key: 'postedToSageLabel', width: 14 },
  { header: 'Sage Order #', key: 'sageOrderNumber', width: 18 },
  { header: 'Sage Reference', key: 'sageReference', width: 22 },
];

function formatExcelDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date;
}

function styleHeaderRow(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.alignment = { vertical: 'middle' };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF374151' } } };
  });
}

function addSalesDetailSheet(workbook, sheetName, rows) {
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = SALES_EXPORT_COLUMNS.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width,
  }));
  styleHeaderRow(sheet.getRow(1));

  for (const row of rows) {
    sheet.addRow({
      ...row,
      saleDate: formatExcelDate(row.saleDate),
      postedToSageLabel: row.postedToSage ? 'Yes' : 'No',
    });
  }

  // Number formats
  SALES_EXPORT_COLUMNS.forEach((column, index) => {
    if (column.money) {
      sheet.getColumn(index + 1).numFmt = CURRENCY_FORMAT;
    }
  });
  const dateColumn = sheet.getColumn(1);
  dateColumn.numFmt = 'yyyy-mm-dd hh:mm';

  // Totals row
  const totals = rows.reduce(
    (acc, row) => ({
      subtotal: acc.subtotal + parseNumber(row.subtotal),
      discount: acc.discount + parseNumber(row.discount),
      tax: acc.tax + parseNumber(row.tax),
      total: acc.total + parseNumber(row.total),
    }),
    { subtotal: 0, discount: 0, tax: 0, total: 0 }
  );

  const totalRow = sheet.addRow({
    customer: `TOTAL (${rows.length} sales)`,
    subtotal: roundCurrency(totals.subtotal),
    discount: roundCurrency(totals.discount),
    tax: roundCurrency(totals.tax),
    total: roundCurrency(totals.total),
  });
  totalRow.font = { bold: true };
  totalRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  });

  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: SALES_EXPORT_COLUMNS.length } };
  return sheet;
}

function addSalesSummarySheet(workbook, rowsByBranch, dateRange, filters) {
  const sheet = workbook.addWorksheet('Summary by Branch');
  sheet.mergeCells('A1:H1');
  sheet.getCell('A1').value = 'Sales Report by Branch';
  sheet.getCell('A1').font = { bold: true, size: 16 };

  sheet.mergeCells('A2:H2');
  sheet.getCell('A2').value =
    `Period: ${dateRange.startDate.slice(0, 10)} to ${dateRange.endDate.slice(0, 10)}`
    + (filters.branchId ? `  |  Branch: ${filters.branchId}` : '')
    + (filters.terminalId ? `  |  Terminal: ${filters.terminalId}` : '');
  sheet.getCell('A2').font = { italic: true, color: { argb: 'FF6B7280' } };

  sheet.mergeCells('A3:H3');
  sheet.getCell('A3').value = `Generated: ${new Date().toISOString()}`;
  sheet.getCell('A3').font = { italic: true, color: { argb: 'FF6B7280' } };

  const headerRowIndex = 5;
  const headers = ['Branch', 'Sales Count', 'Subtotal', 'Discount', 'Tax', 'Total', 'Posted to Sage', 'Pending'];
  const headerRow = sheet.getRow(headerRowIndex);
  headers.forEach((header, index) => {
    headerRow.getCell(index + 1).value = header;
  });
  styleHeaderRow(headerRow);

  sheet.columns = [
    { width: 14 },
    { width: 14 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 12 },
  ];

  const grand = { count: 0, subtotal: 0, discount: 0, tax: 0, total: 0, posted: 0, pending: 0 };
  const sortedBranches = Array.from(rowsByBranch.entries()).sort((left, right) => left[0].localeCompare(right[0]));

  let cursor = headerRowIndex + 1;
  for (const [branchId, rows] of sortedBranches) {
    const agg = rows.reduce(
      (acc, row) => ({
        subtotal: acc.subtotal + parseNumber(row.subtotal),
        discount: acc.discount + parseNumber(row.discount),
        tax: acc.tax + parseNumber(row.tax),
        total: acc.total + parseNumber(row.total),
        posted: acc.posted + (row.postedToSage ? 1 : 0),
      }),
      { subtotal: 0, discount: 0, tax: 0, total: 0, posted: 0 }
    );
    const pending = rows.length - agg.posted;

    const row = sheet.getRow(cursor);
    row.getCell(1).value = branchId;
    row.getCell(2).value = rows.length;
    row.getCell(3).value = roundCurrency(agg.subtotal);
    row.getCell(4).value = roundCurrency(agg.discount);
    row.getCell(5).value = roundCurrency(agg.tax);
    row.getCell(6).value = roundCurrency(agg.total);
    row.getCell(7).value = agg.posted;
    row.getCell(8).value = pending;
    cursor += 1;

    grand.count += rows.length;
    grand.subtotal += agg.subtotal;
    grand.discount += agg.discount;
    grand.tax += agg.tax;
    grand.total += agg.total;
    grand.posted += agg.posted;
    grand.pending += pending;
  }

  const totalRow = sheet.getRow(cursor);
  totalRow.getCell(1).value = 'ALL BRANCHES';
  totalRow.getCell(2).value = grand.count;
  totalRow.getCell(3).value = roundCurrency(grand.subtotal);
  totalRow.getCell(4).value = roundCurrency(grand.discount);
  totalRow.getCell(5).value = roundCurrency(grand.tax);
  totalRow.getCell(6).value = roundCurrency(grand.total);
  totalRow.getCell(7).value = grand.posted;
  totalRow.getCell(8).value = grand.pending;
  totalRow.font = { bold: true };
  totalRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  });

  [3, 4, 5, 6].forEach((columnIndex) => {
    sheet.getColumn(columnIndex).numFmt = CURRENCY_FORMAT;
  });

  return sheet;
}

router.get('/sales/export', reconAuth, async (req, res) => {
  const models = req.app.locals.models;
  const dateRange = buildDateRange(req.query);
  const filters = {
    branchId: req.query.branchId || '',
    terminalId: req.query.terminalId || '',
  };
  console.log('[reconciliation] /sales/export request', { query: req.query, dateRange, filters });

  try {
    const events = await loadEventsWithExports(models, SALES_EVENT_TYPE, dateRange);
    const exportLookup = await loadExportsForSales(models, events);
    const rows = collectSalesExportRows(events, exportLookup, filters, dateRange);

    // Group rows by branch for the per-branch sheets, sorted newest sale first.
    const rowsByBranch = new Map();
    for (const row of rows) {
      const terminalId = String(row.terminalId || 'Unassigned');
      if (!rowsByBranch.has(terminalId)) {
        rowsByBranch.set(terminalId, []);
      }
      rowsByBranch.get(terminalId).push(row);
    }
    for (const branchRows of rowsByBranch.values()) {
      branchRows.sort((left, right) => new Date(right.saleDate) - new Date(left.saleDate));
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Recon Dashboard';
    workbook.created = new Date();

    addSalesSummarySheet(workbook, rowsByBranch, dateRange, filters);

    const sortedBranches = Array.from(rowsByBranch.entries()).sort((left, right) => left[0].localeCompare(right[0]));
    const usedSheetNames = new Set(['Summary by Branch']);
    for (const [TerminalId, branchRows] of sortedBranches) {
      let sheetName = sanitizeSheetName(`${TerminalId}`, 'Branch');
      let suffix = 2;
      while (usedSheetNames.has(sheetName)) {
        sheetName = sanitizeSheetName(`${TerminalId} (${suffix})`, 'Branch');
        suffix += 1;
      }
      usedSheetNames.add(sheetName);
      addSalesDetailSheet(workbook, sheetName, branchRows);
    }

    if (rows.length === 0) {
      // Still return a valid (empty) workbook so finance gets a clear "no data" file.
      addSalesDetailSheet(workbook, 'No Sales', []);
    }

    const branchLabel = filters.branchId ? `branch-${filters.branchId}` : 'all-branches';
    const fileName = `sales-report_${branchLabel}_${dateRange.startDate.slice(0, 10)}_to_${dateRange.endDate.slice(0, 10)}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    await workbook.xlsx.write(res);
    return res.end();
  } catch (error) {
    console.error('[reconciliation] /sales/export failed', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      code: error.code || 'SALES_EXPORT_FAILED',
      message: error.message || 'Failed to generate sales report',
      details: error.details,
    });
  }
});

const CREDIT_NOTE_EXPORT_COLUMNS = [
  { header: 'Credit Note Date', key: 'creditNoteDate', width: 20 },
  { header: 'Branch', key: 'branchId', width: 12 },
  { header: 'Terminal', key: 'terminalId', width: 12 },
  { header: 'Receipt #', key: 'receiptNumber', width: 22 },
  { header: 'Original Sale #', key: 'originalSaleId', width: 16 },
  { header: 'Customer', key: 'customer', width: 24 },
  { header: 'Reason', key: 'reason', width: 28 },
  { header: 'Payment Method', key: 'paymentMethod', width: 16 },
  { header: 'Subtotal', key: 'subtotal', width: 14, money: true },
  { header: 'Tax', key: 'tax', width: 14, money: true },
  { header: 'Total', key: 'total', width: 14, money: true },
  { header: 'Posted to Sage', key: 'postedToSageLabel', width: 14 },
  { header: 'Sage Doc #', key: 'sageDocumentNumber', width: 18 },
];

// Builds one finance-facing credit-note row. Reuses buildCreditNoteRow so the branch/
// terminal/date/Sage values match the dashboard exactly, and adds the financial breakdown.
function buildCreditNoteExportRow(syncEvent, creditNote, creditNoteExportRows) {
  const base = buildCreditNoteRow(syncEvent, creditNote, creditNoteExportRows);
  return {
    creditNoteDate: base.creditNoteDate,
    branchId: base.branchId,
    terminalId: base.terminalId,
    storeId: base.storeId,
    receiptNumber: base.receiptNumber,
    originalSaleId: base.originalSaleId,
    customer: base.customerName,
    reason: base.reason,
    paymentMethod: base.paymentMethod,
    subtotal: roundCurrency(creditNote.subtotal),
    tax: roundCurrency(creditNote.tax_amount),
    total: roundCurrency(creditNote.total_amount),
    postedToSage: base.postedToSage,
    sageDocumentNumber: base.sageDocumentNumber,
  };
}

// Collects deduped credit-note rows for the finance export (latest batch wins), mirroring
// collectSalesExportRows so a credit note is never double-counted in finance totals.
function collectCreditNotesExportRows(events, exportLookup, filters, dateRange) {
  const rowsByKey = new Map();
  const orderedEvents = [...events].sort((left, right) => left.id - right.id);

  for (const syncEvent of orderedEvents) {
    if (!eventMatchesFilters(syncEvent, filters)) {
      continue;
    }

    const exportsBySaleId = groupExportsBySaleId(syncEvent.saleExports || []);

    for (const creditNote of getCreditNotes(syncEvent)) {
      const key = saleIdentityKey(syncEvent.store_id, creditNote.receipt_number, creditNote.id);
      const globalExport = exportLookup.get(key);
      const eventScopedExports = exportsBySaleId.get(String(creditNote.id)) || [];
      const creditNoteExportRows = globalExport ? [globalExport] : eventScopedExports;
      const row = buildCreditNoteExportRow(syncEvent, creditNote, creditNoteExportRows);

      if (!isDateInRange(row.creditNoteDate, dateRange)) {
        continue;
      }

      rowsByKey.set(key, row);
    }
  }

  return Array.from(rowsByKey.values());
}

function addCreditNotesDetailSheet(workbook, sheetName, rows) {
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = CREDIT_NOTE_EXPORT_COLUMNS.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width,
  }));
  styleHeaderRow(sheet.getRow(1));

  for (const row of rows) {
    sheet.addRow({
      ...row,
      creditNoteDate: formatExcelDate(row.creditNoteDate),
      postedToSageLabel: row.postedToSage ? 'Yes' : 'No',
    });
  }

  CREDIT_NOTE_EXPORT_COLUMNS.forEach((column, index) => {
    if (column.money) {
      sheet.getColumn(index + 1).numFmt = CURRENCY_FORMAT;
    }
  });
  sheet.getColumn(1).numFmt = 'yyyy-mm-dd hh:mm';

  const totals = rows.reduce(
    (acc, row) => ({
      subtotal: acc.subtotal + parseNumber(row.subtotal),
      tax: acc.tax + parseNumber(row.tax),
      total: acc.total + parseNumber(row.total),
    }),
    { subtotal: 0, tax: 0, total: 0 }
  );

  const totalRow = sheet.addRow({
    customer: `TOTAL (${rows.length} credit notes)`,
    subtotal: roundCurrency(totals.subtotal),
    tax: roundCurrency(totals.tax),
    total: roundCurrency(totals.total),
  });
  totalRow.font = { bold: true };
  totalRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  });

  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: CREDIT_NOTE_EXPORT_COLUMNS.length } };
  return sheet;
}

function addCreditNotesSummarySheet(workbook, rowsByBranch, dateRange, filters) {
  const sheet = workbook.addWorksheet('Summary by Branch');
  sheet.mergeCells('A1:G1');
  sheet.getCell('A1').value = 'Credit Note Report by Branch';
  sheet.getCell('A1').font = { bold: true, size: 16 };

  sheet.mergeCells('A2:G2');
  sheet.getCell('A2').value =
    `Period: ${dateRange.startDate.slice(0, 10)} to ${dateRange.endDate.slice(0, 10)}`
    + (filters.branchId ? `  |  Branch: ${filters.branchId}` : '')
    + (filters.terminalId ? `  |  Terminal: ${filters.terminalId}` : '');
  sheet.getCell('A2').font = { italic: true, color: { argb: 'FF6B7280' } };

  sheet.mergeCells('A3:G3');
  sheet.getCell('A3').value = `Generated: ${new Date().toISOString()}`;
  sheet.getCell('A3').font = { italic: true, color: { argb: 'FF6B7280' } };

  const headerRowIndex = 5;
  const headers = ['Branch', 'Credit Notes', 'Subtotal', 'Tax', 'Total', 'Posted to Sage', 'Pending'];
  const headerRow = sheet.getRow(headerRowIndex);
  headers.forEach((header, index) => {
    headerRow.getCell(index + 1).value = header;
  });
  styleHeaderRow(headerRow);

  sheet.columns = [
    { width: 14 },
    { width: 14 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 12 },
  ];

  const grand = { count: 0, subtotal: 0, tax: 0, total: 0, posted: 0, pending: 0 };
  const sortedBranches = Array.from(rowsByBranch.entries()).sort((left, right) => left[0].localeCompare(right[0]));

  let cursor = headerRowIndex + 1;
  for (const [branchId, rows] of sortedBranches) {
    const agg = rows.reduce(
      (acc, row) => ({
        subtotal: acc.subtotal + parseNumber(row.subtotal),
        tax: acc.tax + parseNumber(row.tax),
        total: acc.total + parseNumber(row.total),
        posted: acc.posted + (row.postedToSage ? 1 : 0),
      }),
      { subtotal: 0, tax: 0, total: 0, posted: 0 }
    );
    const pending = rows.length - agg.posted;

    const row = sheet.getRow(cursor);
    row.getCell(1).value = branchId;
    row.getCell(2).value = rows.length;
    row.getCell(3).value = roundCurrency(agg.subtotal);
    row.getCell(4).value = roundCurrency(agg.tax);
    row.getCell(5).value = roundCurrency(agg.total);
    row.getCell(6).value = agg.posted;
    row.getCell(7).value = pending;
    cursor += 1;

    grand.count += rows.length;
    grand.subtotal += agg.subtotal;
    grand.tax += agg.tax;
    grand.total += agg.total;
    grand.posted += agg.posted;
    grand.pending += pending;
  }

  const totalRow = sheet.getRow(cursor);
  totalRow.getCell(1).value = 'ALL BRANCHES';
  totalRow.getCell(2).value = grand.count;
  totalRow.getCell(3).value = roundCurrency(grand.subtotal);
  totalRow.getCell(4).value = roundCurrency(grand.tax);
  totalRow.getCell(5).value = roundCurrency(grand.total);
  totalRow.getCell(6).value = grand.posted;
  totalRow.getCell(7).value = grand.pending;
  totalRow.font = { bold: true };
  totalRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  });

  [3, 4, 5].forEach((columnIndex) => {
    sheet.getColumn(columnIndex).numFmt = CURRENCY_FORMAT;
  });

  return sheet;
}

router.get('/credit-notes/export', reconAuth, async (req, res) => {
  const models = req.app.locals.models;
  const dateRange = buildDateRange(req.query);
  const filters = {
    branchId: req.query.branchId || '',
    terminalId: req.query.terminalId || '',
  };
  console.log('[reconciliation] /credit-notes/export request', { query: req.query, dateRange, filters });

  try {
    const events = await loadEventsWithExports(models, CREDIT_NOTE_BATCH_EVENT_TYPE, dateRange);
    const exportLookup = await loadCreditNoteExports(models, events);
    const rows = collectCreditNotesExportRows(events, exportLookup, filters, dateRange);

    const rowsByBranch = new Map();
    for (const row of rows) {
      const branchId = String(row.branchId || 'Unassigned');
      if (!rowsByBranch.has(branchId)) {
        rowsByBranch.set(branchId, []);
      }
      rowsByBranch.get(branchId).push(row);
    }
    for (const branchRows of rowsByBranch.values()) {
      branchRows.sort((left, right) => new Date(right.creditNoteDate) - new Date(left.creditNoteDate));
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Recon Dashboard';
    workbook.created = new Date();

    addCreditNotesSummarySheet(workbook, rowsByBranch, dateRange, filters);

    const sortedBranches = Array.from(rowsByBranch.entries()).sort((left, right) => left[0].localeCompare(right[0]));
    const usedSheetNames = new Set(['Summary by Branch']);
    for (const [branchId, branchRows] of sortedBranches) {
      let sheetName = sanitizeSheetName(`Branch ${branchId}`, 'Branch');
      let suffix = 2;
      while (usedSheetNames.has(sheetName)) {
        sheetName = sanitizeSheetName(`Branch ${branchId} (${suffix})`, 'Branch');
        suffix += 1;
      }
      usedSheetNames.add(sheetName);
      addCreditNotesDetailSheet(workbook, sheetName, branchRows);
    }

    if (rows.length === 0) {
      addCreditNotesDetailSheet(workbook, 'No Credit Notes', []);
    }

    const branchLabel = filters.branchId ? `branch-${filters.branchId}` : 'all-branches';
    const fileName = `credit-note-report_${branchLabel}_${dateRange.startDate.slice(0, 10)}_to_${dateRange.endDate.slice(0, 10)}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    await workbook.xlsx.write(res);
    return res.end();
  } catch (error) {
    console.error('[reconciliation] /credit-notes/export failed', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      code: error.code || 'CREDIT_NOTE_EXPORT_FAILED',
      message: error.message || 'Failed to generate credit note report',
      details: error.details,
    });
  }
});

function projectionDateWhere(dateRange) {
  return { [Op.between]: [dateRange.since, dateRange.until] };
}

function projectionWhere(dateField, dateRange, filters = {}) {
  const where = { [dateField]: projectionDateWhere(dateRange) };
  if (filters.branchId) where.branch_id = String(filters.branchId);
  if (filters.terminalId) where.terminal_id = String(filters.terminalId);
  return where;
}

function batchStatusWhere(status) {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return { [Op.in]: ['failed', 'dead_letter'] };
  if (status === 'pending') return { [Op.in]: ['received', 'queued', 'processing'] };
  return undefined;
}

function databasePagination(total, requestedPage, pageSize) {
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(requestedPage, totalPages);
  return { page, pageSize, total, totalPages, offset: (page - 1) * pageSize };
}

async function loadProjectionOptions(model, dateField, dateRange, extraWhere = {}) {
  const where = { ...extraWhere, [dateField]: projectionDateWhere(dateRange) };
  const [branches, terminals] = await Promise.all([
    model.findAll({
      attributes: ['branch_id'],
      where: { ...where, branch_id: { [Op.ne]: null } },
      group: ['branch_id'],
      raw: true,
    }),
    model.findAll({
      attributes: ['terminal_id'],
      where: { ...where, terminal_id: { [Op.ne]: null } },
      group: ['terminal_id'],
      raw: true,
    }),
  ]);
  return {
    branchOptions: collectOptions(branches.map((row) => row.branch_id)),
    terminalOptions: collectOptions(terminals.map((row) => row.terminal_id)),
  };
}

async function loadProjectionExports(models, rows, documentType, localIdField) {
  const receiptNumbers = rows.map((row) => row.receipt_number).filter(Boolean).map(String);
  const fallbackByStore = new Map();
  for (const row of rows) {
    if (row.receipt_number || row[localIdField] == null) continue;
    const ids = fallbackByStore.get(row.store_id) || [];
    ids.push(String(row[localIdField]));
    fallbackByStore.set(row.store_id, ids);
  }

  const orConditions = [];
  if (receiptNumbers.length > 0) orConditions.push({ receipt_number: { [Op.in]: receiptNumbers } });
  for (const [storeId, ids] of fallbackByStore) {
    orConditions.push({ store_id: storeId, sale_id: { [Op.in]: ids } });
  }
  if (orConditions.length === 0) return new Map();

  const exports = await models.syncSaleExport.findAll({
    where: { document_type: documentType, [Op.or]: orConditions },
    raw: true,
  });
  return new Map(exports.map((row) => [
    saleIdentityKey(row.store_id, row.receipt_number, row.sale_id),
    row,
  ]));
}

function projectionEvent(row) {
  return row.syncEvent?.toJSON ? row.syncEvent.toJSON() : row.syncEvent;
}

const PROJECTION_EVENT_ATTRIBUTES = [
  'id', 'status', 'received_at', 'processed_at', 'last_attempt_at',
  'retry_count', 'idempotency_key', 'last_error',
];

router.get('/sales', reconAuth, async (req, res) => {
  const models = req.app.locals.models;
  await assertProjectionReady(models);
  const page = parsePage(req.query.page);
  const pageSize = parseLimit(req.query.pageSize || req.query.limit || 20);
  const dateRange = buildDateRange(req.query);
  const filters = {
    branchId: req.query.branchId || '',
    terminalId: req.query.terminalId || '',
  };
  console.log('[reconciliation] /sales request', {
    query: req.query,
    dateRange,
    page,
    pageSize,
    filters,
  });
  const where = projectionWhere('sale_date', dateRange, filters);
  const total = await models.reconSale.count({ where });
  const pagination = databasePagination(total, page, pageSize);
  const saleRecords = await models.reconSale.findAll({
    where,
    include: [{
      model: models.syncEvent,
      as: 'syncEvent',
      attributes: PROJECTION_EVENT_ATTRIBUTES,
      required: true,
    }],
    order: [['sync_event_id', 'DESC'], ['id', 'DESC']],
    limit: pageSize,
    offset: pagination.offset,
  });
  const plainSales = saleRecords.map((record) => record.toJSON());
  const exportLookup = await loadProjectionExports(models, plainSales, 'oe_order', 'sale_id');
  const rows = plainSales.map((sale) => {
    const syncEvent = projectionEvent(sale);
    const document = exportLookup.get(sale.identity_key) || null;
    const documents = { oe_order: document };
    return {
      id: `${sale.sync_event_id}:${sale.sale_id}`,
      syncEventId: sale.sync_event_id,
      saleId: String(sale.sale_id),
      receiptNumber: sale.receipt_number || null,
      branchId: sale.branch_id || 'Unassigned',
      terminalId: sale.terminal_id || 'Unassigned',
      storeId: sale.store_id,
      saleDate: sale.sale_date,
      batchReceivedAt: syncEvent.received_at,
      amount: roundCurrency(sale.total_amount),
      paymentMethod: sale.payment_method || null,
      batchStatus: syncEvent.status,
      batchStatusBucket: toStatusBucket(syncEvent.status),
      oeOrderNumber: document?.sage_document_number || null,
      sageReference: document?.sage_reference || null,
      documentsPosted: document ? 1 : 0,
      postedToSage: Boolean(document),
      pendingReason: buildSalePendingReason(syncEvent, documents),
      batchProcessedAt: syncEvent.processed_at,
      batchLastAttemptAt: syncEvent.last_attempt_at,
      batchRetryCount: syncEvent.retry_count,
      batchIdempotencyKey: syncEvent.idempotency_key,
      batchLastError: syncEvent.last_error || null,
    };
  });
  const options = await loadProjectionOptions(models.reconSale, 'sale_date', dateRange);

  return res.json({
    success: true,
    filters: {
      days: dateRange.days,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      branchId: filters.branchId || null,
      terminalId: filters.terminalId || null,
      branchOptions: options.branchOptions,
      terminalOptions: options.terminalOptions,
    },
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: pagination.total,
      totalPages: pagination.totalPages,
    },
    rows,
  });
});

router.get('/credit-notes', reconAuth, async (req, res) => {
  const models = req.app.locals.models;
  await assertProjectionReady(models);
  const page = parsePage(req.query.page);
  const pageSize = parseLimit(req.query.pageSize || req.query.limit || 20);
  const dateRange = buildDateRange(req.query);
  const filters = {
    branchId: req.query.branchId || '',
    terminalId: req.query.terminalId || '',
  };
  console.log('[reconciliation] /credit-notes request', { query: req.query, dateRange, page, pageSize, filters });
  const where = projectionWhere('credit_note_date', dateRange, filters);
  const total = await models.reconCreditNote.count({ where });
  const pagination = databasePagination(total, page, pageSize);
  const noteRecords = await models.reconCreditNote.findAll({
    where,
    include: [{
      model: models.syncEvent,
      as: 'syncEvent',
      attributes: PROJECTION_EVENT_ATTRIBUTES,
      required: true,
    }],
    order: [['sync_event_id', 'DESC'], ['id', 'DESC']],
    limit: pageSize,
    offset: pagination.offset,
  });
  const plainNotes = noteRecords.map((record) => record.toJSON());
  const exportLookup = await loadProjectionExports(models, plainNotes, 'oe_credit_note', 'credit_note_id');
  const rows = plainNotes.map((note) => {
    const syncEvent = projectionEvent(note);
    const document = exportLookup.get(note.identity_key) || null;
    const posted = Boolean(document);
    return {
      id: `${note.sync_event_id}:${note.credit_note_id}`,
      syncEventId: note.sync_event_id,
      creditNoteId: String(note.credit_note_id),
      receiptNumber: note.receipt_number || null,
      originalSaleId: note.original_sale_id || null,
      branchId: note.branch_id || 'Unassigned',
      terminalId: note.terminal_id || 'Unassigned',
      storeId: note.store_id,
      creditNoteDate: note.credit_note_date,
      batchReceivedAt: syncEvent.received_at,
      subtotal: roundCurrency(note.subtotal),
      taxAmount: roundCurrency(note.tax_amount),
      amount: roundCurrency(note.total_amount),
      paymentMethod: note.payment_method || null,
      reason: note.reason || null,
      customerName: note.customer_name || null,
      batchStatus: syncEvent.status,
      batchStatusBucket: toStatusBucket(syncEvent.status),
      sageDocumentNumber: document?.sage_document_number || null,
      sageReference: document?.sage_reference || null,
      postedToSage: posted,
      pendingReason: buildCreditNotePendingReason(syncEvent, posted),
      batchProcessedAt: syncEvent.processed_at,
      batchLastAttemptAt: syncEvent.last_attempt_at,
      batchRetryCount: syncEvent.retry_count,
      batchIdempotencyKey: syncEvent.idempotency_key,
      batchLastError: syncEvent.last_error || null,
    };
  });
  const options = await loadProjectionOptions(models.reconCreditNote, 'credit_note_date', dateRange);

  return res.json({
    success: true,
    filters: {
      days: dateRange.days,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      branchId: filters.branchId || null,
      terminalId: filters.terminalId || null,
      branchOptions: options.branchOptions,
      terminalOptions: options.terminalOptions,
    },
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: pagination.total,
      totalPages: pagination.totalPages,
    },
    rows,
  });
});

router.get('/batches', reconAuth, async (req, res) => {
  const models = req.app.locals.models;
  await assertProjectionReady(models);
  const page = parsePage(req.query.page);
  const pageSize = parseLimit(req.query.pageSize || req.query.limit || 20);
  const dateRange = buildDateRange(req.query);
  const eventType = RELEVANT_EVENT_TYPES.includes(req.query.type) ? req.query.type : SALES_EVENT_TYPE;
  const filters = {
    branchId: req.query.branchId || '',
    terminalId: req.query.terminalId || '',
    status: req.query.status || '',
  };
  console.log('[reconciliation] /batches request', {
    query: req.query,
    dateRange,
    page,
    pageSize,
    eventType,
    filters,
  });
  const where = projectionWhere('received_at', dateRange, filters);
  where.event_type = eventType;
  const statusWhere = batchStatusWhere(filters.status);
  const include = [{
    model: models.syncEvent,
    as: 'syncEvent',
    attributes: PROJECTION_EVENT_ATTRIBUTES,
    required: true,
    ...(statusWhere ? { where: { status: statusWhere } } : {}),
  }];
  const total = await models.reconBatch.count({ where, include });
  const pagination = databasePagination(total, page, pageSize);
  const batchRecords = await models.reconBatch.findAll({
    where,
    include,
    order: [['received_at', 'DESC'], ['sync_event_id', 'DESC']],
    limit: pageSize,
    offset: pagination.offset,
  });
  const plainBatches = batchRecords.map((record) => record.toJSON());
  const eventIds = plainBatches.map((row) => row.sync_event_id);
  const exportRows = eventIds.length > 0
    ? await models.syncSaleExport.findAll({
        where: { sync_event_id: { [Op.in]: eventIds } },
        raw: true,
      })
    : [];
  const exportsByEvent = groupExportsByEventId(exportRows);
  const rows = plainBatches.map((batch) => {
    const syncEvent = projectionEvent(batch);
    const eventExports = exportsByEvent.get(batch.sync_event_id) || [];
    const references = Array.from(new Set(eventExports.map((row) => row.sage_reference).filter(Boolean)));
    return {
      id: batch.sync_event_id,
      eventType: batch.event_type,
      label: EVENT_TYPE_LABELS[batch.event_type] || batch.event_type,
      status: syncEvent.status,
      statusBucket: toStatusBucket(syncEvent.status),
      storeId: batch.store_id,
      branchId: batch.branch_id || 'Unassigned',
      terminalId: batch.terminal_id || 'Unassigned',
      transactionCount: batch.transaction_count,
      totalAmount: roundCurrency(batch.total_amount),
      creditNoteCount: batch.credit_note_count,
      creditNoteTotal: roundCurrency(batch.credit_note_total),
      exportedCount: eventExports.length,
      receivedAt: batch.received_at,
      processedAt: syncEvent.processed_at,
      lastAttemptAt: syncEvent.last_attempt_at,
      retryCount: syncEvent.retry_count,
      idempotencyKey: syncEvent.idempotency_key,
      sageReferences: references.slice(0, 3),
      lastError: syncEvent.last_error,
    };
  });
  const options = await loadProjectionOptions(
    models.reconBatch,
    'received_at',
    dateRange,
    { event_type: eventType }
  );

  return res.json({
    success: true,
    filters: {
      type: eventType,
      days: dateRange.days,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      branchId: filters.branchId || null,
      terminalId: filters.terminalId || null,
      status: filters.status || null,
      branchOptions: options.branchOptions,
      terminalOptions: options.terminalOptions,
      statusOptions: ['completed', 'pending', 'failed'],
    },
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: pagination.total,
      totalPages: pagination.totalPages,
    },
    rows,
  });
});

router.post('/batches/:id/requeue', reconAuth, requireReconRole('admin'), async (req, res) => {
  const models = req.app.locals.models;
  const syncEvent = await models.syncEvent.findByPk(req.params.id);

  if (!syncEvent) {
    return res.status(404).json({ message: 'Sync event not found' });
  }

  if (syncEvent.status === 'completed') {
    return res.status(409).json({ message: 'This event has already completed and cannot be requeued' });
  }

  const job = await queueSyncEvent(syncEvent);

  return res.json({
    success: true,
    eventId: syncEvent.id,
    queued: true,
    jobId: job.id,
    event: serializeSyncEvent(syncEvent),
  });
});

router.post('/batches/:id/reconcile', reconAuth, requireReconRole('admin'), async (req, res) => {
  const models = req.app.locals.models;
  const syncEvent = await models.syncEvent.findByPk(req.params.id);

  if (!syncEvent) {
    return res.status(404).json({ message: 'Sync event not found' });
  }

  if (syncEvent.event_type !== SALES_EVENT_TYPE) {
    return res.status(400).json({ message: 'Reconcile is only supported for day-end (OE order) batches' });
  }

  const body = req.body || {};
  const options = {
    sageOrderNumber: body.sageOrderNumber ? String(body.sageOrderNumber).trim() : null,
    sageOrderUniquifier: body.sageOrderUniquifier ? String(body.sageOrderUniquifier).trim() : null,
    sageReference: body.sageReference ? String(body.sageReference).trim() : null,
    repost: Boolean(body.repost),
  };

  try {
    const dispatchService = new EventDispatchService(models);
    const result = await dispatchService.reconcileDayEndExports(syncEvent, options);

    return res.status(result.success ? 200 : 422).json({
      ...result,
      eventId: syncEvent.id,
      event: serializeSyncEvent(syncEvent),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to reconcile batch with Sage.',
    });
  }
});

// Scans completed day-end batches that never actually posted to Sage (their sales still
// have no OE order export under their own receipt) and optionally re-posts them in bulk.
router.post('/batches/repost-pending', reconAuth, requireReconRole('admin'), async (req, res) => {
  const models = req.app.locals.models;
  const body = req.body || {};
  const dateRange = buildDateRange(body);
  const dryRun = body.dryRun !== false;
  const limit = Math.min(Math.max(Math.trunc(Number(body.limit) || 25), 1), 200);

  // Sort in JS instead of SQL: ORDER BY over this result set would filesort the large
  // JSON payload/response_payload/last_error columns and can overflow sort_buffer_size
  // (ER_OUT_OF_SORTMEMORY). All matching rows are processed anyway, so JS sort is exact.
  const events = await models.syncEvent.findAll({
    where: {
      event_type: SALES_EVENT_TYPE,
      received_at: buildRangeWhere(dateRange),
    },
  });
  events.sort((left, right) => left.id - right.id);

  const dispatchService = new EventDispatchService(models);
  const candidates = [];

  for (const syncEvent of events) {
    const { pendingSales, existingExports } = await dispatchService.resolvePendingSales(syncEvent, 'oe_order');
    if (pendingSales.length === 0) {
      continue;
    }

    candidates.push({
      syncEvent,
      eventId: syncEvent.id,
      idempotencyKey: syncEvent.idempotency_key,
      branchId: getBranchId(syncEvent) || 'Unassigned',
      terminalId: getTerminalId(syncEvent) || 'Unassigned',
      status: syncEvent.status,
      salesCount: getSales(syncEvent).length,
      pendingCount: pendingSales.length,
      exportedCount: existingExports.length,
    });
  }

  const describe = (candidate) => ({
    eventId: candidate.eventId,
    idempotencyKey: candidate.idempotencyKey,
    branchId: candidate.branchId,
    terminalId: candidate.terminalId,
    status: candidate.status,
    salesCount: candidate.salesCount,
    pendingCount: candidate.pendingCount,
    exportedCount: candidate.exportedCount,
  });

  if (dryRun) {
    return res.json({
      success: true,
      dryRun: true,
      filters: { startDate: dateRange.startDate, endDate: dateRange.endDate },
      totalCandidates: candidates.length,
      candidates: candidates.map(describe),
    });
  }

  const toProcess = candidates.slice(0, limit);
  const results = [];

  for (const candidate of toProcess) {
    try {
      const result = await dispatchService.reconcileDayEndExports(candidate.syncEvent, { repost: true });
      results.push({
        ...describe(candidate),
        success: result.success,
        reconciledCount: result.reconciledCount || 0,
        orderNumber: result.orderNumber || null,
        message: result.message || null,
      });
    } catch (error) {
      results.push({
        ...describe(candidate),
        success: false,
        message: error.response?.data?.message || error.message || 'Re-post failed',
      });
    }
  }

  return res.json({
    success: true,
    dryRun: false,
    filters: { startDate: dateRange.startDate, endDate: dateRange.endDate },
    totalCandidates: candidates.length,
    processed: results.length,
    remaining: Math.max(candidates.length - results.length, 0),
    results,
  });
});

module.exports = router;
