import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Env } from '../types/env';

type SessionRow = {
  session_id: string;
  device_id: string;
  site_id: string | null;
  operator_sub: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  notes: string | null;
};

type StepRow = {
  step_id: string;
  title: string;
  state: string;
  readings_json: string | null;
  updated_at?: string | null;
};

type StoredPdf = { key: string; size: number };

type ReportBucket = {
  put: (key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) => Promise<void>;
};

export async function renderCommissioningPdf(env: Env, session_id: string): Promise<StoredPdf> {
  const db = env.DB;
  const session = await db
    .prepare('SELECT * FROM commissioning_sessions WHERE session_id=?')
    .bind(session_id)
    .first<SessionRow>();

  if (!session) {
    throw new Error(`Session ${session_id} not found`);
  }

  const stepsRes = await db
    .prepare(
      'SELECT step_id,title,state,readings_json,updated_at FROM commissioning_steps WHERE session_id=? ORDER BY updated_at',
    )
    .bind(session_id)
    .all<StepRow>();

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const green = rgb(0.13, 0.82, 0.41);

  let page = pdf.addPage([595, 842]);
  let y = 800;

  const drawHeader = () => {
    page.drawText('Greenbro Commissioning Report', { x: 40, y, size: 18, font, color: green });
    y -= 24;
    page.drawText(
      `Device: ${session.device_id}   Site: ${session.site_id ?? '—'}   Operator: ${session.operator_sub}`,
      { x: 40, y, size: 10, font },
    );
    y -= 18;
    page.drawText(
      `Started: ${session.started_at}   Finished: ${session.finished_at ?? '—'}   Outcome: ${session.status}`,
      { x: 40, y, size: 10, font },
    );
    y -= 22;
    page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 1, color: green });
    y -= 16;
  };

  drawHeader();

  const stepRows = (stepsRes?.results ?? []) as StepRow[];
  for (const step of stepRows) {
    if (y < 100) {
      page = pdf.addPage([595, 842]);
      y = 800;
      drawHeader();
    }
    const state = step.state?.toUpperCase() ?? 'PENDING';
    page.drawText(`• ${step.title} — ${state}`, { x: 52, y, size: 11, font });
    y -= 14;
    if (step.readings_json) {
      page.drawText(step.readings_json, { x: 64, y, size: 9, font });
      y -= 12;
    }
  }

  const bytes = await pdf.save();
  const key = `commissioning/${session_id}.pdf`;
  const bucket = env.REPORTS as ReportBucket;
  await bucket.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
  return { key, size: bytes.byteLength };
}
