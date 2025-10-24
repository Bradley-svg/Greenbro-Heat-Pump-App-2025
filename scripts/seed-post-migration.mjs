#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function usage() {
  console.error(`Usage: node scripts/seed-post-migration.mjs --database <binding> [options]

Options:
  --config <file>                JSON file containing seed data.
  --ops-webhook <url>            Override ops_webhook_url.
  --commissioning-delta-t <degC> Override commissioning_delta_t_min.
  --commissioning-flow <lpm>     Override commissioning_flow_min_lpm.
  --commissioning-cop <value>    Override commissioning_cop_min.
  --commissioning-report <list>  Comma-separated commissioning report recipients.
`);
}

function parseArgs(argv) {
  const result = {
    database: null,
    configPath: null,
    overrides: {
      opsWebhookUrl: undefined,
      commissioning: {
        deltaTMin: undefined,
        flowMinLpm: undefined,
        copMin: undefined,
        reportRecipients: undefined,
      },
      accessBindings: undefined,
    },
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--database': {
        const value = argv[++i];
        if (!value) throw new Error('Missing value for --database');
        result.database = value;
        break;
      }
      case '--config': {
        const value = argv[++i];
        if (!value) throw new Error('Missing value for --config');
        result.configPath = value;
        break;
      }
      case '--ops-webhook': {
        const value = argv[++i];
        if (!value) throw new Error('Missing value for --ops-webhook');
        result.overrides.opsWebhookUrl = value;
        break;
      }
      case '--commissioning-delta-t': {
        const value = argv[++i];
        if (!value) throw new Error('Missing value for --commissioning-delta-t');
        result.overrides.commissioning.deltaTMin = Number(value);
        break;
      }
      case '--commissioning-flow': {
        const value = argv[++i];
        if (!value) throw new Error('Missing value for --commissioning-flow');
        result.overrides.commissioning.flowMinLpm = Number(value);
        break;
      }
      case '--commissioning-cop': {
        const value = argv[++i];
        if (!value) throw new Error('Missing value for --commissioning-cop');
        result.overrides.commissioning.copMin = Number(value);
        break;
      }
      case '--commissioning-report': {
        const value = argv[++i];
        if (!value) throw new Error('Missing value for --commissioning-report');
        result.overrides.commissioning.reportRecipients = value.split(',').map((item) => item.trim()).filter(Boolean);
        break;
      }
      default: {
        if (arg.startsWith('--')) {
          throw new Error(`Unknown option: ${arg}`);
        }
      }
    }
  }

  return result;
}

