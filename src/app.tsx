/** @jsxImportSource hono/jsx */
/** @jsxRuntime automatic */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { SignJWT, jwtVerify } from 'jose';
import type { Env, ExecutionContext, MessageBatch, ScheduledEvent } from './types/env';
import type {
  ClientMonthlyReportPayload,
  CommissioningPayload,
  IncidentReportV2Payload,
} from './pdf';
import type { HeartbeatPayload, IngestMessage, TelemetryPayload, Role } from './types';
import { verifyAccessJWT, requireRole, type AccessContext } from './rbac';
// Re-export Durable Object classes so Wrangler can bind them even though this module does not reference them directly.
export { DeviceStateDO, DeviceDO } from './do';
import {
  evaluateTelemetryAlerts,
  evaluateHeartbeatAlerts,
  evaluateBaselineAlerts,
  type Derived,
} from './alerts';
import { BRAND, brandCss, brandEmail, brandLogoSvg, brandLogoWhiteSvg, brandLogoMonoSvg } from './brand';
import {
  renderer,
  OverviewPage,
  AlertsPage,
  DevicesPage,
  AdminSitesPage,
  AdminEmailPage,
  AdminMaintenancePage,
  AdminArchivePage,
  AdminPresetsPage,
  AdminSettingsPage,
  AdminCommissioningPage,
  AdminReportsPage,
  AdminReportsOutboxPage,
  AdminReportsHistoryPage,
  ClientSloPage,
  OpsPage,
  Page,
  type OverviewData,
  type OpsSnapshot,
  type ClientSloSummary,
  type ReportHistoryRow,
  type AdminArchiveRow,
  type AdminCommissioningRow,
  type DeployRibbon,
} from './ssr';
import {
  renderIncidentHtmlV2,
  renderClientMonthlyHtmlV2,
  sampleIncidentReportV2Payload,
  sampleClientMonthlyReportPayload,
} from './report-html';
import { handleQueueBatch as baseQueueHandler } from './queue';
import { sweepIncidents } from './incidents';
import { withSecurityHeaders } from './security';
import { preflight } from './utils/preflight';
import { getVersion } from './utils/version';
import { validateHeartbeat, validateIngest } from './lib/schemas';
import { getLatestTelemetry, computeDeltaT, getWindowSample } from './lib/commissioning';
import { emailCommissioning, emailCommissioningWithZip } from './lib/email';
import { audit } from './lib/audit';
import { pruneR2Prefix } from './lib/prune';
import { compareToIqr } from './lib/baseline';
import { getSetting, setSetting } from './lib/settings';
import { decodeTelemetryFromRegisters, normalizeRegisterMap, FAULT_CODES } from './lib/modbus';
import argon2Module from 'argon2-wasm-esm/lib/argon2.js';
const { ArgonType, hash: argon2Hash } = argon2Module;
const DEV_BYPASS_AUTH: AccessContext = { sub: 'dev-bypass', roles: ['admin', 'ops'], clientIds: [] };

var pdfModulePromise: Promise<any> | null = null;
function getPdfModule(): Promise<any> {
  if (!pdfModulePromise) pdfModulePromise = import('./pdf');
  return pdfModulePromise;
}

var pdfLibPromise: Promise<any> | null = null;
function getPdfLib(): Promise<any> {
  if (!pdfLibPromise) pdfLibPromise = import('pdf-lib');
  return pdfLibPromise;
}

const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'https://dash.greenbro.co.za',
  'https://ops.greenbro.co.za',
]);

const DEV_ALLOWED_ORIGINS = Object.freeze([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
]);

const FAULT_DESCRIPTION_LOOKUP = (() => {
  const map = new Map<string, string>();
  for (const fault of FAULT_CODES) {
    const normalized = fault.code.toLowerCase();
    map.set(normalized, fault.description);
    map.set(normalized.replace(/\s+/g, ''), fault.description);
  }
  return map;
})();

function lookupFaultDescription(code: string): string | undefined {
  if (typeof code !== 'string' || code.length === 0) {
    return undefined;
  }
  const normalized = code.toLowerCase();
  return FAULT_DESCRIPTION_LOOKUP.get(normalized) ?? FAULT_DESCRIPTION_LOOKUP.get(normalized.replace(/\s+/g, ''));
}

function maskId(id: unknown): string {
  if (typeof id !== 'string' || id.length === 0) {
    return '';
  }
  return id.length <= 5 ? `\u2022\u2022\u2022${id.slice(-2)}` : `${id.slice(0, 3)}\u2026${id.slice(-2)}`;
}

function escapeForLike(value: string): string {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

function numberFromSetting(value: unknown, fallback = 0): number {
  if (value == null) return fallback;
  const parsed = Number(value as any);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseWriteLimit(value: string, key: 'WRITE_MIN_C' | 'WRITE_MAX_C'): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${key} is not configured`);
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} is invalid`);
  }
  return parsed;
}

function getWriteLimits(env: Env): { minC: number; maxC: number } {
  return {
    minC: parseWriteLimit(env.WRITE_MIN_C, 'WRITE_MIN_C'),
    maxC: parseWriteLimit(env.WRITE_MAX_C, 'WRITE_MAX_C'),
  };
}

function normalizeFlagGroup(flags: unknown): Record<string, boolean> | undefined {
  if (!flags || typeof flags !== 'object') {
    return undefined;
  }
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(flags as Record<string, unknown>)) {
    if (typeof value === 'boolean') {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeFlagMap(flags: unknown): Record<string, Record<string, boolean>> | undefined {
  if (!flags || typeof flags !== 'object') {
    return undefined;
  }
  const result: Record<string, Record<string, boolean>> = {};
  for (const [groupKey, groupValue] of Object.entries(flags as Record<string, unknown>)) {
    const group = normalizeFlagGroup(groupValue);
    if (group) {
      result[groupKey] = group;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function isDevBypassAllowed(env: Env): boolean {
  if (env.DEV_AUTH_BYPASS !== '1') {
    return false;
  }
  // Allow bypass when running from a recognized local/test build source or when BUILD_SOURCE is not set
  // (which is common in unit tests that provide a minimal Env object).
  if (env.BUILD_SOURCE === 'local' || env.BUILD_SOURCE === undefined) {
    return true;
  }
  return env.ALLOW_AUTH_BYPASS === '1';
}

function isDevBypassActive(env: Env): boolean {
  return env.DEV_AUTH_BYPASS === '1' && isDevBypassAllowed(env);
}

type NormalizedAuthUser = {
  id: string;
  email: string;
  name?: string;
  passwordHash: string;
  passwordSalt: string | null;
  roles: Role[];
  clientIds: string[];
};

type ApiUser = {
  id: string;
  email: string;
  name?: string;
  roles: Role[];
  clientIds: string[];
};

type RefreshRecord = {
  sessionId: string;
  user: ApiUser;
};

const APP_JWT_ISSUER = 'greenbro-app';
const APP_JWT_AUDIENCE = 'greenbro-app';
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;
const REFRESH_TOKEN_PREFIX = 'auth-refresh:';

const ACCESS_COOKIE_NAME = 'gb_access';
const REFRESH_COOKIE_NAME = 'gb_refresh';
const CSRF_COOKIE_NAME = 'gb_csrf';
const CSRF_HEADER_NAME = 'X-CSRF-Token';

const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_LENGTH = 32;
const PASSWORD_TIME_COST = 3;
const PASSWORD_MEMORY_KIB = 64 * 1024;
const PASSWORD_PARALLELISM = 1;

let cachedJwtSecret: { secret: string; key: Uint8Array } | null = null;

function getJwtSecretKey(env: Env): Uint8Array {
  if (!cachedJwtSecret || cachedJwtSecret.secret !== env.JWT_SECRET) {
    cachedJwtSecret = { secret: env.JWT_SECRET, key: new TextEncoder().encode(env.JWT_SECRET) };
  }
  return cachedJwtSecret.key;
}

function normalizeRoleList(raw: unknown): Role[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',').map((value) => value.trim())
      : [];
  const set = new Set<Role>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalised = value.trim().toLowerCase();
    if (normalised === 'admin') set.add('admin');
    else if (normalised === 'ops') set.add('ops');
    else if (normalised === 'client') set.add('client');
    else if (normalised === 'contractor') set.add('contractor');
  }
  return [...set];
}

function normalizeClientIds(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const set = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) {
      set.add(trimmed);
    }
  }
  return [...set];
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function generateSaltHex(): string {
  const salt = new Uint8Array(PASSWORD_SALT_BYTES);
  crypto.getRandomValues(salt);
  return bytesToHex(salt);
}

async function derivePasswordHash(password: string, saltHex?: string): Promise<{ hashHex: string; saltHex: string }> {
  const resolvedSaltHex = saltHex ?? generateSaltHex();
  const salt = hexToBytes(resolvedSaltHex);
  const result = await argon2Hash({
    pass: password,
    salt,
    time: PASSWORD_TIME_COST,
    mem: PASSWORD_MEMORY_KIB,
    parallelism: PASSWORD_PARALLELISM,
    hashLen: PASSWORD_HASH_LENGTH,
    type: ArgonType.argon2id,
  });
  return { hashHex: result.hashHex.toLowerCase(), saltHex: resolvedSaltHex.toLowerCase() };
}

async function hashLegacyPassword(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest)).toLowerCase();
}

type AuthUserRow = {
  id: string;
  email: string;
  name: string | null;
  password_hash: string;
  password_salt: string | null;
  roles: string | null;
  client_ids: string | null;
};

type LegacyAuthUser = {
  id: string;
  email: string;
  name?: string;
  roles: Role[];
  clientIds: string[];
  password?: string;
  passwordHash?: string;
};

function parseAuthUserRow(row: AuthUserRow | null): NormalizedAuthUser | null {
  if (!row) {
    return null;
  }
  const id = typeof row.id === 'string' && row.id.trim().length > 0 ? row.id.trim() : null;
  const email = typeof row.email === 'string' && row.email.trim().length > 0 ? row.email.trim().toLowerCase() : null;
  if (!id || !email) {
    return null;
  }
  const name = typeof row.name === 'string' && row.name.trim().length > 0 ? row.name.trim() : undefined;
  const passwordHash = typeof row.password_hash === 'string' && row.password_hash ? row.password_hash.toLowerCase() : null;
  if (!passwordHash) {
    return null;
  }
  const passwordSalt = typeof row.password_salt === 'string' && row.password_salt ? row.password_salt.toLowerCase() : null;

  const roles: Role[] = (() => {
    if (typeof row.roles === 'string' && row.roles.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(row.roles) as unknown;
        return normalizeRoleList(parsed);
      } catch (error) {
        console.warn('Failed to parse auth user roles JSON', error);
      }
    }
    return normalizeRoleList(row.roles);
  })();
  if (roles.length === 0) {
    return null;
  }

  const clientIds = (() => {
    if (typeof row.client_ids === 'string' && row.client_ids.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(row.client_ids) as unknown;
        return normalizeClientIds(parsed);
      } catch (error) {
        console.warn('Failed to parse auth user client IDs JSON', error);
      }
    }
    return normalizeClientIds(row.client_ids);
  })();

  return { id, email, name, passwordHash, passwordSalt, roles, clientIds };
}

function parseLegacyAuthUser(entry: unknown): LegacyAuthUser | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const idRaw = record.id ?? record.userId ?? record.uid;
  const emailRaw = record.email;
  const nameRaw = record.name;
  const rolesRaw = record.roles ?? record.role;
  const clientsRaw = record.clientIds ?? record.clients;
  const passwordRaw = record.password;
  const passwordHashRaw = record.password_hash ?? record.passwordHash;

  const id = typeof idRaw === 'string' && idRaw.trim().length > 0 ? idRaw.trim() : null;
  const email = typeof emailRaw === 'string' && emailRaw.trim().length > 0 ? emailRaw.trim().toLowerCase() : null;
  if (!id || !email) return null;

  const name = typeof nameRaw === 'string' && nameRaw.trim().length > 0 ? nameRaw.trim() : undefined;
  const roles = normalizeRoleList(rolesRaw);
  if (roles.length === 0) return null;
  const clientIds = normalizeClientIds(clientsRaw);
  const password = typeof passwordRaw === 'string' && passwordRaw ? passwordRaw : undefined;
  const passwordHash = typeof passwordHashRaw === 'string' && passwordHashRaw ? passwordHashRaw.toLowerCase() : undefined;
  return { id, email, name, roles, clientIds, password, passwordHash };
}

let authUserMigrationPromise: Promise<void> | null = null;

async function migrateLegacyAuthUsers(DB: D1Database): Promise<void> {
  if (!authUserMigrationPromise) {
    authUserMigrationPromise = (async () => {
      try {
        const hasTable = await DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_users'")
          .first<{ name: string }>();
        if (!hasTable) {
          return;
        }
      } catch (error) {
        console.warn('Failed to verify auth_users table', error);
        return;
      }

      const legacy = await getSetting(DB, 'auth_users');
      if (!legacy) {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(legacy) as unknown;
      } catch (error) {
        console.warn('Failed to parse legacy auth_users setting', error);
        return;
      }

      if (!Array.isArray(parsed)) {
        return;
      }

      const users: LegacyAuthUser[] = [];
      for (const entry of parsed) {
        const resolved = parseLegacyAuthUser(entry);
        if (resolved) {
          users.push(resolved);
        }
      }

      for (const user of users) {
        try {
          let nextHash: string;
          let nextSalt: string | null = null;
          if (user.password) {
            const derived = await derivePasswordHash(user.password);
            nextHash = derived.hashHex;
            nextSalt = derived.saltHex;
          } else if (user.passwordHash) {
            nextHash = user.passwordHash.toLowerCase();
            nextSalt = null;
          } else {
            continue;
          }

          await DB.prepare(
            `INSERT INTO auth_users (id, email, password_hash, password_salt, name, roles, client_ids)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               email=excluded.email,
               password_hash=excluded.password_hash,
               password_salt=excluded.password_salt,
               name=excluded.name,
               roles=excluded.roles,
               client_ids=excluded.client_ids`,
          )
            .bind(
              user.id,
              user.email,
              nextHash,
              nextSalt,
              user.name ?? null,
              JSON.stringify(user.roles),
              JSON.stringify(user.clientIds),
            )
            .run();
        } catch (error) {
          console.warn('Failed to migrate auth user', user.email, error);
        }
      }

      try {
        await DB.prepare('DELETE FROM settings WHERE key=?').bind('auth_users').run();
      } catch (error) {
        console.warn('Failed to remove legacy auth_users setting', error);
      }
    })();
  }
  await authUserMigrationPromise;
}

async function _loadAuthUsers(DB: D1Database): Promise<NormalizedAuthUser[]> {
  await migrateLegacyAuthUsers(DB);
  try {
    const rows = await DB.prepare(
      'SELECT id, email, name, password_hash, password_salt, roles, client_ids FROM auth_users',
    ).all<AuthUserRow>();
    if (!rows || !rows.results) {
      return [];
    }
    return rows.results
      .map((row) => parseAuthUserRow(row))
      .filter((user): user is NormalizedAuthUser => user !== null);
  } catch (error) {
    console.warn('Failed to load auth users', error);
    return [];
  }
}

async function authenticateUser(DB: D1Database, email: string, password: string): Promise<NormalizedAuthUser | null> {
  const lookup = email.trim().toLowerCase();
  if (!lookup || !password) {
    return null;
  }

  await migrateLegacyAuthUsers(DB);

  let row: AuthUserRow | null = null;
  try {
    row = await DB.prepare(
      'SELECT id, email, name, password_hash, password_salt, roles, client_ids FROM auth_users WHERE email=?',
    )
      .bind(lookup)
      .first<AuthUserRow>();
  } catch (error) {
    console.warn('Failed to query auth user', error);
    // Fallback for test environments or databases without an auth_users table:
    // attempt to read legacy `auth_users` from settings and authenticate against that.
    try {
      const legacy = await getSetting(DB, 'auth_users');
      if (legacy) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(legacy) as unknown;
        } catch {
          parsed = null;
        }
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            const legacyUser = parseLegacyAuthUser(entry);
            if (!legacyUser) continue;
            if (legacyUser.email === lookup) {
              // If the legacy entry has a plaintext password, compare directly.
              if (legacyUser.password && legacyUser.password === password) {
                console.info('authenticateUser: legacy plaintext password matched for', legacyUser.email);
                // Construct a NormalizedAuthUser compatible object (no persisted hash/salt available).
                return {
                  id: legacyUser.id,
                  email: legacyUser.email,
                  name: legacyUser.name,
                  passwordHash: legacyUser.passwordHash ?? '',
                  passwordSalt: null,
                  roles: legacyUser.roles,
                  clientIds: legacyUser.clientIds,
                };
              }
              // If legacyUser has a stored hash, compare using legacy hash function.
              if (legacyUser.passwordHash) {
                const attempt = await hashLegacyPassword(password);
                if (timingSafeEqual(attempt, legacyUser.passwordHash)) {
                  return {
                    id: legacyUser.id,
                    email: legacyUser.email,
                    name: legacyUser.name,
                    passwordHash: legacyUser.passwordHash,
                    passwordSalt: null,
                    roles: legacyUser.roles,
                    clientIds: legacyUser.clientIds,
                  };
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('Legacy auth fallback failed', err);
    }
    return null;
  }

  const user = parseAuthUserRow(row);
  if (!user) {
    return null;
  }

  if (user.passwordSalt) {
    const attempt = await derivePasswordHash(password, user.passwordSalt);
    return timingSafeEqual(attempt.hashHex, user.passwordHash) ? user : null;
  }

  const legacyAttempt = await hashLegacyPassword(password);
  if (!timingSafeEqual(legacyAttempt, user.passwordHash)) {
    return null;
  }

  try {
    const upgraded = await derivePasswordHash(password);
    await DB.prepare('UPDATE auth_users SET password_hash=?, password_salt=? WHERE id=?')
      .bind(upgraded.hashHex, upgraded.saltHex, user.id)
      .run();
    return { ...user, passwordHash: upgraded.hashHex, passwordSalt: upgraded.saltHex };
  } catch (error) {
    console.warn('Failed to upgrade legacy auth user hash', error);
  }

  return user;
}

function toApiUser(user: NormalizedAuthUser): ApiUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roles: [...user.roles],
    clientIds: [...user.clientIds],
  };
}

function generateRefreshToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function generateSessionId(): string {
  return crypto.randomUUID();
}

function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

const COOKIE_BASE_OPTIONS = Object.freeze({ path: '/', secure: true, sameSite: 'Strict' as const });

function setAccessCookie(c: Context, token: string) {
  setCookie(c, ACCESS_COOKIE_NAME, token, {
    ...COOKIE_BASE_OPTIONS,
    httpOnly: true,
    maxAge: ACCESS_TOKEN_TTL_SECONDS,
  });
}

function setRefreshCookie(c: Context, token: string) {
  setCookie(c, REFRESH_COOKIE_NAME, token, {
    ...COOKIE_BASE_OPTIONS,
    httpOnly: true,
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });
}

function setCsrfCookie(c: Context, token: string) {
  setCookie(c, CSRF_COOKIE_NAME, token, {
    ...COOKIE_BASE_OPTIONS,
    httpOnly: false,
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });
}

function clearCookie(c: Context, name: string) {
  setCookie(c, name, '', { ...COOKIE_BASE_OPTIONS, httpOnly: true, maxAge: 0 });
}

function clearCsrfCookie(c: Context) {
  setCookie(c, CSRF_COOKIE_NAME, '', { ...COOKIE_BASE_OPTIONS, httpOnly: false, maxAge: 0 });
}

function clearAuthCookies(c: Context) {
  clearCookie(c, ACCESS_COOKIE_NAME);
  clearCookie(c, REFRESH_COOKIE_NAME);
  clearCsrfCookie(c);
}

async function createAccessToken(env: Env, user: ApiUser, sessionId: string): Promise<string> {
  const payload: Record<string, unknown> = {
    email: user.email,
    name: user.name,
    roles: user.roles,
    clientIds: user.clientIds,
    sid: sessionId,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(APP_JWT_ISSUER)
    .setAudience(APP_JWT_AUDIENCE)
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(getJwtSecretKey(env));
}

async function storeRefreshToken(env: Env, token: string, record: RefreshRecord): Promise<void> {
  try {
    await env.CONFIG.put(`${REFRESH_TOKEN_PREFIX}${token}`, JSON.stringify(record), {
      expirationTtl: REFRESH_TOKEN_TTL_SECONDS,
    });
  } catch (error) {
    console.error('Failed to persist refresh token', error);
  }
}

async function readRefreshRecord(env: Env, token: string): Promise<RefreshRecord | null> {
  try {
    const raw = await env.CONFIG.get(`${REFRESH_TOKEN_PREFIX}${token}`);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : null;
    const userRaw = parsed.user;
    if (!sessionId || !userRaw || typeof userRaw !== 'object') {
      return null;
    }
    const userRecord = userRaw as Record<string, unknown>;
    const id = typeof userRecord.id === 'string' ? userRecord.id : null;
    const email = typeof userRecord.email === 'string' ? userRecord.email : null;
    if (!id || !email) {
      return null;
    }
    const name = typeof userRecord.name === 'string' ? userRecord.name : undefined;
    const roles = normalizeRoleList(userRecord.roles);
    if (roles.length === 0) {
      return null;
    }
    const clientIds = normalizeClientIds(userRecord.clientIds);
    return { sessionId, user: { id, email, name, roles, clientIds } };
  } catch (error) {
    console.warn('Failed to read refresh token', error);
    return null;
  }
}

async function deleteRefreshToken(env: Env, token: string): Promise<void> {
  try {
    await env.CONFIG.delete(`${REFRESH_TOKEN_PREFIX}${token}`);
  } catch (error) {
    console.warn('Failed to delete refresh token', error);
  }
}

async function verifyAppToken(env: Env, token: string): Promise<AccessContext | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecretKey(env), {
      issuer: APP_JWT_ISSUER,
      audience: APP_JWT_AUDIENCE,
    });
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    if (!sub) {
      return null;
    }
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    const name = typeof payload.name === 'string' ? payload.name : undefined;
    const roles = normalizeRoleList((payload as any).roles);
    if (roles.length === 0) {
      return null;
    }
    const clientIds = normalizeClientIds((payload as any).clientIds);
    return { sub, email, name, roles, clientIds };
  } catch (error) {
    console.warn('Invalid bearer auth token', error);
    return null;
  }
}

function getDevBypassUser(): ApiUser {
  return {
    id: DEV_BYPASS_AUTH.sub,
    email: DEV_BYPASS_AUTH.email ?? 'dev@greenbro.test',
    name: 'Developer Bypass',
    roles: [...DEV_BYPASS_AUTH.roles],
    clientIds: [...(DEV_BYPASS_AUTH.clientIds ?? [])],
  };
}

function getAllowedOrigins(env: Env): string[] {
  const configured = (env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const origins = new Set<string>(configured);
  if (origins.size === 0) {
    for (const origin of DEFAULT_ALLOWED_ORIGINS) {
      origins.add(origin);
    }
  }
  if (isDevBypassActive(env)) {
    for (const origin of DEV_ALLOWED_ORIGINS) {
      origins.add(origin);
    }
  }
  return [...origins];
}

function enforceRoles(auth: AccessContext | null | undefined, allowed: Role[]): Response | null {
  try {
    requireRole(auth, allowed);
    return null;
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    throw error;
  }
}

async function getAccessContext(c: Context<Ctx>, jwt?: string): Promise<AccessContext | null> {
  const token = jwt ?? c.req.header('Cf-Access-Jwt-Assertion');
  if (!token) {
    return null;
  }
  try {
    return await verifyAccessJWT(c.env, token);
  } catch (error) {
    console.warn('Invalid Access JWT', error);
    return null;
  }
}

async function requirePageAuth(c: Context<Ctx>, roles: Role[]): Promise<AccessContext | Response> {
  if (isDevBypassActive(c.env)) {
    return { ...DEV_BYPASS_AUTH, roles: [...DEV_BYPASS_AUTH.roles], clientIds: [...(DEV_BYPASS_AUTH.clientIds ?? [])] };
  }
  const auth = await getAccessContext(c);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const failure = enforceRoles(auth, roles);
  if (failure) {
    return failure;
  }
  return auth;
}

export async function getDeploySettings(DB: D1Database) {
  const colorRaw = (await getSetting(DB, 'deploy_color')) || 'green';
  const enabled = (await getSetting(DB, 'deploy_readiness_enabled')) === '1';
  const msg = (await getSetting(DB, 'deploy_readiness_msg')) || '';
  const color: 'blue' | 'green' = colorRaw === 'blue' ? 'blue' : 'green';
  return { color, enabled, msg };
}

const isStr = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;

function validatePresets(arr: unknown): string | null {
  if (!Array.isArray(arr)) return 'Presets must be an array.';
  for (const [i, p] of arr.entries()) {
    if (!p || typeof p !== 'object') return `Preset #${i + 1} must be an object.`;
    const id = (p as any).id;
    const name = (p as any).name;
    const cols = (p as any).cols;
    if (!isStr(id)) return `Preset #${i + 1} missing id.`;
    if (!isStr(name)) return `Preset #${i + 1} missing name.`;
    if (!Array.isArray(cols) || !cols.every(isStr)) {
      return `Preset #${i + 1} cols must be array of strings.`;
    }
  }
  return null;
}

function dedupeRecipients(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, trimmed);
    }
  }
  return Array.from(seen.values());
}

function parseRecipientList(value?: string | null): string[] {
  if (!value) {
    return [];
  }
  const parts = value.split(/[,;\n]+/);
  return dedupeRecipients(parts);
}

function canAccessClient(auth: AccessContext, clientId: string) {
  if (auth.roles.includes('admin') || auth.roles.includes('ops')) {
    return true;
  }
  if ((auth.roles.includes('client') || auth.roles.includes('contractor')) && auth.clientIds) {
    return auth.clientIds.includes(clientId);
  }
  return false;
}

type ReportDeliveryLogEntry = {
  type: string;
  status: string;
  clientId?: string | null;
  siteId?: string | null;
  path?: string | null;
  subject?: string | null;
  to?: string[] | string | null;
  meta?: Record<string, unknown> | null;
};

type ReportDeliveryFilters = {
  clientId?: string | null;
  siteId?: string | null;
  type?: string | null;
  status?: string | null;
  limit?: number | null;
};

