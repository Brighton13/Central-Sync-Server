const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getTillIdentityFromPayload,
  getTillSyncStatus,
} = require('../services/tillRegistryService');

test('getTillIdentityFromPayload resolves branch and terminal IDs from event payloads', () => {
  assert.deepEqual(getTillIdentityFromPayload({
    payload: { branch_id: ' 049 ', terminal_id: ' T01 ' },
  }), {
    branchId: '049',
    terminalId: 'T01',
  });

  assert.deepEqual(getTillIdentityFromPayload({ branch_id: '001' }), {
    branchId: '001',
    terminalId: '001',
  });
});

test('getTillSyncStatus marks known tills by current-day sync activity', async () => {
  const models = {
    knownTill: {
      findAll: async () => [
        {
          toJSON: () => ({
            id: 1,
            branch_id: '001',
            terminal_id: 'T01',
            terminal_name: 'Front till',
            store_id: 7,
            source: 'manual',
            active: true,
            last_sync_at: new Date('2026-07-16T09:00:00+02:00'),
            last_sync_event_id: 10,
            last_event_type: 'day_end.ready',
            createdAt: null,
            updatedAt: null,
          }),
        },
        {
          toJSON: () => ({
            id: 2,
            branch_id: '001',
            terminal_id: 'T02',
            terminal_name: null,
            store_id: 7,
            source: 'manual',
            active: true,
            last_sync_at: new Date('2026-07-15T21:00:00+02:00'),
            last_sync_event_id: 9,
            last_event_type: 'day_end.ready',
            createdAt: null,
            updatedAt: null,
          }),
        },
      ],
    },
  };

  const status = await getTillSyncStatus(models, { now: new Date('2026-07-16T20:00:00+02:00') });

  assert.equal(status.summary.totalTerminals, 2);
  assert.equal(status.summary.syncedCount, 1);
  assert.equal(status.summary.missingCount, 1);
  assert.equal(status.terminals[0].terminalId, 'T02');
  assert.equal(status.terminals[0].sentToday, false);
  assert.equal(status.terminals[1].terminalId, 'T01');
  assert.equal(status.terminals[1].sentToday, true);
});
