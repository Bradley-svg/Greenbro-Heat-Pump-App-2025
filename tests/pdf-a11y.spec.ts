import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8788';

async function scan(page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .disableRules([])
    .analyze();
  expect(
    results.violations,
    `Axe violations on ${url}\n${JSON.stringify(results.violations, null, 2)}`,
  ).toEqual([]);
}

test('@pdf incident v2 a11y', async ({ page }) => {
  const url = `${BASE}/api/reports/preview-html?type=incident&sample=1`;
  await scan(page, url);
});

test('@pdf client-monthly v2 a11y', async ({ page }) => {
  const url = `${BASE}/api/reports/preview-html?type=client-monthly&sample=1`;
  await scan(page, url);
});
