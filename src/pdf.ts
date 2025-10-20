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
