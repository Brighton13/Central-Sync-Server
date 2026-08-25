const test = require('node:test');
const assert = require('node:assert/strict');

const CatalogStockService = require('../services/sage/catalogStockService');

test('catalog stock service normalizes and filters Sage item-location rows', async () => {
  const previousBaseUrl = process.env.SAGE_BASE_URL;
  process.env.SAGE_BASE_URL = 'http://sage.example/Sage300WebApi/v1.0/-/DAPDAT';

  const requests = [];
  const service = new CatalogStockService({
    client: {
      async get(url, options) {
        requests.push({ url, options });
        return {
          data: {
            value: [
              { ItemNumber: 'CP-15', Location: '1001', QuantityOnHand: '39' },
              { ItemNumber: 'XX-01', Location: '1001', QuantityOnHand: '8' },
              { ItemNumber: 'CP-16', Location: '2002', QuantityOnHand: '4' },
            ],
          },
        };
      },
    },
  });

  try {
    const rows = await service.fetchStock({ location: '1001', prefix: 'CP' });

    assert.equal(requests[0].url, 'http://sage.example/Sage300WebApi/v1.0/-/DAPDAT/IC/ICItemLocations');
    assert.equal(requests[0].options.params.$filter, "Location eq '1001'");
    assert.deepEqual(rows, [
      {
        ItemNumber: 'CP-15',
        Location: '1001',
        QuantityOnHand: 39,
        QuantityCommitted: 0,
        QuantityAvailableToShip: 0,
        IsActive: true,
      },
    ]);
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.SAGE_BASE_URL;
    } else {
      process.env.SAGE_BASE_URL = previousBaseUrl;
    }
  }
});

test('catalog stock service falls back to ICItems when item-location resources are unavailable', async () => {
  const previousBaseUrl = process.env.SAGE_BASE_URL;
  process.env.SAGE_BASE_URL = 'http://sage.example/Sage300WebApi/v1.0/-/DAPDAT';

  const requests = [];
  const service = new CatalogStockService({
    client: {
      async get(url, options) {
        requests.push({ url, options });
        if (!url.endsWith('/IC/ICItems')) {
          const error = new Error('not found');
          error.response = { status: 404, data: { message: 'not found' } };
          throw error;
        }
        return {
          data: {
            value: [
              {
                ItemNumber: 'CP-15',
                UnformattedItemNumber: 'CP15',
                QuantityOnHand: '39',
              },
              { ItemNumber: 'BL-01', QuantityOnHand: '4' },
            ],
          },
        };
      },
    },
  });

  try {
    const rows = await service.fetchStock({ location: '1707S', prefix: 'CP' });

    assert.equal(requests.at(-1).url, 'http://sage.example/Sage300WebApi/v1.0/-/DAPDAT/IC/ICItems');
    assert.deepEqual(requests.at(-1).options.params, { $top: 1000 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ItemNumber, 'CP-15');
    assert.equal(rows[0].QuantityOnHand, 39);
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.SAGE_BASE_URL;
    } else {
      process.env.SAGE_BASE_URL = previousBaseUrl;
    }
  }
});
