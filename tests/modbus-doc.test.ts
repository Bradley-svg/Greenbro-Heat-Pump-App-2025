import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { HOLDING_REGISTERS, READ_ONLY_REGISTERS } from '../src/lib/modbus';

test('modbus protocol document lists all defined registers', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const docPath = join(here, '..', 'docs', 'modbus-protocol.md');
  const contents = readFileSync(docPath, 'utf8');
  const registerPattern = /\|\s*0x([0-9a-fA-F]{4})(?:\s*-\s*0x([0-9a-fA-F]{4}))?\s*\|/g;

  const documented = new Set<number>();
  for (let match = registerPattern.exec(contents); match !== null; match = registerPattern.exec(contents)) {
    const start = parseInt(match[1], 16);
    const end = match[2] ? parseInt(match[2], 16) : start;
    for (let addr = start; addr <= end; addr += 1) {
      documented.add(addr & 0xffff);
    }
  }

  for (const reg of HOLDING_REGISTERS) {
    assert.ok(
      documented.has(reg.address),
      `Holding register 0x${reg.address.toString(16).padStart(4, '0')} is missing from docs/modbus-protocol.md`,
    );
  }

  for (const reg of READ_ONLY_REGISTERS) {
    assert.ok(
      documented.has(reg.address),
      `Read-only register 0x${reg.address.toString(16).padStart(4, '0')} is missing from docs/modbus-protocol.md`,
    );
  }
});
