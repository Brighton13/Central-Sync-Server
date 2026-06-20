const { Op } = require('sequelize');
const { sageDispatchQueue, SAGE_DISPATCH_QUEUE } = require('../queues/syncQueues');

function buildQueueJobId(syncEventId) {
  return `sync-event-${syncEventId}`;
}

async function queueSyncEvent(syncEvent) {
  const jobId = buildQueueJobId(syncEvent.id);
  let job = await sageDispatchQueue.getJob(jobId);

  if (job) {
    const state = await job.getState();
    const isActive = ['waiting', 'active', 'delayed', 'paused'].includes(state);

    if (!isActive) {
      try {
        await job.remove();
      } catch (removeError) {
        console.warn(`Failed to remove old job ${jobId} in state ${state}:`, removeError?.message || removeError);
      }
      job = null;
    }
  }

  if (!job) {
    job = await sageDispatchQueue.add(syncEvent.event_type, {
      syncEventId: syncEvent.id,
    }, {
      jobId,
    });
  }

  await syncEvent.update({
    status: 'queued',
    queue_name: SAGE_DISPATCH_QUEUE,
    queue_job_id: String(job.id),
    queued_at: new Date(),
  });

  return job;
}

async function recoverIncompleteEvents(models, queueEvent = queueSyncEvent) {
  const batchSize = Math.min(Math.max(Number(process.env.SYNC_RECOVERY_BATCH_SIZE || 250), 1), 1000);
  let lastId = 0;
  let recoveredCount = 0;

  while (true) {
    const events = await models.syncEvent.findAll({
      where: {
        id: { [Op.gt]: lastId },
        status: {
          [Op.in]: ['received', 'queued', 'failed', 'dead_letter'],
        },
      },
      attributes: ['id', 'event_type', 'status'],
      order: [['id', 'ASC']],
      limit: batchSize,
    });

    if (events.length === 0) {
      break;
    }

    for (const syncEvent of events) {
      await queueEvent(syncEvent);
      lastId = syncEvent.id;
      recoveredCount += 1;
    }

    console.log(`[syncRecovery] recovered ${recoveredCount} event(s); lastId=${lastId}`);
  }

  return recoveredCount;
}

module.exports = {
  SAGE_DISPATCH_QUEUE,
  buildQueueJobId,
  queueSyncEvent,
  recoverIncompleteEvents,
};