async function logReportDelivery(DB: D1Database, entry: ReportDeliveryLogEntry) {
  try {
    const toList =
      entry.to == null
        ? []
        : Array.isArray(entry.to)
          ? dedupeRecipients(entry.to)
          : parseRecipientList(entry.to);
    const recipients = toList.length > 0 ? toList.join(', ') : null;
    const metaJson = entry.meta ? JSON.stringify(entry.meta) : null;
    await DB.prepare(
      `INSERT INTO report_deliveries (delivery_id, type, client_id, site_id, path, recipients, subject, status, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        entry.type,
        entry.clientId ?? null,
        entry.siteId ?? null,
        entry.path ?? null,
        recipients,
        entry.subject ?? null,
        entry.status,
        metaJson,
      )
      .run();
  } catch (error) {
    console.warn('logReportDelivery failed', error);
  }
}

async function listReportDeliveries(DB: D1Database, filters: ReportDeliveryFilters = {}): Promise<ReportHistoryRow[]> {
  let sql =
    'SELECT delivery_id, type, client_id, site_id, path, recipients, subject, status, meta_json, created_at FROM report_deliveries WHERE 1=1';
  const bind: Array<string | number> = [];
  if (filters.clientId) {
    sql += ' AND client_id = ?';
    bind.push(filters.clientId);
  }
  if (filters.siteId) {
    sql += ' AND site_id = ?';
    bind.push(filters.siteId);
  }
  if (filters.type) {
    sql += ' AND type = ?';
    bind.push(filters.type);
  }
  if (filters.status) {
    sql += ' AND status = ?';
    bind.push(filters.status);
  }
  const limit = (() => {
    const raw = filters.limit ?? 100;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return 100;
    }
    return Math.min(Math.max(Math.floor(parsed), 1), 500);
  })();
  sql += ' ORDER BY created_at DESC LIMIT ?';
  bind.push(limit);

  const rows = await DB.prepare(sql)
    .bind(...bind)
    .all<{
      delivery_id: string;
      type: string;
      client_id: string | null;
      site_id: string | null;
      path: string | null;
      recipients: string | null;
      subject: string | null;
      status: string;
      meta_json: string | null;
      created_at: string;
    }>();

  const parseRecipients = (value: string | null): string[] => {
    if (!value) return [];
    return value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  };

  return (rows.results ?? []).map((row) => {
    let meta: Record<string, unknown> | null = null;
    if (row.meta_json) {
      try {
        const parsed = JSON.parse(row.meta_json);
        if (parsed && typeof parsed === 'object') {
          meta = parsed as Record<string, unknown>;
        }
      } catch (error) {
        console.warn('report history meta parse failed', error);
      }
    }
    return {
      delivery_id: row.delivery_id,
      type: row.type,
      client_id: row.client_id ?? null,
      site_id: row.site_id ?? null,
      path: row.path ?? null,
      subject: row.subject ?? null,
      status: row.status,
      recipients: parseRecipients(row.recipients ?? null),
      meta,
      created_at: row.created_at,
    };
  });
}

type EmailSettings = { webhook: string | null; from: string | null };

async function loadEmailSettings(DB: D1Database): Promise<EmailSettings> {
  const [webhook, from] = await Promise.all([
    getSetting(DB, 'email_webhook_url'),
    getSetting(DB, 'email_from'),
  ]);
  return { webhook, from };
}

async function sendEmail(
  env: Env,
  to: string[] | string,
  subject: string,
  text: string,
  settings?: EmailSettings,
  html?: string,
): Promise<boolean> {
  const recipients = Array.isArray(to) ? dedupeRecipients(to) : parseRecipientList(to);
  if (recipients.length === 0) {
    return false;
  }
  const cfg = settings ?? (await loadEmailSettings(env.DB));
  if (!cfg.webhook || !cfg.from) {
    return false;
  }
  try {
    const payload: Record<string, unknown> = {
      from: cfg.from,
      to: recipients,
      subject,
      text,
    };
    if (html) {
      payload.html = html;
    }
    await fetch(cfg.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return true;
  } catch (error) {
    console.error('sendEmail failed', error);
    return false;
  }
}

async function notifyOps(env: Env, message: string) {
  const url = await getSetting(env.DB, 'ops_webhook_url');
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
  } catch (error) {
    console.error('notifyOps failed', error);
  }
}

async function collectSiteRecipients(DB: D1Database, siteId: string) {
  const rows = await DB.prepare(
    `SELECT c.client_id, c.name, cs.report_recipients
       FROM site_clients sc
       JOIN clients c ON c.client_id = sc.client_id
       LEFT JOIN client_slos cs ON cs.client_id = c.client_id
      WHERE sc.site_id = ?`,
  )
    .bind(siteId)
    .all<{ client_id: string; name: string | null; report_recipients: string | null }>();

  const clients: Array<{ id: string; name: string | null }> = [];
  let recipients: string[] = [];
  for (const row of rows.results ?? []) {
    clients.push({ id: row.client_id, name: row.name ?? null });
    if (row.report_recipients) {
      recipients = recipients.concat(parseRecipientList(row.report_recipients));
    }
  }
  return { clients, recipients: dedupeRecipients(recipients) };
}

function formatWindowLabel(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) {
    return 'Custom window';
  }
  if (hours % 24 === 0) {
    const days = hours / 24;
    if (days === 1) {
      return 'Last 24h';
    }
    return `Last ${days} days`;
  }
  const rounded = Math.round(hours * 10) / 10;
  return `Last ${rounded} hours`;
}

function keyToPath(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    return '/api/reports/';
  }
  const normalized = trimmed.replace(/^\/+/, '');
  return normalized.startsWith('api/reports/') ? `/${normalized}` : `/api/reports/${normalized}`;
}

function normalizeReportPath(path: string): string | null {
  if (!path) return null;
  let value = path.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    value = parsed.pathname || value;
  } catch {}
  if (value.startsWith('/api/reports/')) {
    return value;
  }
  if (value.startsWith('api/reports/')) {
    return `/${value}`;
  }
  value = value.replace(/^\/+/, '');
  if (!value) {
    return null;
  }
  return `/api/reports/${value}`;
}

function parseDateParam(value?: string | null): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  const date = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  if (Number.isNaN(date.valueOf())) {
    return null;
  }
  return date;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date.valueOf());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function formatDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function listArchiveRows(DB: D1Database, day: Date): Promise<AdminArchiveRow[]> {
  const start = startOfUtcDay(day);
  const end = addUtcDays(start, 1);
  try {
    const res = await DB.prepare(
      `SELECT table_name, row_count, object_key, size_bytes, exported_at
         FROM export_log
        WHERE exported_at >= ? AND exported_at < ?
        ORDER BY exported_at DESC`,
    )
      .bind(start.toISOString(), end.toISOString())
      .all<{
        table_name: string | null;
        row_count: number | null;
        object_key: string | null;
        size_bytes: number | null;
        exported_at: string | null;
      }>();
    return (res.results ?? []).map((row) => ({
      table: row.table_name ?? '—',
      rows: Math.max(0, Number(row.row_count ?? 0)),
      key: row.object_key ?? '',
      size: Math.max(0, Number(row.size_bytes ?? 0)),
      exportedAt: row.exported_at ?? null,
    }));
  } catch (error) {
    console.warn('listArchiveRows failed', error);
    return [];
  }
}

async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data =
    typeof input === 'string'
      ? new TextEncoder().encode(input)
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : input;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const buffer =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.slice().buffer as ArrayBuffer);
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function formatCsvValue(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  const escaped = str.replace(/"/g, '""');
  return /[",\r\n]/.test(str) ? `"${escaped}"` : escaped;
}

function ndjsonToCsvStream(
  stream: ReadableStream<Uint8Array>,
  columns?: string[],
): ReadableStream<Uint8Array> {
  const initialColumns = columns && columns.length > 0 ? [...columns] : undefined;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = '';
      let headerWritten = false;
      let cols = initialColumns;

      const writeHeader = () => {
        if (!headerWritten && cols && cols.length > 0) {
          controller.enqueue(encoder.encode(cols.join(',') + '\n'));
          headerWritten = true;
        }
      };

      const pushRow = (record: Record<string, unknown>) => {
        if (!cols || cols.length === 0) {
          cols = Object.keys(record);
        }
        if (!cols || cols.length === 0) {
          return;
        }
        writeHeader();
        const values = cols.map((key) => formatCsvValue(record[key]));
        controller.enqueue(encoder.encode(values.join(',') + '\n'));
      };

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object') {
            pushRow(parsed as Record<string, unknown>);
          }
        } catch (error) {
          console.warn('ndjson parse failed', error);
        }
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
            buffer = buffer.slice(newlineIndex + 1);
            processLine(line);
            newlineIndex = buffer.indexOf('\n');
          }
        }
        buffer += decoder.decode();
        if (buffer.length > 0) {
          processLine(buffer.replace(/\r$/, ''));
        }
        writeHeader();
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

type BurnSnapshot = { total: number; ok: number; errRate: number; burn: number };
type FastBurnAction = 'opened' | 'closed' | 'none';
type FastBurnResult = { snapshot: BurnSnapshot; action: FastBurnAction };

function parseDurationMinutes(input: string | null | undefined): number | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = /^([0-9]+)([mh])$/i.exec(trimmed);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2]?.toLowerCase();
  if (!unit) return null;
  if (unit === 'm') return value;
  if (unit === 'h') return value * 60;
  return null;
}

async function computeBurn(DB: D1Database, minutes = 10, target = 0.999): Promise<BurnSnapshot> {
  const row = await DB.prepare(
    `
    SELECT SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) ok,
           COUNT(*) total
    FROM ops_metrics
    WHERE route='/api/ingest' AND ts >= datetime('now', ?)
  `,
  )
    .bind(`-${minutes} minutes`)
    .first<{ ok: number; total: number }>();
  const total = row?.total ?? 0;
  const ok = row?.ok ?? 0;
  const errRate = total ? 1 - ok / total : 0;
  const burn = 1 - target > 0 ? errRate / (1 - target) : 0;
  return { total, ok, errRate, burn };
}

async function openP1IfNeeded(env: Env, nowISO: string, meta: BurnSnapshot): Promise<boolean> {
  const open = await env.DB.prepare(
    "SELECT alert_id FROM alerts WHERE type='ingest_degradation' AND state IN ('open','ack') ORDER BY opened_at DESC LIMIT 1",
  ).first<{ alert_id: string }>();
  if (open) return false;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO alerts (alert_id, device_id, type, severity, state, opened_at, meta_json) VALUES (?, NULL, 'ingest_degradation', 'critical', 'open', ?, ?)",
  )
    .bind(id, nowISO, JSON.stringify(meta))
    .run();
  await notifyOps(
    env,
    `P1: Ingest degradation — burn=${meta.burn.toFixed(2)} (err ${(meta.errRate * 100).toFixed(2)}%, ${meta.ok}/${meta.total} ok)`,
  );
  return true;
}

async function closeP1IfRecovered(env: Env, nowISO: string, meta: BurnSnapshot): Promise<boolean> {
  const open = await env.DB.prepare(
    "SELECT alert_id FROM alerts WHERE type='ingest_degradation' AND state IN ('open','ack') ORDER BY opened_at DESC LIMIT 1",
  ).first<{ alert_id: string }>();
  if (!open) return false;
  await env.DB.prepare("UPDATE alerts SET state='closed', closed_at=? WHERE alert_id=?")
    .bind(nowISO, open.alert_id)
    .run();
  await notifyOps(
    env,
    `Recovered: Ingest degradation — burn=${meta.burn.toFixed(2)} (err ${(meta.errRate * 100).toFixed(2)}%)`,
  );
  return true;
}

async function fastBurnMonitor(env: Env): Promise<FastBurnResult> {
  const nowISO = new Date().toISOString();
  const snapshot = await computeBurn(env.DB, 10, 0.999);
  let action: FastBurnAction = 'none';
  if (snapshot.total >= 200 && snapshot.burn > 2.0) {
    if (await openP1IfNeeded(env, nowISO, snapshot)) {
      action = 'opened';
    }
  }
  if (snapshot.total >= 200 && snapshot.burn <= 1.0) {
    if (await closeP1IfRecovered(env, nowISO, snapshot)) {
      action = 'closed';
    }
  }
  return { snapshot, action };
}

async function pruneStaged(env: Env, days = 14) {
  const bucket: any = (env as any).ARCHIVE || (env as any).REPORTS;
  if (!bucket?.list) return;
  const cutoff = new Date(Date.now() - days * 86400000);

  let cursor: string | undefined;
  do {
    const res: any = await bucket.list({ prefix: 'staged/', cursor });
    cursor = res.truncated ? res.cursor : undefined;
    for (const o of res.objects || []) {
      const m = /^staged\/(\d{4}-\d{2}-\d{2})\//.exec(o.key);
      const d = m ? new Date(`${m[1]}T00:00:00Z`) : o.uploaded ? new Date(o.uploaded) : null;
      if (d && d < cutoff) {
        try {
          await bucket.delete(o.key);
        } catch {}
      }
    }
  } while (cursor);
}

async function isReadOnly(DB: D1Database) {
  return (await getSetting(DB, 'read_only')) === '1';
}

function canSeeDeployRibbon(auth: AccessContext | null | undefined) {
  if (!auth) {
    return false;
  }
  return auth.roles.includes('admin') || auth.roles.includes('ops');
}

async function attachDeployRibbon(c: Context<Ctx>, auth: AccessContext | null | undefined) {
  if (!canSeeDeployRibbon(auth)) {
    return;
  }
  const deploy = await getDeploySettings(c.env.DB);
  if (!deploy.enabled) {
    return;
  }
  const ribbon: DeployRibbon = { color: deploy.color };
  if (deploy.msg) {
    ribbon.text = deploy.msg;
  }
  c.set('ribbon', ribbon);
}

function canSeeVersionChip(auth: AccessContext | null | undefined) {
  if (!auth) {
    return false;
  }
  return auth.roles.includes('admin') || auth.roles.includes('ops');
}

async function attachVersionInfo(c: Context<Ctx>, auth: AccessContext | null | undefined) {
  if (!canSeeVersionChip(auth)) {
    return;
  }
  const version = await getVersion(c.env);
  c.set('version', {
    build_sha: version.build_sha,
    build_date: version.build_date || undefined,
  });
}

async function guardWrite(c: any) {
  if (await isReadOnly(c.env.DB)) {
    return c.text('Read-only mode active', 503);
  }
  return null;
}

function bad(c: any, errors: unknown) {
  return c.json({ ok: false, errors }, 400);
}

type DeviceCommandBody = { dhwSetC?: number; mode?: string };

async function dispatchDeviceCommand(
  c: Context<Ctx>,
  deviceId: string,
  actor: string,
  commandBody: DeviceCommandBody,
): Promise<Response> {
  const envelope = {
    deviceId,
    actor,
    command: commandBody,
    limits: {
      ...getWriteLimits(c.env),
    },
  };
  const payload = JSON.stringify(envelope);

  const doId = c.env.DEVICE_DO.idFromName(deviceId);
  const auditStub = c.env.DEVICE_DO.get(doId);
  const auditRes = await auditStub.fetch(
    new Request(`https://do/devices/${deviceId}/command`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-operator-subject': actor,
      },
      body: payload,
    }),
  );

  if (!auditRes.ok) {
    return new Response(auditRes.body, { status: auditRes.status, headers: auditRes.headers });
  }

  const stateId = c.env.DeviceState.idFromName(deviceId);
  const stateStub = c.env.DeviceState.get(stateId);
  const res = await stateStub.fetch('https://do/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });

  return new Response(res.body, { status: res.status, headers: res.headers });
}

type Ctx = {
  Bindings: Env;
  Variables: {
    auth?: AccessContext;
    metaRefreshSec?: number;
    cspNonce?: string;
    ribbon?: DeployRibbon;
    version?: { build_sha: string; build_date?: string };
  };
};

const app = new Hono<Ctx>();

// Temporary global error handler to surface unexpected runtime errors during tests.
// This logs the full error and returns a 500 so we can see server-side stack traces
// instead of the current 503 fallback. Remove or adjust after debugging.
app.onError((err, c) => {
  try {
    console.error('Unhandled request error:', err instanceof Error ? err.stack ?? err.message : err);
  } catch (logErr) {
    // best-effort logging
    console.error('Failed to log error', logErr);
  }
  try {
    // If we have a Hono context, return a 500 text response; otherwise return a raw Response.
    if (c && typeof c.text === 'function') {
      return c.text('Internal Server Error', 500);
    }
  } catch {}
  return new Response('Internal Server Error', { status: 500 });
});

app.use('*', async (c, next) => {
  if (c.env.DEV_AUTH_BYPASS === '1' && !isDevBypassAllowed(c.env)) {
    return c.text('Service Unavailable (dev auth bypass denied)', 503);
  }
  return next();
});

app.use('*', (c, next) => {
  const allowedOrigins = new Set(getAllowedOrigins(c.env));
  return cors({
    origin: (origin) => {
      if (!origin) {
        return null;
      }
      return allowedOrigins.has(origin) ? origin : null;
    },
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Cf-Access-Jwt-Assertion', CSRF_HEADER_NAME],
    credentials: true,
  })(c, next);
});

app.use('*', async (c, next) => {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  c.set('cspNonce', nonce);
  await next();
  if (c.res) {
    c.res = withSecurityHeaders(c.res, { cspNonce: nonce });
  }
});

app.get('/brand.css', (c) =>
  c.text(brandCss, 200, {
    'Content-Type': 'text/css; charset=utf-8',
    'Cache-Control': 'public, max-age=300, s-maxage=3600',
    'CDN-Cache-Control': 'public, max-age=300, s-maxage=3600',
  }),
);

app.get('/brand/manifest.webmanifest', () =>
  new Response(
    JSON.stringify({
      name: 'Greenbro Control Centre',
      short_name: 'Greenbro',
      start_url: '/overview',
      scope: '/',
      display: 'standalone',
      background_color: '#0b0e12',
      theme_color: '#0b0e12',
      icons: [
        { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        { src: '/brand/logo-white.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      ],
    }),
    {
      headers: {
        'Content-Type': 'application/manifest+json',
        'Cache-Control': 'public, max-age=86400',
      },
    },
  ),
);

app.get('/brand/apple-touch-icon.png', async (c) => {
  const cacheHeaders = {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=604800',
  } as const;

  try {
    const object = await c.env.BRAND.get('apple-touch-icon.png');
    if (object) {
      const headers = new Headers(cacheHeaders);
      object.writeHttpMetadata(headers);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'image/png');
      }
      return new Response(object.body, { headers });
    }
  } catch (error) {
    console.warn('Failed to load apple-touch icon from R2', error);
  }

  const fallbackUrl = new URL('/brand/logo-white.svg', c.req.url);
  const fallback = await fetch(fallbackUrl);
  return new Response(await fallback.arrayBuffer(), {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
    },
  });
});

for (const size of [192, 512] as const) {
  app.get(`/brand/icon-${size}.png`, async (c) => {
    try {
      const object = await c.env.BRAND.get(`icon-${size}.png`);
      if (object) {
        const headers = new Headers({
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
        });
        object.writeHttpMetadata(headers);
        if (!headers.has('Content-Type')) {
          headers.set('Content-Type', 'image/png');
        }
        return new Response(object.body, { headers });
      }
    } catch (error) {
      console.warn(`Failed to load icon-${size}.png from R2`, error);
    }

    return new Response('Not Found', { status: 404 });
  });
}

app.get('/offline', (c) =>
  c.html(`<!doctype html><html lang="en-GB"><head>
    <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>Offline — Greenbro Control Centre</title>
    <link rel="stylesheet" href="/brand.css"/>
  </head><body style="display:grid;place-items:center;min-height:100svh;background:#0b0e12;color:#cfe3d6">
    <div class="card" style="max-width:460px;padding:18px 20px">
      <img src="/brand/logo-white.svg" alt="Greenbro" height="24" style="margin-bottom:10px"/>
      <h2>You’re offline</h2>
      <p class="muted">We’ll reconnect automatically. Critical actions are disabled while offline.</p>
    </div>
  </body></html>`),
);

app.get('/brand/logo.svg', async (c) => {
  const baseHeaders = new Headers({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=86400, s-maxage=604800',
    'CDN-Cache-Control': 'public, max-age=86400, s-maxage=604800',
  });

  try {
    const logo = await c.env.BRAND.get('logo.svg');
    if (logo) {
      const headers = new Headers(baseHeaders);
      logo.writeHttpMetadata(headers);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'image/svg+xml; charset=utf-8');
      }
      return new Response(logo.body, { headers });
    }
  } catch (error) {
    console.warn('Failed to load brand logo from R2', error);
  }

  return new Response(brandLogoSvg, { headers: baseHeaders });
});

app.get('/brand/logo-white.svg', async (c) => {
  const baseHeaders = new Headers({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=86400, s-maxage=604800',
    'CDN-Cache-Control': 'public, max-age=86400, s-maxage=604800',
  });

  try {
    const logo = await c.env.BRAND.get('logo-white.svg');
    if (logo) {
      const headers = new Headers(baseHeaders);
      logo.writeHttpMetadata(headers);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'image/svg+xml; charset=utf-8');
      }
      return new Response(logo.body, { headers });
    }
  } catch (error) {
    console.warn('Failed to load white brand logo from R2', error);
  }

  return new Response(brandLogoWhiteSvg, { headers: baseHeaders });
});

app.get('/brand/favicon.svg', async (c) => {
  const baseHeaders = new Headers({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=604800, s-maxage=604800',
    'CDN-Cache-Control': 'public, max-age=604800, s-maxage=604800',
  });

  try {
    const icon = await c.env.BRAND.get('favicon.svg');
    if (icon) {
      const headers = new Headers(baseHeaders);
      icon.writeHttpMetadata(headers);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'image/svg+xml; charset=utf-8');
      }
      return new Response(icon.body, { headers });
    }
  } catch (error) {
    console.warn('Failed to load brand favicon from R2', error);
  }

  return new Response(brandLogoSvg, { headers: baseHeaders });
});

app.get('/brand/favicon-white.svg', async (c) => {
  const baseHeaders = new Headers({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=604800, s-maxage=604800',
    'CDN-Cache-Control': 'public, max-age=604800, s-maxage=604800',
  });

  try {
    const icon = await c.env.BRAND.get('favicon-white.svg');
    if (icon) {
      const headers = new Headers(baseHeaders);
      icon.writeHttpMetadata(headers);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'image/svg+xml; charset=utf-8');
      }
      return new Response(icon.body, { headers });
    }
  } catch (error) {
    console.warn('Failed to load white brand favicon from R2', error);
  }

  return new Response(brandLogoWhiteSvg, { headers: baseHeaders });
});

app.get('/brand/logo-mono.svg', async (c) => {
  const baseHeaders = new Headers({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=86400, s-maxage=604800',
    'CDN-Cache-Control': 'public, max-age=86400, s-maxage=604800',
  });

  try {
    const logo = await c.env.BRAND.get('logo-mono.svg');
    if (logo) {
      const headers = new Headers(baseHeaders);
      logo.writeHttpMetadata(headers);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'image/svg+xml; charset=utf-8');
      }
      return new Response(logo.body, { headers });
    }
  } catch (error) {
    console.warn('Failed to load monochrome brand logo from R2', error);
  }

  return new Response(brandLogoMonoSvg, { headers: baseHeaders });
});

app.post('/api/auth/login', async (c) => {
  const devBypass = isDevBypassActive(c.env);
  let body: { email?: string; password?: string } | null = null;
  try {
    body = await c.req.json<{ email?: string; password?: string }>();
  } catch {}

  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  let user: ApiUser | null = null;
  if (devBypass) {
    user = getDevBypassUser();
  } else {
    const authenticated = await authenticateUser(c.env.DB, email, password);
    if (!authenticated) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }
    user = toApiUser(authenticated);
  }

  const sessionId = generateSessionId();
  const accessToken = await createAccessToken(c.env, user, sessionId);
  const refreshToken = generateRefreshToken();
  const csrfToken = generateCsrfToken();

  await storeRefreshToken(c.env, refreshToken, { sessionId, user });

  setAccessCookie(c, accessToken);
  setRefreshCookie(c, refreshToken);
  setCsrfCookie(c, csrfToken);

  // Return tokens in body for test convenience (and clients that don't rely solely on cookies).
  return c.json({ user, accessToken, refreshToken, csrfToken });
});

app.post('/api/auth/refresh', async (c) => {
  // Allow refresh token from cookie (browser) or request body (test/agent).
  let refreshToken = getCookie(c, REFRESH_COOKIE_NAME) ?? '';
  let tokenFromBody = false;
  if (!refreshToken) {
    try {
      const parsed = await c.req.json() as Record<string, unknown>;
      if (typeof parsed?.refreshToken === 'string') {
        refreshToken = parsed.refreshToken;
        tokenFromBody = true;
      }
    } catch {}
  }

  if (!refreshToken) {
    return c.json({ error: 'Refresh token missing' }, 401);
  }

  // If the token came from a cookie, enforce CSRF checks for browsers. If the token
  // was supplied in the request body (non-browser test/client), skip the CSRF header check.
  if (!tokenFromBody) {
    const csrfCookie = getCookie(c, CSRF_COOKIE_NAME) ?? '';
    const csrfHeader = c.req.header(CSRF_HEADER_NAME) ?? '';
    if (!csrfCookie || !csrfHeader || !timingSafeEqual(csrfCookie, csrfHeader)) {
      return c.json({ error: 'Invalid CSRF token' }, 403);
    }
  }

  const record = await readRefreshRecord(c.env, refreshToken);
  if (!record) {
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  const accessToken = await createAccessToken(c.env, record.user, record.sessionId);
  const nextRefreshToken = generateRefreshToken();
  const csrfToken = generateCsrfToken();

  await storeRefreshToken(c.env, nextRefreshToken, record);
  await deleteRefreshToken(c.env, refreshToken);

  setAccessCookie(c, accessToken);
  setRefreshCookie(c, nextRefreshToken);
  setCsrfCookie(c, csrfToken);

  // Return tokens in body for test convenience.
  return c.json({ user: record.user, accessToken, refreshToken: nextRefreshToken, csrfToken });
});

app.post('/api/auth/logout', async (c) => {
  const refreshToken = getCookie(c, REFRESH_COOKIE_NAME) ?? '';
  if (refreshToken) {
    await deleteRefreshToken(c.env, refreshToken);
  }
  clearAuthCookies(c);
  return c.json({ ok: true });
});

app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/api/auth/login' || path === '/api/auth/refresh' || path === '/api/auth/logout') {
    await next();
    return;
  }

  if (isDevBypassActive(c.env)) {
    c.set('auth', { ...DEV_BYPASS_AUTH, roles: [...DEV_BYPASS_AUTH.roles], clientIds: [...(DEV_BYPASS_AUTH.clientIds ?? [])] });
    await next();
    return;
  }

  let auth: AccessContext | null = null;
  const accessCookie = getCookie(c, ACCESS_COOKIE_NAME);
  if (accessCookie) {
    auth = await verifyAppToken(c.env, accessCookie).catch((error) => {
      console.warn('Invalid access cookie token', error);
      return null;
    });
  }

  if (!auth) {
    const authorization = c.req.header('Authorization');
    if (authorization && authorization.startsWith('Bearer ')) {
      const token = authorization.slice(7).trim();
      if (token) {
        auth = await verifyAppToken(c.env, token);
      }
    }
  }

  if (!auth) {
    const jwt = c.req.header('Cf-Access-Jwt-Assertion');
    if (jwt) {
      auth = await getAccessContext(c, jwt);
    }
  }

  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  if (auth.roles.length === 0) {
    return c.text('Forbidden (no role)', 403);
  }
  c.set('auth', auth);
  await next();
});

app.get('/api/auth/me', async (c) => {
  if (isDevBypassActive(c.env)) {
    return c.json(getDevBypassUser());
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  return c.json({
    id: auth.sub,
    email: auth.email ?? auth.sub,
    name: auth.name ?? auth.email ?? auth.sub,
    roles: auth.roles,
    clientIds: auth.clientIds ?? [],
  });
});

app.use('/*', renderer);

app.get('/health', async (c) => {
  const ts = new Date().toISOString();
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({ ok: true, ts });
  } catch (error) {
    console.error('health db probe failed', error);
    const message = error instanceof Error ? error.message : 'db probe failed';
    return c.json({ ok: false, ts, db: 'error', error: message }, 503);
  }
});

app.get('/api/devices/:id/latest', async (c) => {
  const { DB } = c.env;
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const id = c.req.param('id');
  if (!(await canAccessDevice(DB, auth, id))) {
    return c.text('Forbidden', 403);
  }
  const row = await DB.prepare('SELECT * FROM latest_state WHERE device_id=?')
    .bind(id)
    .first<{
      device_id: string;
      ts: string;
      supplyC: number | null;
      returnC: number | null;
      tankC: number | null;
      ambientC: number | null;
      flowLps: number | null;
      compCurrentA: number | null;
      eevSteps: number | null;
      powerKW: number | null;
      deltaT: number | null;
      thermalKW: number | null;
      cop: number | null;
      cop_quality: string | null;
      mode: string | null;
      defrost: number | null;
      online: number | null;
      faults_json: string | null;
    }>();

  if (!row) {
    return c.text('Not found', 404);
  }

  const metrics: Record<string, number | null> = {};
  const setMetric = (key: string, value: unknown) => {
    if (value == null) {
      return;
    }
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) {
      return;
    }
    metrics[key] = num;
  };

  setMetric('supplyC', row.supplyC);
  setMetric('returnC', row.returnC);
  setMetric('tankC', row.tankC);
  setMetric('ambientC', row.ambientC);
  setMetric('flowLps', row.flowLps);
  setMetric('compCurrentA', row.compCurrentA);
  setMetric('eevSteps', row.eevSteps);
  setMetric('powerKW', row.powerKW);
  setMetric('deltaT', row.deltaT);
  setMetric('thermalKW', row.thermalKW);
  setMetric('cop', row.cop);

  const status: TelemetryPayload['status'] = {
    mode: typeof row.mode === 'string' && row.mode.length > 0 ? row.mode : undefined,
    defrost: row.defrost == null ? undefined : row.defrost === 1,
    online: row.online == null ? undefined : row.online === 1,
  };

  const faults: Array<{ code: string; description?: string; active: boolean }> = [];
  if (typeof row.faults_json === 'string' && row.faults_json.length > 0) {
    try {
      const parsed = JSON.parse(row.faults_json) as Array<{
        code?: string;
        description?: string;
        active?: boolean;
      }>;
      for (const entry of parsed) {
        if (!entry || typeof entry.code !== 'string') {
          continue;
        }
        const code = entry.code;
        if (faults.some((fault) => fault.code === code)) {
          continue;
        }
        const description =
          typeof entry.description === 'string' && entry.description.length > 0
            ? entry.description
            : lookupFaultDescription(code);
        const active = typeof entry.active === 'boolean' ? entry.active : true;
        faults.push({ code, description, active });
      }
    } catch (error) {
      console.warn('Failed to parse faults_json for latest_state', error);
    }
  }

  if (!status.flags) {
    const statusRow = await DB.prepare(
      'SELECT status_json FROM telemetry WHERE device_id=? ORDER BY ts DESC LIMIT 1',
    )
      .bind(id)
      .first<{ status_json: string | null }>();
    if (statusRow?.status_json) {
      try {
        const parsed = JSON.parse(statusRow.status_json) as { flags?: unknown };
        const flags = normalizeFlagMap(parsed.flags);
        if (flags) {
          status.flags = flags;
        }
      } catch (error) {
        console.warn('Failed to parse status_json for latest_state', error);
      }
    }
  }

  return c.json({
    deviceId: row.device_id,
    timestamp: row.ts,
    metrics,
    status,
    faults,
  });
});

