const axios = require('axios');

class CatalogStockService {
  constructor({ client = axios } = {}) {
    this.client = client;
    this.timeout = Number(process.env.SAGE_TIMEOUT_MS || 60000);
  }

  authConfig() {
    const baseUrl = String(process.env.SAGE_BASE_URL || '').replace(/\/$/, '');
    const username = process.env.SAGE_USERNAME || 'API01';
    const password = process.env.SAGE_PASSWORD || 'Admin123!';

    if (!baseUrl) {
      throw new Error('SAGE_BASE_URL is not configured');
    }

    return {
      baseUrl,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf-8').toString('base64')}`,
      },
    };
  }

  resources() {
    const configured = String(process.env.SAGE_STOCK_RESOURCE || '').trim();
    return configured
      ? [configured]
      : ['IC/ICItemLocations', 'IC/ICLocationDetails', 'IC/ICItems'];
  }

  async fetchStock({ location = '', prefix = '' } = {}) {
    const { baseUrl, headers } = this.authConfig();
    const normalizedLocation = String(location || '').trim();
    const normalizedPrefix = String(prefix || '').trim();
    const errors = [];

    for (const resource of this.resources()) {
      try {
        const response = await this.client.get(`${baseUrl}/${resource.replace(/^\/+/, '')}`, {
          headers,
          params: this.queryParams(resource, normalizedLocation),
          timeout: this.timeout,
        });
        return this.normalizeRows(response.data, {
          location: normalizedLocation,
          prefix: normalizedPrefix,
        });
      } catch (error) {
        errors.push({
          resource,
          status: error.response?.status || null,
          message: error.response?.data?.error?.message?.value
            || error.response?.data?.error?.message
            || error.response?.data?.message
            || error.message,
        });
      }
    }

    const failure = new Error('Unable to read Sage stock from configured Web API resources');
    failure.statusCode = errors.some((entry) => entry.status === 401) ? 502 : 500;
    failure.details = { resourcesTried: errors };
    throw failure;
  }

  queryParams(resource, location) {
    if (!location || /ICItems$/i.test(resource)) return { $top: 1000 };
    return {
      $filter: `Location eq '${this.escapeODataString(location)}'`,
      $top: 1000,
    };
  }

  normalizeRows(payload, { location, prefix }) {
    const rows = Array.isArray(payload?.value)
      ? payload.value
      : Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
          ? payload.data
          : [];

    const normalized = rows
      .map((row) => this.normalizeRow(row))
      .filter((row) => row.ItemNumber)
      .filter((row) => !prefix || row.ItemNumber.startsWith(prefix));
    const hasLocationRows = normalized.some((row) => row.Location);
    return hasLocationRows && location
      ? normalized.filter((row) => row.Location === location)
      : normalized;
  }

  normalizeRow(row) {
    const itemNumber = this.firstText(row, [
      'ItemNumber',
      'UnformattedItemNumber',
      'Item',
      'ITEMNO',
      'itemNumber',
      'product_code',
    ]);
    return {
      ItemNumber: itemNumber,
      Location: this.firstText(row, ['Location', 'LOCATION', 'location']),
      QuantityOnHand: this.firstNumber(row, [
        'QuantityOnHand',
        'QtyOnHand',
        'QTYONHAND',
        'quantityOnHand',
        'stock_quantity',
      ]),
      QuantityCommitted: this.firstNumber(row, [
        'QuantityCommitted',
        'QtyCommitted',
        'QTYCOMMIT',
        'quantityCommitted',
      ]),
      QuantityAvailableToShip: this.firstNumber(row, [
        'QuantityAvailableToShip',
        'QtyAvailableToShip',
        'QTYAVAIL',
        'quantity',
      ]),
      IsActive: row.IsActive ?? row.ACTIVE ?? row.active ?? true,
    };
  }

  firstText(row, keys) {
    for (const key of keys) {
      const value = row?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return String(value).trim();
      }
    }
    return '';
  }

  firstNumber(row, keys) {
    for (const key of keys) {
      const value = row?.[key];
      if (value !== undefined && value !== null && value !== '') {
        const number = Number(value);
        return Number.isFinite(number) ? number : 0;
      }
    }
    return 0;
  }

  escapeODataString(value) {
    return String(value).replace(/'/g, "''");
  }
}

module.exports = CatalogStockService;
