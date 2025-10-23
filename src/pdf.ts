import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Env } from './types/env';
import { BRAND, drawBrandPdfHeader } from './brand';

export type CommissioningPayload = {
  deviceId: string;
  site?: string;
  performedBy: string;
  ts: string;
  checklist: Array<{ step: string; passed: boolean; notes?: string }>;
  measurements: Record<string, string | number>;
};

export type ClientMonthlyReportPayload = {
  clientId: string;
  clientName: string;
  monthLabel: string;
  monthKey: string;
  periodStart: string;
  periodEnd: string;
  siteCount: number;
  deviceCount: number;
  metrics: {
    uptimePct: number | null;
    ingestSuccessPct: number | null;
    avgCop: number | null;
    alerts: Array<{ type: string; severity: string; count: number }>;
  };
  targets: {
    uptimeTarget?: number | null;
    ingestTarget?: number | null;
    copTarget?: number | null;
  };
  recipients?: string | null;
};

export type IncidentReportV2Payload = {
  siteId: string;
  siteName?: string | null;
  region?: string | null;
  windowLabel: string;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  summary: {
    severities: Array<{ severity: string; count: number }>;
    topDevices: Array<{ deviceId: string; openCount: number }>;
  };
  incidents: Array<{
    incidentId: string;
    startedAt: string;
    resolvedAt: string | null;
    lastAlertAt: string | null;
    stateCounts: Record<string, number>;
    alertBreakdown: Array<{ type: string; severity: string; count: number }>;
  }>;
  maintenance: Array<{
    siteId?: string | null;
    deviceId?: string | null;
    startTs: string;
    endTs: string | null;
    reason?: string | null;
  }>;
};

export async function generateCommissioningPDF(
  env: Env,
  payload: CommissioningPayload,
): Promise<{ key: string; url: string }> {
  const pdfDoc = await PDFDocument.create();
  const pageSize: [number, number] = [595, 842];
  let page = pdfDoc.addPage(pageSize);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const textColor = rgb(65 / 255, 64 / 255, 66 / 255);

  const drawText = (text: string, x: number, y: number, size = 12) => {
    page.drawText(text, { x, y, size, font, color: textColor });
  };

  const resetPage = () => {
    page = pdfDoc.addPage(pageSize);
    return drawBrandPdfHeader(page, font, 'Commissioning Report');
  };

  let y = drawBrandPdfHeader(page, font, 'Commissioning Report', { includeSlogan: true });
  drawText(`${BRAND.product} — Commissioning Report`, 40, y, 18);
  y -= 24;
  drawText(`Device: ${payload.deviceId}`, 40, y);
  y -= 16;
  if (payload.site) {
    drawText(`Site: ${payload.site}`, 40, y);
    y -= 16;
  }
  drawText(`Performed by: ${payload.performedBy}`, 40, y);
  y -= 16;
  drawText(`Timestamp (UTC): ${payload.ts}`, 40, y);
  y -= 24;

  drawText('Measurements:', 40, y, 14);
  y -= 18;
  for (const [k, v] of Object.entries(payload.measurements)) {
    drawText(`${k}: ${v}`, 50, y);
    y -= 14;
    if (y < 80) {
      y = resetPage();
    }
  }

  y -= 8;
  drawText('Checklist:', 40, y, 14);
  y -= 18;
  for (const item of payload.checklist) {
    drawText(`${item.passed ? '[✔]' : '[✖]'} ${item.step}${item.notes ? ` — ${item.notes}` : ''}`, 50, y);
    y -= 14;
    if (y < 60) {
      y = resetPage();
    }
  }

  const bytes = await pdfDoc.save();
  const key = `commissioning/${payload.deviceId}/${payload.ts.replace(/[:]/g, '-')}.pdf`;

  await env.REPORTS.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });

  return { key, url: `/api/reports/${encodeURIComponent(key)}` };
}

function pct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

