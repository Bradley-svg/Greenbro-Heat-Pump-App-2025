import type { Env } from './types';
import type { ClientMonthlyReportPayload, IncidentReportV2Payload } from './pdf';
import { BRAND } from './brand';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return escapeHtml(value);
    }
    return escapeHtml(date.toISOString());
  } catch {
    return escapeHtml(value);
  }
}

function renderSeveritySummary(payload: IncidentReportV2Payload): string {
  if (payload.summary.severities.length === 0) {
    return '<p>No open alerts by severity in this window.</p>';
  }
  const rows = payload.summary.severities
    .map(
      (row) =>
        `<tr><th scope="row">${escapeHtml(row.severity)}</th><td>${escapeHtml(row.count)}</td></tr>`,
    )
    .join('');
  return `
    <table class="report-table">
      <caption>Open alerts by severity</caption>
      <thead>
        <tr><th scope="col">Severity</th><th scope="col">Count</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderTopDevices(payload: IncidentReportV2Payload): string {
  if (payload.summary.topDevices.length === 0) {
    return '<p>No devices with open alerts in this window.</p>';
  }
  const items = payload.summary.topDevices
    .map(
      (device) =>
        `<li><span class="device-id">${escapeHtml(device.deviceId)}</span> — ${escapeHtml(device.openCount)} open alerts</li>`,
    )
    .join('');
  return `<ul class="report-list">${items}</ul>`;
}

function renderIncidentRow(incident: IncidentReportV2Payload['incidents'][number]): string {
  const states = Object.entries(incident.stateCounts)
    .map(([state, count]) => `${escapeHtml(state)}: ${escapeHtml(count)}`)
    .join(', ');
  const stateLine = states ? states : 'States: none recorded';
  const alerts = incident.alertBreakdown.length
    ? `<ul>${incident.alertBreakdown
        .map(
          (row) =>
            `<li>${escapeHtml(row.type)} (${escapeHtml(row.severity)}): ${escapeHtml(row.count)}</li>`,
        )
        .join('')}</ul>`
    : '<p>No alerts recorded for this incident.</p>';
  return `
    <article class="incident-card">
      <h3>Incident ${escapeHtml(incident.incidentId)}</h3>
      <dl>
        <div><dt>Started</dt><dd>${formatDate(incident.startedAt)}</dd></div>
        <div><dt>Last alert</dt><dd>${formatDate(incident.lastAlertAt)}</dd></div>
        <div><dt>Resolved</dt><dd>${formatDate(incident.resolvedAt)}</dd></div>
        <div><dt>States</dt><dd>${escapeHtml(stateLine)}</dd></div>
      </dl>
      <section>
        <h4>Alert breakdown</h4>
        ${alerts}
      </section>
    </article>
  `;
}

function renderMaintenanceRows(rows: IncidentReportV2Payload['maintenance']): string {
  if (rows.length === 0) {
    return '<p>No maintenance windows recorded in this period.</p>';
  }
  const items = rows
    .map((row) => {
      const scope = row.deviceId
        ? `Device ${escapeHtml(row.deviceId)}`
        : row.siteId
          ? `Site ${escapeHtml(row.siteId)}`
          : 'Global';
      return `
        <tr>
          <td>${scope}</td>
          <td>${formatDate(row.startTs)}</td>
          <td>${formatDate(row.endTs)}</td>
          <td>${escapeHtml(row.reason ?? '—')}</td>
        </tr>
      `;
    })
    .join('');
  return `
    <table class="report-table">
      <caption>Maintenance windows</caption>
      <thead>
        <tr><th scope="col">Scope</th><th scope="col">Start</th><th scope="col">End</th><th scope="col">Reason</th></tr>
      </thead>
      <tbody>${items}</tbody>
    </table>
  `;
}

export function renderIncidentHtmlV2(_env: Env, payload: IncidentReportV2Payload): string {
  const severity = renderSeveritySummary(payload);
  const devices = renderTopDevices(payload);
  const incidents =
    payload.incidents.length > 0
      ? payload.incidents.map((incident) => renderIncidentRow(incident)).join('')
      : '<p>No incidents intersect this reporting window.</p>';
  const maintenance = renderMaintenanceRows(payload.maintenance);
  const siteLabel = payload.siteName ? `${payload.siteName} (${payload.siteId})` : payload.siteId;

  return `
    <main class="report incident-report" aria-labelledby="incident-report-title">
      <header class="report-header" style="
        background: var(--gb-report-header-bg);
        color: var(--gb-report-header-fg);
        border-bottom: 1px solid rgba(255,255,255,.06);
      ">
        <h1 id="incident-report-title">Incident report</h1>
        <p class="report-meta"><strong style="color: var(--gb-report-header-accent);">Site:</strong> ${escapeHtml(siteLabel)}</p>
        <p class="report-meta"><strong style="color: var(--gb-report-header-accent);">Region:</strong> ${escapeHtml(payload.region ?? '—')}</p>
        <p class="report-meta"><strong style="color: var(--gb-report-header-accent);">Window:</strong> ${escapeHtml(payload.windowLabel)}</p>
        <p class="report-meta"><strong style="color: var(--gb-report-header-accent);">Range:</strong> ${formatDate(payload.windowStart)} → ${formatDate(payload.windowEnd)}</p>
        <p class="report-meta"><strong style="color: var(--gb-report-header-accent);">Generated at:</strong> ${formatDate(payload.generatedAt)}</p>
      </header>
      <section aria-labelledby="incident-summary-heading">
        <h2 id="incident-summary-heading">Alert snapshot</h2>
        ${severity}
        <section aria-labelledby="incident-top-devices-heading">
          <h3 id="incident-top-devices-heading">Top devices by open alerts</h3>
          ${devices}
        </section>
      </section>
      <section aria-labelledby="incident-list-heading">
        <h2 id="incident-list-heading">Incidents during window</h2>
        ${incidents}
      </section>
      <section aria-labelledby="incident-maintenance-heading">
        <h2 id="incident-maintenance-heading">Maintenance windows</h2>
        ${maintenance}
      </section>
      <footer class="report-footer" style="
        background: var(--gb-report-footer-bg);
        color: var(--gb-report-footer-fg);
      ">
        <p><strong style="color: var(--gb-report-header-accent);">${BRAND.product}</strong> · Automated incident summary</p>
        <p>Questions? Contact your ${BRAND.name} operations team.</p>
      </footer>
    </main>
  `;
}

function fmtPercent(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

function fmtNumber(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return Number(value).toFixed(digits);
}

export function renderClientMonthlyHtmlV2(_env: Env, payload: ClientMonthlyReportPayload): string {
  const alerts = payload.metrics.alerts.length
    ? payload.metrics.alerts
        .map(
          (row) =>
            `<tr><td>${escapeHtml(row.type)}</td><td>${escapeHtml(row.severity)}</td><td>${escapeHtml(row.count)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="3">No alerts recorded for this period.</td></tr>';

  return `
    <main class="report monthly-report" aria-labelledby="monthly-report-title">
      <header class="report-header" style="
        background: var(--gb-report-header-bg);
        color: var(--gb-report-header-fg);
        border-bottom: 1px solid rgba(255,255,255,.06);
      ">
        <h1 id="monthly-report-title">Monthly performance report</h1>
        <p class="report-meta"><strong style="color: var(--gb-report-header-accent);">Client:</strong> ${escapeHtml(payload.clientName)} (${escapeHtml(payload.clientId)})</p>
        <p class="report-meta"><strong style="color: var(--gb-report-header-accent);">Period:</strong> ${escapeHtml(payload.monthLabel)}</p>
        <p class="report-meta"><strong style="color: var(--gb-report-header-accent);">Window:</strong> ${formatDate(payload.periodStart)} → ${formatDate(payload.periodEnd)}</p>
        <p class="report-meta"><strong style="color: var(--gb-report-header-accent);">Sites:</strong> ${escapeHtml(payload.siteCount)} · <strong style="color: var(--gb-report-header-accent);">Devices:</strong> ${escapeHtml(payload.deviceCount)}</p>
      </header>
      <section aria-labelledby="monthly-targets-heading">
        <h2 id="monthly-targets-heading">Targets vs actuals</h2>
        <table class="report-table">
          <thead>
            <tr><th scope="col">Metric</th><th scope="col">Target</th><th scope="col">Actual</th><th scope="col">Status</th></tr>
          </thead>
          <tbody>
            <tr><th scope="row">Uptime</th><td>${fmtPercent(payload.targets.uptimeTarget)}</td><td>${fmtPercent(payload.metrics.uptimePct)}</td><td>${renderStatus(payload.metrics.uptimePct, payload.targets.uptimeTarget)}</td></tr>
            <tr><th scope="row">Ingest success</th><td>${fmtPercent(payload.targets.ingestTarget)}</td><td>${fmtPercent(payload.metrics.ingestSuccessPct)}</td><td>${renderStatus(payload.metrics.ingestSuccessPct, payload.targets.ingestTarget)}</td></tr>
            <tr><th scope="row">Average COP</th><td>${fmtNumber(payload.targets.copTarget)}</td><td>${fmtNumber(payload.metrics.avgCop)}</td><td>${renderStatus(payload.metrics.avgCop, payload.targets.copTarget)}</td></tr>
          </tbody>
        </table>
      </section>
      <section aria-labelledby="monthly-alerts-heading">
        <h2 id="monthly-alerts-heading">Alert breakdown</h2>
        <table class="report-table">
          <thead>
            <tr><th scope="col">Type</th><th scope="col">Severity</th><th scope="col">Count</th></tr>
          </thead>
          <tbody>${alerts}</tbody>
        </table>
      </section>
      <footer class="report-footer" style="
        background: var(--gb-report-footer-bg);
        color: var(--gb-report-footer-fg);
      ">
        <p><strong style="color: var(--gb-report-header-accent);">${BRAND.product}</strong> · Monthly performance insights</p>
        <p>Questions? Contact your ${BRAND.name} operations team.</p>
      </footer>
    </main>
  `;
}

function renderStatus(actual: number | null | undefined, target: number | null | undefined): string {
  if (actual == null || target == null || !Number.isFinite(actual) || !Number.isFinite(target)) {
    return 'n/a';
  }
  return actual >= target ? '✅ Met' : '⚠️ Miss';
}

export function sampleIncidentReportV2Payload(): IncidentReportV2Payload {
  const now = new Date();
  const start = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  return {
    siteId: 'SITE-001',
    siteName: 'Demo Site',
    region: 'Cape Town',
    windowLabel: 'Last 6 hours',
    windowStart: start.toISOString(),
    windowEnd: now.toISOString(),
    generatedAt: now.toISOString(),
    summary: {
      severities: [
        { severity: 'critical', count: 1 },
        { severity: 'major', count: 2 },
        { severity: 'minor', count: 4 },
      ],
      topDevices: [
        { deviceId: 'HP-1001', openCount: 3 },
        { deviceId: 'HP-2042', openCount: 2 },
      ],
    },
    incidents: [
      {
        incidentId: 'INC-100',
        startedAt: start.toISOString(),
        lastAlertAt: now.toISOString(),
        resolvedAt: null,
        stateCounts: { open: 2, ack: 1 },
        alertBreakdown: [
          { type: 'High discharge temp', severity: 'critical', count: 1 },
          { type: 'Sensor offline', severity: 'major', count: 2 },
        ],
      },
    ],
    maintenance: [
      {
        siteId: 'SITE-001',
        deviceId: 'HP-2042',
        startTs: new Date(start.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        endTs: new Date(start.getTime() - 60 * 60 * 1000).toISOString(),
        reason: 'Filter replacement',
      },
    ],
  };
}

export function sampleClientMonthlyReportPayload(): ClientMonthlyReportPayload {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const label = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return {
    clientId: 'CLIENT-001',
    clientName: 'Demo Client',
    monthLabel: label,
    monthKey: label,
    periodStart: start.toISOString(),
    periodEnd: new Date(end.getTime() - 1).toISOString(),
    siteCount: 5,
    deviceCount: 42,
    metrics: {
      uptimePct: 0.987,
      ingestSuccessPct: 0.994,
      avgCop: 3.6,
      alerts: [
        { type: 'Sensor offline', severity: 'major', count: 3 },
        { type: 'Low COP', severity: 'minor', count: 5 },
      ],
    },
    targets: {
      uptimeTarget: 0.98,
      ingestTarget: 0.99,
      copTarget: 3.2,
    },
    recipients: 'ops@demo.invalid',
  };
}
