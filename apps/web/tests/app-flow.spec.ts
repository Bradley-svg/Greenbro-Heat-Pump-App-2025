import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { primeOpsSession, primeSession } from './utils/auth';

type DeployMeta = { color: 'green' | 'blue'; msg?: string } | null;

type CommissioningConfig = {
  checklists: Array<{ checklist_id: string; name: string; version: number; steps_json: string; required_steps_json?: string | null }>;
  sessions: Array<{ session_id: string; device_id: string; site_id: string | null; status: string; started_at: string; finished_at: string | null; notes: string | null; last_update: string | null; checklist_id: string | null }>;
  sessionDetails: Record<string, {
    session: { session_id: string; device_id: string; site_id: string | null; status: string; started_at: string; finished_at: string | null; notes: string | null; last_update: string | null; checklist_id: string | null } | null;
    steps: Array<{ step_id: string; title: string; state: 'pending' | 'pass' | 'fail' | 'skip'; readings?: Record<string, unknown> | null; comment: string | null; updated_at: string }>;
    artifacts: Record<string, { r2_key: string; size_bytes: number | null; created_at: string } | undefined>;
  }>;
  settings: { delta_t_min: number; flow_min_lpm: number; cop_min: number };
  finalise: { ok: boolean };
};

type ArchiveConfig = {
  logs: Array<{ table: string; rows: number; key: string; size: number; exportedAt: string | null }>;
  presets: Array<{ id: string; name: string; columns: string[] }>;
};

type OverviewConfig = {
  kpis: Record<string, number>;
  burnSeries: number[];
  spark: { cop: number[]; delta_t: number[] };
  sites: Array<Record<string, unknown>>;
};

type OpsConfig = {
  slo: Record<string, unknown>;
  burnWindow: number[];
  burnPoints: Array<{ ts: string; burn: number; errRate?: number }>;
  deviationCounters: Record<'delta_t' | 'cop' | 'current', { warning: number; critical: number }>;
  deviationHotlist: Array<Record<string, unknown>>;
};

type DevicesConfig = {
  searchResults: { results: Array<Record<string, unknown>>; total: number; limit: number; offset: number; has_more: boolean };
  list: Array<Record<string, unknown>>;
  regions: Array<{ region: string; sites: number }>;
  siteList: Array<{ site_id: string; name?: string | null; region?: string | null }>;
};

type ApiFixtures = {
  readOnly: { flag: boolean; canToggle: boolean };
  readiness: DeployMeta;
  version: { build_sha: string; build_date?: string; schema_ok?: boolean } | null;
  overview: OverviewConfig;
  commissioning: CommissioningConfig;
  archive: ArchiveConfig;
  ops: OpsConfig;
  devices: DevicesConfig;
};

type ApiOverrides = Partial<{ [K in keyof ApiFixtures]: Partial<ApiFixtures[K]> }>; // loose merge

const defaultSessionId = 'COMM-123';

