const axios = require('axios');

class SageCreditNoteService {
  constructor() {
    this.timeout = Number(process.env.SAGE_TIMEOUT_MS || 60000);
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

  buildOrderReference(creditNote, originalSale, date) {
    const creditNoteRef = creditNote?.reference || creditNote?.receipt_number || 'CREDIT-NOTE';
    const originalSaleRef = originalSale?.receipt_number || originalSale?.invoice_no || originalSale?.receipt_no || originalSale?.id || 'SALE';
    const datePart = date ? new Date(date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    const sdcSuffix = creditNote?.sdcid ? ` / SDC:${creditNote.sdcid}` : '';
    return `CN ${creditNoteRef} / ${originalSaleRef} - ${datePart}${sdcSuffix}`;
  }

  buildOrderDetails(items, user, creditNoteRef) {
    let detailNumber = 1;
    return items.map((rawItem) => {
      const item = this.normalizeItem(rawItem);

      const detail = {
        LineNumber: detailNumber * 32,
        LineType: 'Item',
        Item: item.code,
        Description: `${creditNoteRef} - ${item.description}`,
        Category: user?.store?.store_customer_number || '',
        Location: user?.store?.store_number || '',
        StockItem: true,
        QuantityOrdered: item.quantity,
        OrderUnitOfMeasure: 'EACH',
        OrderUnitConversion: 1,
        OrderUnitPrice: this.to4(item.unitPrice),
        PriceOverride: true,
        PricingUnitOfMeasure: 'EACH',
        PricingUnitPrice: this.to4(item.unitPrice),
        PricingUnitConversion: 1,
        DetailNumber: detailNumber,
        TaxAuthority1: user?.store?.store_tax_group || 'VATZMW',
        TaxClass1: 1,
        TaxIncluded1: true,
        UpdateOperation: 'Unspecified',
      };

      detailNumber += 1;
      return detail;
    });
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

    return payload?.OrderNumber ? payload : null;
  }

  escapeODataString(value) {
    return String(value).replace(/'/g, "''");
  }

  async findExistingCreditNoteOrder(orderReference) {
    if (!orderReference) {
      return null;
    }

    const { baseUrl, headers } = this.getAuthConfig();
    console.log('[SageCreditNoteService] findExistingCreditNoteOrder:', {
      orderReference,
      url: `${baseUrl}/OE/OEOrders`,
      timeout: this.timeout,
    });

    try {
      const response = await axios.get(`${baseUrl}/OE/OEOrders`, {
        headers,
        params: {
          $filter: `OrderReference eq '${this.escapeODataString(orderReference)}'`,
          $top: 1,
        },
        timeout: this.timeout,
      });

      console.log('[SageCreditNoteService] findExistingCreditNoteOrder response status:', response.status);
      return this.extractOrderEntity(response.data);
    } catch (error) {
      console.error('[SageCreditNoteService] findExistingCreditNoteOrder error:', {
        orderReference,
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
      throw error;
    }
  }

  async createCreditNoteReturn(creditNote, items, user, originalSale = null, options = {}) {
    const { baseUrl, headers } = this.getAuthConfig();
    const orderDate = creditNote?.credit_note_date || new Date().toISOString();
    const orderReference = options.orderReference || this.buildOrderReference(creditNote, originalSale, orderDate);
    const creditNoteRef = creditNote?.reference || creditNote?.receipt_number || orderReference;
    const sdcTag = creditNote?.sdcid ? ` | SDC:${creditNote.sdcid}` : '';
    const invoiceTag = creditNote?.invoice_no ? ` | INV:${creditNote.invoice_no}` : '';
    const orderDescription = `${creditNoteRef}${originalSale?.receipt_number ? ` / ${originalSale.receipt_number}` : ''}${sdcTag}${invoiceTag}`;

    if (options.reconcileExisting && orderReference) {
      const existingOrder = await this.findExistingCreditNoteOrder(orderReference);
      if (existingOrder) {
        return {
          success: true,
          status: 200,
          data: existingOrder,
          responseBody: existingOrder,
          sageResponse: existingOrder,
          documentNumber: existingOrder.OrderNumber || null,
          documentUniquifier: existingOrder.OrderUniquifier == null ? null : String(existingOrder.OrderUniquifier),
          documentReference: existingOrder.OrderReference || orderReference,
          existingDocument: true,
        };
      }
    }

    const orderDetails = this.buildOrderDetails(items, user, creditNoteRef);
    const totalFromCreditNote = Number(creditNote?.total_amount || 0);
    const fallbackFromLines = orderDetails.reduce((sum, detail) => (
      sum + (Number(detail.OrderUnitPrice) * Number(detail.QuantityOrdered))
    ), 0);
    const orderTotal = this.to4(totalFromCreditNote || fallbackFromLines);

    const order = {
      OrderUniquifier: 0,
      OrderNumber: '*** NEW ***',
      OrderReference: orderReference,
      CustomerNumber: user?.store?.store_customer_number || creditNote?.customer?.customer_number || '1101',
      CustomerGroupCode: user?.store?.currency || creditNote?.currency || 'ZMW',
      ShipToName: creditNote?.customer?.name || user?.store?.store_location || 'POS Customer',
      ShipToAddressLine1: '',
      ShipToCity: '',
      OrderDescription: orderDescription,
      CustomerDiscountLevel: 'Base',
      DefaultPriceListCode: user?.store?.price_list_code || '01',
      TermsCode: user?.store?.terms_code || 'COD',
      OrderType: 'Active',
      OrderDate: new Date(orderDate).toISOString(),
      ExpectedShipDate: new Date(orderDate).toISOString(),
      OrderFiscalYear: String(new Date(orderDate).getUTCFullYear()),
      OrderFiscalPeriod: `Num${new Date(orderDate).getUTCMonth() + 1}`,
      DefaultLocationCode: user?.store?.store_number || '',
      OnHold: false,
      OrderHomeCurrency: user?.store?.currency || creditNote?.currency || 'ZMW',
      OrderRateType: 'SP',
      OrderSourceCurrency: user?.store?.currency || creditNote?.currency || 'ZMW',
      OrderRateDate: new Date(orderDate).toISOString(),
      OrderRate: 1,
      OrderRateDateMatching: 3,
      OrderRateOperator: 1,
      OrderRateOverrideFlag: false,
      TaxGroup: user?.store?.store_tax_group || 'VATZMW',
      TaxAuthority1: user?.store?.store_tax_group || 'VATZMW',
      TaxClass1: 1,
      OrderCompleted: 'IncompleteNotIncluded',
      PostInvoice: false,
      TaxReportingTRCurrency: user?.store?.currency || creditNote?.currency || 'ZMW',
      TRRateType: 'SP',
      TRRateDate: new Date(orderDate).toISOString(),
      TRRate: 1,
      TRRateDateMatching: 1,
      TRRateOperator: 1,
      OrderDetails: orderDetails,
      OrderTotal: orderTotal,
      OrderInclTaxTotal: orderTotal,
      NumberOfLinesOnOrder: orderDetails.length,
      UpdateOperation: 'Unspecified',
    };

    console.log('[SageCreditNoteService] createCreditNoteReturn sending order:', {
      orderReference,
      url: `${baseUrl}/OE/OEOrders`,
      OrderTotal: order.OrderTotal,
      NumberOfLinesOnOrder: order.NumberOfLinesOnOrder,
      timeout: this.timeout,
    });

    try {
      const response = await axios.post(`${baseUrl}/OE/OEOrders`, order, {
        headers,
        timeout: this.timeout,
      });

      console.log('[SageCreditNoteService] createCreditNoteReturn response status:', response.status);
      return {
        success: true,
        status: response.status,
        data: response.data,
        responseBody: response.data,
        sageResponse: response.data,
        documentNumber: response.data?.OrderNumber || null,
        documentUniquifier: response.data?.OrderUniquifier == null ? null : String(response.data.OrderUniquifier),
        documentReference: response.data?.OrderReference || orderReference,
        existingDocument: false,
      };
    } catch (error) {
      console.error('[SageCreditNoteService] createCreditNoteReturn error:', {
        orderReference,
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
      throw error;
    }
  }
}

module.exports = SageCreditNoteService;