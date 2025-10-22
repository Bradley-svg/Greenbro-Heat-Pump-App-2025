import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Env } from './types';

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

export async function generateCommissioningPDF(
  env: Env,
  payload: CommissioningPayload,
): Promise<{ key: string; url: string }> {
  const pdfDoc = await PDFDocument.create();
  let page = pdfDoc.addPage([595, 842]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const drawText = (text: string, x: number, y: number, size = 12) => {
    page.drawText(text, { x, y, size, font, color: rgb(0, 0, 0) });
  };

  let y = 800;
  drawText('GreenBro Commissioning Report', 40, y, 18);
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
      page = pdfDoc.addPage([595, 842]);
      y = 780;
    }
  }

  y -= 8;
  drawText('Checklist:', 40, y, 14);
  y -= 18;
  for (const item of payload.checklist) {
    drawText(`${item.passed ? '[✔]' : '[✖]'} ${item.step}${item.notes ? ` — ${item.notes}` : ''}`, 50, y);
    y -= 14;
    if (y < 60) {
      page = pdfDoc.addPage([595, 842]);
      y = 780;
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
  let page = pdfDoc.addPage([595, 842]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const drawText = (text: string, x: number, y: number, size = 12) => {
    page.drawText(text, { x, y, size, font });
  };

  let y = 800;
  drawText('GreenBro Monthly Report', 40, y, 18);
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

  const colX = [40, 220, 360, 480];
  drawText('Metric', colX[0], y);
  drawText('Target', colX[1], y);
  drawText('Actual', colX[2], y);
  drawText('Status', colX[3], y);
  y -= 14;
  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.5 });
  y -= 12;

  rows.forEach((row) => {
    if (y < 80) {
      page = pdfDoc.addPage([595, 842]);
      y = 780;
    }
    drawText(row.label, colX[0], y);
    drawText(row.target, colX[1], y);
    drawText(row.actual, colX[2], y);
    drawText(row.status, colX[3], y);
    y -= 16;
  });

  if (y < 140) {
    page = pdfDoc.addPage([595, 842]);
    y = 780;
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
        page = pdfDoc.addPage([595, 842]);
        y = 780;
      }
      drawText(alert.type, colX[0], y);
      drawText(alert.severity, colX[1], y);
      drawText(String(alert.count), colX[2], y);
      y -= 16;
    });
  }

  if (y < 120) {
    page = pdfDoc.addPage([595, 842]);
    y = 780;
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
          page = pdfDoc.addPage([595, 842]);
          y = 780;
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
