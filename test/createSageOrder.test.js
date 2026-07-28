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
  assert.equal(payload.PostingDate, undefined);
  assert.equal(payload.ExpectedShipDate, '2026-07-02T12:00:00.000Z');
  assert.equal(payload.OrderRateDate, '2026-07-02T12:00:00.000Z');
  assert.equal(payload.TRRateDate, '2026-07-02T12:00:00.000Z');
  assert.equal(payload.OrderFiscalYear, '2026');
  assert.equal(payload.OrderFiscalPeriod, 'Num7');
  assert.equal(payload.OrderOptionalFields, undefined);
  assert.equal(payload.OrderDetails[0].Category, undefined);
  assert.equal(payload.OrderDetails[0].QuantityOrdered, 2);
  assert.equal(payload.OrderDetails[0].QuantityShipped, 2);
  assert.equal(payload.PerformShipAll, true);
  assert.equal(payload.ProcessOECommand, 'ShipAll');
  assert.equal(payload.ShipmentDate, '2026-07-02T12:00:00.000Z');
  assert.equal(payload.InvoiceDate, '2026-07-02T12:00:00.000Z');
  assert.equal(payload.ShipmentPostingDate, '2026-07-02T12:00:00.000Z');
  assert.equal(payload.InvoicePostingDate, '2026-07-02T12:00:00.000Z');
});

test('ISAUTOMATIC optional field is opt-in for Sage sites that support it', () => {
  const original = process.env.SAGE_INCLUDE_ISAUTOMATIC_OPTIONAL_FIELD;
  process.env.SAGE_INCLUDE_ISAUTOMATIC_OPTIONAL_FIELD = 'true';

  try {
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

    assert.deepEqual(payload.OrderOptionalFields, [{
      OrderUniquifier: 0,
      OptionalField: 'ISAUTOMATIC',
      Value: 'YES',
      YesNoValue: true,
      UpdateOperation: 'Unspecified',
    }]);
  } finally {
    if (original === undefined) {
      delete process.env.SAGE_INCLUDE_ISAUTOMATIC_OPTIONAL_FIELD;
    } else {
      process.env.SAGE_INCLUDE_ISAUTOMATIC_OPTIONAL_FIELD = original;
    }
  }
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
  assert.equal(payload.PostingDate, undefined);
  assert.equal(payload.OrderDescription, '001 T01 2026-06-30');
  assert.equal(payload.OrderFiscalYear, '2026');
  assert.equal(payload.OrderFiscalPeriod, 'Num6');
});

test('day-end order payload does not include the store revenue account on OE details by default', () => {
  const service = new SageOrdersService();
  const payload = service.buildConsolidatedOrder([
    {
      saleReference: 'SALE-RCP-REV',
      items: [{ product_code: 'ITEM-REV', quantity: 1, unit_price: 25 }],
      salesData: { total_amount: 25 },
    },
  ], {
    store: {
      store_number: '049S',
      store_customer_number: '1049',
      store_rev_account: '4000-049',
      currency: 'ZMW',
      store_tax_group: 'VATZMW',
    },
  }, '2026-07-14', 'T01', 'day-end-key', { branchId: '049' });

  assert.equal(payload.CustomerNumber, '1049');
  assert.equal(payload.DefaultLocationCode, '049S');
  assert.equal(payload.OrderDetails[0].Location, '049S');
  assert.equal(payload.OrderDetails[0].Category, '049');
  assert.equal(payload.OrderDetails[0].RevenueAccount, undefined);
  assert.equal(payload.PostingDate, undefined);
});

test('day-end order payload includes the store revenue account on OE details when opted in', () => {
  const original = process.env.SAGE_INCLUDE_OE_DETAIL_REVENUE_ACCOUNT;
  process.env.SAGE_INCLUDE_OE_DETAIL_REVENUE_ACCOUNT = 'true';

  try {
    const service = new SageOrdersService();
    const payload = service.buildConsolidatedOrder([
      {
        saleReference: 'SALE-RCP-REV',
        items: [{ product_code: 'ITEM-REV', quantity: 1, unit_price: 25 }],
        salesData: { total_amount: 25 },
      },
    ], {
      store: {
        store_number: '049S',
        store_customer_number: '1049',
        store_rev_account: '4000-049',
        currency: 'ZMW',
        store_tax_group: 'VATZMW',
      },
    }, '2026-07-14', 'T01', 'day-end-key', { branchId: '049' });

    assert.equal(payload.OrderDetails[0].RevenueAccount, '4000-049');
  } finally {
    if (original === undefined) {
      delete process.env.SAGE_INCLUDE_OE_DETAIL_REVENUE_ACCOUNT;
    } else {
      process.env.SAGE_INCLUDE_OE_DETAIL_REVENUE_ACCOUNT = original;
    }
  }
});

