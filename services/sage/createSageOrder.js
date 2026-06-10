const axios = require('axios');

class SageOrdersService {
  constructor() {
    this.timeout = Number(process.env.SAGE_TIMEOUT_MS || 60000);
  }

  buildOrderDescription(branchId, terminalId, orderDate) {
    return [branchId || '000', terminalId || '000', orderDate].join(' ');
  }

  getAuthConfig() {
    const baseUrl = process.env.SAGE_BASE_URL;
    const username = process.env.SAGE_USERNAME || 'API01';
    const password = process.env.SAGE_PASSWORD || 'Admin123!';

    if (!baseUrl) {
      throw new Error('SAGE_BASE_URL is not configured');
    }

    return {
      baseUrl,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf-8').toString('base64')}`,
      },
    };
  }

  to4(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return 0;
    }
    return Number(numeric.toFixed(4));
  }

  normalizeItem(item) {
    const quantity = Number(item.quantity || 0);
    const unitPrice = Number(item.unit_price || 0);
    const code = item.product?.formatted_product_code
      || item.formatted_product_code
      || item.product?.product_code
      || item.product_code
      || (item.product_id ? String(item.product_id) : '');
    const description = item.product?.name || item.name || 'Item';

    return {
      quantity,
      unitPrice: this.to4(unitPrice),
      code,
      description,
    };
  }

  buildConsolidatedOrder(salesDataArray, user, date, terminalId, orderReference, options = {}) {
    const orderDate = date ? new Date(date).toISOString() : new Date().toISOString();
    let detailIndex = 0;
    const orderDetails = [];

    for (const saleData of salesDataArray) {
      const saleReference = saleData.saleReference || saleData.salesData?.sale_reference || saleData.receiptNumber || saleData.salesData?.receipt_number || `SALE-${detailIndex + 1}`;

      for (const rawItem of (saleData.items || [])) {
        const item = this.normalizeItem(rawItem);
        orderDetails.push({
          LineNumber: (detailIndex + 1) * 32,
          LineType: 'Item',
          Item: item.code,
          Description: `${saleReference} - ${item.description}`,
          Location: user?.store?.store_number || '',
          StockItem: true,
          QuantityOrdered: item.quantity,
          OrderUnitOfMeasure: 'EACH',
          OrderUnitConversion: 1,
          OrderUnitPrice: item.unitPrice,
          PriceOverride: true,
          PricingUnitOfMeasure: 'EACH',
          PricingUnitPrice: item.unitPrice,
          PricingUnitConversion: 1,
          DetailNumber: detailIndex + 1,
          TaxAuthority1: user?.store?.store_tax_group || 'VATZMW',
          TaxClass1: 1,
          TaxIncluded1: true,
          UpdateOperation: 'Unspecified'
        });
        detailIndex += 1;
      }
    }

    const totalFromSales = salesDataArray.reduce((sum, saleData) => sum + (Number(saleData.salesData?.total_amount) || 0), 0);
    const fallbackFromLines = orderDetails.reduce((sum, line) => sum + (Number(line.OrderUnitPrice) * Number(line.QuantityOrdered)), 0);
    const orderTotal = this.to4(totalFromSales || fallbackFromLines);

    return {
      OrderUniquifier: 0,
      OrderNumber: '*** NEW ***',
      OrderReference: orderReference || '',
      CustomerNumber: user?.store?.store_customer_number || salesDataArray[0]?.salesData?.customer?.customer_number || '1101',
      CustomerGroupCode: user?.store?.currency || 'ZMW',
      ShipToName: user?.store?.store_location || salesDataArray[0]?.salesData?.customer?.name || 'POS Customer',
      ShipToAddressLine1: '',
      ShipToCity: '',
      OrderDescription: this.buildOrderDescription(options.branchId, terminalId, orderDate),
      CustomerDiscountLevel: 'Base',
      DefaultPriceListCode: user?.store?.price_list_code || '01',
      TermsCode: user?.store?.terms_code || 'COD',
      OrderType: 'Active',
      OrderDate: orderDate,
      ExpectedShipDate: orderDate,
      OrderFiscalYear: String(new Date(orderDate).getUTCFullYear()),
      OrderFiscalPeriod: `Num${new Date(orderDate).getUTCMonth() + 1}`,
      DefaultLocationCode: user?.store?.store_number || '',
      OnHold: false,
      OrderHomeCurrency: user?.store?.currency || 'ZMW',
      OrderRateType: 'SP',
      OrderSourceCurrency: user?.store?.currency || 'ZMW',
      OrderRateDate: orderDate,
      OrderRate: 1,
      OrderRateDateMatching: 3,
      OrderRateOperator: 1,
      OrderRateOverrideFlag: false,
      TaxGroup: user?.store?.store_tax_group || 'VATZMW',
      TaxAuthority1: user?.store?.store_tax_group || 'VATZMW',
      TaxClass1: 1,
      OrderCompleted: 'IncompleteNotIncluded',
      PostInvoice: false,
      TaxReportingTRCurrency: user?.store?.currency || 'ZMW',
      TRRateType: 'SP',
      TRRateDate: orderDate,
      TRRate: 1,
      TRRateDateMatching: 1,
      TRRateOperator: 1,
      OrderDetails: orderDetails,
      OrderTotal: orderTotal,
      OrderInclTaxTotal: orderTotal,
      NumberOfLinesOnOrder: orderDetails.length,
      UpdateOperation: 'Unspecified'
    };
  }

  normalizeOrderResponse(orderData, status, salesDataArray, order, terminalId, options = {}) {
    return {
      success: true,
      status,
      data: orderData,
      responseBody: orderData,
      sageResponse: orderData,
      terminalId: terminalId || '000',
      orderDetailsCount: order.OrderDetails.length,
      salesProcessed: salesDataArray.length,
      orderTotal: order.OrderTotal,
      orderNumber: orderData?.OrderNumber || null,
      orderUniquifier: orderData?.OrderUniquifier == null ? null : String(orderData.OrderUniquifier),
      orderReference: orderData?.OrderReference || options.orderReference || '',
      existingOrder: Boolean(options.existingOrder),
    };
  }

  extractOrderEntity(payload) {
    if (!payload) {
      return null;
    }

    if (Array.isArray(payload?.value)) {
      return payload.value[0] || null;
    }

    if (Array.isArray(payload)) {
      return payload[0] || null;
    }

    if (payload.OrderNumber) {
      return payload;
    }

    return null;
  }

  escapeODataString(value) {
    return String(value).replace(/'/g, "''");
  }

  async findOrderByReference(orderReference) {
    if (!orderReference) {
      return null;
    }

    const { baseUrl, headers } = this.getAuthConfig();
    const response = await axios.get(`${baseUrl}/OE/OEOrders`, {
      headers,
      params: {
        $filter: `OrderReference eq '${this.escapeODataString(orderReference)}'`,
        $top: 1,
      },
      timeout: this.timeout,
    });

    return this.extractOrderEntity(response.data);
  }

  async findOrderByNumber(orderNumber) {
    if (!orderNumber) {
      return null;
    }

    const { baseUrl, headers } = this.getAuthConfig();
    const response = await axios.get(`${baseUrl}/OE/OEOrders`, {
      headers,
      params: {
        $filter: `OrderNumber eq '${this.escapeODataString(orderNumber)}'`,
        $top: 1,
      },
      timeout: this.timeout,
    });

    return this.extractOrderEntity(response.data);
  }

  async createConsolidatedOrder(salesDataArray, user, date, terminalId, options = {}) {
    const { baseUrl, headers } = this.getAuthConfig();
    const order = this.buildConsolidatedOrder(salesDataArray, user, date, terminalId, options.orderReference, options);

    if (options.orderReference) {
      const existingOrder = await this.findOrderByReference(options.orderReference);
      if (existingOrder) {
        return this.normalizeOrderResponse(existingOrder, 200, salesDataArray, order, terminalId, {
          orderReference: options.orderReference,
          existingOrder: true,
        });
      }
    }

    const response = await axios.post(`${baseUrl}/OE/OEOrders`, order, {
      headers,
      timeout: this.timeout,
    });

    return this.normalizeOrderResponse(response.data, response.status, salesDataArray, order, terminalId, {
      orderReference: options.orderReference,
      existingOrder: false,
    });
  }
}

module.exports = SageOrdersService;
