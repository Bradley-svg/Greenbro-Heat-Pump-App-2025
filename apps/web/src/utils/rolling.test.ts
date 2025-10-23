import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { rollingStats } from './rolling';

test('rollingStats median/IQR', () => {
  const t0 = 1_000_000;
  const samples = [
    { t: t0 + 0, y: 3 },
    { t: t0 + 1_000, y: 7 },
    { t: t0 + 2_000, y: 5 },
    { t: t0 + 95_000, y: 5 },
  ];
  const results = rollingStats(samples, 90_000);
  const last = results.at(-1);
  assert(last, 'expected a final rolling point');
  assert.equal(last.median, 5);
  assert.notEqual(last.p25, null);
  assert.notEqual(last.p75, null);
});
