# Alerting & Monitoring Playbook

This note captures the baseline telemetry and alerting that should run continuously for the worker and queues. It supplements the existing operational docs and focuses on the two risk areas that have bitten us before: ingest queue backlogs and scheduled (cron) failures.

## Queue depth & ingestion latency

1. **Built-in queue metrics**
   * Cloudflare Queues exposes backlogs, in-flight counts, and delivery latencies via GraphQL/Observability. Create alerts in the Cloudflare dashboard with the following thresholds:
     * `backlog_size` ≥ 500 messages for 5 minutes (warning) and 2 000 messages for 2 minutes (critical).
     * `oldest_message_age` ≥ 90 seconds (warning) and 5 minutes (critical).
   * Alerts route to the Ops Slack channel via the existing webhook.

2. **Worker-side confirmation**
   * `handleQueueBatch` already logs to `ops_metrics`. Surface a Grafana panel that charts `duration_ms` grouped by route so the team can correlate CF queue metrics with our own processing times.
   * Add a lightweight scheduled probe (runs every 5 minutes) that calls `env.INGEST_Q.getBacklog()` and pushes the values into `ops_metrics` so we have historical data even if Cloudflare’s metrics lag.

3. **External watchdog**
   * A 2‑line GitHub Actions workflow (or a lightweight Fly.io cron) hits a new `/health/queue` endpoint that returns the backlog snapshot. Non‑200 responses or JSON values above the thresholds raise PagerDuty incidents. This protects us if Cloudflare’s native alerting regresses.

## Cron / scheduled job failures

1. **Cloudflare Scheduled Triggers health**
   * Use Cloudflare’s “Cron Triggers” analytics to alert if a trigger has `last_failure` within the previous run window or if `runs_expected - runs_executed ≥ 1`.
   * Configure two alerts: one warning when the 02:15 monthly report job slips by >10 minutes, and one critical if the 01:00 sweep job skips entirely.

2. **Worker instrumentation**
   * The scheduled handler already writes to `console.error` on failure; extend it to also `CONFIG.put('cron:last:<name>', ISO timestamp)`. Expose `/health/scheduled` to dump the timestamps.
   * The same external watchdog described above hits `/health/scheduled` every 10 minutes and raises PagerDuty if any `last` timestamp is older than 2× the expected cadence.

3. **Postmortem breadcrumbs**
   * Pipe worker logs into our Logpush dataset with filters on `baseline recompute error`, `monthly report generation failed`, and `fast burn monitor error`. Create a DataDog monitor that alerts if any of those occur more than twice in an hour.

## Runbook snippet

* Queue alert fires → check Cloudflare queue backlog chart → confirm worker `ops_metrics` durations → if backlog still growing after 10 minutes, pause new ingest and page the on-call engineer.
* Cron alert fires → hit `/health/scheduled` to identify the stale job → manually run `wrangler schedule run <name>` → if still failing, check Logpush entries for stack traces and involve the duty developer.

This setup gives us an automated path from detection to action without adding new dependencies, and keeps the feedback loops inside Cloudflare unless we need the external watchdog as a belt-and-braces fallback.
