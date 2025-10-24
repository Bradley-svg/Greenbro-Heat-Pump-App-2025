import type { Env } from '../types/env';
import { zipStore } from '../lib/zip';

export async function renderProvisioningZip(env: Env, opts: { device_id: string; session_id?: string | null }) {
  const labelsKey = `labels/${opts.device_id}-latest.pdf`;
  const existing = await env.REPORTS.get(labelsKey);
  let labels = existing ? await existing.arrayBuffer() : null;
  if (!labels) {
    const { renderDeviceLabels } = await import('./labels-pdf');
    const gen = await renderDeviceLabels(env, { device_id: opts.device_id });
    const copy = await env.REPORTS.get(gen.key);
    if (copy) {
      const buffer = await copy.arrayBuffer();
      await env.REPORTS.put(labelsKey, buffer, { httpMetadata: { contentType: 'application/pdf' } });
      labels = buffer;
    }
  }

  const d = await env.DB.prepare(
    'SELECT device_id, site as site_id, profile_id, firmware, map_version FROM devices WHERE device_id=?',
  )
    .bind(opts.device_id)
    .first<{
      device_id: string;
      site_id: string | null;
      profile_id: string | null;
      firmware: string | null;
      map_version: string | null;
    }>();

  const config = {
    device_id: d?.device_id ?? opts.device_id,
    site_id: d?.site_id ?? null,
    profile_id: d?.profile_id ?? null,
    firmware: d?.firmware ?? null,
    map_version: d?.map_version ?? null,
    mqtt_topics: d?.profile_id
      ? {
          telemetry: `devices/${d.profile_id}/${opts.device_id}/telemetry`,
          heartbeat: `devices/${d.profile_id}/${opts.device_id}/heartbeat`,
        }
      : null,
    rs485: {
      a: 'A / D+',
      b: 'B / D-',
      termination: '120Ω at last device',
      addressing: 'Set as per installer guide',
    },
  };

  const readme = [
    '# Greenbro Provisioning',
    '',
    'Contents:',
    '- labels.pdf  → print and affix',
    '- config.json → provisioning metadata (no secrets)',
    '',
    'RS-485:',
    '- Wire A→A (D+), B→B (D-), terminate last device (120Ω).',
    '- Confirm addressing per installer guide.',
    '',
    'Ingest:',
    '- Device sends HTTPS/MQTT telemetry; keys managed separately.',
    '',
  ].join('\n');

  const files = [
    { name: 'labels.pdf', data: new Uint8Array(labels || new ArrayBuffer(0)) },
    { name: 'config.json', data: new TextEncoder().encode(JSON.stringify(config, null, 2)) },
    { name: 'README.md', data: new TextEncoder().encode(readme) },
  ];

  const zip = zipStore(files);
  const key = `provisioning/${opts.device_id}-${Date.now()}.zip`;
  await env.REPORTS.put(key, zip, { httpMetadata: { contentType: 'application/zip' } });
  return { key, size: zip.byteLength };
}
