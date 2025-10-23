#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const configPath = path.join(__dirname, 'copy-guard.json');

if (!fs.existsSync(configPath)) {
  console.error('Missing copy-guard configuration at scripts/copy-guard.json');
  process.exit(1);
}

const configRaw = fs.readFileSync(configPath, 'utf8');
let config;
try {
  config = JSON.parse(configRaw);
} catch (error) {
  console.error('Failed to parse copy-guard.json:', error instanceof Error ? error.message : error);
  process.exit(1);
}

const bannedRules = Array.isArray(config?.banned)
  ? config.banned
      .map((rule) => {
        if (!rule?.pattern) return null;
        try {
          const regex = new RegExp(rule.pattern, 'g');
          return { regex, hint: rule.hint ?? '', pattern: rule.pattern };
        } catch (error) {
          console.error(`Invalid pattern in copy-guard.json: ${rule.pattern}`);
          return null;
        }
      })
      .filter(Boolean)
  : [];

if (bannedRules.length === 0) {
  console.log('No banned patterns configured; skipping copy guard.');
  process.exit(0);
}

const searchRoots = ['apps/web/src', 'src', 'templates', 'views', 'emails', 'docs'];
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.wrangler', '.turbo', 'coverage']);
const ignoredExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.ico',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
]);

function shouldIgnoreFile(relativePath) {
  const normalised = relativePath.replace(/\\/g, '/');
  if (normalised.includes('/node_modules/') || normalised.includes('/dist/') || normalised.includes('/build/')) {
    return true;
  }
  const ext = path.extname(relativePath).toLowerCase();
  if (ignoredExtensions.has(ext)) {
    return true;
  }
  if (Array.isArray(config?.ignorePaths)) {
    for (const pattern of config.ignorePaths) {
      if (typeof pattern !== 'string') continue;
      if (pattern.startsWith('**/') && pattern.endsWith('/**')) {
        const segment = pattern.slice(3, -3);
        if (segment && normalised.includes(`/${segment}/`)) {
          return true;
        }
      } else if (pattern.startsWith('**/*.')) {
        const suffix = pattern.slice(3).toLowerCase();
        if (suffix && normalised.toLowerCase().endsWith(suffix)) {
          return true;
        }
      }
    }
  }
  return false;
}

const offenders = [];

function walk(targetDir) {
  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.git')) continue;
    if (ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(targetDir, entry.name);
    const relative = path.relative(root, fullPath);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (shouldIgnoreFile(relative)) continue;
    const stat = fs.statSync(fullPath);
    if (stat.size > 1024 * 1024) continue;
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of bannedRules) {
        rule.regex.lastIndex = 0;
        if (rule.regex.test(line)) {
          offenders.push({
            file: relative,
            line: index + 1,
            text: line.trim(),
            hint: rule.hint,
            pattern: rule.pattern,
          });
          break;
        }
      }
    });
  }
}

for (const relative of searchRoots) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) continue;
  walk(target);
}

if (offenders.length > 0) {
  console.error('Banned copy detected (GreenBro language guard):');
  offenders.forEach((offender) => {
    const hint = offender.hint ? ` (${offender.hint})` : '';
    console.error(`  ${offender.file}:${offender.line} → ${offender.text}${hint}`);
  });
  process.exit(1);
}

console.log('Copy guard passed.');
