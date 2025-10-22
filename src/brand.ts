import { rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export const brandCss = String.raw`
:root {
  --gb-primary-700: #2e9e3f;
  --gb-primary-500: #39b54a;
  --gb-primary-300: #6fdb7f;
  --gb-ink: #0b0e12;
  --gb-muted: #4b5563;
  --gb-muted-soft: #8f9aa6;
  --gb-bg: #04090d;
  --gb-panel: rgba(12, 20, 14, 0.75);
  --gb-panel-border: rgba(111, 219, 127, 0.18);
  --gb-card: #ffffff;
  --gb-card-border: rgba(46, 158, 63, 0.15);
  --gb-card-shadow: 0 28px 60px -40px rgba(11, 14, 18, 0.55);
  --gb-chip-bg: rgba(57, 181, 74, 0.12);
  --gb-chip-text: var(--gb-primary-700);
}

html,
body {
  background: radial-gradient(120% 120% at 50% 0%, rgba(57, 181, 74, 0.12) 0%, var(--gb-bg) 70%);
  color: var(--gb-ink);
}

body {
  font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.app-shell {
  background: radial-gradient(140% 140% at 50% -20%, rgba(111, 219, 127, 0.18) 0%, transparent 60%),
    linear-gradient(180deg, rgba(8, 12, 9, 0.9) 0%, rgba(4, 9, 13, 0.95) 100%);
  color: var(--gb-ink);
}

.app-sidebar {
  background: transparent;
  border-right: 1px solid var(--gb-panel-border);
  color: rgba(255, 255, 255, 0.92);
}

.app-brand .logo {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  display: block;
  box-shadow: 0 10px 24px -12px rgba(57, 181, 74, 0.6);
  background: linear-gradient(135deg, var(--gb-primary-700), var(--gb-primary-300));
  object-fit: cover;
}

.app-brand .brand {
  color: #ecf7ed;
  letter-spacing: 0.08em;
}

.app-nav__link {
  color: rgba(255, 255, 255, 0.72);
}

.app-nav__link:hover {
  background: rgba(57, 181, 74, 0.15);
  color: #ffffff;
}

.app-nav__link--active {
  background: rgba(57, 181, 74, 0.25);
  color: #eaffeb;
  box-shadow: inset 0 0 0 1px rgba(57, 181, 74, 0.25);
}

.app-main {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.94) 0%, rgba(244, 249, 246, 0.94) 60%, rgba(233, 244, 236, 0.9) 100%);
}

.app-topbar {
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid rgba(11, 14, 18, 0.08);
  box-shadow: 0 10px 30px -28px rgba(11, 14, 18, 0.75);
}

.app-topbar__title {
  color: var(--gb-ink);
}

.app-topbar__user-name {
  color: var(--gb-ink);
}

.app-topbar__user-roles {
  color: var(--gb-muted);
}

.card {
  background: var(--gb-card);
  border: 1px solid var(--gb-card-border);
  box-shadow: var(--gb-card-shadow);
  color: var(--gb-ink);
}

.card--error {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(254, 226, 226, 0.75);
}

.chip {
  background: var(--gb-chip-bg);
  color: var(--gb-chip-text);
  border: 1px solid rgba(57, 181, 74, 0.35);
  font-weight: 600;
}

.chip--active {
  background: var(--gb-primary-500);
  color: #ffffff;
  box-shadow: 0 12px 20px -18px rgba(11, 14, 18, 0.6);
}

.app-button,
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 18px;
  border-radius: 999px;
  border: 1px solid rgba(11, 14, 18, 0.1);
  background: rgba(11, 14, 18, 0.04);
  color: var(--gb-ink);
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.2s ease;
}

.app-button:hover,
.btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 14px 28px -20px rgba(11, 14, 18, 0.55);
  background: rgba(11, 14, 18, 0.08);
}

.app-button:disabled,
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.app-button--primary,
.btn-primary,
.primary-cta {
  background: linear-gradient(95deg, var(--gb-primary-700) 0%, var(--gb-primary-300) 100%);
  border-color: rgba(57, 181, 74, 0.3);
  color: #041205;
  box-shadow: 0 20px 32px -22px rgba(57, 181, 74, 0.8);
}

.app-button--primary:hover,
.btn-primary:hover,
.primary-cta:hover {
  background: linear-gradient(95deg, var(--gb-primary-700) -10%, var(--gb-primary-300) 100%);
}

.status-pill {
  background: rgba(57, 181, 74, 0.12);
  color: var(--gb-primary-700);
  border: 1px solid rgba(57, 181, 74, 0.3);
}

.status-pill--negative {
  color: #b4231a;
  background: rgba(244, 63, 94, 0.12);
  border-color: rgba(244, 63, 94, 0.32);
}

.status-pill--warning {
  color: #b45309;
  background: rgba(251, 191, 36, 0.16);
  border-color: rgba(251, 191, 36, 0.34);
}

.ro-pill {
  background: rgba(57, 181, 74, 0.12);
  color: var(--gb-primary-700);
  border: 1px solid rgba(57, 181, 74, 0.3);
  transition: transform 0.15s ease, box-shadow 0.2s ease;
}

.ro-pill--locked {
  background: rgba(244, 63, 94, 0.12);
  color: #b4231a;
  border-color: rgba(244, 63, 94, 0.32);
}

.ro-pill--unlocked {
  background: rgba(57, 181, 74, 0.12);
  color: var(--gb-primary-700);
}

.ro-pill--interactive:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 12px 20px -18px rgba(11, 14, 18, 0.5);
}

.auth-screen {
  background: radial-gradient(120% 120% at 50% 10%, rgba(57, 181, 74, 0.25) 0%, var(--gb-bg) 60%);
}

:focus-visible {
  outline: 3px solid var(--gb-primary-500);
  outline-offset: 3px;
}

@media (prefers-contrast: more) {
  .app-nav__link,
  .card,
  .chip,
  .status-pill,
  .ro-pill {
    border-color: rgba(57, 181, 74, 0.6) !important;
  }

  .app-button,
  .btn {
    box-shadow: none !important;
    background: rgba(57, 181, 74, 0.18);
    border-color: rgba(57, 181, 74, 0.7);
  }

  .app-button--primary,
  .btn-primary,
  .primary-cta {
    box-shadow: none !important;
    border-color: rgba(57, 181, 74, 0.8);
  }
}

@media (forced-colors: active) {
  :root {
    --gb-primary-700: Highlight;
    --gb-primary-500: Highlight;
    --gb-primary-300: Highlight;
    --gb-ink: CanvasText;
    --gb-muted: GrayText;
    --gb-card: Canvas;
    --gb-card-border: ButtonText;
    --gb-panel-border: ButtonText;
  }

  .app-brand .logo {
    box-shadow: none;
  }

  .app-brand .brand {
    color: ButtonText;
  }

  .app-nav__link--active {
    background: Highlight;
    color: HighlightText;
  }

  .app-button,
  .btn {
    background: ButtonFace;
    color: ButtonText;
    border: 1px solid ButtonText;
    box-shadow: none;
  }

  .app-button--primary,
  .btn-primary,
  .primary-cta {
    background: Highlight;
    color: HighlightText;
    border-color: Highlight;
    box-shadow: none;
  }

  .ro-pill,
  .chip,
  .status-pill {
    border: 1px solid ButtonText;
  }
}
`;

export const brandLogoSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="gb-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2e9e3f" />
      <stop offset="100%" stop-color="#6fdb7f" />
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="#04090d" />
  <path d="M18 46c-2-3-3-7-3-14 0-11 6-20 17-20 9 0 14 6 14 14 0 7-4 12-10 12-4 0-7-2-8-5h-3c1 7 6 12 14 12 9 0 16-7 16-17 0-10-7-19-19-19-14 0-23 11-23 25 0 7 2 12 5 15z" fill="url(#gb-gradient)" />
</svg>`;

type BrandEmailOptions = {
  title: string;
  introLines?: string[];
  detailLines?: string[];
  footerLines?: string[];
  cta?: { href: string; label: string };
  previewText?: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function brandEmail(options: BrandEmailOptions): string {
  const { title, introLines = [], detailLines = [], footerLines = [], cta, previewText } = options;
  const inlineLogo = `data:image/svg+xml,${encodeURIComponent(brandLogoSvg)}`;
  const introMarkup = introLines
    .map((line) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#e9f9ec;">${escapeHtml(line)}</p>`)
    .join('');
  const detailMarkup =
    detailLines.length > 0
      ? `<ul style="margin:0 0 18px;padding:0;list-style:none;">
          ${detailLines
            .map(
              (line) =>
                `<li style="margin:0 0 8px;padding:10px 12px;border-radius:10px;background:rgba(57,181,74,0.12);color:#b8e8c0;font-size:14px;">${escapeHtml(line)}</li>`,
            )
            .join('')}
        </ul>`
      : '';
  const footerMarkup = footerLines
    .map(
      (line) =>
        `<p style="margin:0 0 8px;font-size:12px;color:rgba(233,249,236,0.65);">${escapeHtml(line)}</p>`,
    )
    .join('');
  const ctaMarkup = cta
    ? `<div style="margin:18px 0 12px;">
        <a href="${escapeHtml(cta.href)}" style="display:inline-block;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600;background:linear-gradient(95deg,#2e9e3f 0%,#6fdb7f 100%);color:#041205;">${escapeHtml(cta.label)}</a>
      </div>`
    : '';

  const preview = previewText || introLines[0] || title;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charSet="utf-8" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:24px;background:#04090d;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <span style="display:none!important;color:transparent;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preview)}</span>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:rgba(12,20,14,0.92);border:1px solid rgba(111,219,127,0.25);border-radius:18px;box-shadow:0 32px 60px -40px rgba(8,12,9,0.85);padding:32px;">
            <tr>
              <td style="text-align:center;padding-bottom:12px;">
                <img src="${inlineLogo}" alt="GreenBro" width="48" height="48" style="display:block;margin:0 auto;border-radius:16px;" />
              </td>
            </tr>
            <tr>
              <td style="text-align:center;">
                <h1 style="margin:0 0 16px;font-size:24px;color:#e9f9ec;">${escapeHtml(title)}</h1>
              </td>
            </tr>
            <tr>
              <td>
                ${introMarkup}
                ${detailMarkup}
                ${ctaMarkup}
                ${footerMarkup}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function drawBrandPdfHeader(page: PDFPage, font: PDFFont, title: string): number {
  const { width, height } = page.getSize();
  const barHeight = 72;
  page.drawRectangle({ x: 0, y: height - barHeight, width, height: barHeight, color: rgb(0.18, 0.62, 0.3) });
  page.drawRectangle({
    x: 0,
    y: height - barHeight + 40,
    width,
    height: 12,
    color: rgb(0.43, 0.86, 0.49),
  });
  page.drawText('GreenBro Control Center', {
    x: 40,
    y: height - 34,
    size: 14,
    font,
    color: rgb(0.05, 0.12, 0.07),
  });
  page.drawText(`${title} — Devices`, {
    x: 40,
    y: height - 52,
    size: 18,
    font,
    color: rgb(0.05, 0.12, 0.07),
  });
  return height - barHeight - 32;
}