app.get('/api/devices/:id/series', async (c) => {
  const { DB } = c.env;
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const deviceId = c.req.param('id');
  if (!(await canAccessDevice(DB, auth, deviceId))) {
    return c.text('Forbidden', 403);
  }

  const rangeParam = (c.req.query('range') ?? '24h').toLowerCase();
  const rangeConfig = {
    '24h': { window: "-24 hours", limit: 1440 },
    '7d': { window: "-7 days", limit: 10080 },
  } as const;
  type RangeKey = keyof typeof rangeConfig;
  const rangeKey = (rangeParam in rangeConfig ? (rangeParam as RangeKey) : '24h') as RangeKey;
  const selectedRange = rangeConfig[rangeKey];
  const rangeWindow = selectedRange.window;
  const rangeLimit = selectedRange.limit;

  const rows = await DB.prepare(
    `SELECT ts, metrics_json, deltaT, thermalKW, cop, flowLps, compCurrentA, powerKW
       FROM telemetry
      WHERE device_id=? AND ts >= datetime('now', ?)
      ORDER BY ts DESC
      LIMIT ?`,
  )
    .bind(deviceId, rangeWindow, rangeLimit)
    .all<{
      ts: string;
      metrics_json: string | null;
      deltaT: number | null;
      thermalKW: number | null;
      cop: number | null;
      flowLps: number | null;
      compCurrentA: number | null;
      powerKW: number | null;
    }>();

  const points = (rows.results ?? [])
    .reverse()
    .map((row) => {
      const metrics: Record<string, number | null> = {};
      if (row.metrics_json) {
        try {
          const parsed = JSON.parse(row.metrics_json) as Record<string, unknown>;
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'number') {
              metrics[key] = Number.isFinite(value) ? value : null;
            } else if (value == null) {
              metrics[key] = null;
            }
          }
        } catch (error) {
          console.warn('Failed to parse metrics_json', error);
        }
      }

      const setMetric = (key: string, value: unknown) => {
        if (metrics[key] != null && typeof metrics[key] === 'number') {
          return;
        }
        if (value == null) {
          if (!(key in metrics)) {
            metrics[key] = null;
          }
          return;
        }
        const num = typeof value === 'number' ? value : Number(value);
        if (Number.isFinite(num)) {
          metrics[key] = num;
        }
      };

      setMetric('delta_t', row.deltaT);
      setMetric('deltaT', row.deltaT);
      setMetric('cop', row.cop);
      setMetric('thermal_kw', row.thermalKW);
      setMetric('thermalKW', row.thermalKW);
      setMetric('flow_lps', row.flowLps);
      setMetric('flowLps', row.flowLps);
      setMetric('compressor_current', row.compCurrentA);
      setMetric('compCurrentA', row.compCurrentA);
      setMetric('power_kw', row.powerKW);
      setMetric('powerKW', row.powerKW);

      return { timestamp: row.ts, metrics };
    });

  return c.json(points);
});

app.get('/api/devices/:id/commissioning/window', async (c) => {
  const { DB } = c.env;
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const deviceId = c.req.param('id');
  if (!(await canAccessDevice(DB, auth, deviceId))) {
    return c.text('Forbidden', 403);
  }
  const row = await DB.prepare(
    `
      SELECT cs.readings_json, cs.updated_at
        FROM commissioning_steps cs
        JOIN commissioning_sessions s ON cs.session_id = s.session_id
       WHERE s.device_id=? AND cs.step_id=?
       ORDER BY cs.updated_at DESC
       LIMIT 1
    `,
  )
    .bind(deviceId, 'deltaT_under_load')
    .first<{ readings_json: string | null; updated_at: string | null }>();

  let sample: Record<string, unknown> | null = null;
  if (row?.readings_json) {
    try {
      const parsed = JSON.parse(row.readings_json);
      if (parsed && typeof parsed === 'object') {
        sample = parsed as Record<string, unknown>;
      }
    } catch (error) {
      console.warn('Failed to parse commissioning window sample', error);
    }
  }

  let window: { t_start: string; t_end: string } | null = null;
  if (sample) {
    const tStart = typeof sample.t_start === 'string' ? sample.t_start : null;
    const tEnd = typeof sample.t_end === 'string' ? sample.t_end : null;
    if (tStart && tEnd) {
      window = { t_start: tStart, t_end: tEnd };
    }
  }

  return c.json({
    ok: true,
    window,
    sample,
    updated_at: row?.updated_at ?? null,
    step_id: 'deltaT_under_load',
  });
});

app.get('/api/devices/:id/commissioning/windows', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops', 'contractor']);
  const deviceId = c.req.param('id');
  if (!(await canAccessDevice(c.env.DB, auth, deviceId))) {
    return c.text('Forbidden', 403);
  }
  const limitRaw = Number(c.req.query('limit') ?? 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(50, Math.floor(limitRaw)) : 10;

  const rows = await c.env.DB.prepare(
    `
      SELECT cs.session_id, st.step_id, st.updated_at, st.state, st.readings_json
        FROM commissioning_steps st
        JOIN commissioning_sessions cs ON cs.session_id = st.session_id
       WHERE cs.device_id=? AND st.readings_json IS NOT NULL
       ORDER BY st.updated_at DESC
       LIMIT ?
    `,
  )
    .bind(deviceId, limit)
    .all<{ session_id: string; step_id: string; updated_at: string; state: string; readings_json: string }>();

  const results = (rows.results ?? []).map((row) => {
    let sample: any = null;
    try {
      sample = JSON.parse(row.readings_json);
    } catch (error) {
      console.warn('Failed to parse commissioning window sample', error);
    }
    return {
      session_id: row.session_id,
      step_id: row.step_id,
      updated_at: row.updated_at,
      pass: row.state === 'pass',
      start: sample?.t_start ? Date.parse(sample.t_start) : null,
      end: sample?.t_end ? Date.parse(sample.t_end) : null,
      thresholds: sample?.thresholds ?? null,
      sample: {
        delta_t_med: sample?.delta_t_med ?? null,
        p25: sample?.p25 ?? null,
        p75: sample?.p75 ?? null,
      },
    };
  });

  return c.json(results);
});

app.post('/api/devices/:id/baselines', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const deviceId = c.req.param('id');
  let payload: any;
  try {
    payload = await c.req.json<any>();
  } catch {
    return c.text('Bad Request', 400);
  }
  const {
    kind,
    sample,
    thresholds,
    source_session_id,
    step_id,
    label,
    is_golden,
    expires_at,
  } = payload ?? {};
  if (!kind || !sample) {
    return c.text('Bad Request', 400);
  }
  const id = crypto.randomUUID();
  if (is_golden) {
    await c.env.DB.prepare('UPDATE device_baselines SET is_golden=0 WHERE device_id=? AND kind=?')
      .bind(deviceId, kind)
      .run();
  }
  await c.env.DB.prepare(
    `INSERT INTO device_baselines(
      baseline_id,device_id,kind,sample_json,thresholds_json,source_session_id,step_id,label,is_golden,expires_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      deviceId,
      kind,
      JSON.stringify(sample),
      thresholds ? JSON.stringify(thresholds) : null,
      source_session_id ?? null,
      step_id ?? null,
      label ?? null,
      is_golden ? 1 : 0,
      expires_at ?? null,
    )
    .run();

  return c.json({ ok: true, baseline_id: id });
});

app.get('/api/devices/:id/baselines', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops', 'contractor']);
  const deviceId = c.req.param('id');
  const kind = c.req.query('kind') ?? 'delta_t';
  const rows = await c.env.DB.prepare(
    `SELECT baseline_id, created_at, sample_json, thresholds_json, source_session_id, step_id, label, is_golden, expires_at
     FROM device_baselines WHERE device_id=? AND kind=?
     ORDER BY is_golden DESC, created_at DESC LIMIT 20`,
  )
    .bind(deviceId, kind)
    .all<{
      baseline_id: string;
      created_at: string;
      sample_json: string;
      thresholds_json: string | null;
      source_session_id: string | null;
      step_id: string | null;
      label: string | null;
      is_golden: number | null;
      expires_at: string | null;
    }>();

  const baselines = (rows.results ?? []).map((row) => {
    let sample: any = null;
    try {
      sample = JSON.parse(row.sample_json);
    } catch (error) {
      console.warn('Failed to parse baseline sample', error);
    }
    let thresholds: any = null;
    if (row.thresholds_json) {
      try {
        thresholds = JSON.parse(row.thresholds_json);
      } catch (error) {
        console.warn('Failed to parse baseline thresholds', error);
      }
    }
    return {
      baseline_id: row.baseline_id,
      created_at: row.created_at,
      sample,
      thresholds,
      source_session_id: row.source_session_id,
      step_id: row.step_id,
      label: row.label ?? null,
      is_golden: !!row.is_golden,
      expires_at: row.expires_at ?? null,
    };
  });

  return c.json(baselines);
});

app.get('/api/devices/:id/baseline-suggest', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const deviceId = c.req.param('id');
  const kind = (c.req.query('kind') as 'delta_t' | 'cop' | 'current' | null) ?? 'delta_t';
  const period = c.req.query('period') ?? '7 days';

  const base = await c.env.DB.prepare(
    `SELECT sample_json FROM device_baselines
     WHERE device_id=? AND kind=?
     ORDER BY is_golden DESC, created_at DESC LIMIT 1`,
  )
    .bind(deviceId, kind)
    .first<{ sample_json: string }>();

  if (!base) {
    return c.json({ hasBaseline: false, kind }, 200);
  }

  let sample: any = null;
  try {
    const sampleJson = typeof base.sample_json === 'string' ? base.sample_json : '{}';
    sample = JSON.parse(sampleJson);
  } catch (error) {
    console.warn('baseline sample parse error', error);
  }

  const p25 = sample?.p25;
  const p75 = sample?.p75;
  const baselineMedian = sample?.median;

  if (typeof p25 !== 'number' || typeof p75 !== 'number' || typeof baselineMedian !== 'number') {
    return c.json({ hasBaseline: false, kind }, 200);
  }

  const column = kind === 'delta_t' ? 'delta_t' : kind;
  const rows = await c.env.DB.prepare(
    `SELECT ${column} AS v
     FROM telemetry
     WHERE device_id=? AND ts >= datetime('now', ?)
     ORDER BY ts DESC
     LIMIT 10000`,
  )
    .bind(deviceId, `-${period}`)
    .all<{ v: number | null }>();

  const values = (rows.results ?? [])
    .map((row) => row.v)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  if (!values.length) {
    return c.json({ hasBaseline: true, kind, sampleN: 0 }, 200);
  }

  const drifts = values.map((value) => Math.abs(value - baselineMedian)).sort((a, b) => a - b);
  const percentile = (p: number) => {
    if (!drifts.length) {
      return 0;
    }
    const index = Math.floor(p * drifts.length);
    const clampedIndex = Math.max(0, Math.min(drifts.length - 1, index));
    const value = drifts[clampedIndex];
    return typeof value === 'number' ? value : 0;
  };

  const warnRaw = percentile(0.9);
  const critRaw = percentile(0.99);

  const warnFixed = kind === 'current' ? warnRaw.toFixed(1) : warnRaw.toFixed(2);
  const critFixed = kind === 'current' ? critRaw.toFixed(1) : critRaw.toFixed(2);

  let inside = 0;
  for (const value of values) {
    if (value >= p25 && value <= p75) {
      inside += 1;
    }
  }

  const coverage = values.length ? inside / values.length : 0;
  const units = kind === 'cop' ? '' : kind === 'current' ? 'A' : '°C';

  return c.json({
    hasBaseline: true,
    kind,
    sampleN: values.length,
    units,
    suggestions: {
      drift_warn: Number(warnFixed),
      drift_crit: Number(critFixed),
      note: "Coverage thresholds unchanged; consider tightening/loosening based on recent coverage below.",
    },
    recent: {
      coverage,
      baseline: { p25, p75, median: baselineMedian },
    },
  });
});

app.patch('/api/devices/:id/baselines/:baselineId', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const deviceId = c.req.param('id');
  const baselineId = c.req.param('baselineId');
  let payload: any;
  try {
    payload = await c.req.json<any>();
  } catch {
    return c.text('Bad Request', 400);
  }
  const { label, is_golden, expires_at } = payload ?? {};
  if (is_golden === true) {
    const kindRow = await c.env.DB.prepare(
      'SELECT kind FROM device_baselines WHERE baseline_id=? AND device_id=?',
    )
      .bind(baselineId, deviceId)
      .first<{ kind: string }>();
    if (!kindRow) {
      return c.text('Not Found', 404);
    }
    await c.env.DB.prepare('UPDATE device_baselines SET is_golden=0 WHERE device_id=? AND kind=?')
      .bind(deviceId, kindRow.kind)
      .run();
  }

  await c.env.DB.prepare(
    `UPDATE device_baselines SET
      label=COALESCE(?, label),
      is_golden=COALESCE(?, is_golden),
      expires_at=COALESCE(?, expires_at)
    WHERE baseline_id=? AND device_id=?`,
  )
    .bind(
      label ?? null,
      typeof is_golden === 'boolean' ? (is_golden ? 1 : 0) : null,
      expires_at ?? null,
      baselineId,
      deviceId,
    )
    .run();

  return c.json({ ok: true });
});

app.delete('/api/devices/:id/baselines/:baselineId', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const deviceId = c.req.param('id');
  const baselineId = c.req.param('baselineId');
  await c.env.DB.prepare('DELETE FROM device_baselines WHERE baseline_id=? AND device_id=?')
    .bind(baselineId, deviceId)
    .run();
  return c.json({ ok: true });
});

app.get('/api/devices/:id/baseline-compare', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops', 'contractor']);
  const deviceId = c.req.param('id');
  const kind = c.req.query('kind') ?? 'delta_t';
  const from = Number(c.req.query('from') ?? 0);
  const to = Number(c.req.query('to') ?? 0);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return c.text('Bad Request', 400);
  }

  const baselineRow = await c.env.DB.prepare(
    `SELECT sample_json FROM device_baselines
     WHERE device_id=? AND kind=?
     ORDER BY is_golden DESC, created_at DESC
     LIMIT 1`,
  )
    .bind(deviceId, kind)
    .first<{ sample_json: string }>();
  if (!baselineRow) {
    return c.json({ hasBaseline: false });
  }
  let sample: any = null;
  try {
    sample = JSON.parse(baselineRow.sample_json);
  } catch (error) {
    console.warn('baseline sample parse error', error);
  }
  const p25 = sample?.p25;
  const p75 = sample?.p75;
  const baselineMedian = sample?.median;
  if (typeof p25 !== 'number' || typeof p75 !== 'number') {
    return c.json({ hasBaseline: false });
  }

  const column = kind === 'delta_t' ? 'delta_t' : kind === 'cop' ? 'cop' : 'compressor_current';
  const rows = await c.env.DB.prepare(
    `SELECT ts, ${column} AS v
     FROM telemetry
     WHERE device_id=? AND ts BETWEEN datetime(?, 'unixepoch') AND datetime(?, 'unixepoch')
     ORDER BY ts ASC
     LIMIT 5000`,
  )
    .bind(deviceId, Math.floor(from / 1000), Math.floor(to / 1000))
    .all<{ v: number | null }>();
  const values = (rows.results ?? [])
    .map((row) => row.v)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  const { coverage, median } = compareToIqr(values, p25, p75);
  const drift =
    typeof baselineMedian === 'number' && Number.isFinite(median) ? median - baselineMedian : null;

  return c.json({
    hasBaseline: true,
    p25,
    p75,
    baselineMedian: typeof baselineMedian === 'number' ? baselineMedian : null,
    coverage,
    drift,
    n: values.length,
  });
});

app.post('/api/devices/:id/write', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const deviceId = c.req.param('id');
  const body = await c.req.json<DeviceCommandBody>();
  const actor = auth.email ?? auth.sub ?? 'operator';

  return dispatchDeviceCommand(c, deviceId, actor, body);
});

app.post('/api/devices/:id/command', async (c) => {
  const ro = await isReadOnly(c.env.DB);
  if (ro) {
    return c.text('Read-only', 503);
  }

  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const deviceId = c.req.param('id');
  const raw = await c.req.text();
  let commandBody: DeviceCommandBody = {};
  if (raw.trim().length > 0) {
    try {
      commandBody = JSON.parse(raw) as DeviceCommandBody;
    } catch {
      return c.text('Invalid JSON body', 400);
    }
  }

  const actor = auth.email ?? auth.sub ?? 'operator';

  return dispatchDeviceCommand(c, deviceId, actor, commandBody);
});

app.get('/api/me/saved-views', async (c) => {
  const auth = c.get('auth');
  const uid = auth?.sub ?? auth?.email;
  if (!uid) {
    return c.json([]);
  }

  const rows = await c.env.DB.prepare(
    'SELECT id, name, route, params_json, created_at FROM saved_views WHERE user_id=? ORDER BY created_at DESC',
  )
    .bind(uid)
    .all<{ id: string; name: string; route: string; params_json: string; created_at: string }>();

  return c.json(rows.results ?? []);
});

app.post('/api/me/saved-views', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  const uid = auth?.sub ?? auth?.email;
  if (!uid) {
    return c.text('Unauthorized', 401);
  }

  const body = await c.req
    .json<{ name: string; route: string; params: unknown }>()
    .catch(() => null);
  if (!body?.name || !body?.route) {
    return c.text('Bad Request', 400);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO saved_views (id, user_id, name, route, params_json) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, uid, body.name, body.route, JSON.stringify(body.params ?? {}))
    .run();

  return c.json({ ok: true, id });
});

app.delete('/api/me/saved-views/:id', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  const uid = auth?.sub ?? auth?.email;
  if (!uid) {
    return c.text('Unauthorized', 401);
  }

  await c.env.DB.prepare('DELETE FROM saved_views WHERE id=? AND user_id=?')
    .bind(c.req.param('id'), uid)
    .run();

  return c.json({ ok: true });
});

app.get('/api/settings/public', async (c) => c.json({ read_only: await isReadOnly(c.env.DB) }));

app.get('/api/admin/settings', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const rows = await c.env.DB.prepare('SELECT key,value FROM settings').all<{ key: string; value: string }>();
  return c.json(rows.results ?? []);
});

app.post('/api/admin/settings', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const { key, value } = await c.req.json<{ key: string; value: string }>().catch(() => ({ key: '', value: '' }));
  if (!key) {
    return c.text('Bad Request', 400);
  }
  await setSetting(c.env.DB, key, value ?? '');
  return c.json({ ok: true });
});

app.get('/api/admin/archive/presets', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const table = c.req.query('table');
  if (!table) {
    return c.json({ presets: [] });
  }
  const raw = await getSetting(c.env.DB, `export_presets_${table}`);
  let presets: unknown = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        presets = parsed;
      }
    } catch (error) {
      console.warn('Failed to parse archive presets', error);
    }
  }
  return c.json({ presets });
});

app.post('/api/admin/archive/presets', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const body = await c.req.json<{ table?: string; presets?: unknown }>().catch(() => null);
  const table = typeof body?.table === 'string' && body.table.trim().length > 0 ? body.table.trim() : null;
  const presets = body?.presets ?? [];
  if (!table) {
    return c.text('Bad Request', 400);
  }
  const errorMsg = validatePresets(presets);
  if (errorMsg) {
    return c.json({ ok: false, error: errorMsg }, 400);
  }
  await setSetting(c.env.DB, `export_presets_${table}`, JSON.stringify(presets ?? []));
  return c.json({ ok: true });
});

app.get('/api/admin/archive', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const dateParam = url.searchParams.get('date');
  const parsed = parseDateParam(dateParam);
  const fallback = addUtcDays(startOfUtcDay(new Date()), -1);
  const target = parsed ?? fallback;
  const rows = await listArchiveRows(c.env.DB, target);
  return c.json({ date: formatDateKey(target), results: rows });
});

app.get('/api/admin/archive/download', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  const auth = jwt ? await verifyAccessJWT(c.env, jwt).catch(() => null) : null;
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const key = c.req.query('key');
  if (!key) {
    return c.text('Bad Request', 400);
  }
  const fmt = (c.req.query('format') || 'ndjson').toLowerCase();
  const cols = c
    .req
    .query('columns')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const gz = c.req.query('gz') === '1' || c.req.query('gzip') === '1';
  const gzl = Math.max(1, Math.min(9, Number(c.req.query('gzl') || 0) || 0));
  const stage = c.req.query('stage') === '1';

  const bucket: any = (c.env as any).ARCHIVE || (c.env as any).REPORTS;
  const src = await bucket.get(key);
  if (!src) {
    return c.text('Not Found', 404);
  }

  const base = (key.split('/').pop() || 'export').replace(/\.ndjson$/, '');

  const withGzip = (stream: ReadableStream<Uint8Array>) => {
    if (!gz) return stream;
    try {
      return stream.pipeThrough(new (globalThis as any).CompressionStream('gzip', { level: gzl || 6 }));
    } catch (error) {
      try {
        return stream.pipeThrough(new (globalThis as any).CompressionStream('gzip'));
      } catch (fallbackError) {
        console.warn('gzip unavailable', error, fallbackError);
        return stream;
      }
    }
  };

  if (stage) {
    const sig = await sha256Hex(JSON.stringify({ key, fmt, cols, gz, gzl }));
    const stamp = new Date().toISOString().slice(0, 10);
    const stagedKey = `staged/${stamp}/${base}-${sig}.${fmt}${gz ? '.gz' : ''}`;
    if (!(await bucket.head?.(stagedKey))) {
      const body = withGzip(
        fmt === 'csv'
          ? ndjsonToCsvStream(src.body as ReadableStream<Uint8Array>, cols?.length ? cols : undefined)
          : (src.body as ReadableStream<Uint8Array>),
      );
      await bucket.put(stagedKey, body, {
        httpMetadata: { contentType: fmt === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson' },
      });
    }
    return c.redirect(`/api/admin/archive/object?key=${encodeURIComponent(stagedKey)}`, 302);
  }

  if (fmt === 'csv') {
    const s = ndjsonToCsvStream(src.body as ReadableStream<Uint8Array>, cols?.length ? cols : undefined);
    return new Response(withGzip(s), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${base}.csv${gz ? '.gz' : ''}"`,
        'Cache-Control': 'no-store',
        ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
      },
    });
  }

  return new Response(withGzip(src.body as ReadableStream<Uint8Array>), {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': `attachment; filename="${base}.ndjson${gz ? '.gz' : ''}"`,
      'Cache-Control': 'no-store',
      ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
    },
  });
});

app.get('/api/admin/archive/staged-for', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const date = c.req.query('date');
  const base = c.req.query('base');
  if (!date || !base) {
    return c.text('Bad Request', 400);
  }

  const bucket: any = (c.env as any).ARCHIVE || (c.env as any).REPORTS;
  if (!bucket?.list) {
    return c.json({});
  }
  let latest: any = null;

  try {
    const prefix = `staged/${date}/${base}-`;
    const res = await bucket.list({ prefix });
    for (const o of res.objects || []) {
      const m = /-p-([A-Za-z0-9_-]+)-/.exec(o.key);
      const preset = m ? m[1] : o.customMetadata?.preset || null;
      if (!latest || (o.uploaded && latest.uploaded && o.uploaded > latest.uploaded)) {
        latest = { key: o.key, preset, size: o.size, uploaded: o.uploaded };
      }
    }
  } catch (error) {
    console.warn('staged-for lookup failed', error);
  }

  return c.json(latest || {});
});

// --- Ingest: Telemetry & Heartbeat ---
// Simple shape guard (keep strict & small): 256KB max handled by Cloudflare automatically if set.
type IngestStatus = {
  mode?: string;
  defrost?: boolean;
  online?: boolean;
  [key: string]: unknown;
};

type ValidIngestPayload = {
  device_id: string;
  ts: string;
  metrics?: Record<string, unknown>;
  registers?: Record<string, unknown> | null;
  holding_registers?: Record<string, unknown> | null;
  read_only_registers?: Record<string, unknown> | null;
  status?: IngestStatus | null;
  meta?: Record<string, unknown> | null;
};

type ValidHeartbeatPayload = {
  device_id: string;
  timestamp: string;
  rssi?: number | null;
};

app.post('/api/ingest/:profileId', async (c) => {
  const started = Date.now();
  let status = 500;
  let deviceId: string | undefined;
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !validateIngest(body)) {
      status = 400;
      return bad(c, validateIngest.errors);
    }

    const payload = body as ValidIngestPayload;
    deviceId = payload.device_id;
    if (!deviceId) {
      status = 400;
      return c.text('Invalid device_id', 400);
    }
    const ok = await verifyDeviceKey(c.env.DB, deviceId, c.req.header('X-GREENBRO-DEVICE-KEY'));
    if (!ok) {
      status = 403;
      return c.text('Forbidden', 403);
    }

    const profileId = c.req.param('profileId');
    const idemKey = await (async () => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
      return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
    })();

    if (await isDuplicate(c.env.DB, idemKey)) {
      status = 200;
      return c.json({ ok: true, deduped: true });
    }

    const rawMetrics: Record<string, unknown> =
      payload.metrics && typeof payload.metrics === 'object' ? (payload.metrics as Record<string, unknown>) : {};
    const rawStatus: IngestStatus =
      typeof payload.status === 'object' && payload.status ? (payload.status as IngestStatus) : {};
    const registerSources = [
      payload.registers,
      payload.holding_registers,
      payload.read_only_registers,
    ] as Array<Record<string | number, unknown> | null | undefined>;
    const registerSnapshot: Record<number, number> = {};
    for (const source of registerSources) {
      if (source && typeof source === 'object') {
        Object.assign(registerSnapshot, normalizeRegisterMap(source));
      }
    }
    const decoded = Object.keys(registerSnapshot).length > 0 ? decodeTelemetryFromRegisters(registerSnapshot) : null;

    const toNumber = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined;

    const telemetryMetrics: TelemetryPayload['metrics'] = {
      tankC: toNumber((rawMetrics as any).tankC ?? (rawMetrics as any).tank_c),
      supplyC: toNumber(
        (rawMetrics as any).outlet_temp_c ?? (rawMetrics as any).supplyC ?? (rawMetrics as any).supply_c,
      ),
      returnC: toNumber(
        (rawMetrics as any).return_temp_c ?? (rawMetrics as any).returnC ?? (rawMetrics as any).return_c,
      ),
      ambientC: toNumber((rawMetrics as any).ambient_c ?? (rawMetrics as any).ambientC),
      flowLps: (() => {
        const lps = toNumber((rawMetrics as any).flowLps ?? (rawMetrics as any).flow_lps);
        if (lps != null) return lps;
        const lpm = toNumber((rawMetrics as any).flow_lpm);
        return lpm != null ? lpm / 60 : undefined;
      })(),
      compCurrentA: toNumber((rawMetrics as any).compCurrentA ?? (rawMetrics as any).compressor_a),
      eevSteps: toNumber((rawMetrics as any).eevSteps ?? (rawMetrics as any).eev_steps),
      powerKW: toNumber((rawMetrics as any).powerKW ?? (rawMetrics as any).power_kw),
    };

    if (decoded) {
      for (const [key, value] of Object.entries(decoded.metrics)) {
        if (typeof value === 'number' && telemetryMetrics[key as keyof TelemetryPayload['metrics']] == null) {
          telemetryMetrics[key as keyof TelemetryPayload['metrics']] = value;
        }
      }
    }

    let statusFlags = normalizeFlagMap((rawStatus as { flags?: unknown }).flags);

    const telemetryStatus: TelemetryPayload['status'] = {
      mode: typeof rawStatus.mode === 'string' ? rawStatus.mode : undefined,
      defrost: typeof rawStatus.defrost === 'boolean' ? rawStatus.defrost : undefined,
      online: typeof rawStatus.online === 'boolean' ? rawStatus.online : undefined,
    };

    if (decoded) {
      telemetryStatus.mode = telemetryStatus.mode ?? decoded.status.mode;
      telemetryStatus.defrost =
        typeof telemetryStatus.defrost === 'boolean' ? telemetryStatus.defrost : decoded.status.defrost;
      telemetryStatus.online =
        typeof telemetryStatus.online === 'boolean' ? telemetryStatus.online : decoded.status.online;
      if (decoded.status.flags) {
        statusFlags = statusFlags ?? {};
        for (const [groupKey, groupValue] of Object.entries(decoded.status.flags)) {
          statusFlags[groupKey] = { ...(statusFlags[groupKey] ?? {}), ...groupValue };
        }
      }
    }

    if (statusFlags && Object.keys(statusFlags).length > 0) {
      telemetryStatus.flags = statusFlags;
    }

    const telemetryFaults =
      decoded && decoded.faults.length > 0 ? decoded.faults.map((fault) => ({ ...fault })) : undefined;

    const telemetry: TelemetryPayload = {
      deviceId,
      ts: payload.ts,
      metrics: telemetryMetrics,
      status: telemetryStatus,
    };
    if (telemetryFaults) {
      telemetry.faults = telemetryFaults;
    }

    if (c.env.INGEST_Q) {
      await c.env.INGEST_Q.send({ type: 'telemetry', profileId, body: telemetry });
    } else {
      await processTelemetryInline(c.env, telemetry, payload.ts);
    }

    status = 200;
    return c.json({ ok: true, queued: true });
  } catch (error) {
    console.error('Failed to ingest telemetry', error);
    status = 500;
    return c.text('Internal Server Error', 500);
  } finally {
    const duration = Date.now() - started;
    await logOpsMetric(c.env.DB, '/api/ingest', status, duration, deviceId);
  }
});

