const express = require('express');
const { Op } = require('sequelize');

const { reconAuth, requireReconRole } = require('../middleware/reconAuth');
const { queueSyncEvent } = require('../services/syncEventQueueService');

const router = express.Router();

const RELEVANT_EVENT_TYPES = ['day_end.ready', 'credit_note.created'];
const SALES_EVENT_TYPE = 'day_end.ready';
const ZRA_COMPLIANCE_EVENT_TYPES = ['sale.created', 'sale.updated'];
const EVENT_TYPE_LABELS = {
  'day_end.ready': 'OE Order Batch',
  'sale.created': 'Sale Created',
  'sale.updated': 'Sale Updated',
  'credit_note.created': 'Credit Note Return',
};
const STATUS_BUCKETS = {
  completed: 'completed',
  failed: 'failed',
  dead_letter: 'failed',
  processing: 'pending',
  queued: 'pending',
  received: 'pending',
};

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

function getComplianceSale(syncEvent) {
  const payload = getPayload(syncEvent);
  if (payload.sale && typeof payload.sale === 'object') {
    return payload.sale;
  }

  return payload;
}

function getComplianceBranchId(syncEvent) {
  const payload = getPayload(syncEvent);
  return payload.branch_id || payload.sale?.branch_id || null;
}

function getComplianceTerminalId(syncEvent) {
  const payload = getPayload(syncEvent);
  return payload.terminal_id || payload.sale?.terminal_id || payload.branch_id || null;
}

function getZraStatus(syncEvent) {
  const sale = getComplianceSale(syncEvent);
  return String(sale.zra_status || sale.zraStatus || 'pending').toLowerCase();
}

function isReceiptPrinted(syncEvent) {
  const sale = getComplianceSale(syncEvent);
  return Boolean(sale.receipt_printed ?? sale.receiptPrinted ?? false);
}

function hasQrArtifact(syncEvent) {
  const sale = getComplianceSale(syncEvent);
  return Boolean(sale.qrfilepath || sale.qrFilePath || sale.qrcode_url || sale.qrcodeUrl);
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

  return getSales(syncEvent).length;
}

function getTotalAmount(syncEvent) {
  return roundCurrency(
    getSales(syncEvent).reduce((sum, sale) => sum + parseNumber(sale.total_amount), 0)
  );
}

function getCreditNoteCount(syncEvent) {
  return getCreditNotes(syncEvent).length;
}

function getCreditNoteTotal(syncEvent) {
  return roundCurrency(
    getCreditNotes(syncEvent).reduce((sum, creditNote) => sum + parseNumber(creditNote.total_amount), 0)
  );
}

function makeSaleKey(storeId, saleId) {
  return `${storeId}:${String(saleId)}`;
}

function getComplianceSaleKey(syncEvent) {
  const sale = getComplianceSale(syncEvent);
  const saleId = sale.id || syncEvent.aggregate_id;

  if (!saleId) {
    return null;
  }

  return makeSaleKey(syncEvent.store_id, saleId);
}

