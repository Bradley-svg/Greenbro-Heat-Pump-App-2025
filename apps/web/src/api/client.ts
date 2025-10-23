type Listener = () => void;
let _token: string | null = (typeof localStorage !== 'undefined' && localStorage.getItem('auth_token')) || null;
const listeners = new Set<Listener>();

export function setAuthToken(tok: string | null) {
  _token = tok;
  try {
    if (tok) localStorage.setItem('auth_token', tok);
    else localStorage.removeItem('auth_token');
  } catch {}
  listeners.forEach((l) => l());
}
export function getAuthToken() {
  return _token;
}
export function onAuthChange(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function tryRefresh() {
  const r = await fetch('/api/auth/refresh', { method: 'POST' });
  if (!r.ok) return false;
  const j = await r.json();
  if (j?.token) setAuthToken(j.token);
  return !!j?.token;
}

export async function authFetch(input: RequestInfo | URL, init?: RequestInit) {
  const res = await fetch(input, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
    },
  });
  if (res.status === 401 && (await tryRefresh())) {
    return fetch(input, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        Authorization: `Bearer ${getAuthToken()}`,
      },
    });
  }
  return res;
}