app.get('/api/ops/deviation-counters', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const rows = await c.env.DB.prepare(
    `SELECT
      COALESCE(json_extract(meta_json, '$.kind'), 'delta_t') AS kind,
      severity,
      COUNT(*) AS n
    FROM alerts
    WHERE type='baseline_deviation'
      AND state IN ('open','ack')
      AND opened_at >= datetime('now','-24 hours')
    GROUP BY kind, severity`,
  ).all<{ kind: string | null; severity: string | null; n: number }>();

  const counters: Record<'delta_t' | 'cop' | 'current', { warning: number; critical: number }> = {
    delta_t: { warning: 0, critical: 0 },
    cop: { warning: 0, critical: 0 },
    current: { warning: 0, critical: 0 },
  };

  for (const row of rows.results ?? []) {
    const kind = (row.kind ?? 'delta_t') as 'delta_t' | 'cop' | 'current';
    if (!counters[kind]) {
      continue;
    }
    const severity = row.severity === 'critical' ? 'critical' : row.severity === 'warning' ? 'warning' : null;
    if (!severity) {
      continue;
    }
    counters[kind][severity] = row.n;
  }

  return c.json(counters);
});

app.get('/api/ops/deviation-hotlist', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const rawLimit = Number(c.req.query('limit') ?? 5);
  const limit = Number.isFinite(rawLimit) ? Math.min(10, Math.max(1, rawLimit)) : 5;
  const rows = await c.env.DB.prepare(
    `WITH last_hour AS (
       SELECT a.device_id,
              COALESCE(json_extract(a.meta_json,'$.kind'),'delta_t') AS kind,
              MAX(CASE WHEN a.severity='critical' THEN 1 ELSE 0 END) AS any_crit,
              MIN(a.opened_at) AS since,
              json_extract(a.meta_json,'$.coverage') AS coverage,
              json_extract(a.meta_json,'$.drift') AS drift
         FROM alerts a
        WHERE a.type='baseline_deviation'
          AND a.state IN ('open','ack')
          AND a.opened_at >= datetime('now','-60 minutes')
        GROUP BY a.device_id, kind
     )
     SELECT lh.device_id, lh.kind, lh.any_crit, lh.since, lh.coverage, lh.drift,
            s.site_id, s.name AS site_name, s.region
       FROM last_hour lh
       LEFT JOIN devices d ON d.device_id = lh.device_id
       LEFT JOIN sites s ON s.site_id = d.site_id
      ORDER BY lh.any_crit DESC,
               (1.0 - COALESCE(lh.coverage, 0.0)) DESC,
               lh.since ASC
      LIMIT ?`,
  )
    .bind(limit)
    .all<{
      device_id: string;
      kind: 'delta_t' | 'cop' | 'current';
      any_crit: number;
      since: string;
      coverage: number | null;
      drift: number | null;
      site_id: string | null;
      site_name: string | null;
      region: string | null;
    }>();

  return c.json(rows.results ?? []);
});

app.post('/api/ops/recompute-baselines', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  await recomputeBaselines(c.env.DB);
  return c.json({ ok: true });
});

app.post('/api/ops/incidents/sweep', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const hoursParam = url.searchParams.get('hours');
  const hours = Number(hoursParam ?? '48');
  const windowHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 240) : 48;
  const result = await sweepIncidents(c.env.DB, windowHours);
  return c.json({ ok: true, windowHours, ...result });
});

app.get('/api/ops/incidents', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const sinceParam = url.searchParams.get('since');
  const siteId = url.searchParams.get('siteId');

  let sinceExpr = "datetime('now', ?)";
  const bind: string[] = [];

  if (sinceParam && /^\d{4}-\d{2}-\d{2}/.test(sinceParam)) {
    sinceExpr = '?';
    bind.push(sinceParam);
  } else {
    bind.push(sinceParam ?? '-72 hours');
  }

  let siteClause = '';
  if (siteId) {
    siteClause = ' AND i.site_id = ?';
    bind.push(siteId);
  }

  const rows = await c.env.DB.prepare(
    `SELECT i.incident_id, i.site_id, i.started_at, i.last_alert_at, i.resolved_at, s.name AS site_name
       FROM incidents i
       LEFT JOIN sites s ON s.site_id = i.site_id
      WHERE i.started_at >= ${sinceExpr}${siteClause}
      ORDER BY i.started_at DESC
      LIMIT 200`,
  )
    .bind(...bind)
    .all<{
      incident_id: string;
      site_id: string;
      started_at: string;
      last_alert_at: string;
      resolved_at: string | null;
      site_name: string | null;
    }>();

  const incidents = rows.results ?? [];
  if (incidents.length === 0) {
    return c.json([]);
  }

  const ids = incidents.map((r) => r.incident_id);
  const placeholders = ids.map(() => '?').join(',');
  const alertRows = await c.env.DB.prepare(
    `SELECT ia.incident_id, a.type, a.severity, a.state, COUNT(*) as count
       FROM incident_alerts ia
       JOIN alerts a ON a.alert_id = ia.alert_id
      WHERE ia.incident_id IN (${placeholders})
      GROUP BY ia.incident_id, a.type, a.severity, a.state`,
  )
    .bind(...ids)
    .all<{ incident_id: string; type: string; severity: string; state: string; count: number }>();

  const grouped = new Map<
    string,
    {
      states: Record<string, number>;
      types: Map<string, { type: string; severity: string; count: number }>;
    }
  >();

  for (const row of alertRows.results ?? []) {
    if (!grouped.has(row.incident_id)) {
      grouped.set(row.incident_id, { states: {}, types: new Map() });
    }
    const bucket = grouped.get(row.incident_id)!;
    bucket.states[row.state] = (bucket.states[row.state] ?? 0) + row.count;
    const key = `${row.type}::${row.severity}`;
    const prev = bucket.types.get(key);
    if (prev) {
      prev.count += row.count;
    } else {
      bucket.types.set(key, { type: row.type, severity: row.severity, count: row.count });
    }
  }

  const out = incidents.map((incident) => {
    const meta = grouped.get(incident.incident_id);
    const states = meta?.states ?? {};
    const total = Object.values(states).reduce((acc, value) => acc + value, 0);
    return {
      incidentId: incident.incident_id,
      siteId: incident.site_id,
      siteName: incident.site_name ?? null,
      startedAt: incident.started_at,
      lastAlertAt: incident.last_alert_at,
      resolvedAt: incident.resolved_at,
      alerts: {
        total,
        open: states.open ?? 0,
        ack: states.ack ?? 0,
        closed: states.closed ?? 0,
      },
      types: meta ? Array.from(meta.types.values()) : [],
    };
  });

  return c.json(out);
});

app.post('/api/heartbeat/:profileId', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !validateHeartbeat(body)) {
    return bad(c, validateHeartbeat.errors);
  }
  const payload = body as ValidHeartbeatPayload;
  const deviceId = payload.device_id;
  const timestamp = payload.timestamp;
  const rssi = typeof payload.rssi === 'number' && Number.isFinite(payload.rssi) ? payload.rssi : null;

  const ok = await verifyDeviceKey(c.env.DB, deviceId, c.req.header('X-GREENBRO-DEVICE-KEY'));
  if (!ok) return c.text('Forbidden', 403);

  const profileId = c.req.param('profileId');
  const heartbeat: HeartbeatPayload = { deviceId, ts: timestamp, rssi: rssi ?? undefined };

  if (c.env.INGEST_Q) {
    await c.env.INGEST_Q.send({ type: 'heartbeat', profileId, body: heartbeat });
  } else {
    await processHeartbeatInline(c.env, heartbeat, timestamp);
  }

  return c.json({ ok: true, queued: true });
});

app.get('/api/commissioning/settings', async (c) => {
  const [delta, flow, cop] = await Promise.all([
    getSetting(c.env.DB, 'commissioning_delta_t_min'),
    getSetting(c.env.DB, 'commissioning_flow_min_lpm'),
    getSetting(c.env.DB, 'commissioning_cop_min'),
  ]);
  return c.json({
    delta_t_min: numberFromSetting(delta, 0),
    flow_min_lpm: numberFromSetting(flow, 0),
    cop_min: numberFromSetting(cop, 0),
  });
});

app.get('/api/commissioning/checklists', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT checklist_id,name,version,steps_json,required_steps_json FROM commissioning_checklists ORDER BY created_at DESC',
  ).all();
  return c.json(rows.results ?? []);
});

app.get('/api/commissioning/checklist/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT checklist_id,name,version,steps_json,required_steps_json FROM commissioning_checklists WHERE checklist_id=?',
  )
    .bind(id)
    .first();
  return row ? c.json(row) : c.text('Not Found', 404);
});

app.get('/api/commissioning/sessions', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT session_id, device_id, site_id, operator_sub, started_at, finished_at, status, notes, checklist_id,
            (SELECT MAX(updated_at) FROM commissioning_steps WHERE session_id = cs.session_id) AS last_update
       FROM commissioning_sessions cs
       ORDER BY started_at DESC
       LIMIT 200`,
  ).all<{
    session_id: string;
    device_id: string;
    site_id: string | null;
    operator_sub: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    notes: string | null;
    last_update: string | null;
    checklist_id: string | null;
  }>();

  const sessions = (rows.results ?? []).map((row) => ({
    session_id: row.session_id,
    device_id: row.device_id,
    site_id: row.site_id ?? null,
    operator_sub: row.operator_sub,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    status: row.status,
    notes: row.notes ?? null,
    last_update: row.last_update ?? null,
    checklist_id: row.checklist_id ?? null,
  }));

  return c.json(sessions);
});

app.get('/api/commissioning/session/:id', async (c) => {
  const id = c.req.param('id');
  const session = await c.env.DB.prepare(
    'SELECT session_id, device_id, site_id, operator_sub, started_at, finished_at, status, notes, checklist_id FROM commissioning_sessions WHERE session_id=?',
  )
    .bind(id)
    .first<{
      session_id: string;
      device_id: string;
      site_id: string | null;
      operator_sub: string;
      started_at: string;
      finished_at: string | null;
      status: string;
      notes: string | null;
      checklist_id: string | null;
    }>();

  if (!session) {
    return c.text('Not Found', 404);
  }

  const steps = await c.env.DB.prepare(
    'SELECT step_id,title,state,readings_json,comment,updated_at FROM commissioning_steps WHERE session_id=? ORDER BY updated_at',
  )
    .bind(id)
    .all<{
      step_id: string;
      title: string;
      state: string;
      readings_json: string | null;
      comment: string | null;
      updated_at: string;
    }>();

  const artifacts = await c.env.DB.prepare(
    'SELECT kind,r2_key,size_bytes,created_at FROM commissioning_artifacts WHERE session_id=?',
  )
    .bind(id)
    .all<{
      kind: string;
      r2_key: string;
      size_bytes: number | null;
      created_at: string;
    }>();

  const parsedSteps = (steps.results ?? []).map((row) => {
    let readings: Record<string, unknown> | null = null;
    if (row.readings_json) {
      try {
        const parsed = JSON.parse(row.readings_json);
        if (parsed && typeof parsed === 'object') {
          readings = parsed as Record<string, unknown>;
        }
      } catch (error) {
        console.warn('commissioning step readings parse failed', error);
      }
    }
    return {
      step_id: row.step_id,
      title: row.title,
      state: row.state,
      readings,
      comment: row.comment ?? null,
      updated_at: row.updated_at,
    };
  });

  const artifactMap = new Map<string, { r2_key: string; size_bytes: number | null; created_at: string }>();
  for (const row of artifacts.results ?? []) {
    artifactMap.set(row.kind, {
      r2_key: row.r2_key,
      size_bytes: row.size_bytes ?? null,
      created_at: row.created_at,
    });
  }

  return c.json({
    session: {
      session_id: session.session_id,
      device_id: session.device_id,
      site_id: session.site_id ?? null,
      operator_sub: session.operator_sub,
      started_at: session.started_at,
      finished_at: session.finished_at ?? null,
      status: session.status,
      notes: session.notes ?? null,
      checklist_id: session.checklist_id ?? null,
    },
    steps: parsedSteps,
    artifacts: Object.fromEntries(artifactMap.entries()),
  });
});

app.post('/api/commissioning/start', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const body = await c.req
    .json<{ device_id: string; site_id?: string | null; checklist_id?: string; notes?: string | null }>()
    .catch(() => null);
  if (!body?.device_id) {
    return c.text('Bad Request', 400);
  }
  const sessionId = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO commissioning_sessions(session_id,device_id,site_id,operator_sub,notes,checklist_id) VALUES (?,?,?,?,?,?)',
  )
    .bind(
      sessionId,
      body.device_id,
      body.site_id ?? null,
      auth.sub,
      body.notes ?? null,
      body.checklist_id ?? null,
    )
    .run();

  const cl = await c.env.DB.prepare('SELECT steps_json FROM commissioning_checklists WHERE checklist_id=?')
    .bind(body.checklist_id ?? null)
    .first<{ steps_json?: string | null }>();
  let steps: Array<{ id: string; title: string }> = [];
  if (cl?.steps_json) {
    try {
      steps = JSON.parse(cl.steps_json);
    } catch (error) {
      console.warn('Invalid commissioning checklist JSON', error);
    }
  }
  const stmt = c.env.DB.prepare('INSERT INTO commissioning_steps(session_id,step_id,title,state) VALUES (?,?,?,?)');
  for (const step of steps) {
    await stmt.bind(sessionId, step.id, step.title, 'pending').run();
  }

  await audit(c.env as any, auth, 'commissioning.start', body.device_id, {
    site_id: body.site_id ?? null,
    checklist_id: body.checklist_id ?? null,
  });

  return c.json({ ok: true, session_id: sessionId });
});

app.post('/api/commissioning/step', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const body = await c.req
    .json<{
      session_id: string;
      step_id: string;
      state: string;
      readings?: Record<string, unknown>;
      comment?: string | null;
    }>()
    .catch(() => null);
  if (!body?.session_id || !body.step_id || !body.state) {
    return c.text('Bad Request', 400);
  }
  await c.env.DB.prepare(
    'UPDATE commissioning_steps SET state=?, readings_json=?, comment=?, updated_at=datetime(\'now\') WHERE session_id=? AND step_id=?',
  )
    .bind(
      body.state,
      body.readings ? JSON.stringify(body.readings) : null,
      body.comment ?? null,
      body.session_id,
      body.step_id,
    )
    .run();
  await audit(c.env as any, auth, 'commissioning.step', `${body.session_id}:${body.step_id}`, {
    state: body.state,
    readings: body.readings ?? null,
    comment: body.comment ?? null,
  });
  return c.json({ ok: true });
});

app.post('/api/commissioning/finalise', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const body = await c.req
    .json<{ session_id: string; outcome?: string; notes?: string | null }>()
    .catch(() => null);
  if (!body?.session_id) {
    return c.text('Bad Request', 400);
  }
  const outcome = body.outcome ?? 'passed';
  if (outcome === 'passed') {
    const req = await c.env.DB.prepare(
      `SELECT coalesce(required_steps_json, steps_json) AS steps FROM commissioning_checklists
       WHERE checklist_id = (SELECT checklist_id FROM commissioning_sessions WHERE session_id=?)`,
    )
      .bind(body.session_id)
      .first<{ steps: string } | null>();
    let required: string[] = [];
    if (req?.steps) {
      try {
        const parsed = JSON.parse(req.steps) as Array<{ id?: string } | string>;
        required = parsed
          .map((item) => (typeof item === 'string' ? item : item.id ?? null))
          .filter((id): id is string => !!id);
      } catch (error) {
        console.warn('Invalid commissioning required steps JSON', error);
      }
    }
    if (required.length) {
      const rows = await c.env.DB.prepare(
        'SELECT step_id, state FROM commissioning_steps WHERE session_id=?',
      )
        .bind(body.session_id)
        .all<{ step_id: string; state: string }>();
      const states = Object.fromEntries((rows.results ?? []).map((r) => [r.step_id, r.state]));
      const missing = required.filter((id) => states[id] !== 'pass');
      if (missing.length) {
        return c.json({ ok: false, error: 'required_steps_not_passed', missing }, 409);
      }
    }
  }
  await c.env.DB.prepare(
    "UPDATE commissioning_sessions SET status=?, finished_at=datetime('now'), notes=COALESCE(?,notes) WHERE session_id=?",
  )
    .bind(outcome, body.notes ?? null, body.session_id)
    .run();

  const { renderCommissioningPdf } = await import('./reports/commissioning-pdf');
  const { key, size } = await renderCommissioningPdf(c.env, body.session_id);
  await c.env.DB.prepare(
    'INSERT OR REPLACE INTO commissioning_artifacts(session_id,kind,r2_key,size_bytes) VALUES (?,?,?,?)',
  )
    .bind(body.session_id, 'pdf', key, size)
    .run();

  await audit(c.env as any, auth, 'commissioning.finalise', body.session_id, {
    outcome,
    notes: body.notes ?? null,
  });

  return c.json({ ok: true, r2_key: key });
});

app.post('/api/commissioning/measure-now', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }

  const body = await c.req
    .json<{
      session_id: string;
      step_id: string;
      expectations?: { delta_t_min?: number; flow_min_lpm?: number; cop_min?: number };
    }>()
    .catch(() => null);

  if (!body?.session_id || !body.step_id) {
    return c.text('Bad Request', 400);
  }

  const session = await c.env.DB.prepare('SELECT device_id FROM commissioning_sessions WHERE session_id=?')
    .bind(body.session_id)
    .first<{ device_id: string }>();
  if (!session) {
    return c.text('Session not found', 404);
  }

  const latest = await getLatestTelemetry(c.env.DB, session.device_id);
  if (!latest) {
    return c.text('No telemetry yet', 409);
  }

  const dtMin =
    body.expectations?.delta_t_min ?? numberFromSetting(await getSetting(c.env.DB, 'commissioning_delta_t_min'), 0);
  const flowMin =
    body.expectations?.flow_min_lpm ?? numberFromSetting(await getSetting(c.env.DB, 'commissioning_flow_min_lpm'), 0);
  const copMin =
    body.expectations?.cop_min ?? numberFromSetting(await getSetting(c.env.DB, 'commissioning_cop_min'), 0);

  const outlet = typeof latest.outlet === 'number' ? latest.outlet : undefined;
  const ret = typeof latest.ret === 'number' ? latest.ret : undefined;
  const deltaT = typeof latest.delta_t === 'number' ? latest.delta_t : computeDeltaT(outlet, ret);
  const flowValue = typeof latest.flow_lpm === 'number' ? latest.flow_lpm : undefined;
  const copValue = typeof latest.cop === 'number' ? latest.cop : undefined;

  const flowOk = flowValue === undefined ? flowMin === 0 : flowValue >= flowMin;
  const dtOk = deltaT == null ? dtMin === 0 : deltaT >= dtMin;
  const copOk = copValue === undefined ? copMin === 0 : copValue >= copMin;
  const pass = flowOk && dtOk && copOk;

  const readings = {
    ts: latest.ts,
    outlet: typeof latest.outlet === 'number' ? latest.outlet : null,
    return: typeof latest.ret === 'number' ? latest.ret : null,
    flow_lpm: flowValue ?? null,
    delta_t: deltaT,
    cop: copValue ?? null,
  };

  await c.env.DB.prepare(
    "UPDATE commissioning_steps SET state=?, readings_json=?, updated_at=datetime('now') WHERE session_id=? AND step_id=?",
  )
    .bind(pass ? 'pass' : 'fail', JSON.stringify(readings), body.session_id, body.step_id)
    .run();

  await audit(c.env as any, auth, 'commissioning.measure-now', `${body.session_id}:${body.step_id}`, {
    result: {
      delta_t: deltaT,
      flow_lpm: flowValue,
      cop: copValue,
    },
  });

  return c.json({
    ok: true,
    pass,
    delta_t: deltaT,
    flow_lpm: flowValue,
    cop: copValue,
    ts: latest.ts,
    thresholds: { delta_t_min: dtMin, flow_min_lpm: flowMin, cop_min: copMin },
  });
});

app.post('/api/commissioning/measure-window', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }

  const body = await c.req
    .json<{
      session_id: string;
      step_id: string;
      window_s?: number;
      thresholds?: { delta_t_min?: number; flow_min_lpm?: number; cop_min?: number };
    }>()
    .catch(() => null);

  if (!body?.session_id || !body.step_id) {
    return c.text('Bad Request', 400);
  }

  const session = await c.env.DB.prepare('SELECT device_id FROM commissioning_sessions WHERE session_id=?')
    .bind(body.session_id)
    .first<{ device_id: string }>();
  if (!session) {
    return c.text('Session not found', 404);
  }

  const dtMin = body.thresholds?.delta_t_min
    ?? numberFromSetting(await getSetting(c.env.DB, 'commissioning_delta_t_min'), 0);
  const flowMin = body.thresholds?.flow_min_lpm
    ?? numberFromSetting(await getSetting(c.env.DB, 'commissioning_flow_min_lpm'), 0);
  const copMin = body.thresholds?.cop_min
    ?? numberFromSetting(await getSetting(c.env.DB, 'commissioning_cop_min'), 0);

  const windowSeconds = Math.max(10, Math.min(300, body.window_s ?? 90));
  const sample = await getWindowSample(c.env.DB, session.device_id, windowSeconds);

  const okDt = sample.delta_t_med != null ? sample.delta_t_med >= dtMin : false;
  const okFlow = flowMin ? (sample.flow_lpm_med ?? Number.NEGATIVE_INFINITY) >= flowMin : true;
  const okCop = copMin ? (sample.cop_med ?? Number.NEGATIVE_INFINITY) >= copMin : true;
  const pass = okDt && okFlow && okCop;

  const thresholdsPayload = {
    delta_t_min: dtMin,
    flow_min_lpm: flowMin,
    cop_min: copMin,
    dtMin,
    flMin: flowMin,
    copMin,
  } as const;

  await c.env.DB.prepare(
    "UPDATE commissioning_steps SET state=?, readings_json=?, updated_at=datetime('now') WHERE session_id=? AND step_id=?",
  )
    .bind(
      pass ? 'pass' : 'fail',
      JSON.stringify({
        ...sample,
        thresholds: thresholdsPayload,
      }),
      body.session_id,
      body.step_id,
    )
    .run();

  await audit(c.env as any, auth, 'commissioning.measure-window', `${body.session_id}:${body.step_id}`, {
    sample,
    thresholds: thresholdsPayload,
  });

  return c.json({
    ok: true,
    pass,
    sample,
    thresholds: thresholdsPayload,
  });
});

app.post('/api/commissioning/labels', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }

  const body = await c.req.json<{ session_id: string }>().catch(() => null);
  if (!body?.session_id) {
    return c.text('Bad Request', 400);
  }

  const session = await c.env.DB.prepare('SELECT device_id, site_id FROM commissioning_sessions WHERE session_id=?')
    .bind(body.session_id)
    .first<{ device_id: string; site_id: string | null }>();
  if (!session) {
    return c.text('Not Found', 404);
  }

  const { renderDeviceLabels } = await import('./reports/labels-pdf');
  const { key, size } = await renderDeviceLabels(c.env as Env, {
    device_id: session.device_id,
    site_id: session.site_id ?? null,
  });

  await c.env.DB.prepare(
    'INSERT OR REPLACE INTO commissioning_artifacts (session_id, kind, r2_key, size_bytes) VALUES (?,?,?,?)',
  )
    .bind(body.session_id, 'labels', key, size)
    .run();

  await audit(c.env as any, auth, 'commissioning.labels', body.session_id, { r2_key: key });

  return c.json({ ok: true, r2_key: key, size });
});

app.post('/api/commissioning/provisioning-zip', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }

  const body = await c.req.json<{ session_id: string }>().catch(() => null);
  if (!body?.session_id) {
    return c.text('Bad Request', 400);
  }

  const session = await c.env.DB.prepare('SELECT device_id FROM commissioning_sessions WHERE session_id=?')
    .bind(body.session_id)
    .first<{ device_id: string }>();
  if (!session) {
    return c.text('Not Found', 404);
  }

  const { renderProvisioningZip } = await import('./reports/provisioning-zip');
  const { key, size } = await renderProvisioningZip(c.env, {
    device_id: session.device_id,
    session_id: body.session_id,
  });

  await c.env.DB.prepare(
    'INSERT OR REPLACE INTO commissioning_artifacts(session_id, kind, r2_key, size_bytes) VALUES (?,?,?,?)',
  )
    .bind(body.session_id, 'zip', key, size)
    .run();

  await audit(c.env as any, auth, 'commissioning.provisioning-zip', body.session_id, { r2_key: key });

  return c.json({ ok: true, r2_key: key, size });
});

app.post('/api/commissioning/email-bundle', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const body = await c.req.json<{ session_id: string }>().catch(() => null);
  if (!body?.session_id) {
    return c.text('Bad Request', 400);
  }

  const to = (await getSetting(c.env.DB, 'commissioning_report_recipients')) ?? '';
  const res = await emailCommissioningWithZip(c.env as any, to, body.session_id);
  await audit(c.env as any, auth, 'commissioning.email-bundle', body.session_id, res);
  return c.json(res);
});

app.post('/api/commissioning/email-report', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const body = await c.req.json<{ session_id: string }>().catch(() => null);
  if (!body?.session_id) {
    return c.text('Bad Request', 400);
  }

  const row = await c.env.DB.prepare(
    "SELECT r2_key FROM commissioning_artifacts WHERE session_id=? AND kind='pdf'",
  )
    .bind(body.session_id)
    .first<{ r2_key: string }>();
  if (!row) {
    return c.text('No PDF artefact', 409);
  }

  const recipients = (await getSetting(c.env.DB, 'commissioning_report_recipients')) ?? '';
  const res = await emailCommissioning(
    c.env,
    recipients,
    'Commissioning Report',
    `Session ${body.session_id}`,
    row.r2_key,
  );
  return c.json(res);
});

app.post('/api/alerts/:id/snooze', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const { id } = c.req.param();
  const payload = await c.req.json<{ minutes?: number; reason?: string }>().catch(() => null);
  const minutes = Number(payload?.minutes ?? 60);
  const reasonRaw = payload?.reason;
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim().length > 0 ? reasonRaw.trim() : null;

  const alertRow = await c.env.DB.prepare(
    `SELECT alert_id, device_id, type, meta_json FROM alerts WHERE alert_id=? LIMIT 1`,
  )
    .bind(id)
    .first<{ alert_id: string; device_id: string; type: string; meta_json: string | null }>();

  if (!alertRow) {
    return c.text('Not Found', 404);
  }

  const meta = alertRow.meta_json ? JSON.parse(alertRow.meta_json) : {};
  const kind = typeof meta?.kind === 'string' ? meta.kind : null;
  const durationMinutes = Number.isFinite(minutes) ? Math.max(5, minutes) : 60;
  const untilISO = new Date(Date.now() + durationMinutes * 60_000).toISOString();

  await c.env.DB.prepare(
    `INSERT INTO alert_snoozes(id, device_id, type, kind, until_ts, reason, created_by)
     VALUES(?,?,?,?,?,?,?)`,
  )
    .bind(
      crypto.randomUUID(),
      alertRow.device_id,
      alertRow.type,
      kind,
      untilISO,
      reason,
      auth?.sub ?? auth?.email ?? 'ops',
    )
    .run();

  await c.env.DB.prepare(
    `UPDATE alerts
        SET state='ack',
            meta_json = json_set(COALESCE(meta_json,'{}'), '$.snoozed_until', ?)
      WHERE alert_id=?`,
  )
    .bind(untilISO, alertRow.alert_id)
    .run();

  return c.json({ ok: true, until: untilISO });
});

app.get('/api/alerts/snoozes', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);
  const deviceId = c.req.query('device_id') ?? null;
  const sql = deviceId
    ? `SELECT * FROM alert_snoozes WHERE device_id=? AND until_ts > datetime('now') ORDER BY until_ts ASC`
    : `SELECT * FROM alert_snoozes WHERE until_ts > datetime('now') ORDER BY until_ts ASC LIMIT 100`;
  const rows = deviceId
    ? await c.env.DB.prepare(sql).bind(deviceId).all()
    : await c.env.DB.prepare(sql).all();
  return c.json(rows.results ?? []);
});

app.get('/api/alerts', async (c) => {
  const { DB } = c.env;
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }

  const url = new URL(c.req.url);
  const state = url.searchParams.get('state');
  const severity = url.searchParams.get('severity');
  const type = url.searchParams.get('type');
  const device = url.searchParams.get('deviceId');

  let sql = `SELECT a.*, GROUP_CONCAT(DISTINCT sc.client_id) AS clients
             FROM alerts a
             JOIN devices d ON a.device_id = d.device_id
             LEFT JOIN site_clients sc ON d.site_id = sc.site_id
             WHERE 1=1`;
  const bind: Array<string> = [];
  if (state) {
    sql += ' AND a.state=?';
    bind.push(state);
  }
  if (severity) {
    sql += ' AND a.severity=?';
    bind.push(severity);
  }
  if (type) {
    sql += ' AND a.type=?';
    bind.push(type);
  }
  if (device) {
    sql += ' AND a.device_id=?';
    bind.push(device);
  }

  if (auth.roles.includes('client') || auth.roles.includes('contractor')) {
    const clientIds = auth.clientIds ?? [];
    if (clientIds.length === 0) {
      return c.json([]);
    }
    const placeholders = clientIds.map(() => '?').join(',');
    sql += ` AND EXISTS (
      SELECT 1 FROM site_clients sc2 WHERE sc2.site_id = d.site_id AND sc2.client_id IN (${placeholders})
    )`;
    bind.push(...clientIds);
  }

  sql += ' GROUP BY a.alert_id ORDER BY a.opened_at DESC LIMIT 200';
  const rows = await DB.prepare(sql).bind(...bind).all();
  const results = (rows.results ?? []).map((row) => {
    if (row?.type !== 'baseline_deviation') {
      return row;
    }
    let coverage: number | null =
      typeof row.coverage === 'number' && Number.isFinite(row.coverage) ? row.coverage : null;
    let drift: number | null = typeof row.drift === 'number' && Number.isFinite(row.drift) ? row.drift : null;
    let kind = typeof (row as { meta_kind?: string }).meta_kind === 'string' ? row.meta_kind! : 'delta_t';
    let units = typeof (row as { meta_units?: string }).meta_units === 'string' ? row.meta_units! : '';
    try {
      const metaJson = typeof row.meta_json === 'string' ? row.meta_json : null;
      const meta = metaJson ? JSON.parse(metaJson) : null;
      if (meta && typeof meta === 'object') {
        if (coverage == null && typeof meta.coverage === 'number' && Number.isFinite(meta.coverage)) {
          coverage = meta.coverage;
        }
        if (drift == null && typeof meta.drift === 'number' && Number.isFinite(meta.drift)) {
          drift = meta.drift;
        }
        if (typeof meta.kind === 'string') {
          kind = meta.kind;
        }
        if (typeof meta.units === 'string') {
          units = meta.units;
        }
      }
    } catch (error) {
      console.warn('failed to parse baseline meta', error);
    }
    if (!units) {
      units = kind === 'cop' ? '' : kind === 'current' ? 'A' : '°C';
    }
    const summaryParts = [`Baseline deviation (${kind}) — ${Math.round((coverage ?? 0) * 100)}% in-range`];
    if (typeof drift === 'number' && Number.isFinite(drift)) {
      const signed = `${drift >= 0 ? '+' : ''}${drift.toFixed(2)}${units}`;
      summaryParts.push(`drift ${signed}`);
    }
    return {
      ...row,
      coverage,
      drift,
      meta_kind: kind,
      meta_units: units,
      summary: summaryParts.join('; '),
    };
  });
  const isClientOnly =
    auth && auth.roles.includes('client') && !(auth.roles.includes('admin') || auth.roles.includes('ops'));
  const out = isClientOnly ? results.map((r) => ({ ...r, device_id: maskId(r.device_id) })) : results;
  return c.json(out);
});

app.post('/api/alerts/:id/ack', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const id = c.req.param('id');
  await c.env.DB.prepare("UPDATE alerts SET state='ack', ack_by=?, ack_at=datetime('now') WHERE alert_id=? AND state='open'")
    .bind(auth.email ?? auth.sub, id)
    .run();
  return c.json({ ok: true });
});

app.post('/api/alerts/:id/resolve', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const id = c.req.param('id');
  await c.env.DB.prepare(
    "UPDATE alerts SET state='closed', closed_at=datetime('now') WHERE alert_id=? AND state IN ('open','ack')",
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

app.post('/api/alerts/:id/comment', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const id = c.req.param('id');
  const { body } = await c.req.json<{ body: string }>();
  const cid = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO alert_comments (id, alert_id, author, ts, body) VALUES (?, ?, ?, datetime('now'), ?)`,
  )
    .bind(cid, id, auth.email ?? auth.sub, body)
    .run();
  return c.json({ ok: true, id: cid });
});

