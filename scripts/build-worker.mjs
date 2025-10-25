#!/usr/bin/env node
import { build } from 'esbuild';
import { execSync } from 'node:child_process';

function pick(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function git(command) {
  try {
    return execSync(`git ${command}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

const sha = pick(
  process.env.BUILD_SHA,
  process.env.GITHUB_SHA,
  git('rev-parse --short HEAD'),
) ?? 'unknown-sha';

const date = pick(process.env.BUILD_DATE, process.env.BUILD_TIMESTAMP) ?? new Date().toISOString();

const source = pick(
  process.env.BUILD_SOURCE,
  process.env.GITHUB_REF_NAME && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_REPOSITORY}@${process.env.GITHUB_REF_NAME}`
    : undefined,
  git('rev-parse --abbrev-ref HEAD'),
  'local-dev',
);

console.log(
  `[build-worker] Embedding build metadata: sha=${sha}, date=${date}, source=${source}`,
);

await build({
  entryPoints: ['src/app.tsx'],
  bundle: true,
  format: 'esm',
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'browser',
  conditions: ['worker'],
  define: {
    'process.env.NODE_ENV': '"production"',
    BUILD_SHA: JSON.stringify(sha),
    BUILD_DATE: JSON.stringify(date),
    BUILD_SOURCE: JSON.stringify(source),
  },
  logLevel: 'info',
});