test('dispatcher resolves day-end date aliases before Sage posting', () => {
  const service = new EventDispatchService({});

  assert.equal(service.resolveDayEndDate({ date: '2026-07-02' }), '2026-07-02');
  assert.equal(service.resolveDayEndDate({ business_date: '2026-07-03' }), '2026-07-03');
  assert.equal(service.resolveDayEndDate({ day_end_date: '2026-07-04' }), '2026-07-04');
  assert.equal(service.resolveDayEndDate({}, {
    idempotency_key: 'day_end.ready:store-1:branch-029:date-2026-06-04',
  }), '2026-06-04');
});

test('day-end order payload requires an explicit business date', () => {
  const service = new SageOrdersService();

  assert.throws(() => service.buildConsolidatedOrder([
    {
      saleReference: 'SALE-RCP-MISSING-DATE',
      items: [{ product_code: 'ITEM-1', quantity: 1, unit_price: 10 }],
      salesData: { total_amount: 10 },
    },
  ], {
    store: {
      store_number: 'MAIN',
      store_customer_number: '1101',
      currency: 'ZMW',
      store_tax_group: 'VATZMW',
    },
  }, null, 'T01', 'day-end-key', { branchId: '001' }), /valid day-end date/);
});

test('day-end order posting reuses an existing Sage order with the same order number', async () => {
  const service = new SageOrdersService();
  service.getAuthConfig = () => ({ baseUrl: 'http://sage.example', headers: {} });
  service.findOrderByReference = async () => null;
  service.findOrderByNumber = async (orderNumber) => ({
    OrderNumber: orderNumber,
    OrderUniquifier: 123,
    OrderReference: 'existing-reference',
  });
  service.postOrder = async () => {
    throw new Error('postOrder should not be called when order number already exists');
  };

  const result = await service.createConsolidatedOrder([
    {
      saleReference: 'SALE-RCP-3',
      items: [{ product_code: 'ITEM-3', quantity: 1, unit_price: 12 }],
      salesData: { total_amount: 12 },
    },
  ], {
    store: {
      store_number: 'MAIN',
      store_customer_number: '1101',
      currency: 'ZMW',
      store_tax_group: 'VATZMW',
    },
  }, '2026-07-05', 'T01', {
    branchId: '001',
    orderReference: 'new-reference',
  });

  assert.equal(result.success, true);
  assert.equal(result.existingOrder, true);
  assert.equal(result.existingOrderMatchedBy, 'OrderNumber');
  assert.equal(result.orderNumber, '001-20260705');
  assert.equal(result.orderReference, 'existing-reference');
});

test('422 retry removes malformed optional fields before reposting', async () => {
  const service = new SageOrdersService();
  service.getAuthConfig = () => ({ baseUrl: 'http://sage.example', headers: {} });
  service.findOrderByReference = async () => null;
  service.findOrderByNumber = async () => null;

  const postedOrders = [];
  service.buildOrderOptionalFields = () => [{
    OrderUniquifier: 0,
    Value: 'YES',
    YesNoValue: true,
    UpdateOperation: 'Unspecified',
  }];
  service.postOrder = async (_baseUrl, _headers, order) => {
    postedOrders.push(order);
    if (postedOrders.length === 1) {
      const error = new Error('Request failed with status code 422');
      error.response = {
        status: 422,
        data: { error: { message: { OrderOptionalFields: ['OptionalField is required'] } } },
      };
      throw error;
    }

    return {
      status: 201,
      data: {
        OrderNumber: order.OrderNumber,
        OrderUniquifier: 456,
        OrderReference: order.OrderReference,
      },
    };
  };

  const result = await service.createConsolidatedOrder([
    {
      saleReference: 'SALE-RCP-4',
      items: [{ product_code: 'ITEM-4', quantity: 1, unit_price: 12 }],
      salesData: { total_amount: 12 },
    },
  ], {
    store: {
      store_number: 'MAIN',
      store_customer_number: '1101',
      currency: 'ZMW',
      store_tax_group: 'VATZMW',
    },
  }, '2026-07-06', 'T01', {
    branchId: '001',
    orderReference: 'retry-reference',
  });

  assert.equal(postedOrders.length, 2);
  assert.equal(postedOrders[0].OrderOptionalFields.length, 1);
  assert.equal(postedOrders[1].OrderOptionalFields, undefined);
  assert.equal(result.success, true);
  assert.equal(result.retriedWithoutAutomaticOptionalField, true);
});

