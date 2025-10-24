import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { primeOpsSession } from './utils/auth';

const pages = ['/login', '/overview', '/devices', '/alerts', '/ops'];

test.describe('a11y (@axe)', () => {
  for (const path of pages) {
    test(`scan ${path}`, async ({ page, baseURL }) => {
      if (!baseURL) {
        throw new Error('Playwright baseURL is not configured.');
      }
      const url = new URL(path, baseURL).toString();
      await primeOpsSession(page);
      await page.route(
        '**/api/**',
        (route) =>
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
        { times: 1 },
      );
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();

      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  }
});
