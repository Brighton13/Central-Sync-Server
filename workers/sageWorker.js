const { Worker } = require('bullmq');
const { connectionOptions } = require('../config/redis');
const { SAGE_DISPATCH_QUEUE } = require('../queues/syncQueues');
const EventDispatchService = require('../services/eventDispatchService');

function createSageWorker(models) {
  const dispatchService = new EventDispatchService(models);

  return new Worker(
    SAGE_DISPATCH_QUEUE,
    async (job) => {
      const syncEvent = await models.syncEvent.findByPk(job.data.syncEventId);
      if (!syncEvent) {
        throw new Error(`Sync event ${job.data.syncEventId} not found`);
      }

      await syncEvent.update({
        status: 'processing',
        last_attempt_at: new Date(),
        queue_job_id: String(job.id),
      });

      try {
        const result = await dispatchService.dispatch(syncEvent);
        await syncEvent.update({
          status: 'completed',
          processed_at: new Date(),
          last_error: null,
          response_payload: result,
        });
        return result;
      } catch (error) {
        const retryCount = (syncEvent.retry_count || 0) + 1;

        await syncEvent.update({
          status: 'queued',
          retry_count: retryCount,
          last_error: error.message,
          response_payload: error.response?.data || { message: error.message },
          last_attempt_at: new Date(),
          queued_at: new Date(),
        });

        throw error;
      }
    },
    {
      connection: connectionOptions,
      concurrency: Number(process.env.WORKER_CONCURRENCY || 2),
    }
  );
}

module.exports = {
  createSageWorker,
};