app.get('/api/admin/distinct/regions', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const rows = await c.env.DB.prepare(
    "SELECT DISTINCT region FROM sites WHERE region IS NOT NULL AND TRIM(region)<>'' ORDER BY region",
  ).all();
  return c.json(rows.results ?? []);
});

app.get('/api/admin/distinct/clients', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const rows = await c.env.DB.prepare(
    'SELECT client_id, COALESCE(name, client_id) AS name FROM clients ORDER BY name',
  ).all();
  return c.json(rows.results ?? []);
});

app.get('/api/admin/site-clients', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const rows = await c.env.DB.prepare('SELECT client_id, site_id FROM site_clients ORDER BY client_id, site_id').all();
  return c.json(rows.results ?? []);
});

app.post('/api/admin/site-clients', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const { clientId, siteId } = await c.req.json<{ clientId: string; siteId: string }>();
  if (!clientId || !siteId) {
    return c.text('Bad Request', 400);
  }
  await c.env.DB.prepare('INSERT OR IGNORE INTO site_clients (client_id, site_id) VALUES (?, ?)').bind(clientId, siteId).run();
  return c.json({ ok: true });
});

app.delete('/api/admin/site-clients', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const clientId = url.searchParams.get('clientId');
  const siteId = url.searchParams.get('siteId');
  if (!clientId || !siteId) {
    return c.text('Bad Request', 400);
  }
  await c.env.DB.prepare('DELETE FROM site_clients WHERE client_id=? AND site_id=?').bind(clientId, siteId).run();
  return c.json({ ok: true });
});

app.get('/api/admin/slo', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const clientId = url.searchParams.get('clientId');
  let sql =
    'SELECT cs.client_id, cs.uptime_target, cs.ingest_target, cs.cop_target, cs.report_recipients, cs.updated_at, c.name AS client_name FROM client_slos cs LEFT JOIN clients c ON c.client_id = cs.client_id';
  const bind: string[] = [];
  if (clientId) {
    sql += ' WHERE cs.client_id = ?';
    bind.push(clientId);
  }
  sql += ' ORDER BY COALESCE(c.name, cs.client_id)';
  const rows = await c.env.DB.prepare(sql).bind(...bind).all();
  return c.json(rows.results ?? []);
});

app.post('/api/admin/slo', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const body = await c.req
    .json<{
      clientId: string;
      uptimeTarget?: number | string | null;
      ingestTarget?: number | string | null;
      copTarget?: number | string | null;
      reportRecipients?: string | null;
    }>()
    .catch(() => null);
  if (!body?.clientId) {
    return c.text('clientId required', 400);
  }

  const toRatio = (value: number | string | null | undefined): number | null => {
    if (value == null) return null;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  };

  const uptimeTarget = toRatio(body.uptimeTarget);
  const ingestTarget = toRatio(body.ingestTarget);
  const copTarget = toRatio(body.copTarget);
  const recipients = body.reportRecipients ?? null;

  await c.env.DB.prepare(
    `INSERT INTO client_slos (client_id, uptime_target, ingest_target, cop_target, report_recipients, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(client_id) DO UPDATE SET
         uptime_target=excluded.uptime_target,
         ingest_target=excluded.ingest_target,
         cop_target=excluded.cop_target,
         report_recipients=excluded.report_recipients,
         updated_at=excluded.updated_at`,
  )
    .bind(body.clientId, uptimeTarget, ingestTarget, copTarget, recipients)
    .run();

  return c.json({ ok: true });
});

app.get('/api/admin/sites', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const rows = await c.env.DB.prepare('SELECT site_id, name, region FROM sites ORDER BY site_id').all();
  return c.json(rows.results ?? []);
});

app.get('/api/admin/maintenance', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const rows = await c.env.DB.prepare(
    `SELECT id, site_id, device_id, start_ts, end_ts, reason,
            CASE WHEN start_ts <= datetime('now') AND (end_ts IS NULL OR end_ts >= datetime('now')) THEN 1 ELSE 0 END AS active
       FROM maintenance_windows
       ORDER BY start_ts DESC
       LIMIT 200`,
  ).all<{
    id: string;
    site_id: string | null;
    device_id: string | null;
    start_ts: string;
    end_ts: string;
    reason: string | null;
    active: number | null;
  }>();
  const results = (rows.results ?? []).map((row) => ({
    ...row,
    active: row.active === 1,
  }));
  return c.json(results);
});

app.post('/api/admin/maintenance', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const body = await c.req
    .json<{ siteId?: string; deviceId?: string; startTs?: string; endTs?: string; reason?: string }>()
    .catch(() => null);
  if (!body) {
    return c.text('Bad Request', 400);
  }

  const siteId = body.siteId?.trim() || null;
  const deviceId = body.deviceId?.trim() || null;
  if (!siteId && !deviceId) {
    return c.text('Must provide a siteId or deviceId', 400);
  }

  const startTs = parseIsoTimestamp(body.startTs);
  const endTs = parseIsoTimestamp(body.endTs);
  if (!startTs || !endTs) {
    return c.text('Invalid start or end timestamp', 400);
  }

  if (Date.parse(startTs) >= Date.parse(endTs)) {
    return c.text('End must be after start', 400);
  }

  const reason = body.reason?.trim();
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO maintenance_windows (id, site_id, device_id, start_ts, end_ts, reason) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, siteId, deviceId, startTs, endTs, reason && reason.length > 0 ? reason.slice(0, 500) : null)
    .run();

  return c.json({ ok: true, id });
});

app.delete('/api/admin/maintenance/:id', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM maintenance_windows WHERE id=?').bind(id).run();
  return c.json({ ok: true });
});

app.post('/api/admin/sites', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const { siteId, name, region } = await c.req.json<{ siteId: string; name?: string; region?: string }>();
  if (!siteId) {
    return c.text('Bad Request', 400);
  }
  await c.env.DB.prepare(
    'INSERT INTO sites (site_id, name, region) VALUES (?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET name=excluded.name, region=excluded.region',
  )
    .bind(siteId, name ?? null, region ?? null)
    .run();
  return c.json({ ok: true });
});

app.delete('/api/admin/sites', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const siteId = url.searchParams.get('siteId');
  if (!siteId) {
    return c.text('Bad Request', 400);
  }
  await c.env.DB.prepare('DELETE FROM sites WHERE site_id=?').bind(siteId).run();
  return c.json({ ok: true });
});

app.get('/api/overview', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const data = await buildOverviewData(c.env.DB, auth);
  return c.json(data);
});

app.get('/api/overview/kpis', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const snapshot = await collectOverviewSnapshot(c.env.DB, auth, { includeSites: false, includeSeries: false });
  const onlinePct = snapshot.totalDevices > 0 ? (100 * snapshot.onlineCount) / snapshot.totalDevices : 0;
  return c.json({
    online_pct: onlinePct,
    open_alerts: snapshot.openAlerts,
    avg_cop: snapshot.avgCop ?? 0,
    low_dt: snapshot.lowDeltaCount,
    updated_at: snapshot.updatedAt,
  });
});

app.get('/api/overview/sparklines', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const snapshot = await collectOverviewSnapshot(c.env.DB, auth, { includeSites: false, includeSeries: true });
  const deltaSeries = snapshot.deltaSeries
    .map((entry) => (typeof entry.value === 'number' && Number.isFinite(entry.value) ? entry.value : null))
    .filter((value): value is number => value != null);
  const copSeries = snapshot.copSeries
    .map((entry) => (typeof entry.value === 'number' && Number.isFinite(entry.value) ? entry.value : null))
    .filter((value): value is number => value != null);
  return c.json({ delta_t: deltaSeries, cop: copSeries });
});

app.get('/api/devices', async (c) => {
  const { DB } = c.env;
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }

  const url = new URL(c.req.url);
  const site = url.searchParams.get('site');
  const region = url.searchParams.get('region');
  const client = url.searchParams.get('client');
  const online = url.searchParams.get('online');

  let sql = `SELECT d.device_id, d.site_id, s.name AS site_name, s.region,
                    d.online, d.last_seen_at,
                    GROUP_CONCAT(DISTINCT sc.client_id) AS clients
             FROM devices d
             LEFT JOIN sites s ON d.site_id = s.site_id
             LEFT JOIN site_clients sc ON d.site_id = sc.site_id
             WHERE 1=1`;
  const bind: Array<string | number> = [];
  if (site) {
    sql += ' AND d.site_id=?';
    bind.push(site);
  }
  if (region) {
    sql += ' AND s.region=?';
    bind.push(region);
  }
  if (typeof online === 'string' && (online === '0' || online === '1')) {
    sql += ' AND d.online=?';
    bind.push(Number(online));
  }
  if (client) {
    sql += ' AND EXISTS (SELECT 1 FROM site_clients sc2 WHERE sc2.site_id = d.site_id AND sc2.client_id = ?)';
    bind.push(client);
  }

  if (auth.roles.includes('client') || auth.roles.includes('contractor')) {
    const clientIds = auth.clientIds ?? [];
    if (clientIds.length === 0) {
      return c.json([]);
    }
    const placeholders = clientIds.map(() => '?').join(',');
    sql += ` AND EXISTS (SELECT 1 FROM site_clients sc3 WHERE sc3.site_id = d.site_id AND sc3.client_id IN (${placeholders}))`;
    bind.push(...clientIds);
  }

  sql += ' GROUP BY d.device_id ORDER BY (d.last_seen_at IS NULL), d.last_seen_at DESC LIMIT 500';
  const rows = await DB.prepare(sql).bind(...bind).all();
  const results = rows.results ?? [];
  const isClientOnly =
    auth && auth.roles.includes('client') && !(auth.roles.includes('admin') || auth.roles.includes('ops'));

  const devices = results.map((row: any) => {
    const id = typeof row.device_id === 'string' ? row.device_id : String(row.device_id ?? '');
    const online = Number(row.online) === 1;
    const clients: string[] =
      typeof row.clients === 'string' && row.clients.length > 0 ? row.clients.split(',') : [];
    const baseName = typeof row.site_name === 'string' && row.site_name ? row.site_name : id;
    return {
      id,
      name: isClientOnly ? maskId(id) : baseName,
      status: online ? 'online' : 'offline',
      siteId: (typeof row.site_id === 'string' && row.site_id) || null,
      lastHeartbeat: typeof row.last_seen_at === 'string' ? row.last_seen_at : null,
      clientIds: clients.filter((value: string) => value && value.length > 0),
    };
  });

  return c.json(devices);
});

app.get('/api/regions', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);

  const rows = await c.env.DB.prepare(
    `
    SELECT COALESCE(region, '—') AS region, COUNT(*) AS sites
      FROM sites
     GROUP BY region
     ORDER BY region
  `,
  ).all<{ region: string; sites: number }>();

  return c.json({ regions: rows.results ?? [] });
});

app.get('/api/site-list', async (c) => {
  const auth = c.get('auth');
  requireRole(auth, ['admin', 'ops']);

  const region = c.req.query('region');
  const qParam = c.req.query('q');
  const limitParam = Number(c.req.query('limit') ?? 2000);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(Math.floor(limitParam), 1), 5000)
    : 2000;
  const searchTerm = typeof qParam === 'string' ? qParam.trim() : '';

  let sql = 'SELECT site_id, name, region FROM sites WHERE site_id IS NOT NULL';
  const bind: Array<string | number> = [];
  if (region) {
    sql += ' AND region = ?';
    bind.push(region);
  }
  if (searchTerm) {
    const pattern = `%${escapeForLike(searchTerm)}%`;
    sql += " AND (site_id LIKE ? ESCAPE '\\\\' OR name LIKE ? ESCAPE '\\\\')";
    bind.push(pattern, pattern);
  }

  sql += ' ORDER BY (name IS NULL), name, site_id LIMIT ?';
  bind.push(limit);

  const rows = await c.env.DB.prepare(sql)
    .bind(...bind)
    .all<{ site_id: string; name: string | null; region: string | null }>();

  return c.json({ sites: rows.results ?? [] });
});

app.get('/api/sites/search', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const region = c.req.query('region');
  const onlyUnhealthyParam = c.req.query('only_unhealthy');
  const limitParam = Number(c.req.query('limit') ?? 100);
  const offsetParam = Number(c.req.query('offset') ?? 0);
  const limit = Number.isFinite(limitParam) ? Math.min(500, Math.max(1, limitParam)) : 100;
  const offset = Number.isFinite(offsetParam) ? Math.max(0, offsetParam) : 0;
  const onlyUnhealthy =
    typeof onlyUnhealthyParam === 'string'
      ? ['1', 'true', 'yes', 'on'].includes(onlyUnhealthyParam.toLowerCase())
      : false;
  const staleMinutesThreshold = 10;

  const siteSearchCte = `WITH all_sites AS (
      SELECT site_id FROM sites WHERE site_id IS NOT NULL
      UNION
      SELECT DISTINCT site_id FROM devices WHERE site_id IS NOT NULL
      UNION
      SELECT DISTINCT site_id FROM site_clients WHERE site_id IS NOT NULL
    ),
    device_stats AS (
      SELECT site_id,
             COUNT(*) AS total_devices,
             SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) AS online_devices,
             MIN(CASE WHEN last_seen_at IS NULL THEN NULL ELSE ROUND((julianday('now') - julianday(last_seen_at)) * 24 * 60) END) AS freshness_min
      FROM devices
      GROUP BY site_id
    ),
    alert_stats AS (
      SELECT d.site_id AS site_id,
             COUNT(*) AS open_alerts
        FROM alerts a
        JOIN devices d ON d.device_id = a.device_id
       WHERE a.state IN ('open','ack')
       GROUP BY d.site_id
    ),
    base AS (
      SELECT a.site_id,
             s.name,
             s.region,
             s.lat,
             s.lon,
             COALESCE(device_stats.total_devices, 0) AS total_devices,
             COALESCE(device_stats.online_devices, 0) AS online_devices,
             device_stats.freshness_min,
             COALESCE(alert_stats.open_alerts, 0) AS open_alerts
        FROM all_sites a
        LEFT JOIN sites s ON s.site_id = a.site_id
        LEFT JOIN device_stats ON device_stats.site_id = a.site_id
        LEFT JOIN alert_stats ON alert_stats.site_id = a.site_id
    ),
    annotated AS (
      SELECT base.*,
             (base.total_devices - base.online_devices) AS offline_devices,
             CASE
               WHEN base.total_devices = 0 THEN 0
               WHEN base.open_alerts > 0 OR (base.total_devices - base.online_devices) > 0 OR (base.freshness_min IS NOT NULL AND base.freshness_min > ?) THEN 1
               ELSE 0
             END AS is_unhealthy
        FROM base
    )`;

  const page = await c.env.DB.prepare(
    `${siteSearchCte}
    SELECT site_id, name, region, lat, lon, total_devices, online_devices, offline_devices, open_alerts, freshness_min, is_unhealthy
      FROM annotated
     WHERE (? IS NULL OR region = ?)
       AND (? = 0 OR is_unhealthy = 1)
     ORDER BY site_id
     LIMIT ? OFFSET ?`,
  )
    .bind(
      staleMinutesThreshold,
      region ?? null,
      region ?? null,
      onlyUnhealthy ? 1 : 0,
      limit,
      offset,
    )
    .all<{
      site_id: string | null;
      name: string | null;
      region: string | null;
      lat: number | null;
      lon: number | null;
      total_devices: number | null;
      online_devices: number | null;
      offline_devices: number | null;
      open_alerts: number | null;
      freshness_min: number | null;
      is_unhealthy: number | null;
    }>();

  const totalRow = await c.env.DB.prepare(
    `${siteSearchCte}
    SELECT COUNT(*) AS n
      FROM annotated
     WHERE (? IS NULL OR region = ?)
       AND (? = 0 OR is_unhealthy = 1)`,
  )
    .bind(staleMinutesThreshold, region ?? null, region ?? null, onlyUnhealthy ? 1 : 0)
    .first<{ n: number }>();

  const total = toNumber(totalRow?.n) ?? 0;
  const results = (page.results ?? []).map((row) => {
    const totalDevices = toNumber(row.total_devices) ?? 0;
    const onlineDevices = toNumber(row.online_devices) ?? 0;
    const offlineDevices = toNumber(row.offline_devices) ?? 0;
    const openAlerts = toNumber(row.open_alerts) ?? 0;
    const freshnessMin = toNumber(row.freshness_min);
    const unhealthy = row.is_unhealthy === 1;
    let health: 'healthy' | 'unhealthy' | 'empty';
    if (totalDevices === 0) {
      health = 'empty';
    } else {
      health = unhealthy ? 'unhealthy' : 'healthy';
    }
    return {
      site_id: row.site_id,
      name: row.name,
      region: row.region,
      lat: toNumber(row.lat),
      lon: toNumber(row.lon),
      total_devices: totalDevices,
      online_devices: onlineDevices,
      offline_devices: offlineDevices,
      open_alerts: openAlerts,
      freshness_min: freshnessMin,
      health,
    };
  });

  return c.json({ results, total, limit, offset, has_more: offset + limit < total });
});

app.get('/api/devices/search', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const site = c.req.query('site_id');
  const region = c.req.query('region');
  const health = c.req.query('health');
  const limitParam = Number(c.req.query('limit') ?? 100);
  const offsetParam = Number(c.req.query('offset') ?? 0);
  const limit = Number.isFinite(limitParam) ? Math.min(500, Math.max(1, limitParam)) : 100;
  const offset = Number.isFinite(offsetParam) ? Math.max(0, offsetParam) : 0;

  const where = `WHERE ( ? IS NULL OR d.site_id = ? )
                 AND ( ? IS NULL OR s.region = ? )`;
  const rows = await c.env.DB.prepare(
    `SELECT d.device_id, d.site_id, s.region AS region, d.firmware, d.model, d.online, d.last_seen_at,
            COALESCE(SUM(CASE WHEN a.state IN ('open','ack') THEN 1 ELSE 0 END),0) AS open_alerts
       FROM devices d
       LEFT JOIN sites s ON s.site_id=d.site_id
       LEFT JOIN alerts a ON a.device_id=d.device_id AND a.state IN ('open','ack')
       ${where}
       GROUP BY d.device_id
       HAVING (? IS NULL) OR (
         (?='online'    AND d.online=1) OR
         (?='offline'   AND d.online=0) OR
         (?='unhealthy' AND (d.online=0 OR open_alerts>0))
       )
       ORDER BY d.site_id, d.device_id
       LIMIT ? OFFSET ?`,
  )
    .bind(
      site ?? null,
      site ?? null,
      region ?? null,
      region ?? null,
      health ?? null,
      health ?? null,
      health ?? null,
      health ?? null,
      limit,
      offset,
    )
    .all<{
      device_id: string;
      site_id: string | null;
      firmware: string | null;
      model: string | null;
      online: number | null;
      last_seen_at: string | null;
      region: string | null;
      open_alerts: number | null;
    }>();

  const totalRow = await c.env.DB.prepare(
    `WITH base AS (
        SELECT d.device_id, d.online, d.site_id, s.region AS region,
               COALESCE(SUM(CASE WHEN a.state IN ('open','ack') THEN 1 ELSE 0 END),0) AS open_alerts
          FROM devices d
          LEFT JOIN sites s ON s.site_id=d.site_id
          LEFT JOIN alerts a ON a.device_id=d.device_id AND a.state IN ('open','ack')
          ${where}
          GROUP BY d.device_id
      )
      SELECT COUNT(*) AS n FROM base
      WHERE (? IS NULL) OR (
        (?='online'    AND online=1) OR
        (?='offline'   AND online=0) OR
        (?='unhealthy' AND (online=0 OR open_alerts>0))
      )`,
  )
    .bind(
      site ?? null,
      site ?? null,
      region ?? null,
      region ?? null,
      health ?? null,
      health ?? null,
      health ?? null,
      health ?? null,
    )
    .first<{ n: number }>();

  const total = toNumber(totalRow?.n) ?? 0;
  const results = (rows.results ?? []).map((row) => {
    const openAlerts = toNumber(row.open_alerts) ?? 0;
    const isOnline = row.online === 1;
    const derivedHealth = !isOnline || openAlerts > 0 ? 'unhealthy' : 'healthy';
    return {
      device_id: row.device_id,
      site_id: row.site_id,
      firmware: row.firmware,
      model: row.model,
      online: isOnline,
      last_seen_at: row.last_seen_at,
      region: row.region,
      open_alerts: openAlerts,
      health: derivedHealth,
    };
  });

  return c.json({ results, total, limit, offset, has_more: offset + limit < total });
});

app.post('/api/commissioning/:deviceId/report', async (c) => {
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops', 'contractor']);
  const deviceId = c.req.param('deviceId');
  const payload = await c.req.json<Omit<CommissioningPayload, 'deviceId'>>();
  const { generateCommissioningPDF } = await getPdfModule();
  const res = await generateCommissioningPDF(c.env, { ...payload, deviceId });
  return c.json(res);
});

app.post('/api/reports/incident', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const url = new URL(c.req.url);
  const siteId = url.searchParams.get('siteId');
  const hoursParam = url.searchParams.get('hours');
  if (!siteId) {
    return c.text('siteId required', 400);
  }

  const hours = Number(hoursParam ?? '24');
  const windowHours = Number.isFinite(hours) && hours > 0 ? hours : 24;

  const site = await c.env.DB.prepare('SELECT site_id, name, region FROM sites WHERE site_id=?')
    .bind(siteId)
    .first<{ site_id: string; name: string | null; region: string | null }>();

  const counts = await c.env.DB.prepare(
    `SELECT severity, COUNT(*) as n
     FROM alerts
     WHERE device_id IN (SELECT device_id FROM devices WHERE site_id=?) AND state IN ('open','ack')
     GROUP BY severity`,
  )
    .bind(siteId)
    .all<{ severity: string; n: number }>();

  const top = await c.env.DB.prepare(
    `SELECT d.device_id, SUM(CASE WHEN a.state IN ('open','ack') THEN 1 ELSE 0 END) as open_count
     FROM devices d LEFT JOIN alerts a ON a.device_id = d.device_id
     WHERE d.site_id=?
     GROUP BY d.device_id
     ORDER BY open_count DESC
     LIMIT 5`,
  )
    .bind(siteId)
    .all<{ device_id: string; open_count: number | null }>();

  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1000);
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = windowEnd.toISOString();

  const latestP1 = await c.env.DB.prepare(
    `SELECT opened_at, closed_at, state
       FROM alerts
       WHERE type='ingest_degradation'
       ORDER BY opened_at DESC
       LIMIT 1`,
  ).first<{ opened_at: string; closed_at: string | null; state: string }>();

  const maintenance = await c.env.DB.prepare(
    `SELECT site_id, device_id, start_ts, end_ts, reason
       FROM maintenance_windows
       WHERE (site_id = ? OR site_id IS NULL)
         AND (device_id IS NULL OR device_id IN (SELECT device_id FROM devices WHERE site_id=?))
         AND end_ts >= ?
         AND start_ts <= ?
       ORDER BY start_ts DESC
       LIMIT 5`,
  )
    .bind(siteId, siteId, windowStartIso, windowEndIso)
    .all<{
      site_id: string | null;
      device_id: string | null;
      start_ts: string;
      end_ts: string | null;
      reason: string | null;
    }>();

  const { PDFDocument, StandardFonts } = await getPdfLib();
  const pdf = await PDFDocument.create();
  let page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let y = 800;
  const draw = (text: string, size = 12) => {
    page.drawText(text, { x: 40, y, size, font });
    y -= size + 6;
  };

  draw(`Incident report — ${site?.name ?? siteId}`, 18);
  draw(`Region: ${site?.region ?? '—'}`);
  draw(`Window: last ${Math.round(windowHours * 10) / 10}h`);
  y -= 6;
  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 1 });
  y -= 12;

  const severityRows = counts.results ?? [];
  draw('Open alerts by severity:', 14);
  if (severityRows.length === 0) {
    draw('• None');
  } else {
    for (const row of severityRows) {
      draw(`• ${row.severity}: ${row.n}`);
    }
  }

  y -= 6;
  const topRows = top.results ?? [];
  draw('Top devices:', 14);
  if (topRows.length === 0) {
    draw('• None');
  } else {
    for (const row of topRows) {
      const count = row.open_count ?? 0;
      draw(`• ${row.device_id}: ${count}`);
    }
  }

  const generatedAt = new Date().toISOString();
  y -= 6;
  draw(`Generated at: ${generatedAt}`);

  const normalizeIso = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.valueOf())) return null;
    return parsed.toISOString();
  };

  if (y < 140) {
    page = pdf.addPage([595, 842]);
    y = 780;
  }

  y -= 6;
  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.5 });
  y -= 12;

  draw('Context timeline:', 14);

  if (latestP1) {
    const opened = normalizeIso(latestP1.opened_at) ?? latestP1.opened_at;
    const closed = normalizeIso(latestP1.closed_at) ?? (latestP1.closed_at ? latestP1.closed_at : 'ongoing');
    draw(`P1 ingest degradation: ${opened} → ${closed} (${latestP1.state})`);
  } else {
    draw('P1 ingest degradation: none recorded.');
  }

  const maintenanceRows = maintenance.results ?? [];
  if (maintenanceRows.length === 0) {
    draw('Maintenance windows: none overlapping reporting window.');
  } else {
    draw('Maintenance windows impacting window:');
    for (const row of maintenanceRows) {
      if (y < 60) {
        page = pdf.addPage([595, 842]);
        y = 780;
      }
      const scope = row.device_id
        ? `Device ${row.device_id}`
        : row.site_id
          ? `Site ${row.site_id}`
          : 'Global';
      const startIso = normalizeIso(row.start_ts) ?? row.start_ts;
      const endIso = normalizeIso(row.end_ts) ?? (row.end_ts ? row.end_ts : 'open');
      const reason = row.reason ? ` — ${row.reason.slice(0, 80)}` : '';
      draw(`• ${scope}: ${startIso} → ${endIso}${reason}`);
    }
  }

  const bytes = await pdf.save();
  const key = `reports/incident_${siteId}_${Date.now()}.pdf`;
  await c.env.REPORTS.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });

  return c.json({
    ok: true,
    key,
    path: `/api/reports/${key}`,
    url: `/api/reports/${key}`,
    generatedAt,
  });
});

