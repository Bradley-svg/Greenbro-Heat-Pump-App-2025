import type { Env } from '../types';

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

export function preflight(env: EnvRecord): void {
  const miss: string[] = [];

  for (const key of REQ.d1) {
    if (!env[key]) {
      miss.push(`D1:${String(key)}`);
    }
  }

  for (const key of REQ.r2) {
    if (!env[key]) {
      miss.push(`R2:${String(key)}`);
    }
  }

  const hasJwks = Boolean((env as EnvRecord).ACCESS_JWKS || (env as EnvRecord).ACCESS_JWKS_URL);
  for (const key of REQ.vars) {
    if (key === 'ACCESS_JWKS') {
      if (!hasJwks) {
        miss.push('VAR:ACCESS_JWKS');
      }
      continue;
    }

    if (!env[key]) {
      miss.push(`VAR:${key}`);
    }
  }

  if (miss.length > 0) {
    const why = `Preflight failed: missing ${miss.join(', ')}`;
    throw new Response(why, { status: 503 });
  }
}
