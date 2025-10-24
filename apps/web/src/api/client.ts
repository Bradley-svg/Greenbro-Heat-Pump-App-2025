// Single-source auth + fetch, with legacy-compatible exports to unblock TS builds.

export type AuthListener = () => void;

let _token: string | null = null;
const listeners = new Set<AuthListener>();

// Initialise from storage (best-effort)
try {
  _token = localStorage.getItem('auth_token');
} catch {
  /* ignore storage access issues (SSR or locked-down env) */
}

export function setAuthToken(tok: string | null) {
  _token = tok;
  try {
    if (tok) localStorage.setItem('auth_token', tok);
    else localStorage.removeItem('auth_token');
  } catch {
    /* ignore */
  }
  // notify subscribers
  listeners.forEach((l) => l());
}

export function getAuthToken() {
  return _token;
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

  setAuthToken(null);
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

// ----- refresh helper (used by authFetch retry) -----
export async function tryRefresh(fetchImpl?: typeof fetch): Promise<boolean> {
  const runFetch = getFetchImpl(fetchImpl);
  let refreshToken: string | null = null;
  try {
    const stored = localStorage.getItem('greenbro-auth');
    if (stored) {
      const parsed = JSON.parse(stored) as { tokens?: { refreshToken?: string } };
      if (parsed?.tokens?.refreshToken) {
        refreshToken = parsed.tokens.refreshToken;
      }
    }
  } catch {
    refreshToken = null;
  }

  if (!refreshToken) {
    return false;
  }

  try {
    const response = await runFetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) {
      return false;
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data.accessToken !== 'string') {
      return false;
    }

    const nextRefresh = typeof data.refreshToken === 'string' ? data.refreshToken : undefined;
    setAuthToken(data.accessToken);

    try {
      const stored = localStorage.getItem('greenbro-auth');
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, any>;
        const currentTokens = (parsed.tokens as Record<string, any>) ?? {};
        parsed.tokens = {
          ...currentTokens,
          accessToken: data.accessToken,
          refreshToken: nextRefresh ?? currentTokens.refreshToken,
        };
        localStorage.setItem('greenbro-auth', JSON.stringify(parsed));
      }
    } catch {
      /* ignore storage errors */
    }

    return true;
  } catch {
    return false;
  }
}

// Resolve an API URL relative to the configured base (if any)
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

  const windowBase =
    typeof window !== 'undefined' && window.location?.origin ? window.location.origin : undefined;

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

// ----- primary fetch wrapper -----
export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const runFetch = getFetchImpl(fetchImpl);
  const headers = new Headers(init?.headers || {});
  const tok = getAuthToken();
  if (tok && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${tok}`);

  const first = await runFetch(input, { ...init, headers });
  if (first.status !== 401) return first;

  // one retry on 401 after refresh
  if (await tryRefresh(runFetch)) {
    const headers2 = new Headers(init?.headers || {});
    const tok2 = getAuthToken();
    if (tok2) headers2.set('Authorization', `Bearer ${tok2}`);
    return runFetch(input, { ...init, headers: headers2 });
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

// ===== Legacy compatibility layer =====

// Some modules might expect a factory that yields an object with a `fetch` method
export function createClient() {
  return {
    fetch: authFetch,
  };
}

// Some older snippets import a default `api` or named `api` with a `fetch` method:
export const api = createClient();
export default api;

// Very old code paths might import `createAuthedFetch`:
export function createAuthedFetch() {
  return authFetch;
}
