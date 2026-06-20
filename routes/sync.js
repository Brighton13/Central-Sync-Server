const express = require('express');
const syncAuth = require('../middleware/syncAuth');
const { queueSyncEvent, SAGE_DISPATCH_QUEUE } = require('../services/syncEventQueueService');

const router = express.Router();

function getEventTerminalId(syncEvent) {
  const payload = syncEvent?.payload || {};
  return payload.terminal_id || payload.branch_id || null;
}

function serializeSyncEvent(syncEvent) {
  const plain = syncEvent.toJSON ? syncEvent.toJSON() : syncEvent;
  return {
    ...plain,
    branch_id: plain.payload?.branch_id || null,
    terminal_id: getEventTerminalId(plain),
    response_body: plain.response_payload || null,
    sage_response: plain.response_payload?.sageResponse || plain.response_payload?.responseBody || plain.response_payload?.data || null,
  };
}

function validateSyncEvent(body) {
  if (!body || typeof body !== 'object') {
    return 'Request body is required';
  }

  const requiredFields = ['event_type', 'aggregate_type', 'aggregate_id', 'store_id', 'idempotency_key', 'payload'];
  for (const field of requiredFields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      return `Missing required field: ${field}`;
    }
  }

  if (typeof body.payload !== 'object') {
    return 'payload must be an object';
  }

  return null;
}

router.post('/events', syncAuth, async (req, res) => {
  const validationError = validateSyncEvent(req.body);
  if (validationError) {
    return res.status(400).json({ message: validationError });
  }

  const models = req.app.locals.models;
  const payload = req.body;

  const [syncEvent, created] = await models.syncEvent.findOrCreate({
    where: { idempotency_key: payload.idempotency_key },
    defaults: {
      event_type: payload.event_type,
      aggregate_type: payload.aggregate_type,
      aggregate_id: String(payload.aggregate_id),
      store_id: Number(payload.store_id),
      user_id: payload.user_id == null ? null : Number(payload.user_id),
      receipt_number: payload.receipt_number || null,
      idempotency_key: payload.idempotency_key,
      payload: payload.payload,
      status: 'received',
      source_system: payload.source_system || 'pos-backend',
      received_at: new Date(),
    }
  });

  if (!created) {
    if (syncEvent.status !== 'completed' && syncEvent.status !== 'processing') {
      const retryJob = await queueSyncEvent(syncEvent);

      return res.status(202).json({
        success: true,
        accepted: true,
        duplicate: true,
        requeued: true,
        eventId: syncEvent.id,
        queue: SAGE_DISPATCH_QUEUE,
        jobId: retryJob.id,
        idempotencyKey: syncEvent.idempotency_key,
        event: serializeSyncEvent(syncEvent),
      });
    }

    return res.status(200).json({
      success: true,
      duplicate: true,
      eventId: syncEvent.id,
      status: syncEvent.status,
      idempotencyKey: syncEvent.idempotency_key,
      event: serializeSyncEvent(syncEvent),
    });
  }

  const job = await queueSyncEvent(syncEvent);

  return res.status(202).json({
    success: true,
    accepted: true,
    eventId: syncEvent.id,
    queue: SAGE_DISPATCH_QUEUE,
    jobId: job.id,
    idempotencyKey: syncEvent.idempotency_key,
    event: serializeSyncEvent(syncEvent),
  });
});

router.get('/events', syncAuth, async (req, res) => {
  const models = req.app.locals.models;
  const requestedLimit = Number(req.query.limit || 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 20)
    : 10;
  const includePayload = req.query.includePayload === 'true';
  const events = await models.syncEvent.findAll({
    attributes: includePayload
      ? undefined
      : { exclude: ['payload', 'response_payload'] },
    order: [['id', 'DESC']],
    limit,
  });

  return res.json({
    success: true,
    count: events.length,
    includePayload,
    events: events.map(serializeSyncEvent),
  });
});

module.exports = router;
