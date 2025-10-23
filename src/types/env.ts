import type { IngestMessage } from '../types';

export type {
  D1Database,
  R2Bucket,
  KVNamespace,
  DurableObjectNamespace,
  DurableObjectState,
  MessageBatch,
  Queue,
  ExecutionContext,
  ScheduledEvent,
  ScheduledController,
} from '@cloudflare/workers-types';

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
  ACCESS_JWKS?: string;
  ACCESS_JWKS_URL?: string;
  JWT_SECRET: string;
  WRITE_MIN_C?: string;
  WRITE_MAX_C?: string;
  DEV_AUTH_BYPASS?: string;
  BUILD_SHA?: string;
  BUILD_DATE?: string;
  BUILD_SOURCE?: string;
}
