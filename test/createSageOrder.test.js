const test = require('node:test');
const assert = require('node:assert/strict');

const SageOrdersService = require('../services/sage/createSageOrder');
const EventDispatchService = require('../services/eventDispatchService');

test('builds a stable day-end order number from branch ID and business date', () => {
  const service = new SageOrdersService();

  assert.equal(service.buildDayEndOrderNumber('001', '2026-07-02'), '001-20260702');
  assert.equal(service.buildDayEndOrderNumber('BR-01', '2026-07-02T00:00:00.000Z'), 'BR01-20260702');
});

test('day-end order payload ships all quantities and creates the invoice', () => {
  const service = new SageOrdersService();
  const payload = service.buildConsolidatedOrder([
    {
      saleReference: 'SALE-RCP-1',
      items: [{ product_code: 'ITEM-1', quantity: 2, unit_price: 10 }],
      salesData: { total_amount: 20 },
    },
  ], {
    store: {
      store_number: 'MAIN',
      store_customer_number: '1101',
      currency: 'ZMW',
      store_tax_group: 'VATZMW',
    },
  }, '2026-07-02', 'T01', 'day-end-key', { branchId: '001' });

  assert.equal(payload.OrderNumber, '001-20260702');
  assert.equal(payload.PostInvoice, true);
  assert.equal(payload.OrderDate, '2026-07-02T12:00:00.000Z');
  assert.equal(payload.PostingDate, '2026-07-02T12:00:00.000Z');
  assert.equal(payload.ExpectedShipDate, '2026-07-02T12:00:00.000Z');
  assert.equal(payload.OrderRateDate, '2026-07-02T12:00:00.000Z');
  assert.equal(payload.TRRateDate, '2026-07-02T12:00:00.000Z');
  assert.equal(payload.OrderFiscalYear, '2026');
  assert.equal(payload.OrderFiscalPeriod, 'Num7');
  assert.equal(payload.OrderDetails[0].QuantityOrdered, 2);
  assert.equal(payload.OrderDetails[0].QuantityShipped, 2);
});

test('day-end order payload keeps the supplied business date instead of the posting day', () => {
  const service = new SageOrdersService();
  const payload = service.buildConsolidatedOrder([
    {
      saleReference: 'SALE-RCP-2',
      items: [{ product_code: 'ITEM-2', quantity: 1, unit_price: 15 }],
      salesData: { total_amount: 15 },
    },
  ], {
    store: {
      store_number: 'MAIN',
      store_customer_number: '1101',
      currency: 'ZMW',
      store_tax_group: 'VATZMW',
    },
  }, '2026-06-30T23:59:59.999Z', 'T01', 'day-end-key', { branchId: '001' });

  assert.equal(payload.OrderNumber, '001-20260630');
  assert.equal(payload.OrderDate, '2026-06-30T12:00:00.000Z');
  assert.equal(payload.PostingDate, '2026-06-30T12:00:00.000Z');
  assert.equal(payload.OrderDescription, '001 T01 2026-06-30');
  assert.equal(payload.OrderFiscalYear, '2026');
  assert.equal(payload.OrderFiscalPeriod, 'Num6');
});

test('dispatcher resolves day-end date aliases before Sage posting', () => {
  const service = new EventDispatchService({});

  assert.equal(service.resolveDayEndDate({ date: '2026-07-02' }), '2026-07-02');
  assert.equal(service.resolveDayEndDate({ business_date: '2026-07-03' }), '2026-07-03');
  assert.equal(service.resolveDayEndDate({ day_end_date: '2026-07-04' }), '2026-07-04');
});
