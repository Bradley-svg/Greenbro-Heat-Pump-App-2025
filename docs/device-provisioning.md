# Device Provisioning Guide

Provision every controller before it sends telemetry to the worker. Each device must be associated with a profile (commissioning template), an optional site, and a unique shared secret used for HTTPS authentication.

## When to Provision

1. A new controller is about to be commissioned.
2. An existing device rotates its shared secret (for example after a suspected leak).
3. A device is reassigned to a different profile or site.

## CLI Helper

Use the `device:provision` script to create or update the `devices` table entry and generate a fresh secret.

```bash
npm run device:provision -- \
  --database GREENBRO_DB \
  --device HP-1024 \
  --profile profile-commissioning-2025 \
  --site SITE-CPT-001
```

The script:

- Generates a 64-character hexadecimal device key.
- Hashes and stores the key in D1 (`key_hash`).
- Sets the `profile_id` and optional `site_id`.
- Prints the plaintext key to stdout so it can be flashed onto the controller.

Pass `--print-sql` to preview the SQL without executing it.

## Controller Checklist

1. Record the device ID, profile, site, and generated key.
2. Configure the Wi-Fi module with:
   - Worker hostname (`api.greenbro.co.za` or staging equivalent).
   - Device ID.
   - Profile ID.
   - Shared secret (plaintext key).
3. Trigger a heartbeat to confirm a `202` response.
4. Send a telemetry sample and confirm it appears in the dashboard.
5. Issue a test command from the dashboard; the controller should poll, apply, and acknowledge within 30 seconds.

## Rotating Keys

Re-run the provisioning script for the same device ID when you need a new secret. The script updates the hash in D1 and prints a new key. Install the new key on the controller and restart the device; old keys cease working immediately.

## Troubleshooting

| Symptom | Likely Cause | Fix |
| ------- | ------------ | --- |
| `403 Forbidden` from `/api/ingest/:profileId` | Shared secret incorrect or device not provisioned | Regenerate the key and reflash the controller. |
| `403` after profile change | Controller still using old profile ID | Update the module configuration to match the provisioned value. |
| Poll endpoint returns `204` despite queued command | Device not polling frequently enough or command expired | Reduce poll interval; commands expire after 30 minutes. |
