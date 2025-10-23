import { authFetch, resolveApiUrl } from './client';

type RequestOptions = Omit<RequestInit, 'method' | 'body'> & { body?: BodyInit | null };

type JsonValue = Record<string, unknown> | Array<unknown> | string | number | boolean | null;

function toBody(payload: unknown): BodyInit | undefined {
  if (payload == null) {
    return undefined;
  }
  if (typeof payload === 'string' || payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
    return payload as BodyInit;
  }
  if (payload instanceof FormData || payload instanceof URLSearchParams || payload instanceof Blob) {
    return payload;
  }
  return JSON.stringify(payload as JsonValue);
}

function withJsonHeaders(init: RequestInit, hasBody: boolean): HeadersInit {
  const headers = new Headers(init.headers || {});
  if (hasBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const url = resolveApiUrl(path);
  return authFetch(url, init);
}

export const api = {
  get(path: string, init: RequestOptions = {}) {
    return request(path, { ...init, method: 'GET' });
  },
  post(path: string, payload?: unknown, init: RequestOptions = {}) {
    const body = payload !== undefined ? toBody(payload) : init.body;
    const headers = withJsonHeaders(init, body !== undefined && !(body instanceof FormData));
    return request(path, { ...init, method: 'POST', body, headers });
  },
  put(path: string, payload?: unknown, init: RequestOptions = {}) {
    const body = payload !== undefined ? toBody(payload) : init.body;
    const headers = withJsonHeaders(init, body !== undefined && !(body instanceof FormData));
    return request(path, { ...init, method: 'PUT', body, headers });
  },
  delete(path: string, init: RequestOptions = {}) {
    return request(path, { ...init, method: 'DELETE' });
  },
};

export type ApiClient = typeof api;
