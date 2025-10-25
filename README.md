# Greenbro Heat Pump Platform

This repository documents the cloud architecture that powers the Greenbro heat pump monitoring and analytics platform. Device telemetry is collected through secure edge services, processed by a series of Cloudflare Workers, and surfaced in operator-facing applications.

For a detailed explanation of the end-to-end data flow, see [docs/system-architecture.md](docs/system-architecture.md).
Controller telemetry and command contracts are documented in [docs/controller-api.md](docs/controller-api.md).
Device provisioning steps and CLI helpers are covered in [docs/device-provisioning.md](docs/device-provisioning.md).
Cloudflare resource bindings, Queue names, and Zero Trust settings are catalogued in [docs/cloudflare-config.md](docs/cloudflare-config.md).

## Cloudflare Worker service

The `src/app.ts` worker exposes endpoints that receive device telemetry, queue write-side commands, and surface the latest device state for authenticated operators.

### Endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/health` | Lightweight DB connectivity probe. |
| `POST` | `/api/ingest/:profileId` | Accepts normalized telemetry payloads for a device profile and pushes them onto the ingest queue. |
| `GET` | `/api/devices/:id/latest` | Returns the latest readings stored in D1 (requires Cloudflare Access JWT). |
| `POST` | `/api/devices/:id/write` | Validates and queues operator-issued setpoint adjustments (requires Cloudflare Access JWT). |

Queue batches are processed within the same worker to hydrate D1 hot tables and maintain per-device durable objects. This keeps telemetry ingestion and command orchestration close to the edge.

### Local development

```bash
npm install
npx playwright install --with-deps chromium

# One-time resource provisioning
wrangler d1 create GREENBRO_DB
wrangler kv namespace create CONFIG
wrangler r2 bucket create greenbro-reports
wrangler queues create ingest-q

# Paste generated IDs into wrangler.toml

# Apply database schema
npm run migrate

# Configure worker secrets
wrangler secret put ACCESS_JWKS_URL
wrangler secret put ACCESS_AUD
wrangler secret put WRITE_MIN_C
wrangler secret put WRITE_MAX_C
wrangler secret put JWT_SECRET

# Start the local dev server
npm run dev
```

The dev server relies on bindings configured in `wrangler.toml`. Populate the stub IDs emitted by the resource provisioning commands above and provide secrets (e.g. `ACCESS_JWKS_URL`, `ACCESS_AUD`) with `wrangler secret put ...` before invoking authenticated routes.

### Seeding initial data

After running the migrations, seed the `settings` table so local and staging environments have an operator account, baseline thresholds, and live integrations.

#### Auth users

1. Create a seed file that contains the bootstrap operator(s). The worker hashes any `password` field the first time it loads the record, so you can store a plain text bootstrap secret or pre-compute a SHA-256 hash in `password_hash`.
   ```bash
   cat <<'SQL' > seed-auth-users.sql
   INSERT INTO settings (key, value, updated_at)
   VALUES (
     'auth_users',
     json('[
       {"id":"ops-admin","email":"ops@greenbro.example","name":"Ops Admin","roles":["admin","ops"],"password":"changeme"}
     ]'),
     datetime('now')
   )
   ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;
   SQL
   wrangler d1 execute GREENBRO_DB --file seed-auth-users.sql
   ```
2. Repeat the `json(...)` array to add additional users with `roles` (`admin`, `ops`, `client`, `contractor`) and optional `clientIds` assignments.

#### Platform settings & webhooks

Populate the configuration keys that power commissioning checks, readiness gates, email/webhook delivery, and dashboard copy. Adjust the values to match your environment.

```bash
cat <<'SQL' > seed-settings.sql
INSERT INTO settings (key, value, updated_at) VALUES
  ('deploy_color', 'green', datetime('now')),
  ('deploy_readiness_enabled', '1', datetime('now')),
  ('deploy_readiness_msg', 'ready for rollout', datetime('now')),
  ('ops_webhook_url', 'https://hooks.slack.com/services/XXXX/YYYY/ZZZZ', datetime('now')),
  ('email_webhook_url', 'https://hooks.slack.com/services/AAAA/BBBB/CCCC', datetime('now')),
  ('email_from', 'reports@greenbro.example', datetime('now')),
  ('commissioning_delta_t_min', '5', datetime('now')),
  ('commissioning_flow_min_lpm', '6', datetime('now')),
  ('commissioning_cop_min', '2.2', datetime('now')),
  ('commissioning_report_recipients', 'qa@greenbro.example,ops@greenbro.example', datetime('now')),
  ('baseline_cov_warn', '0.60', datetime('now')),
  ('baseline_cov_crit', '0.40', datetime('now')),
  ('baseline_drift_warn', '0.8', datetime('now')),
  ('baseline_drift_crit', '1.5', datetime('now')),
  ('baseline_dwell_s', '600', datetime('now')),
  ('baseline_cov_warn_cop', '0.60', datetime('now')),
  ('baseline_cov_crit_cop', '0.40', datetime('now')),
  ('baseline_drift_warn_cop', '0.15', datetime('now')),
  ('baseline_drift_crit_cop', '0.30', datetime('now')),
  ('baseline_cov_warn_current', '0.60', datetime('now')),
  ('baseline_cov_crit_current', '0.40', datetime('now')),
  ('baseline_drift_warn_current', '1.0', datetime('now')),
  ('baseline_drift_crit_current', '2.0', datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;
SQL
wrangler d1 execute GREENBRO_DB --file seed-settings.sql
```

