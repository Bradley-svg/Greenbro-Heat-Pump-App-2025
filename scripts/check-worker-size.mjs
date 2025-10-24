#!/usr/bin/env node
import { stat, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const DIST_DIR = join(process.cwd(), 'dist');
const LIMIT_BYTES = 1024 * 1024; // 1 MiB per module

async function listModuleFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(...(await listModuleFiles(join(dir, entry.name))));
    } else if (extname(entry.name) === '.mjs') {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

async function main() {
  let modules;
  try {
    modules = await listModuleFiles(DIST_DIR);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.error('No dist/ directory found. Run "npm run build" before checking bundle size.');
      process.exit(1);
    }
    throw error;
  }

  if (!modules.length) {
    console.error('No .mjs modules found in dist/. Ensure the worker build completed successfully.');
    process.exit(1);
  }

  let hasError = false;
  for (const file of modules) {
    const info = await stat(file);
    const size = info.size;
    const relative = file.slice(process.cwd().length + 1);
    const status = size > LIMIT_BYTES ? 'FAIL' : 'OK  ';
    console.log(`${status} ${relative} - ${size.toLocaleString()} bytes`);
    if (size > LIMIT_BYTES) {
      hasError = true;
    }
  }

  if (hasError) {
    console.error(`\nOne or more worker modules exceed the Cloudflare 1 MiB limit (${LIMIT_BYTES} bytes). Consider additional code splitting or reducing dependencies.`);
    process.exit(1);
  }
}

await main();
