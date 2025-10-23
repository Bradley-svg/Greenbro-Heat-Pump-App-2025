#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const banned = [
  { re: /\bfleet(s)?\b/i, msg: 'Use “devices”.' },
  { re: /\bCenter\b/, msg: 'Use British “Centre”.' },
];
const roots = ['apps/web/src', 'src', 'emails', 'views', 'templates', 'docs', 'spec', 'handbook'];
const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.wrangler', '.turbo']);
const ignoreExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff', '.woff2', '.ttf']);

const offenders = [];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.git')) continue;
    if (ignoreDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (ignoreExtensions.has(ext)) continue;
    const stat = fs.statSync(fullPath);
    if (stat.size > 1024 * 1024) continue;
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of banned) {
        if (rule.re.test(line)) {
          offenders.push({
            file: path.relative(root, fullPath),
            line: index + 1,
            text: line.trim(),
            msg: rule.msg,
          });
          break;
        }
      }
    });
  }
}

for (const relative of roots) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) continue;
  walk(target);
}

if (offenders.length > 0) {
  console.error('Banned copy detected (GreenBro language guard):');
  offenders.forEach((offender) => {
    const advice = offender.msg ? ` (${offender.msg})` : '';
    console.error(`  ${offender.file}:${offender.line} → ${offender.text}${advice}`);
  });
  process.exit(1);
}

console.log('Copy guard passed.');
