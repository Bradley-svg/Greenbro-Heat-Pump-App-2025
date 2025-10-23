# GreenBro Control Centre

The Control Centre offers live devices visibility so operators can spot outages, triage incidents, and dispatch field teams quickly. Each module reflects the same datasets exposed in the SPA, matching the real-time API responses.

## Overview (Devices)

- **KPI strip:** Highlights online device percentage, average COP, low-ΔT counts, and heartbeat freshness with clear traffic-light bands.
- **Incident focus:** One-tap filters surface open critical incidents, mirroring the Guard logic in the web alerts page.
- **Maps & lists:** Device clusters, mobile cards, and compact tables reuse the shared overview hooks so counts stay consistent wherever you view them.

## Usage notes

- `/overview` serves the desktop layout with map, sparklines, and per-region filters.
- `/m` renders the compact dashboard for on-call engineers who need touch-friendly tap targets.
- Run `npm run copy-guard` before shipping docs or UI copy to ensure British terminology stays intact.
