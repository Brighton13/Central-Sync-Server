const test = require('node:test');
const assert = require('node:assert/strict');
const SageInternalUsageService = require('../services/sage/createSageInternalUsage');

test('stock zero-out posts a Sage internal usage with the POS document reference', async () => {
  let capturedUrl = null;
  let capturedBody = null;
  const service = new SageInternalUsageService({
    client: {
      post: async (url, body) => {
        capturedUrl = url;
        capturedBody = body;
        return { data: { TransactionNumber: 42 } };
      },
    },
  });

  const result = await service.createStockReturn({
    document_number: 'ZOUT-1001-1780000000000',
    date: '2026-08-19',
    sage_location: '1001',
    actor: 'Manager',
    items: [
      {
        product_code: 'CP001',
        product_name: 'Test Product',
        category: 'General',
        quantity: 5,
      },
    ],
  });

  assert.match(capturedUrl, /\/IC\/ICInternalUsages$/);
  assert.equal(capturedBody.Reference, 'ZOUT-1001-1780000000000');
  assert.equal(capturedBody.EntryType, 'InternalUsage');
  assert.equal(capturedBody.EnteredBy, 'Manager');
  assert.equal(capturedBody.InternalUsageDetails[0].ItemNumber, 'CP001');
  assert.equal(capturedBody.InternalUsageDetails[0].Location, '1001');
  assert.equal(capturedBody.InternalUsageDetails[0].Quantity, 5);
  assert.equal('Category' in capturedBody.InternalUsageDetails[0], false);
  assert.equal(result.success, true);
  assert.equal(result.transactionNumber, 42);
  assert.equal(result.returnedQuantity, 5);
});

test('duplicate stock zero-out is success only when the Sage document can be verified', async () => {
  const service = new SageInternalUsageService({
    client: {
      post: async () => {
        const error = new Error('Request failed with status code 409');
        error.response = { status: 409, data: { message: 'already exists' } };
        throw error;
      },
      get: async () => ({
        data: {
          value: [{ TransactionNumber: 77, Reference: 'ZOUT-VERIFY' }],
        },
      }),
    },
  });

  const result = await service.createStockReturn({
    document_number: 'ZOUT-VERIFY',
    sage_location: '1707S',
    items: [{ product_code: 'CP-15', product_name: 'Tinnies', quantity: 1 }],
  });

  assert.equal(result.success, true);
  assert.equal(result.idempotent, true);
  assert.equal(result.transactionNumber, 77);
});

test('unverified duplicate stock zero-out remains failed for reconciliation', async () => {
  const service = new SageInternalUsageService({
    client: {
      post: async () => {
        const error = new Error('Request failed with status code 409');
        error.response = { status: 409, data: { message: 'already exists' } };
        throw error;
      },
      get: async () => ({ data: { value: [] } }),
    },
  });

  await assert.rejects(
    () =>
      service.createStockReturn({
        document_number: 'ZOUT-MISSING',
        sage_location: '1707S',
        items: [{ product_code: 'CP-15', product_name: 'Tinnies', quantity: 1 }],
      }),
    (error) => {
      assert.match(error.sageErrorPayload?.message, /no matching document/i);
      return true;
    },
  );
});
