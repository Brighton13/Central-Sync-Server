const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProjectionRows,
  identityKey,
  materializeSyncEvent,
} = require('../services/reconciliationProjectionService');

test('buildProjectionRows normalizes a day-end payload without retaining batch-wide data', () => {
  const rows = buildProjectionRows({
    id: 42,
    event_type: 'day_end.ready',
    store_id: 7,
    received_at: '2026-06-20T10:00:00.000Z',
    payload: {
      date: '2026-06-20',
      branch_id: '001',
      terminal_id: 'T-3',
      sales_count: 2,
      sales: [
        {
          id: 10,
          receipt_number: 'RCP7-10',
          total_amount: 120.5,
          payment_method: 'Cash',
          sdcid: 'SDC-1',
          receipt_no: '1001',
          zra_status: 'sent',
          receipt_printed: true,
          qrcode_url: 'https://example.test/qr/1001',
        },
        { id: 11, total_amount: 79.5, payment_method: 'Card' },
      ],
      credit_notes: [{ id: 3, receipt_number: 'CN7-3', total_amount: 20 }],
    },
  });

  assert.equal(rows.batch.transaction_count, 2);
  assert.equal(rows.batch.total_amount, 200);
  assert.equal(rows.batch.credit_note_count, 1);
  assert.equal(rows.batch.batch_date.toISOString(), '2026-06-20T00:00:00.000Z');
  assert.equal(rows.sales.length, 2);
  assert.equal(rows.sales[0].identity_key, 'rcp:RCP7-10');
  assert.equal(rows.sales[0].zra_sdc_id, 'SDC-1');
  assert.equal(rows.sales[0].zra_receipt_number, '1001');
  assert.equal(rows.sales[0].zra_status, 'sent');
  assert.equal(rows.sales[0].receipt_printed, true);
  assert.equal(rows.sales[0].has_sdc_data, true);
  assert.equal(rows.sales[0].has_qr_artifact, true);
  assert.equal(rows.sales[1].identity_key, 'sid:7:11');
  assert.equal(rows.sales[1].has_sdc_data, false);
  assert.equal(rows.creditNotes[0].identity_key, 'rcp:CN7-3');
  assert.equal(Object.hasOwn(rows.sales[0], 'raw_data'), false);
});

test('buildProjectionRows supports legacy single credit-note events', () => {
  const rows = buildProjectionRows({
    id: 99,
    event_type: 'credit_note.created',
    store_id: 2,
    received_at: '2026-06-20T10:00:00.000Z',
    payload: {
      branch_id: '002',
      credit_note: { id: 8, receipt_number: 'CN2-8', total_amount: 50 },
      items: [{ product_id: 1 }],
    },
  });

  assert.equal(rows.creditNotes.length, 1);
  assert.equal(Object.hasOwn(rows.creditNotes[0], 'raw_data'), false);
  assert.equal(rows.batch.total_amount, 50);
  assert.equal(identityKey(2, null, 8), 'sid:2:8');
});

test('buildProjectionRows projects standalone per-sale check-ins', () => {
  const rows = buildProjectionRows({
    id: 101,
    event_type: 'sale.created',
    store_id: 3,
    received_at: '2026-06-28T08:30:00.000Z',
    payload: {
      branch_id: '001',
      terminal_id: 'T-02',
      sale: {
        id: 88,
        receipt_number: 'RCP1001-88',
        total_amount: 116,
        tax_amount: 16,
        zra_status: 'pending',
      },
    },
  });

  assert.equal(rows.batch.transaction_count, 1);
  assert.equal(rows.batch.terminal_id, 'T-02');
  assert.equal(rows.sales.length, 1);
  assert.equal(rows.sales[0].identity_key, 'rcp:RCP1001-88');
});

test('materializeSyncEvent writes bounded bulk rows and advances a completed projection', async () => {
  const captured = { batches: [], sales: [], notes: [], stateUpdates: [] };
  const models = {
    syncSaleExport: { findAll: async () => [] },
    reconBatch: { upsert: async (row) => captured.batches.push(row) },
    reconSale: { bulkCreate: async (rows, options) => captured.sales.push({ rows, options }) },
    reconCreditNote: { bulkCreate: async (rows, options) => captured.notes.push({ rows, options }) },
    reconProjectionState: {
      update: async (values, options) => captured.stateUpdates.push({ values, options }),
    },
  };

  const result = await materializeSyncEvent(models, {
    id: 123,
    event_type: 'day_end.ready',
    store_id: 1,
    received_at: '2026-06-20T10:00:00.000Z',
    payload: {
      sales: [{ id: 1, receipt_number: 'RCP1-1', total_amount: 10 }],
      credit_notes: [{ id: 2, receipt_number: 'CN1-2', total_amount: 2 }],
    },
  }, { advanceState: true });

  assert.deepEqual(result, { projected: true, sales: 1, creditNotes: 1 });
  assert.equal(captured.batches.length, 1);
  assert.equal(captured.sales[0].rows.length, 1);
  assert.equal(captured.notes[0].rows.length, 1);
  assert.ok(captured.sales[0].options.updateOnDuplicate.includes('updatedAt'));
  assert.ok(captured.sales[0].options.updateOnDuplicate.includes('has_sdc_data'));
  assert.equal(captured.stateUpdates[0].values.last_event_id, 123);
});
