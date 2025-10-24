import type { Page } from '@playwright/test';

const session = {
  user: {
    id: 'ops-tester',
    email: 'ops@example.test',
    name: 'Ops Tester',
    roles: ['admin', 'ops'],
  },
  tokens: {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
  },
};

export async function primeOpsSession(page: Page, opts: { mute?: boolean } = {}) {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session.user) }),
  );
  await page.route('**/api/auth/refresh', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accessToken: session.tokens.accessToken }),
    }),
  );
  await page.addInitScript(
    ({ payload, muted }) => {
      localStorage.setItem('greenbro-auth', JSON.stringify(payload));
      localStorage.setItem('auth_token', payload.tokens.accessToken);
      localStorage.setItem('toast_muted', muted ? '1' : '0');
    },
    { payload: session, muted: Boolean(opts.mute) },
  );
}
