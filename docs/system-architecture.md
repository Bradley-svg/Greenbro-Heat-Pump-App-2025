# System Architecture Overview

The Greenbro Heat Pump monitoring platform ingests telemetry from field devices, processes it through edge services, and surfaces data in user-facing applications. This document captures the high-level data flow and major platform components.

## Data Flow Summary

```
Devices ──(MQTT or HTTPS)──▶ Edge (WAF + API Shield + Access)
                               │
                               ├─► Ingest Worker  ──► Queues (buffer + fan-out)
                               │        │                ├─► Rollup Worker → D1 (hot) + R2 (cold)
                               │        │                └─► Alert Engine Worker → D1 alerts
                               │        └─► Durable Object (per-device session/state)
                               │
Frontend (Pages/Workers) ──────┴─► App/API Worker (RBAC, charts) → D1 (config + latest) + KV (flags)
                                           │
                                           └─► Analytics Engine (ops/SLOs)
Logs/metrics → Logpush → R2 (cheap retention)
Cron Triggers → housekeeping, JWT rotation, alert escalations
```

## Key Components

### Edge Protection Layer
- **Edge (WAF + API Shield + Access):** Secures inbound device traffic, enforcing API schema validation and access controls before requests reach the ingest services.

### Data Ingestion Pipeline
- **Ingest Worker:** Accepts MQTT or HTTPS payloads, normalizes device messages, and forwards them into the internal queuing layer.
- **Queues:** Provide durable buffering and fan-out to downstream processing workers.
- **Rollup Worker:** Aggregates high-frequency device metrics, persisting hot data to D1 and archiving cold data to R2.
- **Alert Engine Worker:** Evaluates incoming events against alerting policies and writes actionable alerts into D1 for fast retrieval.
- **Durable Objects:** Maintain per-device session and stateful context required for efficient, ordered processing.

### Application & Analytics Layer
- **Frontend (Pages/Workers):** Serves the operator UI and public API.
- **App/API Worker:** Implements RBAC, renders charts, and fetches configuration and latest device state from D1 while referencing feature flags stored in KV.
- **Analytics Engine:** Produces operational reports and SLO tracking based on aggregated data.

### Storage & Observability
- **D1:** Primary transactional store for hot telemetry, device configuration, latest state snapshots, and alert records.
- **R2:** Low-cost object storage for cold historical data and log retention.
- **KV:** Lightweight feature flag storage used by the App/API worker.
- **Logpush:** Streams logs and metrics into R2 for long-term retention.

### Automation & Maintenance
- **Cron Triggers:** Automate housekeeping tasks, JWT key rotation, and alert escalations.

## Operational Considerations

- Ensure MQTT clients are provisioned with appropriate certificates or tokens to pass through the Edge security layer.
- Monitor queue depths and worker health metrics to scale ingestion components proactively.
- D1 hot data retention policies should align with alert response requirements; schedule rollups to R2 accordingly.
- Review cron schedules regularly to confirm JWT rotation and escalations happen within compliance windows.

