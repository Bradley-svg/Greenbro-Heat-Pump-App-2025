import fg from 'fast-glob';
import fs from 'node:fs/promises';

const files = await fg([
  '**/*.{ts,tsx,js,jsx,mjs,cjs,md,html,css}',
  '!node_modules/**',
  '!dist/**',
  '!build/**',
]);

const FAIL = [];
for (const f of files) {
  if (f === 'scripts/copy-guard.mjs') continue;
  const t = await fs.readFile(f, 'utf8');

  // Brand casing: allow only "Greenbro" or "GREENBRO"
  if (/\bGreenBro\b|\bGREENBro\b|\bGreenBRO\b/.test(t)) {
    FAIL.push([f, 'Use “Greenbro” or “GREENBRO” (no other variations).']);
  }

  const brandMatches = [...t.matchAll(/\bgreenbro\b/gi)];
  for (const match of brandMatches) {
    if (match[0] === 'Greenbro' || match[0] === 'GREENBRO') {
      continue;
    }
    const index = match.index ?? 0;
    const before = index > 0 ? t[index - 1] : '';
    const after = t[index + match[0].length] ?? '';
    const allowBefore = /[@\/_\.-]/.test(before);
    const allowAfter = /[@\/_\.-]/.test(after);
    if (!allowBefore && !allowAfter) {
      FAIL.push([f, 'Use “Greenbro” or “GREENBRO” (no other variations).']);
      break;
    }
  }
  // British spelling
  if (/\bControl Center\b/.test(t)) {
    FAIL.push([f, 'Use “Control Centre” (British English).']);
  }
  // Ban "fleet" in visible copy (permit technical identifiers if explicitly namespaced)
  if (/\bfleet\b/i.test(t) && !/[_-]fleet|FleetDO|fleet_id|fleetMap/.test(t)) {
    FAIL.push([f, 'Avoid “fleet” in UI copy; use “devices” or “sites/devices”.']);
  }
}

if (FAIL.length) {
  console.error('\nCopy guard failures:');
  for (const [f, msg] of FAIL) console.error(' -', f, '→', msg);
  process.exit(1);
}
console.log('copy-guard: clean');
