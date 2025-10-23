import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { WHITE_LOGO_SVG } from '../shared/brand';
import type { Env } from '../types/env';

export async function embedLogo(pdf: PDFDocument, fetcher: typeof fetch = fetch) {
  try {
    const response = await fetcher('/brand/logo-white.svg');
    if (response?.ok) {
      const svgBuffer = await response.arrayBuffer();
      return await pdf.embedSvg(svgBuffer);
    }
  } catch {
    /* ignore network issues */
  }

  try {
    const fallback = new TextEncoder().encode(WHITE_LOGO_SVG);
    return await pdf.embedSvg(fallback);
  } catch {
    return null;
  }
}

export async function renderDeviceLabels(
  env: Env,
  opts: { device_id: string; site_id?: string | null; profile?: string | null },
) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const green = rgb(0.13, 0.82, 0.41);
  let y = 720;

  const logoImg = await embedLogo(pdf);

  for (let i = 0; i < 4; i++) {
    page.drawRectangle({ x: 40, y, width: 515, height: 120, borderColor: green, borderWidth: 1 });
    page.drawText('Greenbro Heat Pump', { x: 52, y: y + 96, size: 14, font, color: green });
    page.drawText(`Device ID: ${opts.device_id}`, { x: 52, y: y + 76, size: 11, font });
    page.drawText(`Site: ${opts.site_id ?? '—'}`, { x: 52, y: y + 60, size: 10, font });
    page.drawText(`Profile: ${opts.profile ?? '—'}`, { x: 52, y: y + 44, size: 10, font });
    page.drawText('Support: ops@greenbro.example', {
      x: 52,
      y: y + 28,
      size: 10,
      font,
      color: rgb(0.62, 0.69, 0.75),
    });
    page.drawText(`View: https://app.greenbro.example/devices/${opts.device_id}`, {
      x: 52,
      y: y + 12,
      size: 9,
      font,
      color: rgb(0.62, 0.69, 0.75),
    });
    if (logoImg) {
      page.drawImage(logoImg, { x: 430, y: y + 78, width: 100, height: 26 });
    }
    y -= 160;
  }

  const bytes = await pdf.save();
  const key = `labels/${opts.device_id}-${Date.now()}.pdf`;
  await env.REPORTS.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
  return { key, size: bytes.byteLength };
}
