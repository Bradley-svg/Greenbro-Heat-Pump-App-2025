import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ allErrors: true, strict: false, removeAdditional: 'failing' });
addFormats(ajv);

export const IngestSchema = {
  $id: 'gb:ingest-v1',
  type: 'object',
  required: ['device_id', 'ts'],
  additionalProperties: false,
  anyOf: [
    { required: ['metrics'] },
    { required: ['registers'] },
    { required: ['holding_registers'] },
    { required: ['read_only_registers'] },
  ],
  properties: {
    device_id: { type: 'string', minLength: 1 },
    ts: { type: 'string', format: 'date-time' },
    metrics: {
      type: 'object',
      additionalProperties: { type: 'number' },
      properties: {
        outlet_temp_c: { type: 'number' },
        return_temp_c: { type: 'number' },
        ambient_c: { type: 'number' },
        compressor_a: { type: 'number' },
        flow_lpm: { type: 'number' },
      },
    },
    registers: {
      type: 'object',
      additionalProperties: { type: 'number' },
    },
    holding_registers: {
      type: 'object',
      additionalProperties: { type: 'number' },
    },
    read_only_registers: {
      type: 'object',
      additionalProperties: { type: 'number' },
    },
    status: { type: 'object', additionalProperties: true },
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
