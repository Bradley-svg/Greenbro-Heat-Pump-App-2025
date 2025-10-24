#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse as parseToml } from '@iarna/toml';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WRANGLER_PATH = path.join(ROOT, 'wrangler.toml');
const ENV_TYPES_PATH = path.join(ROOT, 'src/types/env.ts');

function normaliseInlineTables(source) {
  return source.replace(/=\s*\{\s*\n([^}]+)\n\s*\}/g, (_, body) => {
    const entries = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/,+$/, ''));
    const inline = entries.join(', ');
    return `= { ${inline} }`;
  });
}

function readToml(file) {
  try {
    const source = fs.readFileSync(file, 'utf8');
    const normalised = normaliseInlineTables(source);
    return parseToml(normalised);
  } catch (error) {
    console.error(`\n✖ Failed to read ${path.relative(ROOT, file)}:`, error.message);
    process.exitCode = 1;
    throw error;
  }
}

function parseEnvContract(file) {
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);
  const entries = [];
  let section = 'Uncategorised';

  const propertyPattern = /^\s{2}([A-Za-z0-9_]+)\??:\s*([A-Za-z0-9_<>]+)/;
  const sectionPattern = /^\s*\/\/\s*(.+)$/;

  for (const line of lines) {
    const sectionMatch = line.match(sectionPattern);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }

    const propertyMatch = line.match(propertyPattern);
    if (!propertyMatch) continue;

    const [, name, typeWithGeneric] = propertyMatch;
    const baseType = typeWithGeneric.split('<')[0];
    const optional = line.includes('?:');

    entries.push({
      name,
      section,
      optional,
      type: baseType,
    });
  }

  return entries;
}

const BINDING_SECTIONS = {
  D1Database: 'd1_databases',
  R2Bucket: 'r2_buckets',
  KVNamespace: 'kv_namespaces',
  DurableObjectNamespace: 'durable_objects',
  Queue: 'queues',
};

const SECTION_LOOKUP_KEY = {
  d1_databases: 'binding',
  r2_buckets: 'binding',
  kv_namespaces: 'binding',
  durable_objects: 'name',
};

function collectExpectations(envEntries) {
  const expectations = {
    bindings: {
      d1_databases: new Map(),
      r2_buckets: new Map(),
      kv_namespaces: new Map(),
      durable_objects: new Map(),
      queues: new Map(),
    },
    config: {
      required: [],
      optional: [],
    },
  };

  for (const entry of envEntries) {
    if (BINDING_SECTIONS[entry.type]) {
      const section = BINDING_SECTIONS[entry.type];
      expectations.bindings[section].set(entry.name, entry);
      continue;
    }

    if (entry.type === 'string') {
      const bucket = entry.optional ? expectations.config.optional : expectations.config.required;
      bucket.push(entry.name);
    }
  }

  return expectations;
}

function flattenBindings(config) {
  return {
    d1_databases: config?.d1_databases ?? [],
    r2_buckets: config?.r2_buckets ?? [],
    kv_namespaces: config?.kv_namespaces ?? [],
    durable_objects: config?.durable_objects?.bindings ?? config?.durable_objects ?? [],
    queues: config?.queues ?? {},
  };
}

function checkDefaultBindings(expectations, wranglerConfig) {
  const results = [];
  const configBindings = flattenBindings(wranglerConfig);

  for (const [section, expectedBindings] of Object.entries(expectations.bindings)) {
    if (section === 'queues') continue;

    for (const name of expectedBindings.keys()) {
      const entries = configBindings[section];
      const key = SECTION_LOOKUP_KEY[section] ?? 'binding';
      const found = entries.some((item) => item?.[key] === name);
      results.push({
        scope: 'default',
        section,
        name,
        status: found ? 'ok' : 'missing',
        details: found ? undefined : `Add a ${section} binding for ${name}`,
      });
    }
  }

  // Queue producers and consumers
  const queueBindings = expectations.bindings.queues;
  for (const [bindingName] of queueBindings) {
    const producers = configBindings.queues?.producers ?? [];
    const consumers = configBindings.queues?.consumers ?? [];
    const producer = producers.find((entry) => entry.binding === bindingName);
    const queueName = producer?.queue;
    const hasProducer = Boolean(producer);
    const hasConsumer = queueName && consumers.some((entry) => entry.queue === queueName);

    results.push({
      scope: 'default',
      section: 'queues.producers',
      name: bindingName,
      status: hasProducer ? 'ok' : 'missing',
      details: hasProducer ? undefined : `Define a producer queue binding for ${bindingName}`,
    });

    results.push({
      scope: 'default',
      section: 'queues.consumers',
      name: queueName ?? '(unknown queue)',
      status: hasConsumer ? 'ok' : 'missing',
      details: hasConsumer ? undefined : `Add a consumer entry for queue ${queueName ?? bindingName}`,
    });
  }

  return results;
}

function checkEnvironmentOverrides(expectations, wranglerConfig) {
  if (!wranglerConfig.env) return [];

  const results = [];
  for (const [envName, envConfig] of Object.entries(wranglerConfig.env)) {
    const flattened = flattenBindings(envConfig);

    for (const [section, expectedBindings] of Object.entries(expectations.bindings)) {
      if (section === 'queues') continue; // queues are global
      for (const name of expectedBindings.keys()) {
        const overrides = flattened[section];
        if (!Array.isArray(overrides) || overrides.length === 0) {
          results.push({
            scope: envName,
            section,
            name,
            status: 'warn',
            details: `No ${section} overrides found for ${name}; defaults will be reused`,
          });
          continue;
        }
        const key = SECTION_LOOKUP_KEY[section] ?? 'binding';
        const exists = overrides.some((entry) => entry?.[key] === name);
        results.push({
          scope: envName,
          section,
          name,
          status: exists ? 'ok' : 'missing',
          details: exists
            ? undefined
            : `Add ${section} override for ${name} under [env.${envName}]`,
        });
      }
    }
  }

  return results;
}

function formatResult(result) {
  const icons = { ok: '✓', missing: '✖', warn: '⚠' };
  const icon = icons[result.status] ?? '•';
  const scopeLabel = result.scope === 'default' ? 'default config' : `env.${result.scope}`;
  const sectionLabel = result.section;
  const detail = result.details ? ` — ${result.details}` : '';
  return `${icon} [${scopeLabel}] ${sectionLabel}: ${result.name}${detail}`;
}

function reportConfig(expectations, wranglerConfig) {
  const lines = [];
  lines.push('Cloudflare Worker configuration checklist\n');

  const bindingChecks = [
    ...checkDefaultBindings(expectations, wranglerConfig),
    ...checkEnvironmentOverrides(expectations, wranglerConfig),
  ];

  const missingBinding = bindingChecks.some((item) => item.status === 'missing');

  lines.push('Bindings:');
  for (const result of bindingChecks) {
    lines.push(`  ${formatResult(result)}`);
  }
  lines.push('');

  lines.push('Secrets & Vars:');
  for (const name of expectations.config.required) {
    lines.push(`  • ${name} (required secret)`);
  }
  for (const name of expectations.config.optional) {
    lines.push(`  • ${name} (optional)`);
  }
  lines.push('');

  lines.push('Tip: load secrets with `wrangler secret put <NAME>` for each environment.');

  console.log(lines.join('\n'));

  if (missingBinding) {
    console.error('\nOne or more required bindings are missing.');
    process.exitCode = 1;
  }
}

const wranglerConfig = readToml(WRANGLER_PATH);
const envEntries = parseEnvContract(ENV_TYPES_PATH);
const expectations = collectExpectations(envEntries);
reportConfig(expectations, wranglerConfig);
