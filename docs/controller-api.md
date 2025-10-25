# Greenbro Controller API Contract

This document defines the JSON interfaces that embedded controllers or Wi-Fi modules must use when communicating with the Greenbro edge worker. All payloads are encoded as UTF-8 JSON and transmitted over HTTPS to the worker hostname configured for your environment (for example `https://api.greenbro.co.za`).

## Common Requirements

- **TLS**: Clients must establish an HTTPS connection. Plain HTTP is rejected.
- **Authentication**: Every request that originates from a controller includes the device key in the `X-GREENBRO-DEVICE-KEY` header. Keys are provisioned by Greenbro operations and are a 64-character hexadecimal string (SHA-256 shared secret). Rotate keys immediately if exposed.
- **Content-Type**: Set `Content-Type: application/json`.
- **Time**: Timestamps are ISO 8601 strings in UTC (e.g. `2025-10-25T12:34:56Z`).
- **Retry / Backoff**: When a request fails with a network error or a 5xx response, retry with exponential backoff starting at 5 seconds, doubling up to a maximum of 5 minutes. Do not retry 4xx responses except `409` (conflict) which indicates an idempotency check in progress—retry after 10 seconds.
- **Idempotency**: Telemetry/heartbeat posts are deduplicated by the worker. Repeat submissions of the exact same payload are safe but should be avoided where possible.

### AT Command Invocation

Wi-Fi modules that rely on the factory AT interface must use `AT+HTTPCLIENTLINE` with the following argument order:

```
AT+HTTPCLIENTLINE=1,0,"application/json","api.greenbro.co.za",443,"/api/ingest/<profileId>",<json>
```

- `transport_type`: use `1` (HTTPS).
- `opt`: `0` (no redirects).
- `json`: inline telemetry payload.
- **Success Criteria**: the module should parse the HTTP status code. Treat any `2xx` response as success. HTTP `202` means the payload was accepted and queued.
- **Failure handling**: for `408` or connection timeout retry immediately; otherwise follow the exponential backoff guidance above.

## Telemetry Upload

**Endpoint**: `POST /api/ingest/:profileId`

Use the profile identifier supplied by Greenbro operations. The `profileId` ties a device to a commissioning template and ensures data is routed correctly.

### Request Body

```json
{
  "device_id": "HP-10001",
  "ts": "2025-10-25T12:34:56Z",
  "metrics": {
    "supply_c": 47.9,
    "return_c": 42.6,
    "tank_c": 49.3,
    "ambient_c": 18.2,
    "flow_lps": 0.33,
    "power_kw": 2.1,
    "compressor_a": 8.7
  },
  "status": {
    "mode": "heating",
    "defrost": false,
    "online": true,
    "flags": {
      "components": {
        "pump": true,
        "ev_valve": false
      }
    }
  },
  "faults": [
    { "code": "low_flow", "active": true, "description": "Flow below expected threshold" }
  ],
  "meta": {
    "firmware_version": "2.8.1",
    "wifi_signal_dbm": -62
  }
}
```

| Field | Type | Required | Units / Notes |
| ----- | ---- | -------- | ------------- |
| `device_id` | string | ✅ | Device identifier registered with Greenbro. |
| `ts` | string | ✅ | ISO 8601 UTC timestamp when telemetry was measured. |
| `metrics.supply_c` | number | ✅ | Leaving water temperature in °C. |
| `metrics.return_c` | number | ✅ | Return water temperature in °C. |
| `metrics.tank_c` | number | optional | Tank temperature in °C. |
| `metrics.ambient_c` | number | optional | Ambient air temperature in °C. |
| `metrics.flow_lps` | number | optional | Flow in litres per second. |
| `metrics.power_kw` | number | optional | Electrical power draw in kW. |
| `metrics.compressor_a` | number | optional | Compressor current in amperes. |
| `status.mode` | string | optional | Textual mode label (`heating`, `cooling`, `dhw`, etc.). |
| `status.defrost` | boolean | optional | `true` while a defrost cycle is active. |
| `status.online` | boolean | optional | `true` if the device considers itself healthy. Defaults to `true`. |
| `status.flags` | object | optional | Nested boolean map for additional component flags. |
| `faults` | array | optional | Active or historical fault codes. Codes should be lowercase snake-case. |
| `meta` | object | optional | Diagnostic metadata (signal strength, firmware, etc.). |