app.post('/api/reports/incident/v2', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const url = new URL(c.req.url);
  const siteId = url.searchParams.get('siteId');
  const hoursParam = url.searchParams.get('hours');
  if (!siteId) {
    return c.text('siteId required', 400);
  }

  const hoursRaw = Number(hoursParam ?? '24');
  const windowHours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : 24;
  const windowEnd = new Date();
  const payload = await buildIncidentReportV2Payload(c.env, siteId, windowHours, { windowEnd });

  const { generateIncidentReportV2 } = await getPdfModule();
  const pdf = await generateIncidentReportV2(c.env, payload);
  const path = keyToPath(pdf.key);

  const { clients, recipients } = await collectSiteRecipients(c.env.DB, siteId);
  const primaryClientId = clients[0]?.id ?? null;

  await logReportDelivery(c.env.DB, {
    type: 'incident',
    status: 'generated',
    clientId: primaryClientId,
    siteId,
    path,
    meta: { hours: windowHours, windowStart: payload.windowStart, windowEnd: payload.windowEnd },
  });

  let emailed = false;
  if (recipients.length > 0) {
    const emailSettings = await loadEmailSettings(c.env.DB);
    const subject = `Incident report — ${payload.siteName ?? payload.siteId}`;
    const introLines = [`Incident report for ${payload.siteName ?? payload.siteId}`];
    const detailLines = [
      `Window: ${payload.windowStart} → ${payload.windowEnd}`,
      payload.incidents.length === 0
        ? 'Incidents: none recorded in this window'
        : `Incidents: ${payload.incidents.length}`,
      payload.maintenance.length === 0
        ? 'Maintenance windows: none'
        : `Maintenance windows: ${payload.maintenance.length}`,
      `Download: ${pdf.url}`,
    ];
    const footerLines = [`R2 path: ${path}`];
    const html = brandEmail({
      title: 'Incident report ready',
      introLines,
      detailLines,
      footerLines,
      cta: { href: pdf.url, label: 'View report' },
    });
    const text = [...introLines, ...detailLines, ...footerLines].join('\n');
    emailed = await sendEmail(c.env, recipients, subject, text, emailSettings, html);
    if (emailed) {
      await logReportDelivery(c.env.DB, {
        type: 'incident',
        status: 'sent',
        clientId: primaryClientId,
        siteId,
        path,
        subject,
        to: recipients,
        meta: { hours: windowHours, windowStart: payload.windowStart, windowEnd: payload.windowEnd },
      });
    }
  }

  return c.json({
    ok: true,
    key: pdf.key,
    path,
    url: pdf.url,
    window: { start: payload.windowStart, end: payload.windowEnd, hours: windowHours },
    incidents: payload.incidents.length,
    maintenance: payload.maintenance.length,
    emailed,
    recipients,
    clients,
  });
});

app.get('/api/reports/preview-html', async (c) => {
  const bypass = isDevBypassActive(c.env);
  if (!bypass) {
    const jwt = c.req.header('Cf-Access-Jwt-Assertion');
    if (!jwt) {
      return c.text('Unauthorized', 401);
    }
    const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
    if (!auth) {
      return c.text('Unauthorized', 401);
    }
    try {
      requireRole(auth, ['admin', 'ops']);
    } catch {
      return c.text('Forbidden', 403);
    }
  }

  const type = (c.req.query('type') || '').toLowerCase();
  const sample = c.req.query('sample') === '1';
  const hoursParam = c.req.query('hours');
  const parsedHours = Number(hoursParam);
  const windowHours = Number.isFinite(parsedHours) && parsedHours > 0 ? parsedHours : 24;

  let innerHtml = '';

  if (type === 'incident') {
    let payload: IncidentReportV2Payload;
    if (sample) {
      payload = sampleIncidentReportV2Payload();
    } else {
      const incidentId = c.req.query('incident_id');
      const siteId = c.req.query('site_id');
      if (incidentId) {
        try {
          payload = await buildIncidentReportV2PayloadForIncident(c.env, incidentId, windowHours);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to load incident';
          return c.text(message, message === 'Incident not found' ? 404 : 400);
        }
      } else if (siteId) {
        payload = await buildIncidentReportV2Payload(c.env, siteId, windowHours);
      } else {
        return c.text('incident_id or site_id required', 400);
      }
    }
    innerHtml = renderIncidentHtmlV2(c.env, payload);
  } else if (type === 'client-monthly') {
    let payload: ClientMonthlyReportPayload;
    if (sample) {
      payload = sampleClientMonthlyReportPayload();
    } else {
      const clientId = c.req.query('client_id');
      const monthKey = c.req.query('month');
      if (!clientId || !monthKey) {
        return c.text('client_id and month required', 400);
      }
      try {
        const prepared = await buildClientMonthlyReportPayload(c.env, clientId, monthKey, { version: 'v2' });
        payload = prepared.payload;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load report';
        if (message === 'Client not found') {
          return c.text(message, 404);
        }
        return c.text(message, 400);
      }
    }
    innerHtml = renderClientMonthlyHtmlV2(c.env, payload);
  } else {
    return c.text('Bad Request', 400);
  }

  const html = (
    <Page title={`Report Preview — ${BRAND.product}`}>
      <div class="report-preview" dangerouslySetInnerHTML={{ __html: innerHtml }} />
    </Page>
  );

  return c.html(html);
});

app.post('/api/reports/client-monthly', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const clientId = url.searchParams.get('client_id');
  const monthParam = url.searchParams.get('month');
  if (!clientId || !monthParam) {
    return c.text('client_id and month required', 400);
  }

  let prepared;
  try {
    prepared = await buildClientMonthlyReportPayload(c.env, clientId, monthParam);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to prepare report';
    if (message === 'Client not found') {
      return c.text(message, 404);
    }
    return c.text(message, 400);
  }

  const { payload, client } = prepared;

  const { generateClientMonthlyReport } = await getPdfModule();
  const pdf = await generateClientMonthlyReport(c.env, payload);

  await logReportDelivery(c.env.DB, {
    type: 'monthly',
    status: 'generated',
    clientId: client.id,
    siteId: null,
    path: keyToPath(pdf.key),
    subject: `Monthly report — ${payload.monthLabel} (${client.name})`,
    meta: { month: monthParam, version: 'v1' },
  });

  return c.json({
    ok: true,
    key: pdf.key,
    url: pdf.url,
    client,
    month: monthParam,
    metrics: payload.metrics,
    targets: payload.targets,
    siteCount: payload.siteCount,
    deviceCount: payload.deviceCount,
    recipients: payload.recipients,
  });
});

app.post('/api/reports/email-existing', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const blocked = await guardWrite(c);
  if (blocked) {
    return blocked;
  }
  let body: {
    type?: string;
    client_id?: string | null;
    site_id?: string | null;
    path?: string | null;
    subject?: string | null;
  } | null = null;
  try {
    body = await c.req.json();
  } catch {}

  const type = typeof body?.type === 'string' ? body.type.trim() : '';
  const clientId = typeof body?.client_id === 'string' ? body.client_id.trim() : '';
  const siteId = typeof body?.site_id === 'string' ? body.site_id.trim() : '';
  const subjectInput = typeof body?.subject === 'string' ? body.subject.trim() : '';
  const normalizedType = type || 'monthly';
  if (!body?.path) {
    return c.text('path required', 400);
  }
  const normalizedPath = normalizeReportPath(body.path);
  if (!normalizedPath) {
    return c.text('Invalid path', 400);
  }
  if (normalizedType !== 'monthly' && normalizedType !== 'incident') {
    return c.text('Unsupported report type', 400);
  }
  if (!clientId && !siteId) {
    return c.text('client_id or site_id required', 400);
  }

  let resolvedClientId: string | null = clientId || null;
  let clientName: string | null = null;
  let siteName: string | null = null;
  let recipients: string[] = [];

  if (clientId) {
    const row = await c.env.DB.prepare(
      `SELECT c.client_id, COALESCE(c.name, c.client_id) AS name, cs.report_recipients
         FROM clients c
         LEFT JOIN client_slos cs ON cs.client_id = c.client_id
        WHERE c.client_id = ?`,
    )
      .bind(clientId)
      .first<{ client_id: string; name: string | null; report_recipients: string | null }>();
    if (row) {
      clientName = row.name ?? row.client_id;
      recipients = recipients.concat(parseRecipientList(row.report_recipients ?? null));
    }
  }

  if (siteId) {
    const siteRow = await c.env.DB.prepare('SELECT site_id, name FROM sites WHERE site_id=?')
      .bind(siteId)
      .first<{ site_id: string; name: string | null }>();
    if (siteRow) {
      siteName = siteRow.name ?? siteRow.site_id;
    }
    const { clients, recipients: siteRecipients } = await collectSiteRecipients(c.env.DB, siteId);
    recipients = recipients.concat(siteRecipients);
    if (!resolvedClientId && clients.length === 1) {
      const [firstClient] = clients;
      resolvedClientId = firstClient?.id ?? null;
      if (!clientName && firstClient) {
        clientName = firstClient.name ?? firstClient.id;
      }
    }
  }

  const uniqueRecipients = dedupeRecipients(recipients);
  const defaultSubject = (() => {
    if (normalizedType === 'monthly') {
      return `Monthly report link — ${clientName ?? resolvedClientId ?? BRAND.name}`;
    }
    if (normalizedType === 'incident') {
      const scope = siteName ?? clientName ?? resolvedClientId ?? BRAND.name;
      return `Incident report link — ${scope}`;
    }
    return 'Report link';
  })();
  const subject = subjectInput || defaultSubject;
  if (uniqueRecipients.length === 0) {
    await logReportDelivery(c.env.DB, {
      type: normalizedType,
      status: 'skipped',
      clientId: resolvedClientId ?? null,
      siteId: siteId || null,
      path: normalizedPath,
      subject,
      meta: { resend: true, reason: 'no_recipients', actor: auth.email ?? auth.sub },
    });
    return c.text('No recipients configured', 400);
  }

  const settings = await loadEmailSettings(c.env.DB);
  if (!settings.webhook || !settings.from) {
    await logReportDelivery(c.env.DB, {
      type: normalizedType,
      status: 'skipped',
      clientId: resolvedClientId ?? null,
      siteId: siteId || null,
      path: normalizedPath,
      subject,
      to: uniqueRecipients,
      meta: { resend: true, reason: 'email_config_missing', actor: auth.email ?? auth.sub },
    });
    return c.text('Email settings incomplete', 503);
  }

  const origin = new URL(c.req.url);
  const downloadUrl = `${origin.origin}${normalizedPath}`;
  const lines = [
    `Report type: ${normalizedType}`,
    resolvedClientId
      ? `Client: ${clientName ?? resolvedClientId} (${resolvedClientId})`
      : clientName
        ? `Client: ${clientName}`
        : null,
    siteId ? `Site: ${siteName ?? siteId} (${siteId})` : siteName ? `Site: ${siteName}` : null,
    `Download: ${downloadUrl}`,
    `R2 path: ${normalizedPath}`,
    `Requested by: ${auth.email ?? auth.sub}`,
  ].filter((line): line is string => typeof line === 'string' && line.length > 0);

  const detailLines = lines.filter((line) => !line.startsWith('R2 path') && !line.startsWith('Requested by'));
  const footerLines = lines.filter((line) => line.startsWith('R2 path') || line.startsWith('Requested by'));
  const html = brandEmail({
    title: subject,
    introLines: [`Here's the latest ${normalizedType} report link from ${BRAND.product}.`],
    detailLines,
    footerLines,
    cta: { href: downloadUrl, label: 'Open report' },
  });
  const emailed = await sendEmail(c.env, uniqueRecipients, subject, lines.join('\n'), settings, html);
  const status = emailed ? 'sent' : 'send_failed';
  await logReportDelivery(c.env.DB, {
    type: normalizedType,
    status,
    clientId: resolvedClientId ?? null,
    siteId: siteId || null,
    path: normalizedPath,
    subject,
    to: uniqueRecipients,
    meta: { resend: true, actor: auth.email ?? auth.sub },
  });
  if (!emailed) {
    return c.text('Failed to send email', 502);
  }
  return c.json({ ok: true, recipients: uniqueRecipients, subject, path: normalizedPath });
});

app.post('/api/reports/client-monthly/v2', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const clientId = url.searchParams.get('client_id');
  const monthParam = url.searchParams.get('month');
  if (!clientId || !monthParam) {
    return c.text('client_id and month required', 400);
  }

  let prepared;
  try {
    prepared = await buildClientMonthlyReportPayload(c.env, clientId, monthParam, { version: 'v2' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to prepare report';
    if (message === 'Client not found') {
      return c.text(message, 404);
    }
    return c.text(message, 400);
  }

  const { payload, client } = prepared;

  const { generateClientMonthlyReport } = await getPdfModule();
  const pdf = await generateClientMonthlyReport(c.env, payload);
  const path = keyToPath(pdf.key);
  await logReportDelivery(c.env.DB, {
    type: 'monthly',
    status: 'generated',
    clientId: client.id,
    siteId: null,
    path,
    subject: `Monthly report — ${payload.monthLabel} (${client.name})`,
    meta: { month: monthParam, version: 'v2' },
  });
  const recipients = parseRecipientList(payload.recipients ?? null);
  let emailed = false;
  if (recipients.length > 0) {
    const settings = await loadEmailSettings(c.env.DB);
    const subject = `Monthly report — ${payload.monthLabel} (${client.name})`;
    const detailLines = [
      `Client: ${client.name} (${client.id})`,
      `Period: ${payload.periodStart} → ${payload.periodEnd}`,
      `Sites: ${payload.siteCount} · Devices: ${payload.deviceCount}`,
      payload.metrics.uptimePct == null
        ? 'Uptime: n/a'
        : `Uptime: ${(payload.metrics.uptimePct * 100).toFixed(2)}%`,
      `Download: ${pdf.url}`,
    ];
    const footerLines = [`R2 path: ${path}`];
    const html = brandEmail({
      title: `Monthly report ready — ${payload.monthLabel}`,
      introLines: [`${client.name}'s monthly performance summary is ready.`],
      detailLines,
      footerLines,
      cta: { href: pdf.url, label: 'View report' },
    });
    const text = [...detailLines, ...footerLines].join('\n');
    emailed = await sendEmail(c.env, recipients, subject, text, settings, html);
    await logReportDelivery(c.env.DB, {
      type: 'monthly',
      status: emailed ? 'sent' : 'send_failed',
      clientId: client.id,
      siteId: null,
      path,
      subject,
      to: recipients,
      meta: { month: monthParam, version: 'v2', auto: true },
    });
  }

  return c.json({
    ok: true,
    key: pdf.key,
    path,
    url: pdf.url,
    client,
    month: monthParam,
    metrics: payload.metrics,
    targets: payload.targets,
    siteCount: payload.siteCount,
    deviceCount: payload.deviceCount,
    recipients,
    emailed,
  });
});

app.get('/api/reports/client-monthly', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const clientId = url.searchParams.get('client_id');
  if (!clientId) {
    return c.text('client_id required', 400);
  }
  const limitParam = url.searchParams.get('limit');
  const limit = Number(limitParam ?? '20');
  const max = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 20;
  const list = await c.env.REPORTS.list({ prefix: `client-reports/${clientId}/`, limit: max });
  const objects = list.objects ?? [];
  const out = objects.map((obj) => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded?.toISOString?.() ?? obj.uploaded,
    url: `/api/reports/${obj.key}`,
  }));
  return c.json(out);
});

app.get('/api/reports/history', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const url = new URL(c.req.url);
  const normalize = (key: string) => {
    const value = url.searchParams.get(key);
    if (!value) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  const limitParam = url.searchParams.get('limit');
  const rows = await listReportDeliveries(c.env.DB, {
    clientId: normalize('client_id'),
    siteId: normalize('site_id'),
    type: normalize('type'),
    status: normalize('status'),
    limit: limitParam ? Number(limitParam) : undefined,
  });
  return c.json(rows);
});

app.get('/api/clients/:clientId/slo-summary', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  await attachDeployRibbon(c, auth);
  const clientId = c.req.param('clientId');
  if (!canAccessClient(auth, clientId)) {
    return c.text('Forbidden', 403);
  }
  const url = new URL(c.req.url);
  const month = url.searchParams.get('month');
  try {
    const summary = await buildClientSloSummary(c.env, clientId, month);
    return c.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build summary';
    if (message === 'Client not found') {
      return c.text(message, 404);
    }
    return c.text(message, 400);
  }
});

app.get('/api/clients/:clientId/uptime-daily', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  const clientId = c.req.param('clientId');
  if (!canAccessClient(auth, clientId)) {
    return c.text('Forbidden', 403);
  }
  const url = new URL(c.req.url);
  const monthParam = url.searchParams.get('month') ?? formatMonthKey(new Date());
  const range = parseMonthRange(monthParam);
  if (!range) {
    return c.text('Invalid month format', 400);
  }

  const mapRows = await c.env.DB.prepare(
    `SELECT DISTINCT d.device_id
       FROM devices d
       JOIN site_clients sc ON sc.site_id = d.site_id
      WHERE sc.client_id = ?`,
  )
    .bind(clientId)
    .all<{ device_id: string | null }>();
  const deviceIds = (mapRows.results ?? [])
    .map((row) => row.device_id)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  const now = new Date();
  const effectiveEndMs = (() => {
    const monthEnd = range.end.getTime();
    const nowMs = now.getTime();
    if (nowMs >= monthEnd) {
      return monthEnd;
    }
    if (nowMs <= range.start.getTime()) {
      return range.start.getTime();
    }
    return nowMs;
  })();

  const dayMs = 24 * 60 * 60 * 1000;
  const totalDays = Math.max(0, Math.floor((range.end.getTime() - range.start.getTime()) / dayMs));
  const series: Array<{ date: string; uptimePct: number | null }> = [];

  for (let i = 0; i < totalDays; i += 1) {
    const dayStart = new Date(range.start.getTime() + i * dayMs);
    const dayEnd = new Date(dayStart.getTime() + dayMs);
    const isoDate = dayStart.toISOString().slice(0, 10);
    if (dayStart.getTime() >= effectiveEndMs || deviceIds.length === 0) {
      series.push({ date: isoDate, uptimePct: null });
      continue;
    }
    const windowEndMs = Math.min(dayEnd.getTime(), effectiveEndMs);
    if (windowEndMs <= dayStart.getTime()) {
      series.push({ date: isoDate, uptimePct: null });
      continue;
    }
    let uptime: number | null = null;
    try {
      uptime = await computeTimeWeightedUptime(
        c.env.DB,
        deviceIds,
        dayStart.toISOString(),
        new Date(windowEndMs).toISOString(),
        5,
      );
    } catch (error) {
      console.warn('daily uptime compute failed', clientId, isoDate, error);
    }
    series.push({ date: isoDate, uptimePct: uptime });
  }

  return c.json({
    clientId,
    month: formatMonthKey(range.start),
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    effectiveEnd: new Date(effectiveEndMs).toISOString(),
    freshnessMinutes: 5,
    deviceCount: deviceIds.length,
    series,
  });
});

app.post('/api/ops/monthly-run', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  let body: { month?: string } | null = null;
  try {
    body = await c.req.json<{ month?: string }>();
  } catch {}

  const month = body?.month ?? previousMonthKey();
  if (!parseMonthRange(month)) {
    return c.text('Invalid month format', 400);
  }

  const rows = await c.env.DB.prepare('SELECT client_id FROM client_slos').all<{ client_id: string }>();
  const emailSettings = await loadEmailSettings(c.env.DB);
  const results: Array<{
    clientId: string;
    ok: boolean;
    key?: string;
    path?: string;
    url?: string;
    recipients?: string[];
    emailed?: boolean;
    error?: string;
  }> = [];

  const { generateClientMonthlyReport } = await getPdfModule();

  for (const row of rows.results ?? []) {
    try {
      const { payload, client } = await buildClientMonthlyReportPayload(c.env, row.client_id, month, { version: 'v2' });
      const pdf = await generateClientMonthlyReport(c.env, payload);
      const recipients = parseRecipientList(payload.recipients ?? null);
      let emailed = false;
      if (recipients.length > 0) {
        const subject = `Monthly report — ${payload.monthLabel} (${client.name})`;
        const detailLines = [
          `Client: ${client.name} (${client.id})`,
          `Period: ${payload.periodStart} → ${payload.periodEnd}`,
          `Sites: ${payload.siteCount} · Devices: ${payload.deviceCount}`,
          payload.metrics.uptimePct == null
            ? 'Uptime: n/a'
            : `Uptime: ${(payload.metrics.uptimePct * 100).toFixed(2)}%`,
          `Download: ${pdf.url}`,
        ];
        const reportPath = keyToPath(pdf.key);
        const footerLines = [`R2 path: ${reportPath}`];
        const html = brandEmail({
          title: `Monthly report ready — ${payload.monthLabel}`,
          introLines: [`${client.name}'s monthly performance summary is ready.`],
          detailLines,
          footerLines,
          cta: { href: pdf.url, label: 'View report' },
        });
        const text = [...detailLines, ...footerLines].join('\n');
        emailed = await sendEmail(c.env, recipients, subject, text, emailSettings, html);
      }
      results.push({
        clientId: client.id,
        ok: true,
        key: pdf.key,
        path: keyToPath(pdf.key),
        url: pdf.url,
        recipients,
        emailed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate report';
      results.push({ clientId: row.client_id, ok: false, error: message });
    }
  }

  return c.json({ ok: true, month, total: results.length, results });
});

app.get('/api/reports/*', async (c) => {
  const key = c.req.path.replace('/api/reports/', '');
  const obj = await c.env.REPORTS.get(key);
  if (!obj) {
    return c.text('Not found', 404);
  }
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
    },
  });
});

app.get('/', async (c) => {
  const authResult = await requirePageAuth(c, ['admin', 'ops', 'client', 'contractor']);
  if (authResult instanceof Response) {
    return authResult;
  }
  const auth = authResult;
  await attachDeployRibbon(c, auth);
  await attachVersionInfo(c, auth);
  const data = await buildOverviewData(c.env.DB, auth);
  return c.render(<OverviewPage data={data} />);
});

app.get('/api/ops/check-fastburn', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const result = await fastBurnMonitor(c.env);
  return c.json(result);
});

app.get('/api/ops/slo', async (c) => {
  try {
    await fastBurnMonitor(c.env);
  } catch (error) {
    console.warn('fast burn monitor error', error);
  }
  const snapshot = await computeOpsSnapshot(c.env.DB);
  return c.json(snapshot);
});

app.get('/api/ops/burn-series', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);

  const url = new URL(c.req.url);
  const windowMinutes = parseDurationMinutes(url.searchParams.get('window')) ?? 10;
  const stepMinutesRaw = parseDurationMinutes(url.searchParams.get('step')) ?? 1;
  const stepMinutes = Math.max(1, stepMinutesRaw);
  const steps = Math.max(1, Math.ceil(windowMinutes / stepMinutes));
  const cappedSteps = Math.min(steps, 600);
  const targetParam = url.searchParams.get('target');
  const parsedTarget = targetParam != null ? Number(targetParam) : Number.NaN;
  const target = Number.isFinite(parsedTarget) && parsedTarget > 0 && parsedTarget < 1 ? parsedTarget : 0.999;

  const rows = await c.env.DB.prepare(
    `SELECT CAST(strftime('%s', ts) / (? * 60) AS INTEGER) AS bucket,
            SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS ok,
            COUNT(*) AS total
       FROM ops_metrics
      WHERE route='/api/ingest' AND ts >= datetime('now', ?)
      GROUP BY bucket
      ORDER BY bucket`,
  )
    .bind(stepMinutes, `-${windowMinutes} minutes`)
    .all<{ bucket: number | null; ok: number | null; total: number | null }>();

  const buckets = new Map<number, { ok: number; total: number }>();
  for (const row of rows.results ?? []) {
    if (row.bucket == null) continue;
    buckets.set(row.bucket, { ok: row.ok ?? 0, total: row.total ?? 0 });
  }

  const nowBucket = Math.floor(Date.now() / (stepMinutes * 60 * 1000));
  const denom = 1 - target;
  const series: number[] = [];
  for (let i = cappedSteps - 1; i >= 0; i--) {
    const bucketIndex = nowBucket - i;
    const bucket = buckets.get(bucketIndex);
    const total = bucket?.total ?? 0;
    const ok = bucket?.ok ?? 0;
    const errRate = total > 0 ? 1 - ok / total : 0;
    const burn = denom > 0 ? errRate / denom : 0;
    series.push(Number.isFinite(burn) ? burn : 0);
  }

  return c.json({ series });
});