function fmt(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export async function generateClientMonthlyReport(
  env: Env,
  payload: ClientMonthlyReportPayload,
): Promise<{ key: string; url: string }> {
  const pdfDoc = await PDFDocument.create();
  const pageSize: [number, number] = [595, 842];
  let page = pdfDoc.addPage(pageSize);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const textColor = rgb(65 / 255, 64 / 255, 66 / 255);

  const drawText = (text: string, x: number, y: number, size = 12) => {
    page.drawText(text, { x, y, size, font, color: textColor });
  };

  const resetPage = () => {
    page = pdfDoc.addPage(pageSize);
    return drawBrandPdfHeader(page, font, 'Monthly Report');
  };

  let y = drawBrandPdfHeader(page, font, 'Monthly Report', { includeSlogan: true });
  drawText(`${BRAND.product} — Monthly Report`, 40, y, 18);
  y -= 24;
  drawText(`Client: ${payload.clientName} (${payload.clientId})`, 40, y);
  y -= 16;
  drawText(`Period: ${payload.monthLabel}`, 40, y);
  y -= 16;
  drawText(`Window: ${payload.periodStart} → ${payload.periodEnd}`, 40, y);
  y -= 16;
  drawText(`Sites covered: ${payload.siteCount} · Devices: ${payload.deviceCount}`, 40, y);
  y -= 24;

  drawText('Targets vs Actuals', 40, y, 14);
  y -= 18;

  const rows: Array<{ label: string; target: string; actual: string; status: string }> = [
    {
      label: 'Uptime',
      target: pct(payload.targets.uptimeTarget ?? null, 2),
      actual: pct(payload.metrics.uptimePct, 2),
      status:
        payload.metrics.uptimePct == null || payload.targets.uptimeTarget == null
          ? 'n/a'
          : payload.metrics.uptimePct >= payload.targets.uptimeTarget
            ? '✅ Met'
            : '⚠️ Miss',
    },
    {
      label: 'Ingest success',
      target: pct(payload.targets.ingestTarget ?? null, 2),
      actual: pct(payload.metrics.ingestSuccessPct, 2),
      status:
        payload.metrics.ingestSuccessPct == null || payload.targets.ingestTarget == null
          ? 'n/a'
          : payload.metrics.ingestSuccessPct >= payload.targets.ingestTarget
            ? '✅ Met'
            : '⚠️ Miss',
    },
    {
      label: 'Average COP',
      target: fmt(payload.targets.copTarget ?? null, 2),
      actual: fmt(payload.metrics.avgCop, 2),
      status:
        payload.metrics.avgCop == null || payload.targets.copTarget == null
          ? 'n/a'
          : payload.metrics.avgCop >= payload.targets.copTarget
            ? '✅ Met'
            : '⚠️ Miss',
    },
  ];

  const colX = [40, 220, 360, 480] as const;
  drawText('Metric', colX[0], y);
  drawText('Target', colX[1], y);
  drawText('Actual', colX[2], y);
  drawText('Status', colX[3], y);
  y -= 14;
  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.5 });
  y -= 12;

  rows.forEach((row) => {
    if (y < 80) {
      y = resetPage();
      drawText('Metric', colX[0], y);
      drawText('Target', colX[1], y);
      drawText('Actual', colX[2], y);
      drawText('Status', colX[3], y);
      y -= 14;
      page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.5 });
      y -= 12;
    }
    drawText(row.label, colX[0], y);
    drawText(row.target, colX[1], y);
    drawText(row.actual, colX[2], y);
    drawText(row.status, colX[3], y);
    y -= 16;
  });

  if (y < 140) {
    y = resetPage();
  }

  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.5 });
  y -= 18;
  drawText('Alert breakdown', 40, y, 14);
  y -= 18;

  const alerts = payload.metrics.alerts;
  if (alerts.length === 0) {
    drawText('No alerts recorded during this period.', 40, y);
    y -= 16;
  } else {
    drawText('Type', colX[0], y);
    drawText('Severity', colX[1], y);
    drawText('Count', colX[2], y);
    y -= 14;
    page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.5 });
    y -= 12;
    alerts.forEach((alert) => {
      if (y < 60) {
        y = resetPage();
        drawText('Type', colX[0], y);
        drawText('Severity', colX[1], y);
        drawText('Count', colX[2], y);
        y -= 14;
        page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.5 });
        y -= 12;
      }
      drawText(alert.type, colX[0], y);
      drawText(alert.severity, colX[1], y);
      drawText(String(alert.count), colX[2], y);
      y -= 16;
    });
  }

  if (y < 120) {
    y = resetPage();
  }

  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.5 });
  y -= 18;
  drawText('Recipients', 40, y, 14);
  y -= 18;
  if (payload.recipients) {
    const lines = payload.recipients.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    if (lines.length === 0) {
      drawText('No recipients configured.', 40, y);
      y -= 16;
    } else {
      lines.forEach((line) => {
        if (y < 50) {
          y = resetPage();
        }
        drawText(`• ${line}`, 40, y);
        y -= 14;
      });
    }
  } else {
    drawText('No recipients configured.', 40, y);
    y -= 16;
  }

  y -= 10;
  drawText(`Generated at: ${new Date().toISOString()}`, 40, y, 10);

  const bytes = await pdfDoc.save();
  const key = `client-reports/${payload.clientId}/${payload.monthKey}.pdf`;

  await env.REPORTS.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });

  return { key, url: `/api/reports/${encodeURIComponent(key)}` };
}

