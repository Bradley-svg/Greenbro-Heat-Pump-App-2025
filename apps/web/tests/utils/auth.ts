import type { Page } from '@playwright/test';

const baseSession = {
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

type PrimeSessionOptions = {
  user?: Partial<(typeof baseSession)['user']> & { roles?: string[] };
  roles?: string[];
  tokens?: Partial<(typeof baseSession)['tokens']>;
  mute?: boolean;
};

export async function primeSession(page: Page, options: PrimeSessionOptions = {}) {
  const nextUser = {
    ...baseSession.user,
    ...(options.user ?? {}),
  };
  if (options.roles) {
    nextUser.roles = [...options.roles];
  } else if (options.user?.roles) {
    nextUser.roles = [...options.user.roles];
  }

  const nextTokens = {
    ...baseSession.tokens,
    ...(options.tokens ?? {}),
  };

  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(nextUser),
    });
  });

  await page.route('**/api/auth/refresh', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accessToken: nextTokens.accessToken,
        refreshToken: nextTokens.refreshToken,
        user: nextUser,
      }),
    });
  });

  await page.addInitScript(
    ({ payload, muted }) => {
      localStorage.setItem('greenbro-auth', JSON.stringify(payload));
      localStorage.setItem('auth_token', payload.tokens.accessToken);
      localStorage.setItem('toast_muted', muted ? '1' : '0');
    },
    { payload: { user: nextUser, tokens: nextTokens }, muted: Boolean(options.mute) },
  );
}

export async function primeOpsSession(page: Page, opts: { mute?: boolean } = {}) {
  await primeSession(page, { mute: opts.mute });
}