const defaultFixtures: ApiFixtures = {
  readOnly: { flag: false, canToggle: true },
  readiness: { color: 'green', msg: 'All systems go' },
  version: { build_sha: 'abcdef1', build_date: '2024-01-02', schema_ok: true },
  overview: {
    kpis: { online_pct: 0.99, avg_cop: 3.2, low_delta_count: 3, heartbeat_fresh_min: 4 },
    burnSeries: [0.8, 1.1, 0.9],
    spark: { cop: [2.5, 2.6, 2.7], delta_t: [8.1, 8.4, 8.0] },
    sites: [
      {
        site_id: 'SITE-9',
        name: 'Site Nine',
        region: 'Western Cape',
        lat: -33.92,
        lon: 18.42,
        online_devices: 4,
        offline_devices: 0,
        open_alerts: 2,
        freshness_min: 5,
      },
    ],
  },
  commissioning: {
    checklists: [
      {
        checklist_id: 'CHK-1',
        name: 'Standard',
        version: 1,
        steps_json: JSON.stringify([
          { id: 'deltaT_under_load', title: 'ΔT under load' },
          { id: 'flow_detected', title: 'Flow detected' },
        ]),
        required_steps_json: JSON.stringify(['deltaT_under_load']),
      },
    ],
    sessions: [
      {
        session_id: defaultSessionId,
        device_id: 'HP-500',
        site_id: 'SITE-9',
        status: 'in_progress',
        started_at: '2024-01-01T09:00:00Z',
        finished_at: null,
        notes: null,
        last_update: '2024-01-01T09:30:00Z',
        checklist_id: 'CHK-1',
      },
    ],
    sessionDetails: {
      [defaultSessionId]: {
        session: {
          session_id: defaultSessionId,
          device_id: 'HP-500',
          site_id: 'SITE-9',
          status: 'in_progress',
          started_at: '2024-01-01T09:00:00Z',
          finished_at: null,
          notes: null,
          last_update: '2024-01-01T09:30:00Z',
          checklist_id: 'CHK-1',
        },
        steps: [
          {
            step_id: 'deltaT_under_load',
            title: 'ΔT under load',
            state: 'pending',
            readings: null,
            comment: null,
            updated_at: '2024-01-01T09:15:00Z',
          },
          {
            step_id: 'flow_detected',
            title: 'Flow detected',
            state: 'pass',
            readings: { flow: 0.7 },
            comment: 'Flow confirmed',
            updated_at: '2024-01-01T09:20:00Z',
          },
        ],
        artifacts: {
          pdf: { r2_key: 'commissioning/HP-500/report.pdf', size_bytes: 1024, created_at: '2024-01-01T09:50:00Z' },
        },
      },
    },
    settings: { delta_t_min: 6, flow_min_lpm: 20, cop_min: 2.8 },
    finalise: { ok: true },
  },
  archive: {
    logs: [
      {
        table: 'telemetry',
        rows: 1800,
        key: 'archive/telemetry-2024-01-01.ndjson',
        size: 2_048_000,
        exportedAt: '2024-01-01T01:00:00Z',
      },
    ],
    presets: [
      { id: 'minimal', name: 'Minimal', columns: ['ts', 'device_id', 'cop'] },
      { id: 'diagnostics', name: 'Diagnostics', columns: ['ts', 'device_id', 'metrics_json'] },
    ],
  },
  ops: {
    slo: {
      ingest_success_pct: 0.998,
      heartbeat_freshness_pct: 0.985,
      p95_ingest_latency_ms: 240,
      burn: 0.9,
      baselineDeviation: { warning: 1, critical: 0 },
      window: '24h',
    },
    burnWindow: [0.9, 1.05, 0.98],
    burnPoints: [
      { ts: '2024-01-01T09:00:00Z', burn: 0.9, errRate: 0.01 },
      { ts: '2024-01-01T09:05:00Z', burn: 1.2, errRate: 0.015 },
    ],
    deviationCounters: {
      delta_t: { warning: 1, critical: 0 },
      cop: { warning: 0, critical: 0 },
      current: { warning: 0, critical: 0 },
    },
    deviationHotlist: [
      {
        device_id: 'HP-500',
        kind: 'delta_t',
        any_crit: 1,
        since: '2024-01-01T08:30:00Z',
        coverage: 0.78,
        drift: 2.4,
        site_id: 'SITE-9',
        site_name: 'Site Nine',
        region: 'Western Cape',
      },
    ],
  },
  devices: {
    searchResults: {
      results: [
        {
          device_id: 'HP-500',
          site_id: 'SITE-9',
          site_name: 'Site Nine',
          region: 'Western Cape',
          online: 1,
          last_seen_at: '2024-01-01T09:30:00Z',
          open_alerts: 0,
        },
      ],
      total: 1,
      limit: 1,
      offset: 0,
      has_more: false,
    },
    list: [
      {
        device_id: 'HP-500',
        site_id: 'SITE-9',
        site_name: 'Site Nine',
        region: 'Western Cape',
        online: 1,
        last_seen_at: '2024-01-01T09:30:00Z',
        open_alerts: 0,
      },
    ],
    regions: [
      { region: 'Western Cape', sites: 3 },
      { region: 'Gauteng', sites: 2 },
    ],
    siteList: [{ site_id: 'SITE-9', name: 'Site Nine', region: 'Western Cape' }],
  },
};

