const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const {
  loadProjectionRowsInBatches,
  salesProjectionToExportRow,
  creditNoteProjectionToExportRow,
} = require('../services/reconciliationExportService');

test('loadProjectionRowsInBatches uses bounded keyset batches and keeps filters', async () => {
  const sourceRows = Array.from({ length: 205 }, (_, index) => ({ id: index + 1 }));
  const calls = [];
  const model = {
    async findAll(query) {
      calls.push(query);
      const afterId = query.where.id?.[Op.gt] || 0;
      return sourceRows.filter((row) => row.id > afterId).slice(0, query.limit);
    },
  };

  const rows = await loadProjectionRowsInBatches(
    model,
    'sale_date',
    { since: new Date('2025-01-01'), until: new Date('2025-12-31') },
    { branchId: '10', terminalId: '4' },
    { batchSize: 100 }
  );

  assert.equal(rows.length, 205);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.limit), [100, 100, 100]);
  assert.deepEqual(calls.map((call) => call.where.id?.[Op.gt] || null), [null, 100, 200]);
  assert.equal(calls[0].where.branch_id, '10');
  assert.equal(calls[0].where.terminal_id, '4');
  assert.deepEqual(calls[0].order, [['id', 'ASC']]);
});

test('projection export mappers use normalized reporting fields', () => {
  const sale = salesProjectionToExportRow({
    sale_date: '2025-02-01', branch_id: '1', terminal_id: '2', store_id: 3,
    receipt_number: 'R1', invoice_number: 'I1', customer_name: 'Buyer', cashier_name: 'Cashier',
    payment_method: 'Cash', subtotal: '90.00', discount_amount: '5.00', tax_amount: '15.00',
    total_amount: '100.00', posted_to_sage: 1, sage_document_number: 'OE1', sage_reference: 'REF1',
  });
  assert.equal(sale.total, 100);
  assert.equal(sale.discount, 5);
  assert.equal(sale.postedToSage, true);
  assert.equal(sale.customer, 'Buyer');

  const note = creditNoteProjectionToExportRow({
    credit_note_date: '2025-02-02', branch_id: '1', terminal_id: '2', store_id: 3,
    receipt_number: 'CN1', original_sale_id: 'S1', customer_name: 'Buyer', reason: 'Return',
    payment_method: 'Cash', subtotal: '40.00', tax_amount: '6.00', total_amount: '46.00',
    posted_to_sage: false, sage_document_number: null,
  });
  assert.equal(note.total, 46);
  assert.equal(note.postedToSage, false);
  assert.equal(note.reason, 'Return');
});