test('400/422 retry removes detail revenue account if Sage rejects the field', async () => {
  const original = process.env.SAGE_INCLUDE_OE_DETAIL_REVENUE_ACCOUNT;
  process.env.SAGE_INCLUDE_OE_DETAIL_REVENUE_ACCOUNT = 'true';
  const service = new SageOrdersService();
  service.getAuthConfig = () => ({ baseUrl: 'http://sage.example', headers: {} });
  service.findOrderByReference = async () => null;
  service.findOrderByNumber = async () => null;

  const postedOrders = [];
  service.postOrder = async (_baseUrl, _headers, order) => {
    postedOrders.push(order);
    if (postedOrders.length === 1) {
      const error = new Error('Request failed with status code 422');
      error.response = {
        status: 400,
        data: {
          error: {
            code: 'InvalidPayload',
            message: {
              lang: 'en-US',
              value: "The property 'RevenueAccount' does not exist on type 'Sage.CA.SBS.ERP.Sage300.OE.WebApi.Models.OrderDetail'.",
            },
          },
        },
      };
      throw error;
    }

    return {
      status: 201,
      data: {
        OrderNumber: order.OrderNumber,
        OrderUniquifier: 789,
        OrderReference: order.OrderReference,
      },
    };
  };

  try {
    const result = await service.createConsolidatedOrder([
      {
        saleReference: 'SALE-RCP-REV',
        items: [{ product_code: 'ITEM-REV', quantity: 1, unit_price: 25 }],
        salesData: { total_amount: 25 },
      },
    ], {
      store: {
        store_number: '049S',
        store_customer_number: '1049',
        store_rev_account: '4000-049',
        currency: 'ZMW',
        store_tax_group: 'VATZMW',
      },
    }, '2026-07-14', 'T01', {
      branchId: '049',
      orderReference: 'retry-revenue-reference',
    });

    assert.equal(postedOrders.length, 2);
    assert.equal(postedOrders[0].OrderDetails[0].RevenueAccount, '4000-049');
    assert.equal(postedOrders[1].OrderDetails[0].RevenueAccount, undefined);
    assert.equal(result.success, true);
    assert.equal(result.retriedWithoutDetailRevenueAccount, true);
  } finally {
    if (original === undefined) {
      delete process.env.SAGE_INCLUDE_OE_DETAIL_REVENUE_ACCOUNT;
    } else {
      process.env.SAGE_INCLUDE_OE_DETAIL_REVENUE_ACCOUNT = original;
    }
  }
});

test('422 retry does not remove detail revenue account for unrelated order schema errors', async () => {
  const original = process.env.SAGE_INCLUDE_OE_DETAIL_REVENUE_ACCOUNT;
  process.env.SAGE_INCLUDE_OE_DETAIL_REVENUE_ACCOUNT = 'true';
  const service = new SageOrdersService();
  service.getAuthConfig = () => ({ baseUrl: 'http://sage.example', headers: {} });
  service.findOrderByReference = async () => null;
  service.findOrderByNumber = async () => null;

  const postedOrders = [];
  service.postOrder = async (_baseUrl, _headers, order) => {
    postedOrders.push(order);
    const error = new Error('Request failed with status code 422');
    error.response = {
      status: 422,
      data: {
        error: {
          message: {
            lang: 'en-US',
            value: "The property 'PostingDate' does not exist on type 'Sage.CA.SBS.ERP.Sage300.OE.WebApi.Models.Order'.",
          },
        },
      },
    };
    throw error;
  };

  try {
    await assert.rejects(() => service.createConsolidatedOrder([
      {
        saleReference: 'SALE-RCP-REV',
        items: [{ product_code: 'ITEM-REV', quantity: 1, unit_price: 25 }],
        salesData: { total_amount: 25 },
      },
    ], {
      store: {
        store_number: '049S',
        store_customer_number: '1049',
        store_rev_account: '4000-049',
        currency: 'ZMW',
        store_tax_group: 'VATZMW',
      },
    }, '2026-07-14', 'T01', {
      branchId: '049',
      orderReference: 'retry-posting-date-reference',
    }), /Request failed with status code 422/);

    assert.equal(postedOrders.length, 1);
    assert.equal(postedOrders[0].OrderDetails[0].RevenueAccount, '4000-049');
  } finally {
    if (original === undefined) {
      delete process.env.SAGE_INCLUDE_OE_DETAIL_REVENUE_ACCOUNT;
    } else {
      process.env.SAGE_INCLUDE_OE_DETAIL_REVENUE_ACCOUNT = original;
    }
  }
});

test('postOrder strips unsupported OE order header PostingDate before sending to Sage', async () => {
  const service = new SageOrdersService();
  let postedOrder = null;

  const originalPost = require('axios').post;
  require('axios').post = async (_url, order) => {
    postedOrder = order;
    return { status: 201, data: { OrderNumber: order.OrderNumber } };
  };

  try {
    await service.postOrder('http://sage.example', {}, {
      OrderNumber: '001-20260728',
      PostingDate: '2026-07-28T12:00:00.000Z',
      ShipmentPostingDate: '2026-07-28T12:00:00.000Z',
      InvoicePostingDate: '2026-07-28T12:00:00.000Z',
    });

    assert.equal(postedOrder.PostingDate, undefined);
    assert.equal(postedOrder.ShipmentPostingDate, '2026-07-28T12:00:00.000Z');
    assert.equal(postedOrder.InvoicePostingDate, '2026-07-28T12:00:00.000Z');
  } finally {
    require('axios').post = originalPost;
  }
});
