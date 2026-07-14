const { Worker } = require('bullmq');
const axios = require('axios');
const { connectionOptions } = require('../config/redis');
const { SAGE_DISPATCH_QUEUE } = require('../queues/syncQueues');
const EventDispatchService = require('../services/eventDispatchService');

const callbackUrl = String(process.env.POS_BACKEND_CALLBACK_URL || '').replace(/\/$/, '');
const callbackToken = String(process.env.POS_BACKEND_CALLBACK_TOKEN || process.env.SYNC_SERVER_TOKEN || '').trim();

async function notifyPosBackend(syncEvent, result) {
  if (!callbackUrl || !callbackToken) {
    return;
  }

  try {
    await axios.post(
      `${callbackUrl}/api/sync/status`,
      {
        event_type: syncEvent.event_type,
        aggregate_type: syncEvent.aggregate_type,
        aggregate_id: syncEvent.aggregate_id,
        store_id: syncEvent.store_id,
        idempotency_key: syncEvent.idempotency_key,
        status: 'accepted',
        response_payload: result,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${callbackToken}`,
        },
        timeout: 15000,
      }
    );
  } catch (error) {
    console.error('Failed to notify POS backend of accepted sync event:', {
      eventId: syncEvent.id,
      error: error.message,
      response: error.response?.data || null,
    });
  }
}

function createSageWorker(models) {
  console.log('[sageWorker] initializing Sage worker');
  const dispatchService = new EventDispatchService(models);

  return new Worker(
    SAGE_DISPATCH_QUEUE,
    async (job) => {
      console.log(`[sageWorker] starting job ${job.id} for syncEventId=${job.data.syncEventId}`);
      const syncEvent = await models.syncEvent.findByPk(job.data.syncEventId);
      if (!syncEvent) {
        console.warn(`[sageWorker] stale job ${job.id}: syncEventId=${job.data.syncEventId} not found. Completing job without retry.`);
        return {
          success: false,
          message: `sync event ${job.data.syncEventId} not found`,
        };
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

        await notifyPosBackend(syncEvent, result);

        return result;
      } catch (error) {
        const retryCount = (syncEvent.retry_count || 0) + 1;
        const sageErrorPayload = error.sageErrorPayload || error.response?.data || { message: error.message };
        const lastError = error.sageErrorPayload?.sageMessage
          || error.response?.data?.error?.message
          || error.response?.data?.message
          || error.message;

        await syncEvent.update({
          status: 'queued',
          retry_count: retryCount,
          last_error: typeof lastError === 'string' ? lastError : error.message,
          response_payload: sageErrorPayload,
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
  )
    .on('error', (error) => {
      console.error('[sageWorker] worker error:', error?.message || error);
    });
}

module.exports = {
  createSageWorker,
};
