import type { Env, R2Bucket } from '../types/env';
import { getSetting } from './settings';

export async function getSignedR2Url(bucket: R2Bucket, key: string, ttlSeconds = 3600): Promise<string> {
  const maybeSign = (bucket as unknown as { createSignedUrl?: (opts: { key: string; expiration: Date }) => Promise<URL | string | { url: string }> }).createSignedUrl;
  if (typeof maybeSign === 'function') {
    const expiration = new Date(Date.now() + ttlSeconds * 1000);
    const result = await maybeSign.call(bucket, { key, expiration });
    if (result instanceof URL) {
      return result.toString();
    }
    if (typeof result === 'string') {
      return result;
    }
    if (result && typeof (result as { url?: string }).url === 'string') {
      return (result as { url: string }).url;
    }
  }
  const encodedKey = encodeURIComponent(key);
  return `https://reports.local/${encodedKey}`;
}

export async function emailCommissioning(
  env: Env,
  toCsv: string,
  subject: string,
  message: string,
  r2Key: string,
) {
  const url = await getSignedR2Url(env.REPORTS, r2Key);
  const hook = await getSetting(env.DB, 'ops_webhook_url');
  if (!hook) {
    return { ok: false as const, reason: 'no webhook configured' };
  }
  await fetch(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `${subject}\n${message}\n${url}\nRecipients: ${toCsv}` }),
  });
  return { ok: true as const };
}