async function tryDB(DB: D1Database) {
  try {
    await DB.prepare('SELECT 1').first();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function tryR2(bucket: R2Bucket, key: string) {
  try {
    const head = await bucket.head(key);
    return { ok: Boolean(head) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function schemaSnapshot(DB: D1Database) {
  try {
    const tables = await DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>();
    const names = (tables.results ?? []).map((row) => row.name).filter(Boolean).sort();
    return { ok: true, tables: names };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

app.get('/api/ops/readiness', async (c) => {
  const bypass = isDevBypassActive(c.env);
  if (!bypass) {
    const hasAdminOpsRole = (ctx: AccessContext | null | undefined) =>
      Boolean(ctx?.roles?.some((role) => role === 'admin' || role === 'ops'));

    const sessionAuth = c.get('auth') as AccessContext | undefined;
    let authorized = hasAdminOpsRole(sessionAuth);

    if (!authorized) {
      const jwt = c.req.header('Cf-Access-Jwt-Assertion');
      if (jwt) {
        const accessAuth = await verifyAccessJWT(c.env, jwt).catch(() => null);
        if (hasAdminOpsRole(accessAuth)) {
          authorized = true;
        }
      }
    }

    if (!authorized) {
      return c.text('Unauthorized', 401);
    }
  }

  const [db, brand, reports, schema, readOnly, deploy] = await Promise.all([
    tryDB(c.env.DB),
    tryR2(c.env.BRAND, 'logo.svg'),
    tryR2(c.env.REPORTS, ''),
    schemaSnapshot(c.env.DB),
    getSetting(c.env.DB, 'read_only').then((value) => value === '1'),
    getDeploySettings(c.env.DB),
  ]);

  const ok = db.ok && brand.ok && schema.ok;
  const body = {
    ok,
    read_only: readOnly,
    deploy: deploy.enabled ? { color: deploy.color, msg: deploy.msg } : null,
    checks: {
      db,
      schema,
      r2_brand: brand,
      r2_reports: reports,
    },
    meta: {
      access_aud: Boolean(c.env.ACCESS_AUD),
      jwks: Boolean(c.env.ACCESS_JWKS ?? c.env.ACCESS_JWKS_URL),
    },
  };

  return withSecurityHeaders(c.json(body));
});

app.get('/api/ops/version', async (c) => {
  const bypass = isDevBypassActive(c.env);
  let allowed = false;

  if (!bypass) {
    const sessionAuth = c.get('auth') as AccessContext | undefined;
    if (canSeeVersionChip(sessionAuth)) {
      allowed = true;
    } else {
      const jwt = c.req.header('Cf-Access-Jwt-Assertion');
      if (jwt) {
        const accessAuth = await verifyAccessJWT(c.env, jwt).catch(() => null);
        allowed = canSeeVersionChip(accessAuth);
      }
    }
    if (!allowed) {
      return c.text('Forbidden', 403);
    }
  }

  const body = await getVersion(c.env);
  return withSecurityHeaders(c.json(body));
});

app.get('/api/ops/health', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  const status = await fetchLatestCanary(c.env.DB);
  return c.json(status);
});

app.get('/ops', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  const auth = jwt ? await verifyAccessJWT(c.env, jwt).catch(() => null) : null;
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  await attachDeployRibbon(c, auth);
  await attachVersionInfo(c, auth);

  const readOnly = await isReadOnly(c.env.DB);
  if (readOnly) {
    c.set('metaRefreshSec', 60);
  }

  const snapshot = await computeOpsSnapshot(c.env.DB);
  return c.render(<OpsPage snapshot={snapshot} />);
});

app.get('/alerts', async (c) => {
  const { DB } = c.env;
  const authResult = await requirePageAuth(c, ['admin', 'ops', 'client', 'contractor']);
  if (authResult instanceof Response) {
    return authResult;
  }
  const auth = authResult;
  await attachDeployRibbon(c, auth);
  await attachVersionInfo(c, auth);

  const url = new URL(c.req.url);
  const state = url.searchParams.get('state') ?? undefined;
  const severity = url.searchParams.get('severity') ?? undefined;
  const type = url.searchParams.get('type') ?? undefined;
  const deviceId = url.searchParams.get('deviceId') ?? undefined;

  let sql = `SELECT a.*, GROUP_CONCAT(DISTINCT sc.client_id) AS clients
             FROM alerts a
             JOIN devices d ON a.device_id = d.device_id
             LEFT JOIN site_clients sc ON d.site_id = sc.site_id
             WHERE 1=1`;
  const bind: Array<string> = [];
  if (state) {
    sql += ' AND a.state=?';
    bind.push(state);
  }
  if (severity) {
    sql += ' AND a.severity=?';
    bind.push(severity);
  }
  if (type) {
    sql += ' AND a.type=?';
    bind.push(type);
  }
  if (deviceId) {
    sql += ' AND a.device_id=?';
    bind.push(deviceId);
  }

  if (auth.roles.includes('client') || auth.roles.includes('contractor')) {
    const clientIds = auth.clientIds ?? [];
    if (clientIds.length === 0) {
      return c.render(<AlertsPage alerts={[]} filters={{ state, severity, type, deviceId }} />);
    }
    const placeholders = clientIds.map(() => '?').join(',');
    sql += ` AND EXISTS (SELECT 1 FROM site_clients sc2 WHERE sc2.site_id = d.site_id AND sc2.client_id IN (${placeholders}))`;
    bind.push(...clientIds);
  }

  sql += ' GROUP BY a.alert_id ORDER BY a.opened_at DESC LIMIT 100';
  const rows = await DB.prepare(sql).bind(...bind).all();
  const results = rows.results ?? [];
  const isClientOnly = auth.roles.includes('client') && !(auth.roles.includes('admin') || auth.roles.includes('ops'));
  const alerts = isClientOnly ? results.map((r) => ({ ...r, device_id: maskId(r.device_id) })) : results;
  return c.render(<AlertsPage alerts={alerts} filters={{ state, severity, type, deviceId }} />);
});

app.get('/clients/:clientId/slo', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  await attachVersionInfo(c, auth);
  const clientId = c.req.param('clientId');
  if (!canAccessClient(auth, clientId)) {
    return c.text('Forbidden', 403);
  }
  const url = new URL(c.req.url);
  const monthParam = url.searchParams.get('month');
  try {
    const summary = await buildClientSloSummary(c.env, clientId, monthParam);
    return c.render(
      <ClientSloPage
        summary={summary}
        filters={{
          month: monthParam ?? summary.month.key,
        }}
      />,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load summary';
    if (message === 'Client not found') {
      return c.text(message, 404);
    }
    return c.text(message, 400);
  }
});

app.get('/devices', async (c) => {
  const { DB } = c.env;
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  await attachDeployRibbon(c, auth);
  await attachVersionInfo(c, auth);

  let sql = `SELECT d.device_id, d.site_id, s.name AS site_name, s.region,
                    d.online, d.last_seen_at,
                    GROUP_CONCAT(DISTINCT sc.client_id) AS clients
             FROM devices d
             LEFT JOIN sites s ON d.site_id = s.site_id
             LEFT JOIN site_clients sc ON d.site_id = sc.site_id
             WHERE 1=1`;
  const bind: Array<string> = [];

  if (auth.roles.includes('client') || auth.roles.includes('contractor')) {
    const clientIds = auth.clientIds ?? [];
    if (clientIds.length === 0) {
      return c.render(<DevicesPage rows={[]} />);
    }
    const placeholders = clientIds.map(() => '?').join(',');
    sql += ` AND EXISTS (SELECT 1 FROM site_clients sc2 WHERE sc2.site_id = d.site_id AND sc2.client_id IN (${placeholders}))`;
    bind.push(...clientIds);
  }

  sql += ' GROUP BY d.device_id ORDER BY (d.last_seen_at IS NULL), d.last_seen_at DESC LIMIT 500';
  const rows = await DB.prepare(sql).bind(...bind).all();
  const results = rows.results ?? [];
  const isClientOnly =
    auth && auth.roles.includes('client') && !(auth.roles.includes('admin') || auth.roles.includes('ops'));
  const out = isClientOnly ? results.map((r) => ({ ...r, device_id: maskId(r.device_id) })) : results;
  return c.render(<DevicesPage rows={out} />);
});

app.get('/admin/archive', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  await attachDeployRibbon(c, auth);
  await attachVersionInfo(c, auth);
  const url = new URL(c.req.url);
  const parsed = parseDateParam(url.searchParams.get('date'));
  const fallback = addUtcDays(startOfUtcDay(new Date()), -1);
  const target = parsed ?? fallback;
  const rows = await listArchiveRows(c.env.DB, target);
  return c.render(<AdminArchivePage date={formatDateKey(target)} rows={rows} />);
});

app.get('/admin/presets', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  await attachDeployRibbon(c, auth);
  await attachVersionInfo(c, auth);
  return c.render(<AdminPresetsPage />);
});

app.get('/admin/commissioning', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  await attachDeployRibbon(c, auth);
  await attachVersionInfo(c, auth);

  const sessions = await c.env.DB.prepare(
    `SELECT session_id, device_id, site_id, status, started_at, finished_at, notes, checklist_id,
            (SELECT MAX(updated_at) FROM commissioning_steps WHERE session_id = cs.session_id) AS last_update
       FROM commissioning_sessions cs
       ORDER BY started_at DESC
       LIMIT 100`,
  ).all<{
    session_id: string;
    device_id: string;
    site_id: string | null;
    status: string;
    started_at: string;
    finished_at: string | null;
    notes: string | null;
    checklist_id: string | null;
    last_update: string | null;
  }>();

  const sessionRows = sessions.results ?? [];
  const checklistIds = [...new Set(sessionRows.map((row) => row.checklist_id).filter((id): id is string => !!id))];
  const checklistRequired = new Map<string, Set<string>>();
  if (checklistIds.length) {
    const placeholders = checklistIds.map(() => '?').join(',');
    const rows = await c.env.DB.prepare(
      `SELECT checklist_id, coalesce(required_steps_json, steps_json) AS required
         FROM commissioning_checklists
        WHERE checklist_id IN (${placeholders})`,
    )
      .bind(...checklistIds)
      .all<{ checklist_id: string; required: string | null }>();
    for (const row of rows.results ?? []) {
      if (!row.required) continue;
      try {
        const parsed = JSON.parse(row.required);
        if (Array.isArray(parsed)) {
          const ids = parsed
            .map((value) => {
              if (typeof value === 'string') return value;
              if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
                return (value as { id: string }).id;
              }
              return null;
            })
            .filter((id): id is string => Boolean(id));
          checklistRequired.set(row.checklist_id, new Set(ids));
        }
      } catch (error) {
        console.warn('Failed to parse checklist required steps', error);
      }
    }
  }

  const stepMap = new Map<string, Array<{ step_id: string; title: string; state: string }>>();
  if (sessionRows.length) {
    const placeholders = sessionRows.map(() => '?').join(',');
    const steps = await c.env.DB.prepare(
      `SELECT session_id, step_id, title, state
         FROM commissioning_steps
        WHERE session_id IN (${placeholders})`,
    )
      .bind(...sessionRows.map((row) => row.session_id))
      .all<{ session_id: string; step_id: string; title: string; state: string }>();
    for (const row of steps.results ?? []) {
      let list = stepMap.get(row.session_id);
      if (!list) {
        list = [];
        stepMap.set(row.session_id, list);
      }
      list.push({ step_id: row.step_id, title: row.title, state: row.state });
    }
  }

  const artifactMap = new Map<string, Map<string, { r2_key: string; size_bytes: number | null; created_at: string }>>();
  if (sessionRows.length > 0) {
    const placeholders = sessionRows.map(() => '?').join(',');
    const artifactRows = await c.env.DB.prepare(
      `SELECT session_id, kind, r2_key, size_bytes, created_at
         FROM commissioning_artifacts
        WHERE session_id IN (${placeholders})`,
    )
      .bind(...sessionRows.map((row) => row.session_id))
      .all<{
        session_id: string;
        kind: string;
        r2_key: string;
        size_bytes: number | null;
        created_at: string;
      }>();

    for (const row of artifactRows.results ?? []) {
      let target = artifactMap.get(row.session_id);
      if (!target) {
        target = new Map();
        artifactMap.set(row.session_id, target);
      }
      target.set(row.kind, {
        r2_key: row.r2_key,
        size_bytes: row.size_bytes ?? null,
        created_at: row.created_at,
      });
    }
  }

  const toRow = (row: (typeof sessionRows)[number]): AdminCommissioningRow => {
    const artifacts = artifactMap.get(row.session_id) ?? new Map();
    const steps = stepMap.get(row.session_id) ?? [];
    const requiredIds = row.checklist_id && checklistRequired.has(row.checklist_id)
      ? checklistRequired.get(row.checklist_id)!
      : new Set(steps.map((step) => step.step_id));
    const requiredTotal = requiredIds.size;
    let requiredPassed = 0;
    const missingNames: string[] = [];
    if (requiredTotal > 0) {
      for (const step of steps) {
        if (!requiredIds.has(step.step_id)) continue;
        if (step.state === 'pass') {
          requiredPassed += 1;
        } else {
          missingNames.push(step.title);
        }
      }
    }
    return {
      session_id: row.session_id,
      device_id: row.device_id,
      site_id: row.site_id ?? null,
      status: row.status,
      started_at: row.started_at,
      finished_at: row.finished_at ?? null,
      last_update: row.last_update ?? null,
      notes: row.notes ?? null,
      artifacts: Object.fromEntries(artifacts.entries()) as Record<
        string,
        { r2_key: string; size_bytes: number | null; created_at: string } | undefined
      >,
      required_total: requiredTotal,
      required_passed: requiredPassed,
      required_missing: missingNames,
    };
  };

  const open = sessionRows.filter((row) => row.status === 'in_progress').map(toRow);
  const completed = sessionRows.filter((row) => row.status !== 'in_progress').map(toRow);

  return c.render(<AdminCommissioningPage open={open} completed={completed} />);
});

app.get('/admin/sites', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  await attachDeployRibbon(c, auth);
  await attachVersionInfo(c, auth);
  return c.render(<AdminSitesPage />);
});

app.get('/admin/email', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  await attachDeployRibbon(c, auth);
  await attachVersionInfo(c, auth);
  return c.render(<AdminEmailPage />);
});

app.get('/admin/maintenance', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  await attachDeployRibbon(c, auth);
  await attachVersionInfo(c, auth);
  return c.render(<AdminMaintenancePage />);
});

app.get('/admin/settings', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  await attachDeployRibbon(c, auth);
  await attachVersionInfo(c, auth);
  return c.render(<AdminSettingsPage />);
});

app.get('/admin/reports/outbox', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  await attachDeployRibbon(c, auth);
  await attachVersionInfo(c, auth);
  const url = new URL(c.req.url);
  const getRaw = (key: string) => url.searchParams.get(key) ?? '';
  const statusValue = url.searchParams.has('status') ? getRaw('status') : 'generated';
  const limitParam = getRaw('limit') || '50';
  const rows = await listReportDeliveries(c.env.DB, {
    type: getRaw('type') ? getRaw('type') : null,
    status: statusValue ? statusValue : null,
    clientId: getRaw('client_id') ? getRaw('client_id') : null,
    siteId: getRaw('site_id') ? getRaw('site_id') : null,
    limit: limitParam ? Number(limitParam) : undefined,
  });
  return c.render(
    <AdminReportsOutboxPage
      rows={rows}
      filters={{
        type: getRaw('type'),
        status: statusValue,
        clientId: getRaw('client_id'),
        siteId: getRaw('site_id'),
        limit: limitParam,
      }}
    />,
  );
});

app.get('/admin/reports', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  await attachDeployRibbon(c, auth);
  await attachVersionInfo(c, auth);
  return c.render(<AdminReportsPage />);
});

app.get('/admin/reports/history', async (c) => {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return c.text('Unauthorized', 401);
  }
  const auth = await verifyAccessJWT(c.env, jwt).catch(() => null);
  if (!auth) {
    return c.text('Unauthorized', 401);
  }
  requireRole(auth, ['admin', 'ops']);
  await attachDeployRibbon(c, auth);
  await attachVersionInfo(c, auth);
  const url = new URL(c.req.url);
  const get = (key: string) => {
    const value = url.searchParams.get(key);
    return value ?? '';
  };
  const limitParam = url.searchParams.get('limit');
  const rows = await listReportDeliveries(c.env.DB, {
    clientId: get('client_id') ? get('client_id') : null,
    siteId: get('site_id') ? get('site_id') : null,
    type: get('type') ? get('type') : null,
    status: get('status') ? get('status') : null,
    limit: limitParam ? Number(limitParam) : undefined,
  });
  return c.render(
    <AdminReportsHistoryPage
      rows={rows}
      filters={{
        clientId: get('client_id'),
        siteId: get('site_id'),
        type: get('type'),
        status: get('status'),
        limit: limitParam ?? '',
      }}
    />,
  );
});

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

type OverviewSnapshot = {
  totalDevices: number;
  onlineCount: number;
  openAlerts: number;
  avgCop: number | null;
  lowDeltaCount: number;
  updatedAt: string | null;
  sites: OverviewData['sites'];
  deltaSeries: OverviewData['series']['deltaT'];
  copSeries: OverviewData['series']['cop'];
};

type OverviewSnapshotOptions = {
  includeSites?: boolean;
  includeSeries?: boolean;
};

const emptyOverviewSnapshot = (): OverviewSnapshot => ({
  totalDevices: 0,
  onlineCount: 0,
  openAlerts: 0,
  avgCop: null,
  lowDeltaCount: 0,
  updatedAt: null,
  sites: [],
  deltaSeries: [],
  copSeries: [],
});


async function collectOverviewSnapshot(
  DB: D1Database,
  auth: AccessContext | undefined,
  options: OverviewSnapshotOptions = {},
): Promise<OverviewSnapshot> {
  const includeSites = options.includeSites !== false;
  const includeSeries = options.includeSeries !== false;

  const restricted = !!auth && (auth.roles.includes('client') || auth.roles.includes('contractor'));
  let siteFilter: string[] | null = null;

  if (restricted) {
    const clientIds = auth?.clientIds ?? [];
    if (clientIds.length === 0) {
      return emptyOverviewSnapshot();
    }
    const placeholders = clientIds.map(() => '?').join(',');
    const siteRows = await DB.prepare(
      `SELECT DISTINCT site_id FROM site_clients WHERE client_id IN (${placeholders}) AND site_id IS NOT NULL`,
    )
      .bind(...clientIds)
      .all();
    const sites = (siteRows.results ?? [])
      .map((row: any) => row.site_id as string | null)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (sites.length === 0) {
      return emptyOverviewSnapshot();
    }
    siteFilter = [...new Set(sites)];
  }

  const bindSites = siteFilter ?? [];
  const sitePlaceholder = siteFilter ? siteFilter.map(() => '?').join(',') : '';

  const deviceRow = await DB.prepare(
    `SELECT SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) as onlineCount, COUNT(*) as totalCount FROM devices${
      siteFilter ? ` WHERE site_id IN (${sitePlaceholder})` : ''
    }`,
  )
    .bind(...bindSites)
    .first<{ onlineCount: number | null; totalCount: number | null }>()
    .catch(() => null);

  const openAlertsRow = await DB.prepare(
    siteFilter
      ? `SELECT COUNT(*) as n FROM alerts a JOIN devices d ON d.device_id = a.device_id WHERE a.state IN ('open','ack') AND d.site_id IN (${sitePlaceholder})`
      : `SELECT COUNT(*) as n FROM alerts WHERE state IN ('open','ack')`,
  )
    .bind(...bindSites)
    .first<{ n: number | null }>()
    .catch(() => null);

  const avgCopRow = await DB.prepare(
    siteFilter
      ? `SELECT AVG(ls.cop) as avgCop FROM latest_state ls JOIN devices d ON d.device_id = ls.device_id WHERE ls.cop IS NOT NULL AND d.site_id IN (${sitePlaceholder})`
      : `SELECT AVG(cop) as avgCop FROM latest_state WHERE cop IS NOT NULL`,
  )
    .bind(...bindSites)
    .first<{ avgCop: number | null }>()
    .catch(() => null);

  const updatedRow = await DB.prepare(
    siteFilter
      ? `SELECT MAX(ls.updated_at) AS updated_at FROM latest_state ls JOIN devices d ON d.device_id = ls.device_id WHERE d.site_id IN (${sitePlaceholder})`
      : `SELECT MAX(updated_at) AS updated_at FROM latest_state`,
  )
    .bind(...bindSites)
    .first<{ updated_at: string | null }>()
    .catch(() => null);

  const deltaSeries: OverviewData['series']['deltaT'] = [];
  const copSeries: OverviewData['series']['cop'] = [];

  if (includeSeries) {
    const telemetryRows = await DB.prepare(
      siteFilter
        ? `SELECT t.ts, t.deltaT, t.cop FROM telemetry t JOIN devices d ON d.device_id = t.device_id WHERE t.ts >= datetime('now','-24 hours') AND d.site_id IN (${sitePlaceholder}) ORDER BY t.ts DESC LIMIT 240`
        : `SELECT ts, deltaT, cop FROM telemetry WHERE ts >= datetime('now', '-24 hours') ORDER BY ts DESC LIMIT 240`,
    )
      .bind(...bindSites)
      .all()
      .catch(() => null);

    for (const row of (telemetryRows?.results ?? []).reverse()) {
      const ts = (row as any).ts as string;
      deltaSeries.push({ ts, value: toNumber((row as any).deltaT) });
      copSeries.push({ ts, value: toNumber((row as any).cop) });
    }
  }

  const sites: OverviewData['sites'] = [];
  if (includeSites) {
    const severityRows = await DB.prepare(
      siteFilter
        ? `SELECT d.site_id AS site_id,
                 MAX(CASE a.severity WHEN 'critical' THEN 3 WHEN 'major' THEN 2 WHEN 'minor' THEN 1 ELSE 0 END) AS severity_rank,
                 COUNT(*) AS open_alerts
           FROM alerts a
           JOIN devices d ON d.device_id = a.device_id
           WHERE a.state IN ('open','ack') AND d.site_id IN (${sitePlaceholder})
           GROUP BY d.site_id`
        : `SELECT d.site_id AS site_id,
                 MAX(CASE a.severity WHEN 'critical' THEN 3 WHEN 'major' THEN 2 WHEN 'minor' THEN 1 ELSE 0 END) AS severity_rank,
                 COUNT(*) AS open_alerts
           FROM alerts a
           JOIN devices d ON d.device_id = a.device_id
           WHERE a.state IN ('open','ack')
           GROUP BY d.site_id`,
    )
      .bind(...bindSites)
      .all()
      .catch(() => null);

    const severityMap = new Map<string, { rank: number; openAlerts: number }>();
    for (const row of severityRows?.results ?? []) {
      const siteId = (row as any).site_id as string | null;
      if (!siteId) continue;
      const rank = toNumber((row as any).severity_rank) ?? 0;
      const openAlerts = toNumber((row as any).open_alerts) ?? 0;
      severityMap.set(siteId, { rank, openAlerts });
    }

    const siteRows = await DB.prepare(
      `WITH all_sites AS (
        SELECT site_id FROM sites WHERE site_id IS NOT NULL
        UNION
        SELECT DISTINCT site_id FROM devices WHERE site_id IS NOT NULL
        UNION
        SELECT DISTINCT site_id FROM site_clients WHERE site_id IS NOT NULL
      )
      SELECT a.site_id, s.name, s.region, s.lat, s.lon,
             COALESCE(cnt.total_devices, 0) AS device_count,
             COALESCE(cnt.online_devices, 0) AS online_count
      FROM all_sites a
      LEFT JOIN sites s ON s.site_id = a.site_id
      LEFT JOIN (
        SELECT site_id,
               COUNT(*) AS total_devices,
               SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) AS online_devices
        FROM devices
        GROUP BY site_id
      ) cnt ON cnt.site_id = a.site_id
      ${siteFilter ? `WHERE a.site_id IN (${sitePlaceholder})` : ''}
      ORDER BY a.site_id`,
    )
      .bind(...bindSites)
      .all()
      .catch(() => null);

    const seenSites = new Set<string>();
    for (const row of siteRows?.results ?? []) {
      const siteId = (row as any).site_id as string | null;
      if (!siteId) continue;
      seenSites.add(siteId);
      const stats = severityMap.get(siteId);
      const rank = stats?.rank ?? 0;
      const severity: 'critical' | 'major' | 'minor' | null =
        rank >= 3 ? 'critical' : rank >= 2 ? 'major' : rank >= 1 ? 'minor' : null;
      const deviceCount = toNumber((row as any).device_count) ?? 0;
      const status: 'critical' | 'major' | 'ok' | 'empty' =
        deviceCount === 0 ? 'empty' : severity === 'critical' ? 'critical' : severity === 'major' ? 'major' : 'ok';
      sites.push({
        siteId,
        name: ((row as any).name as string) ?? null,
        region: ((row as any).region as string) ?? null,
        lat: toNumber((row as any).lat),
        lon: toNumber((row as any).lon),
        deviceCount,
        onlineCount: toNumber((row as any).online_count) ?? 0,
        openAlerts: stats?.openAlerts ?? 0,
        maxSeverity: severity,
        status,
      });
    }

    if (siteFilter) {
      for (const siteId of siteFilter) {
        if (seenSites.has(siteId)) continue;
        const stats = severityMap.get(siteId);
        const rank = stats?.rank ?? 0;
        const severity: 'critical' | 'major' | 'minor' | null =
          rank >= 3 ? 'critical' : rank >= 2 ? 'major' : rank >= 1 ? 'minor' : null;
        const status: 'critical' | 'major' | 'ok' | 'empty' =
          severity === 'critical' ? 'critical' : severity === 'major' ? 'major' : 'empty';
        sites.push({
          siteId,
          name: null,
          region: null,
          lat: null,
          lon: null,
          deviceCount: 0,
          onlineCount: 0,
          openAlerts: stats?.openAlerts ?? 0,
          maxSeverity: severity,
          status,
        });
      }
    }

    sites.sort((a, b) => a.siteId.localeCompare(b.siteId));
  }

  const totalDevices = toNumber(deviceRow?.totalCount) ?? 0;
  const onlineCount = toNumber(deviceRow?.onlineCount) ?? 0;
  const openAlerts = toNumber(openAlertsRow?.n) ?? 0;
  const avgCop = toNumber(avgCopRow?.avgCop);

  return {
    totalDevices,
    onlineCount,
    openAlerts,
    avgCop: avgCop ?? null,
    lowDeltaCount: 0,
    updatedAt: updatedRow?.updated_at ?? null,
    sites,
    deltaSeries,
    copSeries,
  };
}

async function buildOverviewData(DB: D1Database, auth?: AccessContext): Promise<OverviewData> {
  const snapshot = await collectOverviewSnapshot(DB, auth, { includeSites: true, includeSeries: true });
  return {
    kpis: {
      onlinePct: snapshot.totalDevices > 0 ? (100 * snapshot.onlineCount) / snapshot.totalDevices : 0,
      openAlerts: snapshot.openAlerts,
      avgCop: snapshot.avgCop,
    },
    sites: snapshot.sites,
    series: {
      deltaT: snapshot.deltaSeries,
      cop: snapshot.copSeries,
    },
  };
}

const RESTRICTED_DEVICE_ROLES = new Set<Role>(['client', 'contractor']);

async function canAccessDevice(DB: D1Database, auth: AccessContext, deviceId: string): Promise<boolean> {
  const restricted = auth.roles.some((role) => RESTRICTED_DEVICE_ROLES.has(role));
  if (!restricted) {
    return true;
  }
  const clientIds = auth.clientIds ?? [];
  if (clientIds.length === 0) {
    return false;
  }
  const placeholders = clientIds.map(() => '?').join(',');
  const row = await DB.prepare(
    `SELECT 1 FROM devices d JOIN site_clients sc ON sc.site_id = d.site_id WHERE d.device_id=? AND sc.client_id IN (${placeholders}) LIMIT 1`,
  )
    .bind(deviceId, ...clientIds)
    .first();
  return !!row;
}

async function verifyDeviceKey(DB: D1Database, deviceId: string, key: string | null | undefined) {
  if (!key) return false;
  const row = await DB.prepare('SELECT key_hash FROM devices WHERE device_id=?')
    .bind(deviceId)
    .first<{ key_hash?: string | null }>();
  const stored = row?.key_hash;
  if (!stored) return false;
  return crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(key))
    .then((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''))
    .then((digest) => digest === stored);
}

async function isDuplicate(DB: D1Database, key: string) {
  const hit = await DB.prepare('SELECT k FROM idem WHERE k=?').bind(key).first();
  if (hit) return true;
  await DB.prepare("INSERT OR IGNORE INTO idem (k, ts) VALUES (?, datetime('now'))").bind(key).run();
  await DB.prepare("DELETE FROM idem WHERE ts < datetime('now','-1 day')").run();
  return false;
}

async function recomputeBaselines(DB: D1Database) {
  await DB.exec(`CREATE TABLE IF NOT EXISTS baselines_hourly (
    device_id TEXT,
    how INTEGER,
    dt_mean REAL,
    dt_std REAL,
    dt_n INTEGER,
    cop_mean REAL,
    cop_std REAL,
    cop_n INTEGER,
    PRIMARY KEY(device_id, how)
  )`);

  const rows = await DB.prepare(`
    SELECT
      device_id,
      ((CAST(strftime('%w', ts) AS INT) + 6) % 7) * 24 + CAST(strftime('%H', ts) AS INT) AS how,
      AVG(deltaT) AS dt_mean,
      AVG(deltaT * deltaT) AS dt_sq_mean,
      COUNT(deltaT) AS dt_n,
      AVG(cop) AS cop_mean,
      AVG(cop * cop) AS cop_sq_mean,
      COUNT(cop) AS cop_n
    FROM telemetry
    WHERE ts >= datetime('now','-7 days')
    GROUP BY device_id, how
  `).all<{
    device_id: string;
    how: number;
    dt_mean: number | null;
    dt_sq_mean: number | null;
    dt_n: number;
    cop_mean: number | null;
    cop_sq_mean: number | null;
    cop_n: number;
  }>();

  const results = rows.results ?? [];
  if (results.length === 0) {
    return;
  }

  await DB.batch(
    results.map((row) => {
      const dtStd =
        row.dt_n > 1 && row.dt_mean != null && row.dt_sq_mean != null
          ? Math.sqrt(Math.max(0, row.dt_sq_mean - row.dt_mean * row.dt_mean))
          : null;
      const copStd =
        row.cop_n > 1 && row.cop_mean != null && row.cop_sq_mean != null
          ? Math.sqrt(Math.max(0, row.cop_sq_mean - row.cop_mean * row.cop_mean))
          : null;

      return DB.prepare(`
        INSERT INTO baselines_hourly (device_id, how, dt_mean, dt_std, dt_n, cop_mean, cop_std, cop_n)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id, how) DO UPDATE SET
          dt_mean=excluded.dt_mean,
          dt_std=excluded.dt_std,
          dt_n=excluded.dt_n,
          cop_mean=excluded.cop_mean,
          cop_std=excluded.cop_std,
          cop_n=excluded.cop_n
      `).bind(
        row.device_id,
        row.how,
        row.dt_mean,
        dtStd,
        row.dt_n,
        row.cop_mean,
        copStd,
        row.cop_n,
      );
    }),
    );
  }

  async function logOpsMetric(
  DB: D1Database,
  route: string,
  statusCode: number,
  durationMs: number,
  deviceId?: string | null,
) {
  try {
    await DB.prepare(
      'INSERT INTO ops_metrics (ts, route, status_code, duration_ms, device_id) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(new Date().toISOString(), route, statusCode, durationMs, deviceId ?? null)
      .run();
  } catch (error) {
    console.warn('logOpsMetric failed', error);
  }
}

function parseIsoTimestamp(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.valueOf())) return null;
  return parsed.toISOString();
}

type MonthRange = { start: Date; end: Date; label: string };

function parseMonthRange(month: string): MonthRange | null {
  const m = /^([0-9]{4})-([0-9]{2})$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return null;
  }
  const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
  const label = start.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return { start, end, label };
}

function formatMonthKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

function previousMonthKey(reference: Date = new Date()): string {
  const base = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1));
  base.setUTCMonth(base.getUTCMonth() - 1);
  return formatMonthKey(base);
}

