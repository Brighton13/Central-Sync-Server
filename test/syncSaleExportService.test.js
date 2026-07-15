const test = require('node:test');
const assert = require('node:assert/strict');

const SyncSaleExportService = require('../services/syncSaleExportService');

test('findExportsForSales can be scoped to the current day-end batch key', async () => {
  let capturedWhere = null;
  const service = new SyncSaleExportService({
    syncSaleExport: {
      findAll: async (options) => {
        capturedWhere = options.where;
        return [];
      },
    },
  });

  await service.findExportsForSales(1, [
    { id: 26296, receipt_number: 'RCP1111-26033' },
  ], 'oe_order', {
    dayEndIdempotencyKey: 'day_end.ready:store-1:branch-049:date-2026-07-14',
  });

  assert.equal(capturedWhere.document_type, 'oe_order');
  assert.equal(capturedWhere.day_end_idempotency_key, 'day_end.ready:store-1:branch-049:date-2026-07-14');
});

test('persistExports relinks a stale receipt export to the current day-end order', async () => {
  let updatedDefaults = null;
  const staleRecord = {
    exported_at: new Date('2026-07-03T18:00:00.000Z'),
    sage_document_number: '049-20260703',
    day_end_idempotency_key: 'day_end.ready:store-1:branch-049:date-2026-07-03',
    update: async (values) => {
      updatedDefaults = values;
      Object.assign(staleRecord, values);
    },
  };

  const service = new SyncSaleExportService({
    syncSaleExport: {
      findOrCreate: async () => [staleRecord, false],
    },
    reconSale: {
      update: async () => {},
    },
  });

  const syncEvent = {
    id: 663,
    store_id: 1,
    idempotency_key: 'day_end.ready:store-1:branch-049:date-2026-07-14',
  };

  await service.persistExports(syncEvent, [
    { id: 26296, receipt_number: 'RCP1111-26033' },
  ], {
    orderNumber: '049-20260714',
    orderUniquifier: '999',
    orderReference: syncEvent.idempotency_key,
  }, 'oe_order');

  assert.equal(updatedDefaults.sage_document_number, '049-20260714');
  assert.equal(updatedDefaults.day_end_idempotency_key, syncEvent.idempotency_key);
  assert.equal(updatedDefaults.receipt_number, 'RCP1111-26033');
});