async function primeAppApi(page: Page, overrides: ApiOverrides = {}) {
  const commissioningOverrides = overrides.commissioning as Partial<CommissioningConfig> | undefined;
  const opsOverrides = overrides.ops as Partial<OpsConfig> | undefined;
  const devicesOverrides = overrides.devices as Partial<DevicesConfig> | undefined;
  const overviewOverrides = overrides.overview as Partial<OverviewConfig> | undefined;
  const config: ApiFixtures = {
    readOnly: { ...defaultFixtures.readOnly, ...(overrides.readOnly ?? {}) },
    readiness: (overrides.readiness as DeployMeta | undefined) ?? defaultFixtures.readiness,
    version: (overrides.version as ApiFixtures['version'] | undefined) ?? defaultFixtures.version,
    overview: {
      ...defaultFixtures.overview,
      ...(overviewOverrides ?? {}),
      spark: {
        ...defaultFixtures.overview.spark,
        ...(overviewOverrides?.spark ?? {}),
      },
    },
    commissioning: {
      ...defaultFixtures.commissioning,
      ...(commissioningOverrides ?? {}),
      sessionDetails: {
        ...defaultFixtures.commissioning.sessionDetails,
        ...(commissioningOverrides?.sessionDetails ?? {}),
      },
    },
    archive: {
      ...defaultFixtures.archive,
      ...(overrides.archive ?? {}),
    },
    ops: {
      ...defaultFixtures.ops,
      ...(opsOverrides ?? {}),
      deviationCounters: {
        ...defaultFixtures.ops.deviationCounters,
        ...(opsOverrides?.deviationCounters ?? {}),
      },
      deviationHotlist: opsOverrides?.deviationHotlist ?? defaultFixtures.ops.deviationHotlist,
    },
    devices: {
      ...defaultFixtures.devices,
      ...(devicesOverrides ?? {}),
    },
  };

  const finaliseCalls: Array<Record<string, unknown>> = [];

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/auth/')) {
      await route.fallback();
      return;
    }
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 200, body: '' });
      return;
    }

    if (url.pathname === '/api/settings/public') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ read_only: config.readOnly.flag }),
      });
      return;
    }
    if (url.pathname === '/api/admin/settings') {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: config.readOnly.canToggle ? 200 : 403, contentType: 'application/json', body: '{}' });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      return;
    }
    if (url.pathname === '/api/ops/readiness') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deploy: config.readiness }),
      });
      return;
    }
    if (url.pathname === '/api/ops/version') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(config.version),
      });
      return;
    }
    if (url.pathname === '/api/overview/kpis') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config.overview.kpis) });
      return;
    }
    if (url.pathname === '/api/ops/burn-series' && url.searchParams.get('window') === '10m') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ series: config.ops.burnWindow }),
      });
      return;
    }
    if (url.pathname === '/api/ops/burn-series' && url.searchParams.get('minutes') === '10') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(config.ops.burnPoints),
      });
      return;
    }
    if (url.pathname === '/api/overview/sparklines') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config.overview.spark) });
      return;
    }
    if (url.pathname === '/api/sites/search') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: config.overview.sites }),
      });
      return;
    }
    if (url.pathname === '/api/ops/slo') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config.ops.slo) });
      return;
    }
    if (url.pathname === '/api/ops/deviation-counters') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config.ops.deviationCounters) });
      return;
    }
    if (url.pathname === '/api/ops/deviation-hotlist') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config.ops.deviationHotlist) });
      return;
    }
    if (url.pathname === '/api/commissioning/checklists') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config.commissioning.checklists) });
      return;
    }
    if (url.pathname === '/api/commissioning/sessions') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config.commissioning.sessions) });
      return;
    }
    if (url.pathname.startsWith('/api/commissioning/session/')) {
      const id = url.pathname.split('/').pop() ?? '';
      const detail = config.commissioning.sessionDetails[id] ?? { session: null, steps: [], artifacts: {} };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) });
      return;
    }
    if (url.pathname === '/api/commissioning/settings') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config.commissioning.settings) });
      return;
    }
    if (url.pathname === '/api/commissioning/finalise') {
      const payload = JSON.parse(route.request().postData() ?? '{}');
      finaliseCalls.push(payload);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config.commissioning.finalise) });
      return;
    }
    if (url.pathname === '/api/commissioning/step' || url.pathname === '/api/commissioning/measure-now' || url.pathname === '/api/commissioning/measure-window' || url.pathname === '/api/commissioning/start' || url.pathname === '/api/commissioning/labels' || url.pathname === '/api/commissioning/provisioning-zip' || url.pathname === '/api/commissioning/email-bundle') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    if (url.pathname === '/api/admin/archive') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ date: url.searchParams.get('date') ?? '2024-01-01', results: config.archive.logs }),
      });
      return;
    }
    if (url.pathname === '/api/admin/archive/presets') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ presets: config.archive.presets }) });
      return;
    }
    if (url.pathname === '/api/devices/search') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config.devices.searchResults) });
      return;
    }
    if (url.pathname === '/api/devices') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config.devices.list) });
      return;
    }
    if (url.pathname === '/api/regions') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ regions: config.devices.regions }) });
      return;
    }
    if (url.pathname === '/api/site-list') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sites: config.devices.siteList }) });
      return;
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });

  return { finaliseCalls };
}

