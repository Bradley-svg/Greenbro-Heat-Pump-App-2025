import type { User } from '@utils/types';
import { apiFetch, getCsrfToken, resolveApiUrl, setCsrfToken } from './client';

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: User;
  csrfToken?: string;
}

export interface RefreshResponse {
  user?: User;
  csrfToken?: string;
}

export async function login(input: LoginInput): Promise<LoginResponse> {
  const data = await apiFetch<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
    headers: { 'Content-Type': 'application/json' },
  });
  if (typeof data?.csrfToken === 'string') {
    setCsrfToken(data.csrfToken);
  }
  return data;
}

export async function logout(): Promise<void> {
  await fetch(resolveApiUrl('/api/auth/logout'), {
    method: 'POST',
    credentials: 'include',
  }).catch(() => undefined);
  setCsrfToken(null);
}

export async function fetchMe(): Promise<User> {
  return apiFetch<User>('/api/auth/me');
}

export async function refresh(): Promise<RefreshResponse> {
  const headers = new Headers();
  const csrf = getCsrfToken();
  if (csrf) {
    headers.set('X-CSRF-Token', csrf);
  }

  const response = await fetch(resolveApiUrl('/api/auth/refresh'), {
    method: 'POST',
    credentials: 'include',
    headers,
  });

  if (!response.ok) {
    const message = await response
      .text()
      .catch(() => '')
      .then((text) => text || 'Failed to refresh session');
    throw new Error(message);
  }

  const data = (await response.json().catch(() => ({}))) as RefreshResponse;
  if (typeof data?.csrfToken === 'string') {
    setCsrfToken(data.csrfToken);
  }
  return data;
}
