#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main() {
  const distPath = resolve(process.cwd(), 'dist');
  await rm(distPath, { recursive: true, force: true });
}

await main();
