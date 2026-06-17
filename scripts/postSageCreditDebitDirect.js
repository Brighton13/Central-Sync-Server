require('dotenv').config();
const axios = require('axios');

async function main() {
  const base = process.env.SAGE_BASE_URL || 'http://localhost/Sage300WebApi/v1.0/-/DAPDAT';
  const auth = 'Basic ' + Buffer.from(`${process.env.SAGE_USERNAME || 'ADMIN'}:${process.env.SAGE_PASSWORD || 'Admin123!'}`, 'utf-8').toString('base64');
  const headers = { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' };

  const invoiceNumber = process.argv[2] || 'IN00000000000000018710';
  const invRes = await axios.get(`${base}/OE/OEInvoices`, {
    headers,
    params: { $filter: `InvoiceNumber eq '${invoiceNumber}'`, $top: 1 },
  });
  const invoice = invRes.data?.value?.[0];
  if (!invoice) {
    throw new Error(`Invoice not found: ${invoiceNumber}`);
  }

  const noteDate = invoice.InvoiceDate || invoice.CreditDebitNoteDate || new Date().toISOString();
  const month = new Date(noteDate).getUTCMonth() + 1;
  const testNumber = `CN-E2E-${Date.now()}`;

  const locationCode = process.argv[5] || invoice.DefaultLocationCode || '1304S';
  const quantityReturned = Number(process.argv[6] || 1);
  const unitPrice = Number(process.argv[4] || 10);
  const lineAmount = Number((quantityReturned * unitPrice).toFixed(4));

  const payload = {
    CreditDebitNoteNumber: testNumber,
    CreditDebitNoteType: 'CreditNote',
    OrderNumber: invoice.OrderNumber,
    InvoiceNumber: invoice.InvoiceNumber,
    CustomerNumber: invoice.CustomerNumber,
    BillTo: invoice.BillTo || invoice.ShipToName || 'POS Customer',
    BillToAddress1: invoice.BillToAddress1 || '',
    BillToCity: invoice.BillToCity || '',
    DefaultLocationCode: locationCode,
    DefaultPriceListCode: invoice.DefaultPriceListCode || '01',
    Description: `POS E2E test ${testNumber}`,
    CreditDebitNoteDate: noteDate,
    CreditDebitNoteFiscalYear: String(new Date(noteDate).getUTCFullYear()),
    CreditDebitNoteFiscalPeriod: `Num${month}`,
    ReturnDate: noteDate,
    CreditDebitNoteHomeCurrency: invoice.InvoiceHomeCurrency || 'ZMW',
    CreditDebitNoteRateType: invoice.InvoiceRateType || 'SP',
    CreditDebitNoteSourceCurr: invoice.InvoiceSourceCurrency || 'ZMW',
    CreditDebitNoteRateDate: noteDate,
    CreditDebitNoteRate: 1,
    TaxGroup: invoice.TaxGroup || 'VATZMW',
    TaxAuthority1: invoice.TaxAuthority1 || 'VATZMW',
    TaxClass1: invoice.TaxClass1 || 1,
    UpdateOperation: 'Unspecified',
    CreditDebitDetails: [
      {
        LineNumber: 32,
        LineType: 'Item',
        Item: process.argv[3] || 'CP-11',
        Description: 'POS E2E credit note test line',
        Location: locationCode,
        QuantityReturned: quantityReturned,
        CreditDebitNoteUOM: 'EACH',
        UnitConversion: 1,
        UnitPrice: unitPrice,
        LineAmount: lineAmount,
        ExtendedPrice: lineAmount,
        PriceOverride: true,
        ReturnType: 'ItemsReturnedToInventory',
        TaxAuthority1: invoice.TaxAuthority1 || 'VATZMW',
        TaxClass1: invoice.TaxClass1 || 1,
        TaxIncluded1: true,
        UpdateOperation: 'Unspecified',
      },
    ],
  };

  console.log('Posting payload', JSON.stringify(payload, null, 2));

  try {
    const response = await axios.post(`${base}/OE/OECreditDebitNotes`, payload, { headers });
    console.log('SUCCESS', response.status, JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('FAILED', error.response?.status, JSON.stringify(error.response?.data, null, 2));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
