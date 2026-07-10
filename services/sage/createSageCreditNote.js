const axios = require('axios');

const CREDIT_DEBIT_RESOURCE = 'OE/OECreditDebitNotes';

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

  escapeODataString(value) {
    return String(value).replace(/'/g, "''");
  }

  resolveNoteDate(creditNote, fallbackDate) {
    return this.resolveSageBusinessDate(
      fallbackDate
      || creditNote?.credit_note_date
      || creditNote?.sage_invoice_date
      || new Date()
    );
  }

  resolveBusinessDateKey(date) {
    const raw = String(date || '').trim();
    const directDateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (directDateMatch) {
      return `${directDateMatch[1]}-${directDateMatch[2]}-${directDateMatch[3]}`;
    }

    const parsed = date ? new Date(date) : new Date();
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('A valid business date is required for Sage credit-note posting');
    }

    return parsed.toISOString().slice(0, 10);
  }

  resolveSageBusinessDate(date) {
    const dateKey = this.resolveBusinessDateKey(date);
    return `${dateKey}T12:00:00.000Z`;
  }

  resolveOriginalSaleReceipt(creditNote) {
    if (creditNote?.original_sale_receipt_number) {
      return creditNote.original_sale_receipt_number;
    }

    const receiptNumber = String(creditNote?.receipt_number || '');
    if (receiptNumber.startsWith('CN-')) {
      return receiptNumber.slice(3);
    }

    return null;
  }

  buildFiscalPeriod(dateValue) {
    const month = Number(this.resolveBusinessDateKey(dateValue).slice(5, 7));
    return `Num${month}`;
  }

  mapDispatchResult(entity, fallbackReference) {
    return {
      success: true,
      status: 200,
      data: entity,
      responseBody: entity,
      sageResponse: entity,
      documentNumber: entity?.CreditDebitNoteNumber || null,
      documentUniquifier: entity?.CNUniquifier == null
        ? (entity?.CreditDebitNoteUniquifier == null ? null : String(entity.CreditDebitNoteUniquifier))
        : String(entity.CNUniquifier),
      documentReference: entity?.CreditDebitNoteNumber || fallbackReference || null,
    };
  }

  async findExistingCreditDebitNote(creditDebitNoteNumber) {
    if (!creditDebitNoteNumber) {
      return null;
    }

    const { baseUrl, headers } = this.getAuthConfig();
    const response = await axios.get(`${baseUrl}/${CREDIT_DEBIT_RESOURCE}`, {
      headers,
      params: {
        $filter: `CreditDebitNoteNumber eq '${this.escapeODataString(creditDebitNoteNumber)}'`,
        $top: 1,
      },
      timeout: this.timeout,
    });

    return response.data?.value?.[0] || null;
  }

  async findInvoiceForOrder(orderNumber) {
    if (!orderNumber) {
      return null;
    }

    const { baseUrl, headers } = this.getAuthConfig();
    const response = await axios.get(`${baseUrl}/OE/OEInvoices`, {
      headers,
      params: {
        $filter: `OrderNumber eq '${this.escapeODataString(orderNumber)}'`,
        $orderby: 'InvoiceDate desc',
        $top: 1,
      },
      timeout: this.timeout,
    });

    return response.data?.value?.[0] || null;
  }

  // Enriches the credit note with Sage order/invoice references when available.
  // Invoice linkage is optional — credit notes can post without it.
  async resolveCreditNoteReferences(creditNote, syncModels = null) {
    const originalSaleReceipt = this.resolveOriginalSaleReceipt(creditNote);
    if (!originalSaleReceipt || !syncModels?.syncSaleExport) {
      return creditNote;
    }

    const orderExport = await syncModels.syncSaleExport.findOne({
      where: {
        receipt_number: originalSaleReceipt,
        document_type: 'oe_order',
      },
      order: [['id', 'DESC']],
    });

    const sageOrderNumber = creditNote.sage_order_number || orderExport?.sage_document_number || null;
    if (!sageOrderNumber) {
      return {
        ...creditNote,
        original_sale_receipt_number: originalSaleReceipt,
      };
    }

    const invoice = await this.findInvoiceForOrder(sageOrderNumber);
    return {
      ...creditNote,
      original_sale_receipt_number: originalSaleReceipt,
      sage_order_number: sageOrderNumber,
      sage_invoice_number: creditNote.sage_invoice_number || invoice?.InvoiceNumber || null,
      sage_invoice_date: creditNote.sage_invoice_date || invoice?.InvoiceDate || null,
    };
  }

  buildCreditDebitDetails(items, user, creditNoteRef) {
    let lineNumber = 1;
    const locationCode = user?.store?.store_number || '';

    return items.map((rawItem) => {
      const item = this.normalizeItem(rawItem);
      const detail = {
        LineNumber: lineNumber * 32,
        LineType: 'Item',
        Item: item.code,
        Description: `${creditNoteRef} - ${item.description}`,
        Location: locationCode,
        QuantityReturned: item.quantity,
        CreditDebitNoteUOM: 'EACH',
        UnitConversion: 1,
        UnitPrice: this.to4(item.unitPrice),
        PriceOverride: true,
        ReturnType: 'ItemsReturnedToInventory',
        TaxAuthority1: user?.store?.store_tax_group || 'VATZMW',
        TaxClass1: 1,
        TaxIncluded1: true,
        UpdateOperation: 'Unspecified',
      };

      lineNumber += 1;
      return detail;
    });
  }

  buildCreditDebitNote(creditNote, items, user, originalSale = null, options = {}) {
    const noteDate = this.resolveNoteDate(creditNote, options.date);
    const creditNoteRef = creditNote?.reference || creditNote?.receipt_number || `CN-${creditNote?.id}`;
    const creditDebitNoteNumber = options.creditDebitNoteNumber || creditNoteRef;
    const customerName = creditNote?.customer?.name || user?.store?.store_location || 'POS Customer';
    const locationCode = user?.store?.store_number || '';
    const currency = user?.store?.currency || creditNote?.currency || 'ZMW';
    const taxGroup = user?.store?.store_tax_group || 'VATZMW';

    const orderNumber = options.orderNumber || creditNote?.sage_order_number || originalSale?.sage_order_number || '';
    const invoiceNumber = options.invoiceNumber || creditNote?.sage_invoice_number || '';

    const payload = {
      CreditDebitNoteNumber: creditDebitNoteNumber,
      CreditDebitNoteType: 'CreditNote',
      CustomerNumber: user?.store?.store_customer_number || creditNote?.customer?.customer_number || '1101',
      BillTo: customerName,
      BillToAddress1: creditNote?.customer?.address || '',
      BillToCity: creditNote?.customer?.city || '',
      DefaultLocationCode: locationCode,
      DefaultPriceListCode: user?.store?.price_list_code || '01',
      Description: creditNote?.notes || `POS credit note ${creditNoteRef}`,
      CreditDebitNoteDate: noteDate,
      CreditDebitNoteFiscalYear: this.resolveBusinessDateKey(noteDate).slice(0, 4),
      CreditDebitNoteFiscalPeriod: this.buildFiscalPeriod(noteDate),
      ReturnDate: noteDate,
      CreditDebitNoteHomeCurrency: currency,
      CreditDebitNoteRateType: 'SP',
      CreditDebitNoteSourceCurr: currency,
      CreditDebitNoteRateDate: noteDate,
      CreditDebitNoteRate: 1,
      TaxGroup: taxGroup,
      TaxAuthority1: taxGroup,
      TaxClass1: 1,
      UpdateOperation: 'Unspecified',
      CreditDebitDetails: this.buildCreditDebitDetails(items, user, creditNoteRef),
    };

    // Invoice linkage is optional — Sage accepts standalone credit notes.
    if (orderNumber) {
      payload.OrderNumber = orderNumber;
    }
    if (invoiceNumber) {
      payload.InvoiceNumber = invoiceNumber;
    }

    return payload;
  }

  async postCreditDebitNote(creditDebitNote) {
    const { baseUrl, headers } = this.getAuthConfig();
    const response = await axios.post(`${baseUrl}/${CREDIT_DEBIT_RESOURCE}`, creditDebitNote, {
      headers,
      timeout: this.timeout,
    });

    return response.data;
  }

  async createCreditNoteReturn(creditNote, items, user, originalSale = null, options = {}) {
    const creditNoteRef = creditNote?.reference || creditNote?.receipt_number || `CN-${creditNote?.id}`;
    const enrichedCreditNote = await this.resolveCreditNoteReferences(creditNote, options.syncModels || null);

    if (options.reconcileExisting) {
      const existingNote = await this.findExistingCreditDebitNote(creditNoteRef);
      if (existingNote) {
        return {
          ...this.mapDispatchResult(existingNote, creditNoteRef),
          existingDocument: true,
        };
      }
    }

    const creditDebitNote = this.buildCreditDebitNote(enrichedCreditNote, items, user, originalSale, {
      date: options.date,
      creditDebitNoteNumber: creditNoteRef,
      orderNumber: enrichedCreditNote.sage_order_number,
      invoiceNumber: enrichedCreditNote.sage_invoice_number,
    });

    console.log('[SageCreditNoteService] createCreditNoteReturn posting:', {
      creditNoteRef,
      url: `${this.getAuthConfig().baseUrl}/${CREDIT_DEBIT_RESOURCE}`,
      hasInvoice: Boolean(enrichedCreditNote.sage_invoice_number),
      lineCount: creditDebitNote.CreditDebitDetails.length,
    });

    try {
      const entity = await this.postCreditDebitNote(creditDebitNote);
      return {
        ...this.mapDispatchResult(entity, creditNoteRef),
        existingDocument: false,
      };
    } catch (error) {
      console.error('[SageCreditNoteService] createCreditNoteReturn error:', {
        creditNoteRef,
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
      throw error;
    }
  }

  // Posts each credit note in the daily batch as its own O/E Credit/Debit document.
  // Idempotent per credit-note receipt number. Invoice linkage is optional.
  async createConsolidatedCreditNoteReturn(creditNotes, user, date, options = {}) {
    const perSaleDocuments = [];
    let lastResult = null;
    let postedCount = 0;
    let existingCount = 0;
    let failedCount = 0;
    const errors = [];
    const syncModels = options.syncModels || null;

    for (const rawCreditNote of creditNotes) {
      const creditNote = await this.resolveCreditNoteReferences(rawCreditNote, syncModels);
      const creditNoteRef = creditNote?.reference || creditNote?.receipt_number || `CN-${creditNote?.id}`;
      const items = creditNote.items || [];

      try {
        let result;

        if (options.reconcileExisting !== false) {
          const existingNote = await this.findExistingCreditDebitNote(creditNoteRef);
          if (existingNote) {
            result = {
              ...this.mapDispatchResult(existingNote, creditNoteRef),
              existingDocument: true,
            };
            existingCount += 1;
          }
        }

        if (!result) {
          const creditDebitNote = this.buildCreditDebitNote(creditNote, items, creditNote.cashier || user, null, {
            date,
            creditDebitNoteNumber: creditNoteRef,
            orderNumber: creditNote.sage_order_number,
            invoiceNumber: creditNote.sage_invoice_number,
          });

          console.log('[SageCreditNoteService] createConsolidatedCreditNoteReturn posting:', {
            creditNoteRef,
            hasInvoice: Boolean(creditNote.sage_invoice_number),
            lineCount: creditDebitNote.CreditDebitDetails.length,
          });

          const entity = await this.postCreditDebitNote(creditDebitNote);
          result = {
            ...this.mapDispatchResult(entity, creditNoteRef),
            existingDocument: false,
          };
          postedCount += 1;
        }

        lastResult = result;
        perSaleDocuments.push({
          sale_id: String(creditNote.id),
          receipt_number: creditNote.receipt_number || null,
          document_number: result.documentNumber,
          document_uniquifier: result.documentUniquifier,
          sage_reference: result.documentReference,
          existingDocument: result.existingDocument,
        });
      } catch (error) {
        failedCount += 1;
        const errMsg = error?.response?.data?.error?.message?.value
          || error?.response?.data?.error
          || error.message;
        errors.push({ creditNoteRef, error: errMsg });
        console.error('[SageCreditNoteService] batch credit note failed:', {
          creditNoteRef,
          message: errMsg,
          status: error.response?.status,
        });
      }
    }

    const success = failedCount === 0 && (postedCount > 0 || existingCount > 0);

    return {
      success,
      status: success ? 200 : 207,
      postedCount,
      existingCount,
      failedCount,
      creditNotesProcessed: creditNotes.length,
      perSaleDocuments,
      errors: errors.length > 0 ? errors : undefined,
      documentNumber: lastResult?.documentNumber || null,
      documentUniquifier: lastResult?.documentUniquifier || null,
      documentReference: lastResult?.documentReference || null,
      data: lastResult?.data || null,
      responseBody: lastResult?.responseBody || null,
      sageResponse: lastResult?.sageResponse || null,
    };
  }
}

module.exports = SageCreditNoteService;
