import type { Env } from '../types/env';

type EnvRecord = Partial<Record<keyof Env, unknown>> & Record<string, unknown>;

type RequirementGroups = {
  d1: Array<keyof EnvRecord>;
  r2: Array<keyof EnvRecord>;
  vars: string[];
};

const REQ: RequirementGroups = {
  d1: ['DB'],
  r2: ['REPORTS', 'BRAND', 'ARCHIVE'],
  vars: ['ACCESS_AUD', 'ACCESS_ISS', 'ACCESS_JWKS', 'JWT_SECRET'],
};

export function preflight(env: EnvRecord | Env): void {
  const record = env as EnvRecord;
  const miss: string[] = [];
  const bypassAuthRaw = record.DEV_AUTH_BYPASS;
  const bypassAuth =
    typeof bypassAuthRaw === 'string'
      ? bypassAuthRaw !== '0' && bypassAuthRaw.toLowerCase() !== 'false'
      : Boolean(bypassAuthRaw);

  for (const key of REQ.d1) {
    if (!record[key]) {
      miss.push(`D1:${String(key)}`);
    }
  }

  for (const key of REQ.r2) {
    if (!record[key]) {
      miss.push(`R2:${String(key)}`);
    }
  }

  const hasJwks = Boolean(record.ACCESS_JWKS || record.ACCESS_JWKS_URL);
  for (const key of REQ.vars) {
    if (key !== 'JWT_SECRET' && bypassAuth) {
      continue;
    }
    if (key === 'ACCESS_JWKS') {
      if (!hasJwks) {
        miss.push('VAR:ACCESS_JWKS');
      }
      continue;
    }

    if (!record[key]) {
      miss.push(`VAR:${key}`);
    }
  }

  if (miss.length > 0) {
    const why = `Preflight failed: missing ${miss.join(', ')}`;
    throw new Response(why, { status: 503 });
  }
}
