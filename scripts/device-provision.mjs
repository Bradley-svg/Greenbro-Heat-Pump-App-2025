#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

function usage() {
  console.error(`Usage: node scripts/device-provision.mjs --database <binding> --device <id> --profile <profileId> [options]

Options:
  --site <siteId>      Optional site identifier to associate with the device.
  --print-sql          Emit the generated SQL instead of executing it (dry run).

The script provisions or rotates the shared secret for a device and updates the
profile/site linkage. The plaintext device key is printed to stdout.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function escapeSql(value) {
  return value.replace(/'/g, "''");
}

function buildSql({ deviceId, profileId, siteId, keyHash }) {
  const siteClause = siteId ? `'${escapeSql(siteId)}'` : 'NULL';
  return `
INSERT INTO devices (device_id, profile_id, site_id, key_hash, created_at)
VALUES ('${escapeSql(deviceId)}', '${escapeSql(profileId)}', ${siteClause}, '${keyHash}', datetime('now'))
ON CONFLICT(device_id)
DO UPDATE SET
  profile_id=excluded.profile_id,
  site_id=excluded.site_id,
  key_hash=excluded.key_hash;
`;
}

async function executeSql(binding, sql) {
  return new Promise((resolve, reject) => {
    const proc = spawn('wrangler', ['d1', 'execute', binding, '--command', sql], {
      stdio: 'inherit',
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler d1 execute exited with code ${code}`));
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  const opts = parseArgs(argv);
  const database = opts.database;
  const deviceId = opts.device;
  const profileId = opts.profile;
  const siteId = opts.site || null;
  const printSql = Boolean(opts['print-sql']);

  if (!database || !deviceId || !profileId) {
    usage();
    process.exitCode = 1;
    return;
  }

  const deviceKey = crypto.randomBytes(32).toString('hex');
  const keyHash = crypto.createHash('sha256').update(deviceKey).digest('hex');

  const sql = buildSql({ deviceId, profileId, siteId, keyHash });

  if (printSql) {
    console.log(sql.trim());
  } else {
    await executeSql(database, sql);
  }

  console.log('');
  console.log('Device provisioned:');
  console.log(`  Device ID : ${deviceId}`);
  console.log(`  Profile   : ${profileId}`);
  if (siteId) console.log(`  Site      : ${siteId}`);
  console.log('');
  console.log('Provision this key on the controller:');
  console.log(deviceKey);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
