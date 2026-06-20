const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { recoverIncompleteEvents } = require('../services/syncEventQueueService');

test('recoverIncompleteEvents reads and queues records in bounded keyset batches', async () => {
  const previousBatchSize = process.env.SYNC_RECOVERY_BATCH_SIZE;
  process.env.SYNC_RECOVERY_BATCH_SIZE = '2';

  const sourceRows = [1, 2, 3, 4, 5].map((id) => ({ id, event_type: 'day_end.ready', status: 'queued' }));
  const queriedAfterIds = [];
  const queuedIds = [];

  const models = {
    syncEvent: {
      async findAll(options) {
        const afterId = options.where.id[Op.gt];
        queriedAfterIds.push(afterId);
        return sourceRows
          .filter((row) => row.id > afterId)
          .slice(0, options.limit);
      },
    },
  };

  try {
    const count = await recoverIncompleteEvents(models, async (event) => {
      queuedIds.push(event.id);
    });

    assert.equal(count, 5);
    assert.deepEqual(queuedIds, [1, 2, 3, 4, 5]);
    assert.deepEqual(queriedAfterIds, [0, 2, 4, 5]);
  } finally {
    if (previousBatchSize === undefined) {
      delete process.env.SYNC_RECOVERY_BATCH_SIZE;
    } else {
      process.env.SYNC_RECOVERY_BATCH_SIZE = previousBatchSize;
    }
  }
});
