const axios = require('axios');

class SageOrdersService {
  constructor() {
    this.timeout = Number(process.env.SAGE_TIMEOUT_MS || 60000);
  }

  buildOrderDescription(branchId, terminalId, orderDate) {
    return [branchId || '000', terminalId || '000', orderDate].join(' ');
  }

  buildDayEndOrderNumber(branchId, date) {
    const normalizedBranchId = String(branchId || '').trim().replace(/[^A-Za-z0-9]/g, '');
    const datePart = this.resolveBusinessDateKey(date).replace(/-/g, '');

    if (!normalizedBranchId) {
      throw new Error('A branch ID is required to build the Sage day-end order number');
    }

    if (!/^\d{8}$/.test(datePart)) {
      throw new Error('A valid day-end date is required to build the Sage order number');
    }

    return `${normalizedBranchId}-${datePart}`;
  }

  resolveBusinessDateKey(date) {
    const raw = String(date || '').trim();
    const directDateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (directDateMatch) {
      return `${directDateMatch[1]}-${directDateMatch[2]}-${directDateMatch[3]}`;
    }

    const parsed = date ? new Date(date) : new Date();
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('A valid day-end date is required for Sage posting');
    }

    return parsed.toISOString().slice(0, 10);
  }

  resolveSageBusinessDate(date) {
    const dateKey = this.resolveBusinessDateKey(date);
    // Anchor at midday UTC so Sage keeps the intended business date even if the
    // web API/database applies a local timezone conversion while posting to GL.
    return `${dateKey}T12:00:00.000Z`;
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
    const orderDate = this.resolveSageBusinessDate(date);
    const businessDateKey = this.resolveBusinessDateKey(date);
    const orderNumber = this.buildDayEndOrderNumber(options.branchId, date);
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
          QuantityShipped: item.quantity,
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
    const orderOptionalFields = [{
      OrderUniquifier: 0,
      OptionalField: 'ISAUTOMATIC',
      Value: 'YES',
      YesNoValue: true,
      UpdateOperation: 'Unspecified',
    }];

    return {
      OrderUniquifier: 0,
      OrderNumber: orderNumber,
      OrderReference: orderReference || '',
      CustomerNumber: user?.store?.store_customer_number || salesDataArray[0]?.salesData?.customer?.customer_number || '1101',
      CustomerGroupCode: user?.store?.currency || 'ZMW',
      ShipToName: user?.store?.store_location || salesDataArray[0]?.salesData?.customer?.name || 'POS Customer',
      ShipToAddressLine1: '',
      ShipToCity: '',
      OrderDescription: this.buildOrderDescription(options.branchId, terminalId, businessDateKey),
      CustomerDiscountLevel: 'Base',
      DefaultPriceListCode: user?.store?.price_list_code || '01',
      TermsCode: user?.store?.terms_code || 'COD',
      OrderType: 'Active',
      OrderDate: orderDate,
      PostingDate: orderDate,
      ExpectedShipDate: orderDate,
      OrderFiscalYear: businessDateKey.slice(0, 4),
      OrderFiscalPeriod: `Num${Number(businessDateKey.slice(5, 7))}`,
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
      // Shipping every detail and enabling PostInvoice makes Sage post the shipment and
      // create the corresponding O/E invoice as part of posting this order.
      PostInvoice: true,
      TaxReportingTRCurrency: user?.store?.currency || 'ZMW',
      TRRateType: 'SP',
      TRRateDate: orderDate,
      TRRate: 1,
      TRRateDateMatching: 1,
      TRRateOperator: 1,
      OrderOptionalFields: orderOptionalFields,
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