export async function generateIncidentReportV2(
  env: Env,
  payload: IncidentReportV2Payload,
): Promise<{ key: string; url: string }> {
  const pdfDoc = await PDFDocument.create();
  const pageSize: [number, number] = [595, 842];
  let page = pdfDoc.addPage(pageSize);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const textColor = rgb(65 / 255, 64 / 255, 66 / 255);

  const resetPage = () => {
    page = pdfDoc.addPage(pageSize);
    return drawBrandPdfHeader(page, font, 'Incident Report');
  };

  const ensureSpace = (minY: number) => {
    if (minY < 0) {
      return;
    }
    if (y < minY) {
      y = resetPage();
    }
  };

  const drawText = (text: string, x = 40, size = 12, lineGap = 6) => {
    if (y < 60) {
      y = resetPage();
    }
    page.drawText(text, { x, y, size, font, color: textColor });
    y -= size + lineGap;
  };

  const drawSectionTitle = (title: string) => {
    ensureSpace(120);
    drawText(title, 40, 14);
  };

  const summarizeStateCounts = (stateCounts: Record<string, number>) => {
    const entries = Object.entries(stateCounts).filter(([, value]) => Number.isFinite(value) && value > 0);
    if (entries.length === 0) {
      return 'States: none recorded';
    }
    return `States: ${entries
      .map(([state, value]) => `${state}: ${value}`)
      .join(', ')}`;
  };

  let y = drawBrandPdfHeader(page, font, 'Incident Report', { includeSlogan: true });
  const siteLabel = payload.siteName ? `${payload.siteName} (${payload.siteId})` : payload.siteId;
  drawText(`${BRAND.product} — Incident Report`, 40, 18);
  drawText(`Site: ${siteLabel}`);
  drawText(`Region: ${payload.region ?? '—'}`);
  drawText(`Window: ${payload.windowLabel}`);
  drawText(`Range: ${payload.windowStart} → ${payload.windowEnd}`);
  y -= 6;
  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 1 });
  y -= 12;

  drawSectionTitle('Alert snapshot');
  if (payload.summary.severities.length === 0) {
    drawText('• No open alerts by severity in this window.');
  } else {
    payload.summary.severities.forEach((row) => {
      drawText(`• ${row.severity}: ${row.count}`);
    });
  }

  y -= 2;
  if (payload.summary.topDevices.length > 0) {
    drawText('Top devices by open alerts:', 40, 12);
    payload.summary.topDevices.forEach((device) => {
      drawText(`• ${device.deviceId}: ${device.openCount} open`);
    });
  } else {
    drawText('No devices with open alerts in this window.');
  }

  y -= 4;
  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.5 });
  y -= 12;

  drawSectionTitle('Incidents during window');
  if (payload.incidents.length === 0) {
    drawText('No incidents intersecting this window.');
  } else {
    payload.incidents.forEach((incident) => {
      ensureSpace(100);
      drawText(`Incident ${incident.incidentId}`, 40, 13);
      drawText(`• Started: ${incident.startedAt}`);
      drawText(`• Last alert: ${incident.lastAlertAt ?? '—'}`);
      drawText(`• Resolved: ${incident.resolvedAt ?? 'Open'}`);
      drawText(`• ${summarizeStateCounts(incident.stateCounts)}`);
      if (incident.alertBreakdown.length > 0) {
        drawText('• Alerts:', 40, 12);
        incident.alertBreakdown.forEach((row) => {
          drawText(`    - ${row.type} (${row.severity}): ${row.count}`);
        });
      }
      y -= 4;
    });
  }

  y -= 4;
  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.5 });
  y -= 12;

  drawSectionTitle('Maintenance windows');
  if (payload.maintenance.length === 0) {
    drawText('No maintenance windows recorded.');
  } else {
    payload.maintenance.forEach((row) => {
      ensureSpace(80);
      const scope = row.deviceId
        ? `Device ${row.deviceId}`
        : row.siteId
          ? `Site ${row.siteId}`
          : 'Global';
      drawText(`• ${scope}`);
      drawText(`  Window: ${row.startTs} → ${row.endTs ?? 'ongoing'}`);
      drawText(`  Reason: ${row.reason?.trim() ? row.reason : '—'}`);
      y -= 4;
    });
  }

  y -= 8;
  drawText(`Generated at: ${payload.generatedAt}`, 40, 10, 4);

  const bytes = await pdfDoc.save();
  const key = `reports/incident_${payload.siteId}_${Date.now()}_v2.pdf`;
  await env.REPORTS.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });

  return { key, url: `/api/reports/${encodeURIComponent(key)}` };
}
