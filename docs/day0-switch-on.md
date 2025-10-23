# Day-0 Switch-On Micro-Plan

Fifteen-minute checklist to exercise the platform immediately after a fresh deploy.

1. **Preflight sanity**
   - Deploy to staging.
   - Call `GET /api/ops/readiness` with `DEV_AUTH_BYPASS=1` (or valid Access JWT).
   - Expect `{ "ok": true }` with all checks reporting `ok: true`.

2. **Read-only toggle**
   - Visit `/admin/settings` and enable the read-only flag.
   - Confirm the SSR `/ops` dashboard shows the auto-refresh banner and mutation attempts respond with HTTP 503.
   - Disable read-only mode and verify writes succeed again.

3. **Burn drill**
   - Seed a handful of synthetic 5xx rows into `ops_metrics` (or temporarily slow ingest) to trigger alerts.
   - Confirm the Slack P1 alert fires and the SPA surfaces the warning toast.
   - Restore normal ingest and ensure the alert auto-resolves.

4. **Reports smoke**
   - Request `/api/reports/preview-html?type=client-monthly&sample=1`.
   - Run `npm run axe:pdf` to validate accessibility budgets.
   - Generate a real client PDF and ensure the contrast budget passes.

5. **Archive verification**
   - Stage a CSV export with presets.
   - Download both the `.csv` and `.csv.gz` artifacts from the archive bucket.
   - Confirm `Content-Length` headers match the staged object sizes.
