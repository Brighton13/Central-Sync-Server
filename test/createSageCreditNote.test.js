const test = require('node:test');
const assert = require('node:assert/strict');

const SageCreditNoteService = require('../services/sage/createSageCreditNote');

test('credit-note batch payload uses the batch business date for Sage posting fields', () => {
  const service = new SageCreditNoteService();
  const payload = service.buildCreditDebitNote(
    {
      id: 10,
      receipt_number: 'CN-RCP-1',
      credit_note_date: '2026-07-01T08:00:00.000Z',
      sage_invoice_date: '2026-06-28T10:00:00.000Z',
    },
    [{ product_code: 'ITEM-1', quantity: 1, unit_price: 10 }],
    {
      store: {
        store_number: 'MAIN',
        store_customer_number: '1101',
        currency: 'ZMW',
        store_tax_group: 'VATZMW',
      },
    },
    null,
    {
      date: '2026-07-02',
      creditDebitNoteNumber: 'CN-RCP-1',
    }
  );

  assert.equal(payload.CreditDebitNoteDate, '2026-07-02T12:00:00.000Z');
  assert.equal(payload.ReturnDate, '2026-07-02T12:00:00.000Z');
  assert.equal(payload.CreditDebitNoteRateDate, '2026-07-02T12:00:00.000Z');
  assert.equal(payload.CreditDebitNoteFiscalYear, '2026');
  assert.equal(payload.CreditDebitNoteFiscalPeriod, 'Num7');
});