test.describe('App flows', () => {
  test('primary navigation renders and navigates between core sections', async ({ page, baseURL }) => {
    await primeOpsSession(page);
    await primeAppApi(page);

    await page.goto(new URL('/overview', baseURL!).toString());
    const navLinks = page.locator('.app-nav__link');
    await expect(navLinks).toHaveCount(7);

    await page.getByRole('link', { name: 'Devices' }).click();
    await expect(page).toHaveURL(/\/devices$/);
    await expect(page.getByRole('heading', { name: 'Devices' })).toBeVisible();

    await page.getByRole('link', { name: 'Ops' }).click();
    await expect(page).toHaveURL(/\/ops$/);
    await expect(page.getByRole('heading', { name: 'Ops — Reliability' })).toBeVisible();
  });

  test('users without privileged roles are redirected to the unauthorized view', async ({ page, baseURL }) => {
    await primeSession(page, { roles: ['client'] });
    await primeAppApi(page);

    await page.goto(new URL('/admin', baseURL!).toString());
    await expect(page).toHaveURL(/\/unauthorized$/);
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  });

  test('commissioning session can be finalised from the detail view', async ({ page, baseURL }) => {
    await primeOpsSession(page);
    const { finaliseCalls } = await primeAppApi(page);

    await page.goto(new URL('/commissioning', baseURL!).toString());
    await expect(page.getByRole('heading', { name: 'Commissioning' })).toBeVisible();
    // Check the device ID in the session list
    await expect(page.getByRole('button', { name: /HP-500.*/ })).toBeVisible();

    const reqPromise = page.waitForRequest('**/api/commissioning/finalise');
    await page.getByRole('button', { name: 'Finalise – Passed' }).click();
    const request = await reqPromise;
    const payload = JSON.parse(request.postData() ?? '{}');
    expect(payload.session_id).toBe(defaultSessionId);
    expect(payload.outcome).toBe('passed');
    expect(finaliseCalls.length).toBeGreaterThan(0);
  });

  test('archive downloads expose signed R2 links', async ({ page, baseURL }) => {
    await primeOpsSession(page);
    await primeAppApi(page);

    await page.goto(new URL('/admin/archive', baseURL!).toString());
    const downloadLink = page.getByRole('link', { name: 'Download' }).first();
    await expect(downloadLink).toHaveAttribute(
      'href',
      /api\/admin\/archive\/export\?table=telemetry.*format=ndjson.*gz=1.*gzl=6/,
    );
  });

  test('archive builder toggles staging and column presets', async ({ page, baseURL }) => {
    await primeOpsSession(page);
    await primeAppApi(page);

    await page.goto(new URL('/admin/archive', baseURL!).toString());
    const ndjsonLink = page.getByRole('link', { name: 'Download NDJSON' });

    await page.getByLabel('Stage (Content-Length)').check();
    await expect(ndjsonLink).toHaveAttribute('href', /stage=1/);

    const timestampCheckbox = page.getByLabel('Timestamp');
    await timestampCheckbox.uncheck();
    await expect(page.getByText(/10 of \d+ selected/)).toBeVisible();

    await page.getByRole('button', { name: 'Select all' }).click();
    await expect(page.getByText(/11 of \d+ selected/)).toBeVisible();
  });
});
