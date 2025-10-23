// tools/contrast-budget.mjs
// ESM, Node ≥18
import fs from 'node:fs';

const CSS_CANDIDATES = [
  './worker/brand.css',
  './server/brand.css',
  './apps/web/src/components/brand.css', // fallback
];

function loadCss() {
  for (const p of CSS_CANDIDATES) {
    try {
      return { css: fs.readFileSync(p, 'utf8'), path: p };
    } catch {}
  }
  throw new Error('brand.css not found in expected locations');
}

function parseVars(css) {
  // naive --var: value; extractor
  const re = /--([a-z0-9\-]+)\s*:\s*([^;]+);/gi;
  const map = new Map();
  let m;
  while ((m = re.exec(css))) {
    map.set(`--${m[1]}`, m[2].trim());
  }
  // one-level var() resolution
  function resolve(v) {
    const varRef = v.match(/var\((--[a-z0-9\-]+)\)/i);
    if (varRef && map.has(varRef[1])) return resolve(map.get(varRef[1]));
    return v;
  }
  for (const [k, v] of map) map.set(k, resolve(v));
  return map;
}

function hexToRgb(s) {
  const m = s.trim().match(/^#?([a-f0-9]{6}|[a-f0-9]{3})$/i);
  if (!m) return null;
  const h = m[1].length === 3
    ? m[1].split('').map((x) => x + x).join('')
    : m[1];
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function relLum({ r, g, b }) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const R = f(r);
  const G = f(g);
  const B = f(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
function contrastRatio(fgHex, bgHex) {
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);
  if (!fg || !bg) return 0;
  const L1 = relLum(fg);
  const L2 = relLum(bg);
  const [hi, lo] = L1 >= L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

// --- Load & check ---
const { css, path: cssPath } = loadCss();
const vars = parseVars(css);

// Budget: name, fg var, bg var, minimum ratio
const BUDGET = [
  { name: 'Report header body text', fg: '--gb-report-header-fg', bg: '--gb-report-header-bg', min: 4.5 },
  { name: 'Report header accent', fg: '--gb-report-header-accent', bg: '--gb-report-header-bg', min: 3.0 }, // large numerals/labels
  { name: 'Report footer text', fg: '--gb-report-footer-fg', bg: '--gb-report-footer-bg', min: 4.5 },
];

let failures = 0;
console.log(`Reading brand tokens from ${cssPath}`);
for (const rule of BUDGET) {
  const fg = (vars.get(rule.fg) || '').trim();
  const bg = (vars.get(rule.bg) || '').trim();
  const fgHex = fg.startsWith('#') ? fg : null;
  const bgHex = bg.startsWith('#') ? bg : null;
  const ratio = fgHex && bgHex ? contrastRatio(fgHex, bgHex) : 0;
  const ok = ratio >= rule.min;
  const line = `${ok ? '✓' : '✗'} ${rule.name}: ${fg} on ${bg} = ${ratio.toFixed(2)} (min ${rule.min})`;
  console[ok ? 'log' : 'error'](line);
  if (!ok) failures++;
}

if (failures) {
  console.error(`Contrast budget FAILED: ${failures} rule(s) below threshold.`);
  process.exit(1);
} else {
  console.log('Contrast budget OK.');
}
