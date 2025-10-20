import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env, Role } from './types';

export type AccessContext = {
  sub: string;
  email?: string;
  roles: Role[];
  clientIds?: string[];
};

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function verifyAccessJWT(env: Env, jwt: string): Promise<AccessContext> {
  if (!jwksCache) {
    jwksCache = createRemoteJWKSet(new URL(env.ACCESS_JWKS_URL));
  }

  const { payload } = await jwtVerify(jwt, jwksCache, {
    audience: env.ACCESS_AUD,
  });

  const roles = normalizeRoles(payload);
  const clientIds = extractClientIds(payload);

  return { sub: String(payload.sub), email: str(payload, 'email'), roles, clientIds };
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
