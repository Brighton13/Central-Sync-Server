const test = require('node:test');
const assert = require('node:assert/strict');

const SageOrdersService = require('../services/sage/createSageOrder');

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
  assert.equal(payload.OrderDetails[0].QuantityOrdered, 2);
  assert.equal(payload.OrderDetails[0].QuantityShipped, 2);
});
