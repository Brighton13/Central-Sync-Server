# Central Sync Server

Collects sync events from multiple POS backends, persists them with idempotency control, queues them in BullMQ, and dispatches day-end Sage orders from a worker.

## What it does

- Accepts `POST /api/sync/events` from POS backends
- Deduplicates by `idempotency_key`
- Persists each accepted event in `sync_events`
- Enqueues BullMQ jobs in Redis
- Processes queued jobs in a worker
- Dispatches `day_end.ready` payloads to Sage OE Orders
- Dispatches `credit_note.created` payloads to Sage OE Orders for return handling
- Stores worker results and failures on the sync event row

## Supported events

- `sale.created`: staged and stored for audit/tracing
- `day_end.ready`: converted into a consolidated Sage OE Order request
- `credit_note.created`: converted into a Sage OE Order request for the original sale reversal

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

`GET /api/sync/events` omits large event and response payloads by default. Pass
`includePayload=true` only for focused diagnostics; the endpoint is capped at 20 rows.

## Production data-volume safeguards

- Incomplete events are recovered with keyset pagination in batches controlled by
  `SYNC_RECOVERY_BATCH_SIZE` (default `250`).
- Legacy raw-payload reconciliation is rejected with HTTP `413` before loading data when
  its event JSON exceeds `RECON_MAX_PAYLOAD_BYTES` (default `64 MiB`). Dashboard pages
  and Excel exports use normalized projections and are not constrained by raw JSON size.
- Excel exports scan normalized rows with keyset pagination controlled by
  `RECON_EXPORT_BATCH_SIZE` (default `1000`, bounded from `100` to `5000`).
- Database pool sizing is controlled by `DB_POOL_MAX`, `DB_POOL_MIN`,
  `DB_POOL_ACQUIRE_MS`, and `DB_POOL_IDLE_MS`.
- Required reconciliation range indexes are installed idempotently during startup.

### Normalized reconciliation projection

Dashboard summaries, Excel exports, and the sales, credit-note, and batch registers read from compact
`recon_batches`, `recon_sales`, and `recon_credit_notes` tables. New sync events update
these tables in the same transaction as ingestion. On the first upgraded startup, an
idempotent background backfill processes historical event JSON in batches controlled by
`RECON_BACKFILL_BATCH_SIZE` (default `25`). Reconciliation endpoints return HTTP `503`
until that first backfill is complete, while event ingestion and Sage processing remain
available.

## Auth

If `SYNC_SERVER_TOKEN` is set, requests must send:

`Authorization: Bearer <token>`

Reconciliation password endpoints:

- `POST /api/recon/auth/change-password` (Bearer token required)
- `POST /api/recon/auth/forgot-password` with `{ "email": "..." }`
- `POST /api/recon/auth/reset-password` with `{ "email": "...", "otp": "123456", "newPassword": "..." }`

OTP email requires `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and optionally
`SMTP_FROM`, `SMTP_SECURE`, `SMTP_TLS_REJECT_UNAUTHORIZED`, `COMPANY_NAME`,
`PASSWORD_RESET_OTP_TTL_MINUTES`, `PASSWORD_RESET_OTP_MAX_ATTEMPTS`,
`PASSWORD_RESET_OTP_RESEND_SECONDS`, and `PASSWORD_RESET_OTP_SECRET`.

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
