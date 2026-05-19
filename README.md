# Central Sync Server

Collects sync events from multiple POS backends, persists them with idempotency control, queues them in BullMQ, and dispatches day-end Sage orders from a worker.

## What it does

- Accepts `POST /api/sync/events` from POS backends
- Deduplicates by `idempotency_key`
- Persists each accepted event in `sync_events`
- Enqueues BullMQ jobs in Redis
- Processes queued jobs in a worker
- Dispatches `day_end.ready` payloads to Sage OE Orders
- Stores worker results and failures on the sync event row

## Supported events

- `sale.created`: staged and stored for audit/tracing
- `day_end.ready`: converted into a consolidated Sage OE Order request

## Required services

- MySQL-compatible database for `sync_events`
- Redis for BullMQ
- Sage API reachable from this server

## Setup

1. Copy `.env.example` to `.env`
2. Set database, Redis, Sage, and token values
3. Install dependencies with `npm install`
4. Start with `npm run dev` or `npm start`

## Main endpoints

- `GET /health`
- `POST /api/sync/events`
- `GET /api/sync/events`

## Auth

If `SYNC_SERVER_TOKEN` is set, requests must send:

`Authorization: Bearer <token>`

## Expected ingest payload

```json
{
  "event_type": "day_end.ready",
  "aggregate_type": "day_end",
  "aggregate_id": 20260511,
  "store_id": 1,
  "user_id": 4,
  "receipt_number": null,
  "idempotency_key": "day_end.ready:store-1:date-2026-05-11",
  "payload": {
    "date": "2026-05-11",
    "store_id": 1,
    "sales_count": 10,
    "sales": []
  }
}
```
