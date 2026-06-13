require('dotenv').config();
const models = require('../models');
const EventDispatchService = require('../services/eventDispatchService');

async function main() {
  const sourceEventId = Number(process.argv[2] || 150);
  const creditNoteId = process.argv[3] ? Number(process.argv[3]) : null;

  const sourceEvent = await models.syncEvent.findByPk(sourceEventId);
  if (!sourceEvent) {
    throw new Error(`Source event ${sourceEventId} not found`);
  }

  const payload = sourceEvent.payload || {};
  let creditNotes = payload.credit_notes || [];
  if (creditNoteId) {
    creditNotes = creditNotes.filter((row) => Number(row.id) === creditNoteId);
  } else {
    creditNotes = creditNotes.slice(0, 1);
  }

  if (creditNotes.length === 0) {
    throw new Error('No credit note found in source payload');
  }

  const testReceiptNumber = process.argv[4] || `CN-E2E-${Date.now()}`;
  creditNotes = creditNotes.map((creditNote, index) => ({
    ...creditNote,
    id: Number(`${Date.now()}${index}`),
    receipt_number: testReceiptNumber,
    reference: testReceiptNumber,
    sage_order_number: process.env.E2E_SAGE_ORDER_NUMBER || 'ORD0000000000000020380',
    sage_invoice_number: process.env.E2E_SAGE_INVOICE_NUMBER || 'IN00000000000000018710',
    sage_invoice_date: process.env.E2E_SAGE_INVOICE_DATE || '2026-05-13T00:00:00Z',
  }));

  const testKey = `credit_note_batch.ready:test:e2e:${Date.now()}`;
  const testEvent = await models.syncEvent.create({
    event_type: 'credit_note_batch.ready',
    aggregate_type: 'credit_note_batch',
    aggregate_id: Number(String(Date.now()).slice(-8)),
    store_id: sourceEvent.store_id,
    user_id: sourceEvent.user_id,
    receipt_number: null,
    idempotency_key: testKey,
    payload: {
      ...payload,
      date: payload.date || new Date().toISOString().slice(0, 10),
      credit_notes_count: creditNotes.length,
      credit_notes: creditNotes,
    },
    status: 'received',
    retry_count: 0,
    received_at: new Date(),
    queued_at: new Date(),
  });

  console.log('Created test sync event', {
    id: testEvent.id,
    idempotency_key: testEvent.idempotency_key,
    creditNote: creditNotes[0].receipt_number,
  });

  const dispatchService = new EventDispatchService(models);
  const result = await dispatchService.dispatch(testEvent);

  await testEvent.update({
    status: result.success === false ? 'failed' : 'completed',
    processed_at: new Date(),
    last_error: result.success === false ? JSON.stringify(result.errors || result) : null,
    response_payload: result,
  });

  console.log('Dispatch result', JSON.stringify(result, null, 2));

  const exports = await models.syncSaleExport.findAll({
    where: { sync_event_id: testEvent.id },
    order: [['id', 'ASC']],
  });
  console.log('Persisted exports', exports.map((row) => ({
    receipt_number: row.receipt_number,
    sage_document_number: row.sage_document_number,
    sage_reference: row.sage_reference,
  })));

  process.exit(result.success === false ? 1 : 0);
}

main().catch((error) => {
  console.error('E2E test failed:', error.message);
  if (error.response?.data) {
    console.error('Sage response:', JSON.stringify(error.response.data, null, 2));
  }
  process.exit(1);
});