Keep the webhook URLs in sync with Slack (or your chosen destination) and rotate them alongside the secrets stored in Cloudflare.

### Cloudflare Access roles

The worker trusts Cloudflare Access JWTs for browser sessions and API calls. Configure the Access application so that issued tokens include:

1. A shared audience/issuer pair that matches `ACCESS_AUD` / `ACCESS_ISS` bindings.
2. A `roles` claim that maps to the role names consumed by the worker (`admin`, `ops`, `client`, `contractor`). Add Access groups for each role and inject them via the `roles` array (or a custom namespace like `https://greenbro/roles`).
3. Optional `clients` claim listing customer IDs the principal can access; these populate `clientIds` for RBAC filtering.

Once Access is configured, the bootstrap credentials in `auth_users` are only required for local development or fallback entry points.

### Operational notes

* **Cloudflare Access JWTs** - In Cloudflare Zero Trust, add both the dashboard and this API as Access applications that share the same audience (AUD). When requests pass through Access, the worker automatically reads the token from the `Cf-Access-Jwt-Assertion` header.
* **API Shield** - Once an OpenAPI schema exists for these endpoints, enable schema validation on `/api/*` to reject malformed telemetry before it reaches the worker.
* **Telemetry precision** - The consumer rounds temperatures to `0.1 degC` and power/COP values to `0.01`. Adjust the rounding logic in `src/queue.ts` if the charts require a different precision.
* **Rollups & retention** - Consider adding a secondary consumer or a cron-triggered worker to aggregate one-minute rollups and archive telemetry older than 90 days to the `greenbro-reports` R2 bucket. The SQL schema separates `latest_state` (fast reads) from `telemetry` (history) to support this.
* **Release gate parity** - Use `npm run dev:gate` to start `wrangler dev` alongside the Vite preview server (`npm run -w apps/web preview`) just like the CI release gate workflow. Run Playwright checks from a separate shell once both services report ready.
* **Worker bundle size** - After `npm run build`, execute `npm run worker:size` to confirm no generated module exceeds Cloudflare's 1&nbsp;MiB limit. The command lists each module's size and fails if a file crosses the threshold, prompting additional code splitting.
* **Post-migration seeding** - Immediately after `wrangler d1 migrations apply`, run `npm run seed:ops -- --database GREENBRO_DB --config ops-seed.json` (see [docs/post-migration-seed.md](docs/post-migration-seed.md)) to hydrate alert webhooks, commissioning thresholds, SLO contacts, and Access bindings.


## Alerts & Commissioning Enhancements

1. Apply the new migrations:
   ```bash
   wrangler d1 migrations create GREENBRO_DB --name 002_alerts
   wrangler d1 migrations create GREENBRO_DB --name 003_sites
   # paste the SQL from `migrations/002_alerts.sql` and `migrations/003_sites.sql` into the generated files or copy them directly
   wrangler d1 migrations apply GREENBRO_DB
   ```
2. Rebuild and deploy:
   ```bash
   npm run build
   wrangler deploy
   ```
3. Core APIs:
   - `GET /api/alerts`
   - `POST /api/alerts/:id/ack`
   - `POST /api/alerts/:id/resolve`
   - `POST /api/alerts/:id/comment` with `{ "body": "..." }`
   - `GET /api/devices`
   - `GET|POST|DELETE /api/admin/sites`
   - `GET|POST|DELETE /api/admin/site-clients`
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
         { "step": "Delta T under load", "passed": true, "notes": "4.9 degC" }
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
   - `GET /` - KPI overview cards
   - `GET /alerts` - Server-rendered alerts table with live refresh
   - `GET /devices` - Server-rendered device roster with live refresh
   - `GET /admin/sites` - Admin surface for site catalog and site+client mapping
