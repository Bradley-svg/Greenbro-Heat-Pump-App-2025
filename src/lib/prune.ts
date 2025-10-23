import type { R2Bucket } from '../types/env';

export async function pruneR2Prefix(bucket: R2Bucket, prefix: string, olderThanDays: number) {
  const cutoff = Date.now() - olderThanDays * 86400_000;
  let cursor: string | undefined;
  do {
    const { objects, cursor: next } = await bucket.list({ prefix, limit: 1000, cursor });
    cursor = next;
    for (const o of objects) {
      if (o.uploaded && o.uploaded.getTime() < cutoff) {
        await bucket.delete(o.key).catch(() => {});
      }
    }
  } while (cursor);
}
