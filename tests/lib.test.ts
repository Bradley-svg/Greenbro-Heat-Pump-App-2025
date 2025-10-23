import assert from 'node:assert/strict';
import test from 'node:test';

import { computeDerived } from '../src/lib/math';
import { hourOfWeek } from '../src/lib/time';
import { z } from '../src/lib/z';

test('hourOfWeek returns Monday 00:00 as zero', () => {
  const monday = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));
  assert.equal(hourOfWeek(monday), 0);
});

test('hourOfWeek rolls over at end of week', () => {
  const sundayLate = new Date(Date.UTC(2024, 0, 7, 23, 0, 0));
  assert.equal(hourOfWeek(sundayLate), 7 * 24 - 1);
});

test('computeDerived calculates thermal output and COP', () => {
  const derived = computeDerived({
    supplyC: 45,
    returnC: 35,
    flowLps: 0.8,
    powerKW: 1.5,
  });

  assert.equal(derived.deltaT, 10);
  assert.equal(derived.thermalKW, 0.03);
  assert.equal(derived.cop, 0.02);
  assert.equal(derived.copQuality, 'measured');
});

test('computeDerived estimates quality when power missing', () => {
  const derived = computeDerived({
    supplyC: 48,
    returnC: 38,
    flowLps: 0.6,
  });

  assert.equal(derived.cop, null);
  assert.equal(derived.copQuality, 'estimated');
});

test('z returns zero when std is missing or zero', () => {
  assert.equal(z(10, 8, 0), 0);
  assert.equal(z(10, 8, null), 0);
});

test('z returns the expected score', () => {
  assert.equal(z(12, 10, 2), 1);
});
