import { test, expect } from '@playwright/test';

const redSeries = [
  { ts: '2024-01-01T11:51:00.000Z', burn: 1.2, errRate: 0.01 },
  { ts: '2024-01-01T12:00:00.000Z', burn: 2.6, errRate: 0.055 },
];

test.describe('Burn toast + mute behaviour', () => {
  test('muted: no toast when burn flips RED', async ({ page, baseURL }) => {
    await page.addInitScript(() => localStorage.setItem('toast_muted', '1'));

    await page.route('**/api/ops/burn-series**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(redSeries),
      });
    });

    await page.goto(new URL('/ops', baseURL!).toString(), { waitUntil: 'domcontentloaded' });

    await page.waitForTimeout(300);

    await expect(page.locator('[data-testid="toast-container"] .toast')).toHaveCount(0);
  });

  test('unmuted: toast appears when burn is RED', async ({ page, baseURL }) => {
    await page.addInitScript(() => localStorage.setItem('toast_muted', '0'));
    await page.route('**/api/ops/burn-series**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(redSeries),
      });
    });

    await page.goto(new URL('/ops', baseURL!).toString(), { waitUntil: 'domcontentloaded' });

    const toasts = page.locator('[data-testid="toast-container"] .toast');
    await expect(toasts).toHaveCount(1);
    await expect(toasts.first()).toContainText('Fast burn ≥2×');
  });

  test('toggling mute on the page silences subsequent toasts', async ({ page, baseURL }) => {
    await page.addInitScript(() => localStorage.setItem('toast_muted', '0'));
    await page.route('**/api/ops/burn-series**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(redSeries),
      });
    });

    await page.goto(new URL('/ops', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    const container = page.locator('[data-testid="toast-container"]');
    await expect(container.locator('.toast')).toHaveCount(1);

    await page.getByTestId('toast-mute').check();

    await page.reload({ waitUntil: 'domcontentloaded' });

    await page.waitForTimeout(300);
    await expect(container.locator('.toast')).toHaveCount(0);
  });
});