async function readConfig(configPath) {
  if (!configPath) {
    return {};
  }
  const raw = await fs.readFile(configPath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Config JSON must be an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse config JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function formatRecipients(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    const normalised = value.map((item) => String(item).trim()).filter(Boolean);
    return normalised.length > 0 ? normalised.join(', ') : undefined;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(value) {
  if (value == null) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function upsertSetting(key, value) {
  return `INSERT INTO settings (key, value, updated_at) VALUES (${sqlString(key)}, ${sqlString(value)}, datetime('now'))\n` +
    `ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;`;
}

function buildStatements(config, overrides) {
  const statements = [];
  const opsWebhook = overrides.opsWebhookUrl ?? config.opsWebhookUrl;
  if (opsWebhook) {
    statements.push(upsertSetting('ops_webhook_url', opsWebhook));
  }

  const commissioningSource =
    config && typeof config.commissioning === 'object' && config.commissioning !== null
      ? config.commissioning
      : {};
  const commissioning = {
    deltaTMin: overrides.commissioning.deltaTMin ?? commissioningSource.deltaTMin,
    flowMinLpm: overrides.commissioning.flowMinLpm ?? commissioningSource.flowMinLpm,
    copMin: overrides.commissioning.copMin ?? commissioningSource.copMin,
    reportRecipients: overrides.commissioning.reportRecipients ?? commissioningSource.reportRecipients,
  };

  const deltaTMin = readNumber(commissioning.deltaTMin);
  if (deltaTMin != null) {
    statements.push(upsertSetting('commissioning_delta_t_min', deltaTMin));
  }
  const flowMin = readNumber(commissioning.flowMinLpm);
  if (flowMin != null) {
    statements.push(upsertSetting('commissioning_flow_min_lpm', flowMin));
  }
  const copMin = readNumber(commissioning.copMin);
  if (copMin != null) {
    statements.push(upsertSetting('commissioning_cop_min', copMin));
  }
  const commissioningRecipients = formatRecipients(commissioning.reportRecipients);
  if (commissioningRecipients) {
    statements.push(upsertSetting('commissioning_report_recipients', commissioningRecipients));
  }

  const sloContacts = Array.isArray(config.sloContacts) ? config.sloContacts : [];
  for (const entry of sloContacts) {
    if (!entry || typeof entry !== 'object') continue;
    const clientId = typeof entry.clientId === 'string' ? entry.clientId.trim() : '';
    if (!clientId) continue;
    const uptime = readNumber(entry.uptimeTarget);
    const ingest = readNumber(entry.ingestTarget);
    const cop = readNumber(entry.copTarget);
    const recipients = formatRecipients(entry.reportRecipients);
    statements.push(
      `INSERT INTO client_slos (client_id, uptime_target, ingest_target, cop_target, report_recipients, updated_at) VALUES (` +
        `${sqlString(clientId)}, ${uptime != null ? uptime : 'NULL'}, ${ingest != null ? ingest : 'NULL'}, ` +
        `${cop != null ? cop : 'NULL'}, ${recipients ? sqlString(recipients) : 'NULL'}, datetime('now'))\n` +
        `ON CONFLICT(client_id) DO UPDATE SET ` +
        `uptime_target=excluded.uptime_target, ingest_target=excluded.ingest_target, cop_target=excluded.cop_target, ` +
        `report_recipients=excluded.report_recipients, updated_at=excluded.updated_at;`,
    );
  }

  const accessBindingsRaw = overrides.accessBindings ?? config.accessBindings;
  if (Array.isArray(accessBindingsRaw) && accessBindingsRaw.length > 0) {
    const normalised = [];
    for (const binding of accessBindingsRaw) {
      if (!binding || typeof binding !== 'object') continue;
      const subject = typeof binding.subject === 'string' ? binding.subject.trim() : '';
      if (!subject) continue;
      const roles = Array.isArray(binding.roles)
        ? binding.roles.map((role) => String(role).trim()).filter(Boolean)
        : [];
      if (roles.length === 0) continue;
      const clientIds = Array.isArray(binding.clientIds)
        ? binding.clientIds.map((id) => String(id).trim()).filter(Boolean)
        : [];
      normalised.push({ subject, roles, clientIds });
    }
    if (normalised.length > 0) {
      statements.push(upsertSetting('access_bindings', JSON.stringify(normalised)));
    }
  }

  return statements;
}

async function runWrangler(database, sqlFile) {
  return new Promise((resolve, reject) => {
    const proc = spawn('wrangler', ['d1', 'execute', database, '--file', sqlFile], { stdio: 'inherit' });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler d1 execute exited with code ${code}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.database) {
    usage();
    throw new Error('Missing required --database');
  }

  const config = await readConfig(args.configPath);
  const statements = buildStatements(config, args.overrides);
  if (statements.length === 0) {
    console.log('Nothing to seed – provide values via --config or CLI overrides.');
    return;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'greenbro-seed-'));
  const sqlFile = path.join(tmpDir, 'seed.sql');
  await fs.writeFile(sqlFile, statements.join('\n\n') + '\n');

  console.log('Applying seed data via wrangler d1 execute...');
  await runWrangler(args.database, sqlFile);
  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log('Seed data applied successfully.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