function selectLatestComplianceEvents(events) {
  const latestBySale = new Map();

  for (const syncEvent of events) {
    const saleKey = getComplianceSaleKey(syncEvent);
    if (!saleKey) {
      continue;
    }

    const existingEvent = latestBySale.get(saleKey);
    if (!existingEvent || syncEvent.id > existingEvent.id) {
      latestBySale.set(saleKey, syncEvent);
    }
  }

  return Array.from(latestBySale.values());
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

async function loadEventsWithExports(models, eventTypes, dateRange) {
  console.log('[reconciliation] loadEventsWithExports start', {
    eventTypes,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
  });

  const events = await models.syncEvent.findAll({
    where: {
      event_type: Array.isArray(eventTypes) ? { [Op.in]: eventTypes } : eventTypes,
      received_at: buildRangeWhere(dateRange),
    },
  });

  const plainEvents = events.map((event) => (event.toJSON ? event.toJSON() : event));
  const eventIds = plainEvents.map((event) => event.id);
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

async function loadExportsWithEvents(models, dateRange) {
  console.log('[reconciliation] loadExportsWithEvents start', {
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
  });

  const exports = await models.syncSaleExport.findAll({
    where: {
      document_type: 'oe_order',
      exported_at: buildRangeWhere(dateRange),
    },
  });

  const plainExports = exports.map((row) => (row.toJSON ? row.toJSON() : row));
  const eventIds = Array.from(new Set(plainExports.map((row) => row.sync_event_id).filter(Boolean)));
  const events = eventIds.length > 0
    ? await models.syncEvent.findAll({
        where: { id: { [Op.in]: eventIds } },
      })
    : [];

  console.log('[reconciliation] loadExportsWithEvents loaded', {
    exportCount: plainExports.length,
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
    eventMap,
  };
}

router.get('/summary', reconAuth, async (req, res) => {
  const models = req.app.locals.models;
  const limit = parseLimit(req.query.limit);
  const dateRange = buildDateRange(req.query);
  console.log('[reconciliation] /summary request', {
    query: req.query,
    dateRange,
    limit,
  });
  const events = await loadEventsWithExports(models, RELEVANT_EVENT_TYPES, dateRange);
  const recentBatchRows = sortByIdDesc(events).slice(0, limit);
  const exportBundle = await loadExportsWithEvents(models, dateRange);
  const recentExports = sortByIdDesc(exportBundle.exports).slice(0, limit * 2);

  const branchPerformance = new Map();
  const terminalPerformance = new Map();
  const documentSummary = {};
  const uniqueSales = new Map();
  const postedSales = new Set();
  const recentExportRows = [];

  let totalBatches = 0;
  let completedBatches = 0;
  let pendingBatches = 0;
  let failedBatches = 0;
  let totalSalesValue = 0;
  let totalCreditNotesCount = 0;
  let totalCreditNotesValue = 0;

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
    const saleExports = (syncEvent.saleExports || []).filter((item) => item.document_type === 'oe_order');
    const exportedSaleKeys = new Set(saleExports.map((item) => makeSaleKey(syncEvent.store_id, item.sale_id)));

    totalSalesValue += getTotalAmount(syncEvent);
    totalCreditNotesCount += getCreditNoteCount(syncEvent);
    totalCreditNotesValue += getCreditNoteTotal(syncEvent);
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
      const saleKey = makeSaleKey(syncEvent.store_id, sale.id);
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

      if (exportedSaleKeys.has(saleKey)) {
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

    incrementDocumentCounter(documentSummary, exportRow.document_type, 1);

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

  const totalSalesCount = uniqueSales.size;
  const postedSalesCount = postedSales.size;
  const pendingSalesCount = Math.max(totalSalesCount - postedSalesCount, 0);

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
  const limit = parseLimit(req.query.limit);
  const dateRange = buildDateRange(req.query);
  console.log('[reconciliation] /zra-compliance request', {
    query: req.query,
    dateRange,
    limit,
  });
  const events = selectLatestComplianceEvents(
    await loadEventsWithExports(models, ZRA_COMPLIANCE_EVENT_TYPES, dateRange)
  );

  const terminalCompliance = new Map();
  const branchCompliance = new Map();
  let totalSalesCount = 0;
  let submittedCount = 0;
  let pendingCount = 0;
  let failedCount = 0;
  let receiptPrintedCount = 0;
  let qrArtifactCount = 0;

  for (const syncEvent of events) {
    const branchId = String(getComplianceBranchId(syncEvent) || 'Unassigned');
    const terminalId = String(getComplianceTerminalId(syncEvent) || 'Unassigned');
    const sale = getComplianceSale(syncEvent);
    const zraStatus = getZraStatus(syncEvent);
    const printed = isReceiptPrinted(syncEvent);
    const hasQr = hasQrArtifact(syncEvent);
    const saleDate = sale.sale_date || syncEvent.received_at;
    const key = `${branchId}:${terminalId}`;

    const terminalBucket = upsertComplianceBucket(terminalCompliance, key, `Terminal ${terminalId}`);
    const branchBucket = upsertComplianceBucket(branchCompliance, branchId, `Branch ${branchId}`);

    terminalBucket.branchId = branchId;
    terminalBucket.terminalId = terminalId;
    branchBucket.branchId = branchId;

    totalSalesCount += 1;
    terminalBucket.totalSalesCount += 1;
    branchBucket.totalSalesCount += 1;

    if (zraStatus === 'sent') {
      submittedCount += 1;
      terminalBucket.submittedCount += 1;
      branchBucket.submittedCount += 1;
    } else if (zraStatus === 'failed') {
      failedCount += 1;
      terminalBucket.failedCount += 1;
      branchBucket.failedCount += 1;
    } else {
      pendingCount += 1;
      terminalBucket.pendingCount += 1;
      branchBucket.pendingCount += 1;
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
      receiptPrintedCount,
      qrArtifactCount,
      complianceRate: calculateComplianceRate(submittedCount, totalSalesCount),
      printedRate: calculateComplianceRate(receiptPrintedCount, totalSalesCount),
      qrRate: calculateComplianceRate(qrArtifactCount, totalSalesCount),
    },
    branchCompliance: branchRows,
    terminalCompliance: terminalRows,
  });
});

router.get('/sales', reconAuth, async (req, res) => {
  const models = req.app.locals.models;
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

  const events = await loadEventsWithExports(models, SALES_EVENT_TYPE, dateRange);
  const branchOptions = collectOptions(events.map((event) => getBranchId(event)));
  const terminalOptions = collectOptions(events.map((event) => getTerminalId(event)));
  const rows = [];

  for (const syncEvent of events) {
    if (!eventMatchesFilters(syncEvent, filters)) {
      continue;
    }

    const saleExportsBySaleId = groupExportsBySaleId(syncEvent.saleExports || []);

    for (const sale of getSales(syncEvent)) {
      const row = buildSaleRow(syncEvent, sale, saleExportsBySaleId.get(String(sale.id)) || []);
      if (!isDateInRange(row.saleDate, dateRange)) {
        continue;
      }
      rows.push(row);
    }
  }

  const orderedRows = rows.sort((left, right) => {
    if (right.syncEventId !== left.syncEventId) {
      return right.syncEventId - left.syncEventId;
    }

    return Number(right.saleId) - Number(left.saleId);
  });

  console.log('[reconciliation] /sales prepared rows', {
    totalRows: rows.length,
    page,
    pageSize,
  });

  const paginated = paginateRows(orderedRows, page, pageSize);

  return res.json({
    success: true,
    filters: {
      days: dateRange.days,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      branchId: filters.branchId || null,
      terminalId: filters.terminalId || null,
      branchOptions,
      terminalOptions,
    },
    pagination: paginated.pagination,
    rows: paginated.rows,
  });
});

router.get('/batches', reconAuth, async (req, res) => {
  const models = req.app.locals.models;
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

  const events = await loadEventsWithExports(models, eventType, dateRange);
  const branchOptions = collectOptions(events.map((event) => getBranchId(event)));
  const terminalOptions = collectOptions(events.map((event) => getTerminalId(event)));
  const rows = sortByIdDesc(events)
    .filter((event) => eventMatchesFilters(event, filters))
    .map(buildBatchRow);
  const paginated = paginateRows(rows, page, pageSize);
  console.log('[reconciliation] /batches prepared rows', {
    totalRows: rows.length,
    page,
    pageSize,
  });

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
      branchOptions,
      terminalOptions,
      statusOptions: ['completed', 'pending', 'failed'],
    },
    pagination: paginated.pagination,
    rows: paginated.rows,
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

module.exports = router;
