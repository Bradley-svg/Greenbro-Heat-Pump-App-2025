import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env, Role } from './types';

export type AccessContext = {
  sub: string;
  email?: string;
  roles: Role[];
  clientIds?: string[];
};

type CachedJwks = {
  url: string;
  expiresAt: number;
  set: ReturnType<typeof createRemoteJWKSet>;
};

const JWKS_CACHE_TTL_MS = 10 * 60_000;

let jwksCache: CachedJwks | null = null;

export async function verifyAccessJWT(env: Env, jwt: string): Promise<AccessContext> {
  const jwks = getCachedJwks(env);

  const { payload } = await jwtVerify(jwt, jwks, {
    audience: env.ACCESS_AUD,
  });

  const roles = normalizeRoles(payload);
  const clientIds = extractClientIds(payload);

  return { sub: String(payload.sub), email: str(payload, 'email'), roles, clientIds };
}

function getCachedJwks(env: Env): ReturnType<typeof createRemoteJWKSet> {
  const now = Date.now();
  if (!jwksCache || jwksCache.url !== env.ACCESS_JWKS_URL || jwksCache.expiresAt <= now) {
    jwksCache = {
      url: env.ACCESS_JWKS_URL,
      expiresAt: now + JWKS_CACHE_TTL_MS,
      set: createRemoteJWKSet(new URL(env.ACCESS_JWKS_URL)),
    };
  } else {
    jwksCache.expiresAt = now + JWKS_CACHE_TTL_MS;
  }
  return jwksCache.set;
}

function normalizeRoles(payload: JWTPayload): Role[] {
  const raw = ((payload as any).roles || (payload as any)['https://greenbro/roles'] || []) as string[];
  const set = new Set<Role>();
  for (const r of raw) {
    if (r === 'admin') set.add('admin');
    else if (r === 'ops') set.add('ops');
    else if (r === 'client') set.add('client');
    else if (r === 'contractor') set.add('contractor');
  }
  return [...set];
}

function extractClientIds(payload: JWTPayload): string[] {
  const raw = ((payload as any).clients || (payload as any)['https://greenbro/clients'] || []) as string[];
  return Array.from(new Set(raw));
}

function str(p: JWTPayload, key: string): string | undefined {
  const v = (p as any)[key];
  return typeof v === 'string' ? v : undefined;
}

export function requireRole(ctx: AccessContext, allowed: Role[]): void {
  if (!ctx.roles.some((r) => allowed.includes(r))) {
    throw new Response('Forbidden', { status: 403 });
  }
}
