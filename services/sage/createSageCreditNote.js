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
    const totalPrice = item.total_price != null ? Number(item.total_price) : quantity * unitPrice;
    const code = item.product?.formatted_product_code
      || item.product?.product_code
      || item.product_code
      || (item.product_id ? String(item.product_id) : '');
    const description = item.product?.name || item.name || 'Item';

    return {
      quantity,
      unitPrice: this.to4(unitPrice),
      totalPrice: this.to4(totalPrice),
      code,
      description,
    };
  }

  buildBatchDescription(creditNote, originalSale, date) {
    const creditNoteRef = creditNote?.reference || creditNote?.receipt_number || 'CREDIT-NOTE';
    const originalSaleRef = originalSale?.receipt_number || originalSale?.invoice_no || originalSale?.receipt_no || originalSale?.id || 'SALE';
    const datePart = date ? new Date(date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    return `CN ${creditNoteRef} / ${originalSaleRef} - ${datePart}`;
  }

  buildInvoiceDetails(items, user, batchEntryNumber, creditNoteRef) {
    let lineNumber = 1;
    return items.map((rawItem) => {
      const item = this.normalizeItem(rawItem);
      const taxRate = 16;
      const taxExclusiveTotalBase = rawItem.tax_exclusive_total != null
        ? Number(rawItem.tax_exclusive_total)
        : (item.totalPrice / (1 + (taxRate / 100)));
      const taxAmount = item.totalPrice - taxExclusiveTotalBase;

      const detail = {
        BatchNumber: 0,
        EntryNumber: batchEntryNumber,
        LineNumber: lineNumber * 20,
        Description: `${creditNoteRef} - ${item.description}`,
        Quantity: item.quantity,
        Price: this.to4(item.unitPrice),
        ExtendedAmountWithoutTIP: this.to4(taxExclusiveTotalBase),
        ExtendedAmountWithTIP: this.to4(item.totalPrice),
        RevenueAccount: user?.store?.store_rev_account,
        UpdateOperation: 'Unspecified',
        TaxTotal: this.to4(taxAmount),
        TaxBase1: this.to4(taxExclusiveTotalBase),
        TaxAmount1: this.to4(taxAmount),
        TaxIncluded1: 'Yes',
        FunctionalTaxBase1: this.to4(taxExclusiveTotalBase),
        FunctionalTaxAmount1: this.to4(taxAmount),
        TaxAmount1Total: this.to4(taxAmount),
      };

      lineNumber += 1;
      return detail;
    });
  }

  async findExistingCreditNoteBatch(batchDescription) {
    if (!batchDescription) {
      return null;
    }

    const { baseUrl, headers } = this.getAuthConfig();
    const response = await axios.get(`${baseUrl}/AR/ARInvoiceBatches`, {
      headers,
      params: {
        $filter: `Description eq '${String(batchDescription).replace(/'/g, "''")}'`,
        $top: 1,
      },
      timeout: this.timeout,
    });

    const payload = response.data;
    if (Array.isArray(payload?.value)) {
      return payload.value[0] || null;
    }

    if (Array.isArray(payload)) {
      return payload[0] || null;
    }

    return payload?.BatchNumber ? payload : null;
  }

  isReusableBatch(batch) {
    if (!batch) {
      return false;
    }

    const status = String(batch.BatchStatus || batch.Status || batch.batchStatus || batch.status || '').trim().toLowerCase();
    const total = Number(batch.BatchTotal ?? batch.batchTotal ?? batch.DocumentTotalIncludingTax ?? batch.documentTotalIncludingTax ?? 0);

    if (!Number.isFinite(total) || total <= 0) {
      return false;
    }

    return status !== 'deleted';
  }

  async createCreditNoteReturn(creditNote, items, user, originalSale = null, options = {}) {
    const { baseUrl, headers } = this.getAuthConfig();
    const batchDate = creditNote?.credit_note_date || new Date().toISOString();
    const batchDescription = options.batchDescription || this.buildBatchDescription(creditNote, originalSale, batchDate);
    const creditNoteRef = creditNote?.reference || creditNote?.receipt_number || batchDescription;

    if (options.reconcileExisting && batchDescription) {
      const existingBatch = await this.findExistingCreditNoteBatch(batchDescription);
      if (this.isReusableBatch(existingBatch)) {
        return {
          success: true,
          status: 200,
          data: existingBatch,
          responseBody: existingBatch,
          sageResponse: existingBatch,
          documentNumber: existingBatch.BatchNumber == null ? null : String(existingBatch.BatchNumber),
          documentUniquifier: existingBatch.BatchNumber == null ? null : String(existingBatch.BatchNumber),
          documentReference: batchDescription,
          existingDocument: true,
        };
      }
    }

    const taxRate = 16;
    const invoiceDetails = this.buildInvoiceDetails(items, user, 1, creditNoteRef);
    const totalBeforeTax = this.to4((items || []).reduce((sum, item) => {
      if (item.tax_exclusive_total != null) {
        return sum + Number(item.tax_exclusive_total);
      }
      const normalized = this.normalizeItem(item);
      return sum + (normalized.totalPrice / (1 + (taxRate / 100)));
    }, 0));
    const totalTax = this.to4((items || []).reduce((sum, item) => {
      if (item.tax_exclusive_total != null) {
        const total = Number(item.total_price || 0);
        return sum + (total - Number(item.tax_exclusive_total));
      }
      const normalized = this.normalizeItem(item);
      const base = normalized.totalPrice / (1 + (taxRate / 100));
      return sum + (normalized.totalPrice - base);
    }, 0));
    const totalWithTax = this.to4(totalBeforeTax + totalTax);

    const batch = {
      BatchNumber: 0,
      BatchDate: new Date(batchDate).toISOString(),
      DateLastEdited: new Date().toISOString(),
      Description: batchDescription,
      BatchType: 'Entered',
      BatchStatus: 'Open',
      BatchTotal: totalWithTax,
      DefaultInvoiceType: 'Item',
      ProcessCommand: 'UnlockBatchResource',
      Invoices: [{
        BatchNumber: 0,
        EntryNumber: 1,
        CustomerNumber: user?.store?.store_customer_number,
        DateGenerated: new Date(batchDate).toISOString(),
        PostingDate: new Date(batchDate).toISOString(),
        DueDate: new Date(batchDate).toISOString(),
        AsOfDate: new Date(batchDate).toISOString(),
        DocumentDate: new Date(batchDate).toISOString(),
        DocumentType: 'CreditNote',
        TransactionType: 'CreditNoteSummaryIssued',
        InvoiceDescription: `${creditNoteRef}${originalSale?.receipt_number ? ` / ${originalSale.receipt_number}` : ''}`,
        InvoicePrinted: 'No',
        CurrencyCode: user?.store?.currency || creditNote?.currency || 'ZMW',
        Terms: user?.store?.terms_code || 'COD',
        Taxable: taxRate > 0 ? 'Yes' : 'No',
        TaxGroup: user?.store?.store_tax_group || 'VATZMW',
        InvoiceType: 'Summary',
        AmountDue: totalWithTax,
        TaxBase1: totalBeforeTax,
        FunctionalTaxBase1: totalBeforeTax,
        TaxAmount1: totalTax,
        TaxAmount1Total: totalTax,
        FunctionalTaxAmount1: totalTax,
        DocumentTotalBeforeTax: totalBeforeTax,
        DocumentTotalIncludingTax: totalWithTax,
        ProcessCommand: 'CalculateTaxes',
        InvoiceDetails: invoiceDetails,
        InvoicePaymentSchedules: [{
          BatchNumber: 0,
          EntryNumber: 1,
          PaymentNumber: 1,
          DueDate: new Date(batchDate).toISOString(),
          AmountDue: totalWithTax,
          FunctionalAmountDue: totalWithTax,
          UpdateOperation: 'Unspecified',
        }],
        UpdateOperation: 'Unspecified',
      }],
    };

    const response = await axios.post(`${baseUrl}/AR/ARInvoiceBatches`, batch, {
      headers,
      timeout: this.timeout,
    });

    return {
      success: true,
      status: response.status,
      data: response.data,
      responseBody: response.data,
      sageResponse: response.data,
      documentNumber: response.data?.BatchNumber == null ? null : String(response.data.BatchNumber),
      documentUniquifier: response.data?.BatchNumber == null ? null : String(response.data.BatchNumber),
      documentReference: batchDescription,
      existingDocument: false,
    };
  }
}

module.exports = SageCreditNoteService;