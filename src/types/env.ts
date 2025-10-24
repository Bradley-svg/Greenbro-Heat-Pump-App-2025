/// <reference types="@cloudflare/workers-types" />

import type { IngestMessage } from '../types';

export type D1Database = globalThis.D1Database;
export type R2Bucket = globalThis.R2Bucket;
export type KVNamespace = globalThis.KVNamespace;
export type DurableObjectNamespace = globalThis.DurableObjectNamespace;
export type DurableObjectState = globalThis.DurableObjectState;
export type MessageBatch<T = unknown> = globalThis.MessageBatch<T>;
export type Queue<T = unknown> = globalThis.Queue<T>;
export type ExecutionContext = globalThis.ExecutionContext;
export type ScheduledEvent = globalThis.ScheduledEvent;
export type ScheduledController = globalThis.ScheduledController;

export interface Env {
  // Storage
  DB: D1Database;
  CONFIG: KVNamespace;
  REPORTS: R2Bucket;
  BRAND: R2Bucket;
  ARCHIVE: R2Bucket;

  // Queues
  INGEST_Q: Queue<IngestMessage>;

  // Durable Objects
  DeviceState: DurableObjectNamespace;
  DEVICE_DO: DurableObjectNamespace;

  // Configuration
  ACCESS_AUD: string;
  ACCESS_ISS: string;
  ACCESS_JWKS: string;
  ACCESS_JWKS_URL?: string;
  JWT_SECRET: string;
  WRITE_MIN_C: string;
  WRITE_MAX_C: string;
  DEV_AUTH_BYPASS?: string;
  CORS_ALLOWED_ORIGINS?: string;
  REPORTS_PUBLIC_BASE_URL?: string;
  BUILD_SHA?: string;
  BUILD_DATE?: string;
  BUILD_SOURCE?: string;
  ALLOW_AUTH_BYPASS?: string;
}
