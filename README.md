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
npm run dev
```

The dev server relies on bindings configured in `wrangler.toml`. Populate the stub IDs and provide secrets (e.g. `ACCESS_JWKS_URL`, `ACCESS_AUD`) with `wrangler secret put ...` before invoking authenticated routes.

