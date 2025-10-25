import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ allErrors: true, strict: false, removeAdditional: 'failing' });
addFormats(ajv);

export const IngestSchema = {
  $id: 'gb:ingest-v1',
  type: 'object',
  required: ['device_id', 'ts', 'metrics'],
  additionalProperties: false,
  properties: {
    device_id: { type: 'string', minLength: 1 },
    ts: { type: 'string', format: 'date-time' },
    metrics: {
      type: 'object',
      required: ['supply_c', 'return_c'],
      properties: {
        supply_c: { type: ['number', 'string'] },
        return_c: { type: ['number', 'string'] },
        tank_c: { type: ['number', 'string'] },
        ambient_c: { type: ['number', 'string'] },
        flow_lps: { type: ['number', 'string'] },
        flow_lpm: { type: ['number', 'string'] },
        power_kw: { type: ['number', 'string'] },
        compressor_a: { type: ['number', 'string'] },
        eev_steps: { type: ['number', 'string'] }
      },
      additionalProperties: { type: ['number', 'string', 'null'] },
    },
    status: {
      type: 'object',
      additionalProperties: true,
      properties: {
        mode: { type: 'string' },
        defrost: { type: 'boolean' },
        online: { type: 'boolean' },
        flags: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            additionalProperties: { type: 'boolean' },
          },
        },
      },
    },
    faults: {
      type: 'array',
      items: {
        type: 'object',
        required: ['code'],
        additionalProperties: false,
        properties: {
          code: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          active: { type: 'boolean' },
        },
      },
    },
    meta: { type: 'object', additionalProperties: true },
  },
} as const;

export const HeartbeatSchema = {
  $id: 'gb:heartbeat-v1',
  type: 'object',
  required: ['device_id', 'timestamp'],
  additionalProperties: false,
  properties: {
    device_id: { type: 'string', minLength: 1 },
    timestamp: { type: 'string', format: 'date-time' },
    rssi: { type: ['number', 'null'] },
  },
} as const;

export const validateIngest = ajv.compile(IngestSchema);
export const validateHeartbeat = ajv.compile(HeartbeatSchema);
