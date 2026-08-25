const axios = require('axios');

class SageInternalUsageService {
  constructor({ client = axios } = {}) {
    this.client = client;
  }

  async createStockReturn(payload = {}) {
    const documentNumber = String(payload.document_number || '').trim();
    if (!documentNumber) {
      throw new Error('Stock return document_number is required');
    }
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (items.length === 0) {
      return {
        success: true,
        staged: true,
        message: 'Stock return contains no items',
        documentNumber,
      };
    }

    const usageDetails = items.map((item, index) => ({
      SequenceNumber: 0,
      LineNumber: (index + 1) * 1000,
      ItemNumber: String(item.product_code || '').trim(),
      ItemDescription: String(item.product_name || '').trim(),
      Location: String(payload.sage_location || payload.store_number || '').trim(),
      Quantity: Number(item.quantity || 0),
      UnitOfMeasure: 'EACH',
      ConversionFactor: 1,
      UnitCost: Number(item.unit_cost || 0),
      ExtendedCost: 0,
      Comments: `POS zero-out ${documentNumber}`,
      UnformattedItemNumber: String(item.product_code || '').trim(),
      ProcessCommand: 'NothingToProcess',
      SerialNumbers: true,
      ForcePopupSN: true,
      CloseSN: true,
      ForcePopupLT: true,
      CloseLT: true,
      UOM: 'EACH',
      NumberOfOptionalFields: 0,
      NumberOfSerials: 0,
      LotQuantity: 0,
      SeparateQuantities: false,
      AssetQuantity: 0,
    }));

    const body = {
      SequenceNumber: 0,
      TransactionNumber: 0,
      Description: `POS zero-out ${documentNumber}`,
      EntryType: 'InternalUsage',
      InternalUsageDate: payload.date
        ? new Date(payload.date).toISOString()
        : new Date().toISOString(),
      Reference: documentNumber,
      RecordStatus: 'Entered',
      RecordDeleted: false,
      RecordPrinted: false,
      NumberOfOptionalFields: 0,
      EmployeeNumber: '',
      EnteredBy: String(payload.actor || 'POS').trim(),
      PostSequenceNumber: 0,
      NextDetailLineNumber: usageDetails.length + 1,
      InternalUsageDetails: usageDetails,
    };

    try {
      const response = await this.client.post(
        `${this.baseUrl()}/IC/ICInternalUsages`,
        body,
        { headers: this.headers(), timeout: 30000 }
      );
      return {
        success: true,
        documentNumber,
        transactionNumber: response.data?.TransactionNumber || null,
        itemsProcessed: usageDetails.length,
        returnedQuantity: usageDetails.reduce((sum, item) => sum + Number(item.Quantity || 0), 0),
        sageResponse: response.data,
      };
    } catch (error) {
      const responseBody = error.response?.data;
      const message = responseBody?.error?.message || responseBody?.message || error.message || '';
      if (error.response?.status === 409 || /already exists|duplicate/i.test(String(message))) {
        const existingUsage = await this.findExistingStockReturn(documentNumber);
        if (existingUsage) {
          return {
            success: true,
            idempotent: true,
            documentNumber,
            transactionNumber: existingUsage.TransactionNumber || null,
            itemsProcessed: usageDetails.length,
            sageResponse: existingUsage,
            message: 'Duplicate Sage internal usage verified as already posted',
          };
        }
        error.sageErrorPayload = {
          message:
            'Sage reported duplicate internal usage, but no matching document could be found by reference.',
          sageResponse: responseBody || null,
          documentNumber,
        };
        throw error;
      }
      error.sageErrorPayload = responseBody || { message };
      throw error;
    }
  }

  async findExistingStockReturn(documentNumber) {
    for (const filter of [
      `Reference eq '${this.escapeODataString(documentNumber)}'`,
      `Description eq 'POS zero-out ${this.escapeODataString(documentNumber)}'`,
    ]) {
      try {
        const response = await this.client.get(
          `${this.baseUrl()}/IC/ICInternalUsages`,
          {
            headers: this.headers(),
            params: { $filter: filter, $top: 1 },
            timeout: 30000,
          }
        );
        const rows = Array.isArray(response.data?.value)
          ? response.data.value
          : Array.isArray(response.data)
            ? response.data
            : [];
        if (rows[0]) return rows[0];
      } catch (error) {
        // If lookup is unavailable, let the original duplicate error remain visible.
      }
    }
    return null;
  }

  escapeODataString(value) {
    return String(value).replace(/'/g, "''");
  }

  baseUrl() {
    return String(process.env.SAGE_BASE_URL || 'http://localhost/Sage300WebApi/v1.0/-/INDCOM').replace(/\/$/, '');
  }

  headers() {
    const username = process.env.SAGE_USERNAME || 'ADMIN';
    const password = process.env.SAGE_PASSWORD || 'Admin123!';
    const authorization = Buffer.from(`${username}:${password}`, 'utf-8').toString('base64');
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Basic ${authorization}`,
    };
  }
}

module.exports = SageInternalUsageService;
