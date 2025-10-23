import fg from 'fast-glob';
import fs from 'node:fs/promises';

const files = await fg(['**/*.{ts,tsx,md,html,css}', '!node_modules/**', '!dist/**'], {
  dot: false,
});

const errors = [];
const contents = await Promise.all(
  files.map(async (file) => ({
    file,
    text: await fs.readFile(file, 'utf8'),
  })),
);

const bannedCaseRegex = /\bGreenBro\b|\bGREENBro\b|\bGreenBRO\b/g;
for (const { file, text } of contents) {
  if (bannedCaseRegex.test(text)) {
    errors.push(`${file}: Use “Greenbro” or “GREENBRO” only.`);
    continue;
  }

  const lowerMatches = text.matchAll(/\bgreenbro\b/g);
  for (const match of lowerMatches) {
    const index = match.index ?? 0;
    const before = index > 0 ? text[index - 1] : '';
    const after = text[index + match[0].length] ?? '';
    const allowedBefore = new Set(['/', '@', '#', '-', '_', '.']);
    const allowedAfter = new Set(['-', '_', '.', '/', ':']);
    if (allowedBefore.has(before) || allowedAfter.has(after)) {
      continue;
    }
    errors.push(`${file}: Use “Greenbro” or “GREENBRO” only.`);
    break;
  }
}

const darkSurfacePattern = /login|Shell|Topbar|header|layout/i;
for (const { file, text } of contents.filter(({ file }) => darkSurfacePattern.test(file))) {
  if (/logo\.svg/.test(text) && !/logo-white\.svg/.test(text)) {
    errors.push(`${file}: Dark surfaces should use /brand/logo-white.svg.`);
  }
}

const brandSource = contents.find(({ file }) => file === 'src/brand.ts')?.text ?? '';
if (!/export const brandLogoSvg/.test(brandSource) || !/export const brandLogoWhiteSvg/.test(brandSource)) {
  errors.push('src/brand.ts: Missing fallback brand SVG exports.');
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log('brand-audit: OK');
