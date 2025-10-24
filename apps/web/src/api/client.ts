// Shared auth-aware fetch helpers.

import type { User } from '@utils/types';

export type AuthListener = (payload?: { user?: User } | null) => void;

const CSRF_COOKIE_NAME = 'gb_csrf';
const CSRF_HEADER_NAME = 'X-CSRF-Token';

let _csrfToken: string | null = null;
const listeners = new Set<AuthListener>();

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match && typeof match[1] === 'string' ? decodeURIComponent(match[1]) : null;
}

try {
  _csrfToken = readCookie(CSRF_COOKIE_NAME);
} catch {
  _csrfToken = null;
}

export function setCsrfToken(token: string | null) {
  _csrfToken = token;
  listeners.forEach((listener) => listener(null));
}

export function getCsrfToken(): string | null {
  if (!_csrfToken) {
    _csrfToken = readCookie(CSRF_COOKIE_NAME);
  }
  return _csrfToken;
}

export function onAuthChange(fn: AuthListener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getFetchImpl(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? fetch;
}
function clearStoredSession() {
  try {
    localStorage.removeItem('greenbro-auth');
  } catch {
    /* ignore */
  }
}

let handlingUnauthorized = false;

async function handleRefreshFailure(fetchImpl: typeof fetch): Promise<void> {
  if (handlingUnauthorized) {
    return;
  }
  handlingUnauthorized = true;

  (globalThis as any).setAuthToken?.(null);
  clearStoredSession();

  try {
    await fetchImpl(resolveApiUrl('/api/auth/logout'), {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    /* ignore */
  }

  if (typeof window !== 'undefined') {
    try {
      if (window.location.pathname !== '/login') {
        window.location.replace('/login');
      }
    } catch {
      /* ignore navigation errors */
    }
  }
}

function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) {
    return init.method.toUpperCase();
  }
  if (input instanceof Request) {
    return input.method.toUpperCase();
  }
  return 'GET';
}

function shouldAttachCsrf(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

/* tryRefresh is implemented below (single export). */

function applyCsrf(headers: Headers, method: string) {
  if (!shouldAttachCsrf(method)) {
    return;
  }
  const token = getCsrfToken();
  if (token && !headers.has(CSRF_HEADER_NAME)) {
    headers.set(CSRF_HEADER_NAME, token);
  }
}

function isAuthEndpoint(input: RequestInfo | URL): boolean {
  const target =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (typeof target !== 'string') {
    return false;
  }
  return (
    target.includes('/api/auth/login') ||
    target.includes('/api/auth/refresh') ||
    target.includes('/api/auth/logout')
  );
}

export function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const normalised = path.startsWith('/') ? path : `/${path}`;

  const globalBase =
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { __API_BASE_URL__?: unknown }).__API_BASE_URL__ === 'string'
      ? ((globalThis as { __API_BASE_URL__?: string }).__API_BASE_URL__ as string)
      : undefined;

  const metaBase =
    typeof import.meta !== 'undefined' &&
    typeof (import.meta as unknown as { env?: { VITE_API_BASE_URL?: unknown } }).env?.VITE_API_BASE_URL === 'string'
      ? ((import.meta as unknown as { env: { VITE_API_BASE_URL: string } }).env.VITE_API_BASE_URL as string)
      : undefined;

  const windowBase = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : undefined;

  const base = metaBase || globalBase || windowBase;
  if (!base) {
    return normalised;
  }

  try {
    return new URL(normalised, base).toString();
  } catch {
    return normalised;
  }
}

export async function tryRefresh(fetchImpl?: typeof fetch): Promise<boolean> {
  const runFetch = getFetchImpl(fetchImpl);
  const headers = new Headers();
  const csrf = getCsrfToken();
  if (csrf) {
    headers.set(CSRF_HEADER_NAME, csrf);
  }

  try {
    const response = await runFetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers,
    });
    if (!response.ok) {
      if (response.status === 403) {
        setCsrfToken(null);
      }
      return false;
    }
    const data = (await response.json().catch(() => null)) as { user?: User; csrfToken?: string } | null;
    if (data && typeof data.csrfToken === 'string') {
      setCsrfToken(data.csrfToken);
    } else {
      setCsrfToken(readCookie(CSRF_COOKIE_NAME));
    }
    listeners.forEach((listener) => listener(data));
    return true;
  } catch {
    return false;
  }
}

export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const runFetch = getFetchImpl(fetchImpl);
  const method = resolveMethod(input, init);
  const headers = new Headers(init?.headers ?? {});
  applyCsrf(headers, method);

  const first = await runFetch(input, {
    ...init,
    headers,
    credentials: init?.credentials ?? 'include',
  });
  if (first.status !== 401 || isAuthEndpoint(input)) {
    return first;
  }

  if (await tryRefresh(runFetch)) {
    const retryHeaders = new Headers(init?.headers ?? {});
    applyCsrf(retryHeaders, method);
    return runFetch(input, {
      ...init,
      headers: retryHeaders,
      credentials: init?.credentials ?? 'include',
    });
  }
  await handleRefreshFailure(runFetch);
  return first;
}

export async function apiFetch<T = unknown>(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetchImpl?: typeof fetch,
): Promise<T> {
  const response = await authFetch(input, init, fetchImpl);
  if (!response.ok) {
    const message = await response
      .text()
      .catch(() => '')
      .then((text) => text || response.statusText || `HTTP ${response.status}`);
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const raw = await response
    .text()
    .catch(() => '');
  if (!raw) {
    return undefined as T;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as unknown as T;
  }
}

export function createClient() {
  return {
    fetch: authFetch,
  };
}

export const api = createClient();