The worker will compute derived metrics such as delta-T and COP automatically.

### Response

`202 Accepted` with body:

```json
{ "ok": true, "queued": true }
```

If the payload is a duplicate, the worker returns `200` with `{ "ok": true, "deduped": true }`.

Validation failures produce `400` with `{ "ok": false, "errors": [...] }`.

`403` indicates the device key or profile association is invalid.

## Heartbeat

**Endpoint**: `POST /api/heartbeat/:profileId`

```json
{
  "device_id": "HP-10001",
  "timestamp": "2025-10-25T12:35:00Z",
  "rssi": -61
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `device_id` | ✅ | Matches telemetry uploads. |
| `timestamp` | ✅ | Time the heartbeat was generated. |
| `rssi` | optional | Wi-Fi signal in dBm. |

Response: `202` with `{ "ok": true, "queued": true }`.

Send a heartbeat at least every five minutes while the device is online.

## Command Polling

Controllers fetch pending operator commands with long-polling.

### Request

**Endpoint**: `POST /api/device/:deviceId/commands/poll`

Body:

```json
{
  "max": 1,
  "wait_s": 20,
  "last_ack": "cmd_01HZ7A"
}
```

- `max` (optional): maximum commands to return; defaults to `1`.
- `wait_s` (optional): long-poll timeout. The worker holds the request for up to 20 seconds waiting for new commands. Servers may shorten the wait.
- `last_ack` (optional): command identifier that the controller most recently acknowledged; enables idempotent resume after reconnect.

### Response

`200 OK`

```json
{
  "commands": [
    {
      "id": "cmd_01HZ7FQ6B8T0",
      "ts": "2025-10-25T12:37:02Z",
      "expires_at": "2025-10-25T13:07:02Z",
      "body": {
        "dhw_set_c": 55,
        "mode": "heating"
      }
    }
  ]
}
```

- The controller must apply commands in order of `ts`.
- Commands expire after 30 minutes; expired commands appear with status `expired` on the operator side and will no longer be sent.

If no commands are available before `wait_s` elapses, the worker responds with `204 No Content`. Clients should immediately issue another poll.

`403` means the device key or device ID is invalid.

### Acknowledgement

After applying a command, the controller reports the result.

**Endpoint**: `POST /api/device/:deviceId/commands/:commandId/ack`

```json
{
  "status": "applied",
  "applied_at": "2025-10-25T12:37:15Z",
  "details": "Command executed successfully."
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `status` | ✅ | `applied` or `failed`. |
| `applied_at` | optional | Time the command completed. Defaults to current server time. |
| `details` | optional | Diagnostic text. Required when `status` = `failed`. |

Responses:

- `200` on success.
- `409` if the command has already been acknowledged (idempotent retry).
- `404` if the command does not exist or expired.

## Status Codes Summary

| Status | Meaning | Client Action |
|--------|---------|---------------|
| `200` | OK. For poll without commands returns empty array. | Continue normal operation. |
| `202` | Accepted/queued. | Treat as success. |
| `204` | No pending commands before timeout. | Immediately reissue poll. |
| `400` | Validation error. | Inspect `errors`, fix payload. |
| `401`/`403` | Authentication failure. | Verify device key/profile setup. |
| `404` | Command not found/expired. | Drop local reference. |
| `409` | Duplicate acknowledgement. | Safe to ignore. |
| `429` | Rate limited. | Backoff for 30 seconds, then retry. |
| `500`+ | Server error. | Retry with exponential backoff. |

## Telemetry & Command Retention

- Telemetry history: retained for at least 90 days in hot storage.
- Commands: pending for up to 30 minutes, acknowledged records retained for audit for 365 days.
- Operators are alerted if a command remains unacknowledged for 10 minutes.

## Provisioning Checklist

1. Request a device ID and shared secret from Greenbro operations.
2. Configure the device with:
   - Worker hostname (staging or production).
   - Device ID.
   - Device key (hex string).
   - Profile ID (provided per deployment).
3. Verify connectivity by sending a heartbeat. Expect `202` in response.
4. Trigger a telemetry transmission and confirm it surfaces in the operator dashboard.
5. Initiate a test command from the dashboard and ensure the device polls, applies, and acknowledges it within 30 seconds.

