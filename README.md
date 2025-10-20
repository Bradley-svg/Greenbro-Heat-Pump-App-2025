# Greenbro Heat Pump Platform

This repository documents the cloud architecture that powers the Greenbro heat pump monitoring and analytics platform. Device telemetry is collected through secure edge services, processed by a series of Cloudflare Workers, and surfaced in operator-facing applications.

For a detailed explanation of the end-to-end data flow, see [docs/system-architecture.md](docs/system-architecture.md).

## Cloudflare Worker service

The `src/app.ts` worker exposes endpoints that receive device telemetry, queue write-side commands, and surface the latest device state for authenticated operators.

### Endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/health` | Lightweight DB connectivity probe. |
| `POST` | `/v1/telemetry` | Accepts normalized telemetry payloads from devices and pushes them onto the ingest queue. |
| `GET` | `/v1/devices/:id/latest` | Returns the latest readings stored in D1 (requires Cloudflare Access JWT). |
| `GET` | `/v1/devices/:id/state` | Proxy to the device durable object's cached state (requires Cloudflare Access JWT). |
| `POST` | `/v1/devices/:id/setpoint` | Validates and queues operator-issued setpoint adjustments (requires Cloudflare Access JWT). |

Queue batches are processed within the same worker to hydrate D1 hot tables and maintain per-device durable objects. This keeps telemetry ingestion and command orchestration close to the edge.

### Local development

```bash
npm install

# One-time resource provisioning
wrangler d1 create GREENBRO_DB
wrangler kv namespace create CONFIG
wrangler r2 bucket create greenbro-reports
wrangler queues create greenbro-ingest

# Paste generated IDs into wrangler.toml

# Apply database schema
npm run migrate

# Configure worker secrets
wrangler secret put ACCESS_JWKS_URL
wrangler secret put ACCESS_AUD
wrangler secret put WRITE_MIN_C
wrangler secret put WRITE_MAX_C

# Start the local dev server
npm run dev
```

The dev server relies on bindings configured in `wrangler.toml`. Populate the stub IDs emitted by the resource provisioning commands above and provide secrets (e.g. `ACCESS_JWKS_URL`, `ACCESS_AUD`) with `wrangler secret put ...` before invoking authenticated routes.

### Operational notes

* **Cloudflare Access JWTs** – In Cloudflare Zero Trust, add both the dashboard and this API as Access applications that share the same audience (AUD). When requests pass through Access, the worker automatically reads the token from the `Cf-Access-Jwt-Assertion` header.
* **API Shield** – Once an OpenAPI schema exists for these endpoints, enable schema validation on `/api/*` to reject malformed telemetry before it reaches the worker.
* **Telemetry precision** – The consumer rounds temperatures to `0.1 °C` and power/COP values to `0.01`. Adjust the rounding logic in `src/queue.ts` if the charts require a different precision.
* **Rollups & retention** – Consider adding a secondary consumer or a cron-triggered worker to aggregate one-minute rollups and archive telemetry older than 90 days to the `greenbro-reports` R2 bucket. The SQL schema separates `latest_state` (fast reads) from `telemetry` (history) to support this.


## Alerts & Commissioning Enhancements

1. Apply the new migration:
   ```bash
   wrangler d1 migrations create GREENBRO_DB --name 002_alerts
   # paste `migrations/002_alerts.sql` into the generated file or copy it directly
   wrangler d1 migrations apply GREENBRO_DB
   ```
2. Rebuild and deploy:
   ```bash
   npm run build
   wrangler deploy
   ```
3. Core alert APIs:
   - `GET /api/alerts`
   - `POST /api/alerts/:id/ack`
   - `POST /api/alerts/:id/resolve`
   - `POST /api/alerts/:id/comment` with `{ "body": "..." }`
4. Generate a commissioning PDF and store it in R2:
   ```bash
   curl -X POST https://<worker>/api/commissioning/GBR-HP-12345/report \
     -H 'Content-Type: application/json' \
     -d '{
       "performedBy": "alice@greenbro.co.za",
       "ts": "2025-10-20T10:00:00Z",
       "site": "Cape Town POC",
       "checklist": [
         { "step": "Sensors sane", "passed": true },
         { "step": "ΔT under load", "passed": true, "notes": "4.9°C" }
       ],
       "measurements": {
         "supplyC": 49.8,
         "returnC": 44.9,
         "flowLps": 0.23,
         "cop": 2.24
       }
     }'
   ```
5. SSR dashboard routes:
   - `GET /` – KPI overview cards
   - `GET /alerts` – Server-rendered alerts table with live refresh