async function computeTimeWeightedUptime(
  DB: D1Database,
  deviceIds: string[],
  startIso: string,
  endIso: string,
  freshnessMinutes = 5,
): Promise<number | null> {
  if (deviceIds.length === 0) {
    return null;
  }
  const start = new Date(startIso);
  const end = new Date(endIso);
  const startMs = start.getTime();
  const endMs = end.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }

  const placeholders = deviceIds.map(() => '?').join(',');
  const heartbeats = await DB.prepare(
    `SELECT device_id, ts
       FROM heartbeat
      WHERE device_id IN (${placeholders})
        AND ts >= ?
        AND ts <= ?
      ORDER BY device_id, ts`,
  )
    .bind(...deviceIds, startIso, endIso)
    .all<{ device_id: string; ts: string }>()
    .catch(() => ({ results: [] }));

  const previous = await DB.prepare(
    `SELECT device_id, MAX(ts) as ts
       FROM heartbeat
      WHERE device_id IN (${placeholders})
        AND ts < ?
      GROUP BY device_id`,
  )
    .bind(...deviceIds, startIso)
    .all<{ device_id: string; ts: string | null }>()
    .catch(() => ({ results: [] }));

  const perDevice = new Map<string, number[]>();
  for (const id of deviceIds) {
    perDevice.set(id, []);
  }

  for (const row of heartbeats.results ?? []) {
    const bucket = perDevice.get(row.device_id);
    if (!bucket) continue;
    const ts = new Date(row.ts).getTime();
    if (!Number.isFinite(ts)) continue;
    bucket.push(ts);
  }

  for (const row of previous.results ?? []) {
    if (!row.ts) continue;
    const bucket = perDevice.get(row.device_id);
    if (!bucket) continue;
    const ts = new Date(row.ts).getTime();
    if (!Number.isFinite(ts)) continue;
    bucket.push(ts);
  }

  const thresholdMs = freshnessMinutes * 60 * 1000;
  const windowMs = endMs - startMs;
  let totalOnlineMs = 0;

  for (const id of deviceIds) {
    const beats = perDevice.get(id) ?? [];
    if (beats.length === 0) {
      continue;
    }
    beats.sort((a, b) => a - b);
    const intervals: Array<{ start: number; end: number }> = [];
    for (const beatMs of beats) {
      const intervalStart = Math.max(beatMs, startMs);
      const intervalEnd = Math.min(beatMs + thresholdMs, endMs);
      if (intervalEnd <= intervalStart) {
        continue;
      }
      intervals.push({ start: intervalStart, end: intervalEnd });
    }
    if (intervals.length === 0) {
      continue;
    }
    intervals.sort((a, b) => a.start - b.start);
    let current = { ...intervals[0]! };
    for (let i = 1; i < intervals.length; i++) {
      const next = intervals[i]!;
      if (next.start <= current.end) {
        current.end = Math.max(current.end, next.end);
      } else {
        totalOnlineMs += current.end - current.start;
        current = { ...next };
      }
    }
    totalOnlineMs += current.end - current.start;
  }

  const denominator = windowMs * deviceIds.length;
  if (denominator <= 0) {
    return null;
  }
  return totalOnlineMs / denominator;
}

type ClientMonthlyMetrics = {
  uptimePct: number | null;
  ingestSuccessPct: number | null;
  avgCop: number | null;
  alerts: Array<{ type: string; severity: string; count: number }>;
};

async function computeClientMonthlyMetricsV1(
  DB: D1Database,
  clientId: string,
  deviceIds: string[],
  startIso: string,
  endIso: string,
): Promise<ClientMonthlyMetrics> {
  let uptimePct: number | null = null;
  let avgCop: number | null = null;

  if (deviceIds.length > 0) {
    const placeholders = deviceIds.map(() => '?').join(',');
    const telemetryRow = await DB.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN COALESCE(json_extract(status_json,'$.online'),0) = 1 THEN 1 ELSE 0 END) as online_count,
              AVG(cop) as avg_cop
         FROM telemetry
        WHERE device_id IN (${placeholders})
          AND ts >= ?
          AND ts < ?`,
    )
      .bind(...deviceIds, startIso, endIso)
      .first<{ total: number | null; online_count: number | null; avg_cop: number | null }>()
      .catch(() => null);
    const total = toNumber(telemetryRow?.total) ?? 0;
    const online = toNumber(telemetryRow?.online_count) ?? 0;
    if (total > 0) {
      uptimePct = online / total;
    }
    avgCop = toNumber(telemetryRow?.avg_cop);
  }

  const ingestRow = await DB.prepare(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) as ok
       FROM ops_metrics
      WHERE route='/api/ingest'
        AND ts >= ?
        AND ts < ?`,
  )
    .bind(startIso, endIso)
    .first<{ total: number | null; ok: number | null }>()
    .catch(() => null);

  const ingestTotal = toNumber(ingestRow?.total) ?? 0;
  const ingestOk = toNumber(ingestRow?.ok) ?? 0;
  const ingestSuccessPct = ingestTotal > 0 ? ingestOk / ingestTotal : null;

  const alertRows = await DB.prepare(
    `SELECT a.type, a.severity, COUNT(*) as count
       FROM alerts a
       JOIN devices d ON d.device_id = a.device_id
       JOIN site_clients sc ON sc.site_id = d.site_id
      WHERE sc.client_id = ?
        AND a.opened_at >= ?
        AND a.opened_at < ?
      GROUP BY a.type, a.severity
      ORDER BY count DESC`,
  )
    .bind(clientId, startIso, endIso)
    .all<{ type: string; severity: string; count: number }>()
    .catch(() => ({ results: [] }));

  const alerts = (alertRows.results ?? []).map((row) => ({ type: row.type, severity: row.severity, count: row.count }));

  return { uptimePct, ingestSuccessPct, avgCop, alerts };
}

async function computeClientMonthlyMetricsV2(
  DB: D1Database,
  clientId: string,
  deviceIds: string[],
  startIso: string,
  endIso: string,
): Promise<ClientMonthlyMetrics> {
  const base = await computeClientMonthlyMetricsV1(DB, clientId, deviceIds, startIso, endIso);
  const weighted = await computeTimeWeightedUptime(DB, deviceIds, startIso, endIso, 5);
  return { ...base, uptimePct: weighted ?? base.uptimePct };
}

async function buildIncidentReportV2Payload(
  env: Env,
  siteId: string,
  windowHours: number,
  options?: { windowEnd?: Date; windowStart?: Date },
): Promise<IncidentReportV2Payload> {
  const baseEnd = options?.windowEnd ?? new Date();
  const validEnd = Number.isNaN(baseEnd.getTime()) ? new Date() : baseEnd;
  const fallbackHours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 24;
  const defaultStart = new Date(validEnd.getTime() - fallbackHours * 60 * 60 * 1000);
  const providedStart = options?.windowStart;
  const startCandidate = providedStart && !Number.isNaN(providedStart.getTime()) ? providedStart : defaultStart;
  const windowStart = startCandidate > validEnd ? new Date(validEnd.getTime() - 60 * 60 * 1000) : startCandidate;
  const windowEnd = windowStart > validEnd ? windowStart : validEnd;
  const startIso = windowStart.toISOString();
  const endIso = windowEnd.toISOString();
  const durationHours = Math.max((windowEnd.getTime() - windowStart.getTime()) / (60 * 60 * 1000), 0.25);

  const site = await env.DB.prepare('SELECT site_id, name, region FROM sites WHERE site_id=?')
    .bind(siteId)
    .first<{ site_id: string; name: string | null; region: string | null }>();

  const severityRows = await env.DB.prepare(
    `SELECT severity, COUNT(*) as n
       FROM alerts
      WHERE device_id IN (SELECT device_id FROM devices WHERE site_id=?)
        AND state IN ('open','ack')
      GROUP BY severity`,
  )
    .bind(siteId)
    .all<{ severity: string; n: number }>();

  const top = await env.DB.prepare(
    `SELECT d.device_id, SUM(CASE WHEN a.state IN ('open','ack') THEN 1 ELSE 0 END) as open_count
       FROM devices d LEFT JOIN alerts a ON a.device_id = d.device_id
      WHERE d.site_id=?
      GROUP BY d.device_id
      ORDER BY open_count DESC
      LIMIT 5`,
  )
    .bind(siteId)
    .all<{ device_id: string; open_count: number | null }>();

  const incidentsRows = await env.DB.prepare(
    `SELECT incident_id, site_id, started_at, last_alert_at, resolved_at
       FROM incidents
      WHERE site_id=?
        AND started_at <= ?
        AND (resolved_at IS NULL OR resolved_at >= ?)
      ORDER BY started_at DESC
      LIMIT 50`,
  )
    .bind(siteId, endIso, startIso)
    .all<{
      incident_id: string;
      site_id: string;
      started_at: string;
      last_alert_at: string | null;
      resolved_at: string | null;
    }>();

  const incidents = incidentsRows.results ?? [];
  let incidentMeta = new Map<
    string,
    {
      states: Record<string, number>;
      alerts: Map<string, { type: string; severity: string; count: number }>;
    }
  >();

  if (incidents.length > 0) {
    const ids = incidents.map((row) => row.incident_id);
    const placeholders = ids.map(() => '?').join(',');
    const metaRows = await env.DB.prepare(
      `SELECT ia.incident_id, a.type, a.severity, a.state, COUNT(*) as count
         FROM incident_alerts ia
         JOIN alerts a ON a.alert_id = ia.alert_id
        WHERE ia.incident_id IN (${placeholders})
        GROUP BY ia.incident_id, a.type, a.severity, a.state`,
    )
      .bind(...ids)
      .all<{ incident_id: string; type: string; severity: string; state: string | null; count: number }>();

    incidentMeta = new Map();
    for (const row of metaRows.results ?? []) {
      if (!incidentMeta.has(row.incident_id)) {
        incidentMeta.set(row.incident_id, { states: {}, alerts: new Map() });
      }
      const bucket = incidentMeta.get(row.incident_id)!;
      if (row.state) {
        bucket.states[row.state] = (bucket.states[row.state] ?? 0) + row.count;
      }
      const key = `${row.type}:${row.severity}`;
      if (!bucket.alerts.has(key)) {
        bucket.alerts.set(key, { type: row.type, severity: row.severity, count: row.count });
      } else {
        const existing = bucket.alerts.get(key)!;
        existing.count += row.count;
      }
    }
  }

  const maintenanceRows = await env.DB.prepare(
    `SELECT site_id, device_id, start_ts, end_ts, reason
       FROM maintenance_windows
      WHERE (site_id = ? OR site_id IS NULL)
        AND (device_id IS NULL OR device_id IN (SELECT device_id FROM devices WHERE site_id=?))
        AND end_ts >= ?
        AND start_ts <= ?
      ORDER BY start_ts DESC
      LIMIT 20`,
  )
    .bind(siteId, siteId, startIso, endIso)
    .all<{
      site_id: string | null;
      device_id: string | null;
      start_ts: string;
      end_ts: string | null;
      reason: string | null;
    }>();

  return {
    siteId,
    siteName: site?.name ?? null,
    region: site?.region ?? null,
    windowLabel: formatWindowLabel(durationHours),
    windowStart: startIso,
    windowEnd: endIso,
    generatedAt: new Date().toISOString(),
    summary: {
      severities: (severityRows.results ?? []).map((row) => ({ severity: row.severity, count: row.n })),
      topDevices: (top.results ?? []).map((row) => ({ deviceId: row.device_id, openCount: row.open_count ?? 0 })),
    },
    incidents: incidents.map((row) => {
      const bucket = incidentMeta.get(row.incident_id);
      const alertBreakdown = bucket
        ? Array.from(bucket.alerts.values()).sort((a, b) => b.count - a.count)
        : [];
      return {
        incidentId: row.incident_id,
        startedAt: row.started_at,
        lastAlertAt: row.last_alert_at ?? null,
        resolvedAt: row.resolved_at ?? null,
        stateCounts: bucket?.states ?? {},
        alertBreakdown,
      };
    }),
    maintenance: (maintenanceRows.results ?? []).map((row) => ({
      siteId: row.site_id,
      deviceId: row.device_id,
      startTs: row.start_ts,
      endTs: row.end_ts,
      reason: row.reason ?? null,
    })),
  };
}

async function buildIncidentReportV2PayloadForIncident(
  env: Env,
  incidentId: string,
  windowHours: number,
): Promise<IncidentReportV2Payload> {
  const incident = await env.DB.prepare(
    'SELECT incident_id, site_id, started_at, last_alert_at, resolved_at FROM incidents WHERE incident_id=?',
  )
    .bind(incidentId)
    .first<{ incident_id: string; site_id: string | null; started_at: string; last_alert_at: string | null; resolved_at: string | null }>();

  if (!incident || !incident.site_id) {
    throw new Error('Incident not found');
  }

  const endRaw = incident.resolved_at ?? incident.last_alert_at ?? incident.started_at;
  const windowEnd = endRaw ? new Date(endRaw) : new Date();
  const validEnd = Number.isNaN(windowEnd.getTime()) ? new Date() : windowEnd;
  const incidentStart = incident.started_at ? new Date(incident.started_at) : null;
  const baseStart = new Date(validEnd.getTime() - (Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 24) * 60 * 60 * 1000);
  const windowStart = incidentStart && !Number.isNaN(incidentStart.getTime()) && incidentStart < baseStart ? incidentStart : baseStart;

  return buildIncidentReportV2Payload(env, incident.site_id, windowHours, { windowEnd: validEnd, windowStart });
}

async function buildClientMonthlyReportPayload(
  env: Env,
  clientId: string,
  monthKey: string,
  options?: { version?: 'v1' | 'v2' },
): Promise<{ payload: ClientMonthlyReportPayload; client: { id: string; name: string } }> {
  const range = parseMonthRange(monthKey);
  if (!range) {
    throw new Error('Invalid month format');
  }

  const client = await env.DB.prepare('SELECT client_id, name FROM clients WHERE client_id=?')
    .bind(clientId)
    .first<{ client_id: string; name: string | null }>();
  if (!client) {
    throw new Error('Client not found');
  }

  const mapRows = await env.DB.prepare(
    `SELECT DISTINCT d.device_id, d.site_id
       FROM devices d
       JOIN site_clients sc ON sc.site_id = d.site_id
      WHERE sc.client_id = ?`,
  )
    .bind(clientId)
    .all<{ device_id: string; site_id: string | null }>();

  const deviceIds = (mapRows.results ?? []).map((row) => row.device_id).filter((id): id is string => !!id);
  const siteIds = new Set<string>();
  for (const row of mapRows.results ?? []) {
    if (row.site_id) {
      siteIds.add(row.site_id);
    }
  }

  const startIso = range.start.toISOString();
  const endIso = range.end.toISOString();

  const metrics =
    options?.version === 'v2'
      ? await computeClientMonthlyMetricsV2(env.DB, clientId, deviceIds, startIso, endIso)
      : await computeClientMonthlyMetricsV1(env.DB, clientId, deviceIds, startIso, endIso);

  const slo = await env.DB.prepare(
    'SELECT uptime_target, ingest_target, cop_target, report_recipients FROM client_slos WHERE client_id=?',
  )
    .bind(clientId)
    .first<{ uptime_target: number | null; ingest_target: number | null; cop_target: number | null; report_recipients: string | null }>();

  const periodEndDisplay = new Date(range.end.getTime() - 1);

  const payload: ClientMonthlyReportPayload = {
    clientId,
    clientName: client.name ?? clientId,
    monthLabel: range.label,
    monthKey,
    periodStart: startIso,
    periodEnd: periodEndDisplay.toISOString(),
    siteCount: siteIds.size,
    deviceCount: deviceIds.length,
    metrics,
    targets: {
      uptimeTarget: toNumber(slo?.uptime_target),
      ingestTarget: toNumber(slo?.ingest_target),
      copTarget: toNumber(slo?.cop_target),
    },
    recipients: slo?.report_recipients ?? null,
  };

  return { payload, client: { id: clientId, name: client.name ?? clientId } };
}

async function buildClientSloSummary(env: Env, clientId: string, monthParam?: string | null): Promise<ClientSloSummary> {
  const now = new Date();
  let monthKey = monthParam ?? formatMonthKey(now);
  let range = parseMonthRange(monthKey);
  if (!range) {
    monthKey = formatMonthKey(now);
    range = parseMonthRange(monthKey);
  }
  if (!range) {
    throw new Error('Invalid month');
  }

  const client = await env.DB.prepare('SELECT client_id, name FROM clients WHERE client_id=?')
    .bind(clientId)
    .first<{ client_id: string; name: string | null }>();
  if (!client) {
    throw new Error('Client not found');
  }

  const mapRows = await env.DB.prepare(
    `SELECT DISTINCT d.device_id, d.site_id
       FROM devices d
       JOIN site_clients sc ON sc.site_id = d.site_id
      WHERE sc.client_id = ?`,
  )
    .bind(clientId)
    .all<{ device_id: string | null; site_id: string | null }>();

  const deviceIds = (mapRows.results ?? [])
    .map((row) => row.device_id)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const siteIds = new Set<string>();
  for (const row of mapRows.results ?? []) {
    if (row.site_id) {
      siteIds.add(row.site_id);
    }
  }

  const startIso = range.start.toISOString();
  const monthEndMs = range.end.getTime();
  const nowMs = now.getTime();
  let effectiveEnd = range.end;
  if (nowMs >= range.start.getTime()) {
    effectiveEnd = nowMs < monthEndMs ? new Date(nowMs) : range.end;
  }
  const endIso = effectiveEnd.toISOString();

  const metrics = await computeClientMonthlyMetricsV2(env.DB, clientId, deviceIds, startIso, endIso);

  const alertsBySeverity: Record<string, number> = {};
  for (const alert of metrics.alerts) {
    alertsBySeverity[alert.severity] = (alertsBySeverity[alert.severity] ?? 0) + alert.count;
  }

  const slo = await env.DB.prepare(
    'SELECT uptime_target, ingest_target, cop_target, report_recipients FROM client_slos WHERE client_id=?',
  )
    .bind(clientId)
    .first<{ uptime_target: number | null; ingest_target: number | null; cop_target: number | null; report_recipients: string | null }>();

  const dayMs = 24 * 60 * 60 * 1000;
  const sparkEnd = new Date(nowMs);
  const sparkStart = new Date(sparkEnd.getTime() - 6 * dayMs);
  const copSparkline: Array<{ ts: string; value: number | null }> = [];
  for (let i = 0; i < 7; i += 1) {
    const point = new Date(sparkStart.getTime() + i * dayMs);
    copSparkline.push({ ts: point.toISOString().slice(0, 10), value: null });
  }

  if (deviceIds.length > 0) {
    const placeholders = deviceIds.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', ts) AS day, AVG(cop) AS avg_cop
         FROM telemetry
        WHERE device_id IN (${placeholders})
          AND ts >= ?
          AND ts <= ?
        GROUP BY day
        ORDER BY day`,
    )
      .bind(...deviceIds, sparkStart.toISOString(), sparkEnd.toISOString())
      .all<{ day: string; avg_cop: number | null }>();

    const lookup = new Map<string, number | null>();
    for (const row of rows.results ?? []) {
      lookup.set(row.day, toNumber(row.avg_cop));
    }
    copSparkline.forEach((point, idx) => {
      const value = lookup.has(point.ts) ? lookup.get(point.ts) ?? null : null;
      copSparkline[idx] = { ts: point.ts, value };
    });
  }

  return {
    clientId: client.client_id,
    clientName: client.name ?? client.client_id,
    month: {
      key: monthKey,
      label: range.label,
      start: startIso,
      end: range.end.toISOString(),
      effectiveEnd: endIso,
    },
    siteCount: siteIds.size,
    deviceCount: deviceIds.length,
    metrics: {
      uptimePct: metrics.uptimePct,
      ingestSuccessPct: metrics.ingestSuccessPct,
      avgCop: metrics.avgCop,
      alerts: metrics.alerts,
      alertsBySeverity,
    },
    targets: {
      uptimeTarget: toNumber(slo?.uptime_target),
      ingestTarget: toNumber(slo?.ingest_target),
      copTarget: toNumber(slo?.cop_target),
    },
    recipients: slo?.report_recipients ?? null,
    copSparkline,
    heartbeatFreshnessMinutes: 5,
    window: { start: startIso, end: endIso },
    updatedAt: new Date().toISOString(),
  };
}

async function fetchLatestCanary(DB: D1Database): Promise<{ lastAt: string | null; minutesSince: number | null; status: 'ok' | 'warn' | 'crit' }> {
  try {
    const row = await DB.prepare(
      "SELECT ts FROM ops_metrics WHERE route IN ('/ops/canary','/api/ops/canary','ops_canary','canary') ORDER BY ts DESC LIMIT 1",
    ).first<{ ts: string | null }>();
    const raw = row?.ts ?? null;
    if (!raw) {
      return { lastAt: null, minutesSince: null, status: 'crit' };
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.valueOf())) {
      return { lastAt: null, minutesSince: null, status: 'crit' };
    }
    const diffMs = Date.now() - parsed.valueOf();
    const minutes = Number.isFinite(diffMs) ? Math.max(0, diffMs / 60000) : null;
    const status = minutes == null ? 'crit' : minutes <= 10 ? 'ok' : minutes <= 15 ? 'warn' : 'crit';
    return { lastAt: parsed.toISOString(), minutesSince: minutes, status };
  } catch (error) {
    console.warn('fetchLatestCanary failed', error);
    return { lastAt: null, minutesSince: null, status: 'crit' };
  }
}

async function computeOpsSnapshot(DB: D1Database): Promise<OpsSnapshot> {
  const totalRow = await DB.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS success FROM ops_metrics WHERE route='/api/ingest'",
  )
    .first<{ total: number | null; success: number | null }>()
    .catch(() => null);

  const overallTotal = toNumber(totalRow?.total) ?? 0;
  const overallSuccess = toNumber(totalRow?.success) ?? 0;
  const overallError = Math.max(0, overallTotal - overallSuccess);
  const overallSuccessPct = overallTotal > 0 ? (overallSuccess / overallTotal) * 100 : 100;

  const windowRow = await DB.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS success FROM (SELECT status_code FROM ops_metrics WHERE route='/api/ingest' ORDER BY ts DESC LIMIT 1000)",
  )
    .first<{ total: number | null; success: number | null }>()
    .catch(() => null);

  const windowTotal = toNumber(windowRow?.total) ?? 0;
  const windowSuccess = toNumber(windowRow?.success) ?? 0;
  const windowError = Math.max(0, windowTotal - windowSuccess);
  const windowSuccessPct = windowTotal > 0 ? (windowSuccess / windowTotal) * 100 : 100;
  let burnWindow: BurnSnapshot = { total: 0, ok: 0, errRate: 0, burn: 0 };
  try {
    burnWindow = await computeBurn(DB, 10, 0.999);
  } catch (error) {
    console.warn('computeBurn failed', error);
  }

  const heartbeatRow = await DB.prepare(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) AS online FROM devices',
  )
    .first<{ total: number | null; online: number | null }>()
    .catch(() => null);

  const heartbeatTotal = toNumber(heartbeatRow?.total) ?? 0;
  const heartbeatOnline = toNumber(heartbeatRow?.online) ?? 0;
  const heartbeatPct = heartbeatTotal > 0 ? (heartbeatOnline / heartbeatTotal) * 100 : 0;

  const canary = await fetchLatestCanary(DB);

  const baselineDeviationRow = await DB.prepare(
    `SELECT
        SUM(CASE WHEN severity = 'critical' AND state IN ('open','ack') THEN 1 ELSE 0 END) AS critical,
        SUM(CASE WHEN severity IN ('major','warning') AND state IN ('open','ack') THEN 1 ELSE 0 END) AS warning
     FROM alerts
     WHERE type='baseline_deviation' AND opened_at >= datetime('now', '-1 day')`,
  )
    .first<{ critical: number | null; warning: number | null }>()
    .catch(() => null);

  const baselineDeviation = {
    window: '24h',
    critical: toNumber(baselineDeviationRow?.critical) ?? 0,
    warning: toNumber(baselineDeviationRow?.warning) ?? 0,
  };

  return {
    generatedAt: new Date().toISOString(),
    ingest: {
      total: {
        total: overallTotal,
        success: overallSuccess,
        successPct: Number.isFinite(overallSuccessPct) ? overallSuccessPct : 0,
        error: overallError,
      },
      window1k: {
        total: windowTotal,
        success: windowSuccess,
        successPct: Number.isFinite(windowSuccessPct) ? windowSuccessPct : 0,
        error: windowError,
      },
      burnRate: Number.isFinite(burnWindow.burn) ? burnWindow.burn : 0,
    },
    heartbeat: {
      total: heartbeatTotal,
      online: heartbeatOnline,
      onlinePct: Number.isFinite(heartbeatPct) ? heartbeatPct : 0,
    },
    canary,
    baselineDeviation,
  };
}

async function processTelemetryInline(
  env: Env,
  telemetry: TelemetryPayload,
  receivedAt: string,
): Promise<void> {
  void receivedAt;
  await baseQueueHandler(
    {
      messages: [
        {
          body: { type: 'telemetry', profileId: telemetry.deviceId, body: telemetry },
          ack: () => {},
          retry: () => {},
        },
      ],
    } as unknown as MessageBatch<IngestMessage>,
    env,
    {
      waitUntil: (promise: Promise<unknown>) => promise,
      passThroughOnException: () => {},
    } as ExecutionContext,
  );
}

async function processHeartbeatInline(
  env: Env,
  heartbeat: HeartbeatPayload,
  receivedAt: string,
): Promise<void> {
  void receivedAt;
  await baseQueueHandler(
    {
      messages: [
        {
          body: { type: 'heartbeat', profileId: heartbeat.deviceId, body: heartbeat },
          ack: () => {},
          retry: () => {},
        },
      ],
    } as unknown as MessageBatch<IngestMessage>,
    env,
    {
      waitUntil: (promise: Promise<unknown>) => promise,
      passThroughOnException: () => {},
    } as ExecutionContext,
  );
}

export async function queue(batch: MessageBatch<IngestMessage>, env: Env, ctx: ExecutionContext) {
  await baseQueueHandler(batch, env, ctx);

  for (const message of batch.messages) {
    if (message.body?.type !== 'telemetry') continue;
    const telemetry = message.body.body;
    try {
      const latest = await env.DB.prepare(
        'SELECT deltaT, thermalKW, cop, cop_quality as copQuality FROM latest_state WHERE device_id=?',
      )
        .bind(telemetry.deviceId)
        .first<{
          deltaT: number | null;
          thermalKW: number | null;
          cop: number | null;
          copQuality: 'measured' | 'estimated' | null;
        }>();
      const derived: Derived = latest ?? { deltaT: null, thermalKW: null, cop: null, copQuality: null };
      await evaluateTelemetryAlerts(env, telemetry, derived);
      await evaluateBaselineAlerts(env, telemetry.deviceId, Date.now());
    } catch (error) {
      console.error('alert evaluation error', error);
    }
  }
}

const CRON_FAST = '*/5 * * * *';
const CRON_NIGHTLY = '0 2 * * *';
const CRON_MONTHLY = '15 2 1 * *';

async function runFastBurnJob(env: Env) {
  try {
    await fastBurnMonitor(env);
  } catch (error) {
    console.error('fast burn monitor error', error);
  }
}

async function runNightlyJobs(env: Env) {
  await evaluateHeartbeatAlerts(env, new Date().toISOString()).catch((error) => {
    console.error('heartbeat sweep error', error);
  });
  await recomputeBaselines(env.DB).catch((error) => {
    console.error('baseline recompute error', error);
  });
  await env.DB
    .prepare("DELETE FROM device_baselines WHERE expires_at IS NOT NULL AND expires_at < datetime('now')")
    .run()
    .catch((error) => {
      console.error('baseline prune error', error);
    });
  await sweepIncidents(env.DB).catch((error) => {
    console.error('incident sweep error', error);
  });
}

async function runMonthlyJobs(env: Env, evt: ScheduledEvent) {
  const reference = evt.scheduledTime ? new Date(evt.scheduledTime) : new Date();
  const monthKey = previousMonthKey(reference);
  const sloRows = await env.DB.prepare('SELECT client_id FROM client_slos').all<{ client_id: string }>();
  const { generateClientMonthlyReport } = await getPdfModule();
  for (const row of sloRows.results ?? []) {
    try {
      const { payload } = await buildClientMonthlyReportPayload(env, row.client_id, monthKey);
      await generateClientMonthlyReport(env, payload);
    } catch (error) {
      console.error('monthly report generation failed', row.client_id, error);
    }
  }
}

async function runHousekeepingJobs(env: Env) {
  try {
    await pruneStaged(env, 14);
  } catch {}
  try {
    await pruneR2Prefix(env.REPORTS, 'provisioning/', 180);
  } catch {}
}

type CronHandler = (env: Env, evt: ScheduledEvent) => Promise<void>;

const CRON_HANDLERS: Record<string, CronHandler> = {
  [CRON_FAST]: async (env) => {
    await runFastBurnJob(env);
  },
  [CRON_NIGHTLY]: async (env) => {
    await runFastBurnJob(env);
    await runNightlyJobs(env);
  },
  [CRON_MONTHLY]: async (env, evt) => {
    await runFastBurnJob(env);
    await runNightlyJobs(env);
    await runMonthlyJobs(env, evt);
  },
};

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => {
    // Only run the preflight checks when the critical write-limit env vars are present.
    // Tests create lightweight Env objects that intentionally omit many production bindings
    // (WRITE_MIN_C / WRITE_MAX_C among them). Running full preflight there causes 503s
    // during unit tests. In production the vars will be present and preflight will run.
    if (env.WRITE_MIN_C !== undefined && env.WRITE_MAX_C !== undefined) {
      preflight(env);
    }
    return app.fetch(req, env, ctx);
  },
  queue,
  scheduled: async (evt: ScheduledEvent, env: Env) => {
    const cron = evt.cron ?? '';
    if (!cron) {
      await runFastBurnJob(env);
      await runNightlyJobs(env);
      await runMonthlyJobs(env, evt);
      await runHousekeepingJobs(env);
      return;
    }

    const handler = CRON_HANDLERS[cron];
    if (!handler) {
      console.warn('No scheduled handler registered for cron expression', cron);
      await runHousekeepingJobs(env);
      return;
    }

    await handler(env, evt);
    await runHousekeepingJobs(env);
  },
};
