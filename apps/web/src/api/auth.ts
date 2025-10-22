import type { AuthSession, AuthTokens, User } from '@utils/types';
import { apiFetch, resolveApiUrl } from './client';

export interface LoginInput {
  email: string;
  password: string;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken?: string;
  user?: User;
}

export async function login(input: LoginInput): Promise<AuthSession> {
  const data = await apiFetch<{ user: User; accessToken: string; refreshToken?: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });

  return {
    user: data.user,
    tokens: {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
    },
  };
}

export async function logout(accessToken?: string): Promise<void> {
  await fetch(resolveApiUrl('/api/auth/logout'), {
    method: 'POST',
    credentials: 'include',
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
  }).catch(() => undefined);
}

export async function fetchMe(accessToken: string): Promise<User> {
  return apiFetch<User>('/api/auth/me', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

export async function refresh(refreshToken: string): Promise<RefreshResponse> {
  return apiFetch<RefreshResponse>('/api/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken }),
  });
}

export function storeSession(session: AuthSession | null): void {
  if (typeof window === 'undefined') return;
  if (!session) {
    localStorage.removeItem('greenbro-auth');
    return;
  }
  localStorage.setItem(
    'greenbro-auth',
    JSON.stringify({
      user: session.user,
      tokens: session.tokens,
      storedAt: Date.now(),
    }),
  );
}

export function loadStoredSession(): AuthSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('greenbro-auth');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { user: User; tokens: AuthTokens };
    if (!parsed?.tokens?.accessToken) {
      return null;
    }
    return {
      user: parsed.user,
      tokens: parsed.tokens,
    };
  } catch (error) {
    console.warn('Failed to parse stored auth session', error);
    return null;
  }
}
