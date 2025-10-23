
/** @jsxImportSource hono/jsx */
/** @jsxRuntime automatic */
import { jsxRenderer, useRequestContext } from 'hono/jsx-renderer';

export type OverviewData = {
  kpis: { onlinePct: number; openAlerts: number; avgCop: number | null };
  sites: Array<{
    siteId: string;
    name?: string | null;
    region?: string | null;
    lat?: number | null;
    lon?: number | null;
    deviceCount: number;
    onlineCount: number;
    openAlerts: number;
    maxSeverity: 'critical' | 'major' | 'minor' | null;
    status: 'critical' | 'major' | 'ok' | 'empty';
  }>;
  series: {
    deltaT: Array<{ ts: string; value: number | null }>;
    cop: Array<{ ts: string; value: number | null }>;
  };
};

export type OpsSnapshot = {
  generatedAt: string;
  ingest: {
    total: { total: number; success: number; successPct: number; error: number };
    window1k: { total: number; success: number; successPct: number; error: number };
    burnRate: number;
  };
  heartbeat: { total: number; online: number; onlinePct: number };
  canary?: { lastAt: string | null; minutesSince: number | null; status: 'ok' | 'warn' | 'crit' };
};

export type ReportHistoryRow = {
  delivery_id: string;
  type: string;
  client_id: string | null;
  site_id: string | null;
  path: string | null;
  subject: string | null;
  status: string;
  recipients: string[];
  meta: Record<string, unknown> | null;
  created_at: string;
};

export type ReportHistoryFilters = {
  clientId: string;
  siteId: string;
  type: string;
  status: string;
  limit: string;
};

export type AdminArchiveRow = {
  table: string;
  rows: number;
  key: string;
  size: number;
  exportedAt: string | null;
};

export type ClientSloSummary = {
  clientId: string;
  clientName: string;
  month: { key: string; label: string; start: string; end: string; effectiveEnd: string };
  siteCount: number;
  deviceCount: number;
  metrics: {
    uptimePct: number | null;
    ingestSuccessPct: number | null;
    avgCop: number | null;
    alerts: Array<{ type: string; severity: string; count: number }>;
    alertsBySeverity: Record<string, number>;
  };
  targets: {
    uptimeTarget: number | null;
    ingestTarget: number | null;
    copTarget: number | null;
  };
  recipients: string | null;
  copSparkline: Array<{ ts: string; value: number | null }>;
  heartbeatFreshnessMinutes: number;
  window: { start: string; end: string };
  updatedAt: string;
};

const readOnlySnippet = `
if(!window.__roPoller){
  window.__roPoller = true;
  async function _ro(){ try{ const s=await (await fetch('/api/settings/public')).json();
    document.body.toggleAttribute('data-ro', !!s.read_only);
  } catch{} }
  _ro(); setInterval(_ro, 60000);
}
`;

const overviewScript = `
(function(){
  const root = document.getElementById('overview');
  if(!root) return;

  const dataEl = document.getElementById('overview-data');
  const mapSvg = root.querySelector('#devices-map');
  const updatedEl = root.querySelector('[data-updated]');
  const listEl = root.querySelector('#devices-sites');
  const kpiOnline = root.querySelector('[data-kpi="online"]');
  const kpiAlerts = root.querySelector('[data-kpi="alerts"]');
  const kpiCop = root.querySelector('[data-kpi="cop"]');
  const deltaSvg = root.querySelector('#sparkline-delta');
  const copSvg = root.querySelector('#sparkline-cop');
  const deltaValueEl = root.querySelector('[data-sparkline-value="delta"]');
  const deltaRangeEl = root.querySelector('[data-sparkline-range="delta"]');
  const copValueEl = root.querySelector('[data-sparkline-value="cop"]');
  const copRangeEl = root.querySelector('[data-sparkline-range="cop"]');

  const MAP_BOUNDS = { minLon: 16, maxLon: 33, minLat: -35, maxLat: -22 };
  const MAP_WIDTH = 600;
  const MAP_HEIGHT = 360;

  const REGION_CENTROIDS = {
    'Western Cape': { lat: -33.9249, lon: 18.4241 },
    'Gauteng': { lat: -26.2041, lon: 28.0473 },
    'KZN': { lat: -29.8587, lon: 31.0218 },
    'KwaZulu-Natal': { lat: -29.8587, lon: 31.0218 },
    'Eastern Cape': { lat: -33.0487, lon: 27.8555 },
    'Free State': { lat: -28.4541, lon: 26.7968 },
    'Mpumalanga': { lat: -25.5653, lon: 30.5277 },
    'Limpopo': { lat: -23.4018, lon: 29.4179 },
    'North West': { lat: -26.6639, lon: 25.2838 },
    'Northern Cape': { lat: -29.0467, lon: 21.8569 },
  };

  const STATUS_COLOR = {
    critical: '#f85149',
    major: '#f0883e',
    ok: '#3fb950',
    empty: '#3d4b63'
  };

  function esc(str){
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function project(lat, lon){
    const x = ((lon - MAP_BOUNDS.minLon) / (MAP_BOUNDS.maxLon - MAP_BOUNDS.minLon)) * MAP_WIDTH;
    const y = ((MAP_BOUNDS.maxLat - lat) / (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat)) * MAP_HEIGHT;
    return {
      x: Math.min(MAP_WIDTH, Math.max(0, x)),
      y: Math.min(MAP_HEIGHT, Math.max(0, y))
    };
  }

  function formatNumber(value, digits){
    if(value == null || Number.isNaN(value)) return '—';
    return Number(value).toFixed(digits);
  }

  function renderKpis(kpis){
    if(kpiOnline) kpiOnline.textContent = formatNumber(kpis.onlinePct, 1) + '%';
    if(kpiAlerts) kpiAlerts.textContent = String(kpis.openAlerts ?? 0);
    if(kpiCop) kpiCop.textContent = kpis.avgCop == null ? '—' : formatNumber(kpis.avgCop, 2);
  }

  function renderMap(sites){
    if(!mapSvg) return;
    const grid = [];
    const segments = 6;
    for(let i=1;i<segments;i++){
      const x = (MAP_WIDTH / segments) * i;
      grid.push('<line x1="' + x.toFixed(1) + '" y1="0" x2="' + x.toFixed(1) + '" y2="' + MAP_HEIGHT + '" stroke="#1e2632" stroke-dasharray="4 8" />');
    }
    for(let j=1;j<4;j++){
      const y = (MAP_HEIGHT / 4) * j;
      grid.push('<line x1="0" y1="' + y.toFixed(1) + '" x2="' + MAP_WIDTH + '" y2="' + y.toFixed(1) + '" stroke="#1e2632" stroke-dasharray="4 8" />');
    }

    const markers = [];
    const listItems = [];
    sites.forEach(function(site){
      let lat = site.lat;
      let lon = site.lon;
      if((lat == null || lon == null) && site.region && REGION_CENTROIDS[site.region]){
        lat = REGION_CENTROIDS[site.region].lat;
        lon = REGION_CENTROIDS[site.region].lon;
      }
      const color = STATUS_COLOR[site.status] || STATUS_COLOR.ok;
      if(lat != null && lon != null){
        const pos = project(lat, lon);
        const size = site.deviceCount > 0 ? Math.min(16, 6 + site.deviceCount) : 8;
        markers.push(
          '<g class="marker">' +
            '<circle cx="' + pos.x.toFixed(1) + '" cy="' + pos.y.toFixed(1) + '" r="' + (size / 2).toFixed(1) + '" fill="' + color + '" stroke="#0b0e12" stroke-width="2" />' +
            '<title>' + esc(site.name || site.siteId) + '\nDevices: ' + site.deviceCount + '\nOnline: ' + site.onlineCount + '\nOpen alerts: ' + site.openAlerts + '</title>' +
          '</g>'
        );
      }
      listItems.push(
        '<li>' +
          '<span class="dot" style="background:' + color + '"></span>' +
          '<span class="name">' + esc(site.name || site.siteId) + '</span>' +
          '<span class="meta">' + site.onlineCount + '/' + site.deviceCount + ' online · ' + site.openAlerts + ' alerts</span>' +
        '</li>'
      );
    });

    mapSvg.innerHTML = [
      '<rect x="0" y="0" width="' + MAP_WIDTH + '" height="' + MAP_HEIGHT + '" rx="14" ry="14" fill="#0b1119" stroke="#1e2632" />',
      grid.join(''),
      markers.join('')
    ].join('');

    if(listEl){
      listEl.innerHTML = listItems.length > 0 ? listItems.join('') : '<li class="empty">No sites to display</li>';
    }
  }

  function renderSparkline(svg, valueEl, rangeEl, series, opts){
    if(!svg) return;
    const width = opts && opts.width || 320;
    const height = opts && opts.height || 80;
    const values = series.map(function(p){ return typeof p.value === 'number' ? p.value : null; }).filter(function(v){ return v != null; });
    if(values.length === 0){
      svg.innerHTML = '';
      if(valueEl) valueEl.textContent = '—';
      if(rangeEl) rangeEl.textContent = '';
      return;
    }
    let min = Math.min.apply(null, values);
    let max = Math.max.apply(null, values);
    if(opts && typeof opts.baseline === 'number'){
      min = Math.min(min, opts.baseline);
    }
    if(max === min){
      max = min + 1;
    }
    const span = max - min;
    let path = '';
    let started = false;
    const count = series.length;
    series.forEach(function(point, idx){
      const value = typeof point.value === 'number' ? point.value : null;
      const x = count <= 1 ? width : (idx / (count - 1)) * width;
      if(value == null){
        started = false;
        return;
      }
      const y = height - ((value - min) / span) * height;
      if(!started){
        path += 'M' + x.toFixed(1) + ',' + y.toFixed(1);
        started = true;
      } else {
        path += ' L' + x.toFixed(1) + ',' + y.toFixed(1);
      }
    });
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.innerHTML = '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="#0b1119" stroke="#1e2632" />' +
      '<path d="' + path + '" fill="none" stroke="#3fb950" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />';

    const last = series.slice().reverse().find(function(p){ return typeof p.value === 'number'; });
    if(valueEl) valueEl.textContent = last ? formatNumber(last.value, opts && opts.precision != null ? opts.precision : 1) : '—';
    if(rangeEl){
      const precision = opts && opts.precision != null ? opts.precision : 1;
      const minText = formatNumber(Math.min.apply(null, values), precision);
      const maxText = formatNumber(Math.max.apply(null, values), precision);
      const rangeText = minText + ' – ' + maxText;
      rangeEl.textContent = opts && opts.suffix ? rangeText + ' ' + opts.suffix : rangeText;
    }
  }

  function render(data){
    if(!data) return;
    renderKpis(data.kpis || { onlinePct: 0, openAlerts: 0, avgCop: null });
    if(updatedEl) updatedEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
    renderMap(Array.isArray(data.sites) ? data.sites : []);
    renderSparkline(deltaSvg, deltaValueEl, deltaRangeEl, (data.series && data.series.deltaT) || [], { width: 320, height: 80, precision: 1, suffix: '\u00b0C' });
    renderSparkline(copSvg, copValueEl, copRangeEl, (data.series && data.series.cop) || [], { width: 320, height: 80, precision: 2, baseline: 0, suffix: 'COP' });
  }

  let initial = null;
  if(dataEl){
    try {
      initial = JSON.parse(dataEl.textContent || '');
    } catch (err) {
      console.warn('overview: failed to parse initial payload', err);
    }
  }
  if(initial) render(initial);

  async function refresh(){
    try {
      const res = await fetch('/api/overview');
      if(!res.ok) return;
      const payload = await res.json();
      render(payload);
    } catch (err) {
      console.warn('overview refresh failed', err);
    }
  }

  setInterval(refresh, 60000);
  refresh();
})();
${readOnlySnippet}
`;

const encodeJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

function latestValue(series: Array<{ value: number | null }>) {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i]?.value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function rangeLabel(series: Array<{ value: number | null }>, digits: number) {
  const values = series
    .map((point) => point.value)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) {
    return '';
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  return `${min.toFixed(digits)} – ${max.toFixed(digits)}`;
}

const alertsScript = `
(function(){
  const form = document.getElementById('alert-filters');
  const tbody = document.getElementById('alerts-tbody');
  async function load(){
    const params = new URLSearchParams(new FormData(form));
    const res = await fetch('/api/alerts?' + params.toString());
    const data = await res.json();
    tbody.innerHTML = data.map(function(a){
      const action = a.state !== 'closed'
        ? '<form method="post" action="/api/alerts/' + a.alert_id + '/ack"><button class="btn" type="submit">Ack</button></form>'
        : '';
      return '<tr>'
        + '<td>' + a.device_id + '</td>'
        + '<td>' + a.type + '</td>'
        + '<td>' + a.severity + '</td>'
        + '<td>' + a.state + '</td>'
        + '<td>' + a.opened_at + '</td>'
        + '<td>' + (a.clients ?? '—') + '</td>'
        + '<td>' + action + '</td>'
        + '</tr>';
    }).join('');
  }
  form.addEventListener('change', function(e){ e.preventDefault(); load(); });
  form.addEventListener('submit', function(e){ e.preventDefault(); load(); });
  load();
  setInterval(load, 15000);
})();
${readOnlySnippet}
`;

const devicesScript = `
  (async function(){
    const form = document.getElementById('device-filters');
    const tbody = document.getElementById('devices-tbody');
    const regionSel = document.getElementById('region-select');
    const clientSel = document.getElementById('client-select');
    const siteInput = document.getElementById('site-filter');
    const incidentBtn = document.getElementById('incident-btn');
    const hoursInput = document.getElementById('incident-hours');
    const defaultIncidentLabel = incidentBtn ? incidentBtn.textContent : '';

    async function load(){
      const params = new URLSearchParams(new FormData(form));
      const res = await fetch('/api/devices?' + params.toString());
      const data = await res.json();
      tbody.innerHTML = data.map(function(r){
        return '<tr>' +
          '<td>' + r.device_id + '</td>' +
          '<td>' + (r.site_name ?? r.site_id) + '</td>' +
          '<td>' + (r.region ?? '—') + '</td>' +
          '<td>' + (r.clients ?? '—') + '</td>' +
          '<td>' + (r.online ? 'Yes' : 'No') + '</td>' +
          '<td>' + (r.last_seen_at ?? '—') + '</td>' +
        '</tr>';
      }).join('');
    }

    async function loadOptions(){
      try {
        const [rRes, cRes] = await Promise.all([
          fetch('/api/admin/distinct/regions'),
          fetch('/api/admin/distinct/clients')
        ]);
        if (rRes.ok) {
          const regions = await rRes.json();
          regionSel.innerHTML = '<option value="">All</option>' +
            regions.map(function(r){ return '<option value="' + r.region + '">' + r.region + '</option>'; }).join('');
        }
        if (cRes.ok) {
          const clients = await cRes.json();
          clientSel.innerHTML = '<option value="">All</option>' +
            clients.map(function(c){ return '<option value="' + c.client_id + '">' + (c.name ?? c.client_id) + '</option>'; }).join('');
        }
      } catch { /* non-admin users may 403: ignore and keep empty dropdowns */ }
    }

    form.addEventListener('change', function(e){ e.preventDefault(); load(); });
    form.addEventListener('submit', function(e){ e.preventDefault(); load(); });

    function syncIncidentButton(){
      if (!incidentBtn) return;
      const hasSite = siteInput && siteInput.value.trim().length > 0;
      incidentBtn.disabled = !hasSite;
    }

    if (siteInput) {
      siteInput.addEventListener('input', function(){
        syncIncidentButton();
      });
    }

    if (hoursInput) {
      hoursInput.addEventListener('change', function(){
        const value = Number(hoursInput.value);
        if (!Number.isFinite(value) || value <= 0) {
          hoursInput.value = '24';
        }
      });
    }

    if (incidentBtn && siteInput) {
      incidentBtn.addEventListener('click', async function(){
        const siteId = siteInput.value.trim();
        if (!siteId) {
          syncIncidentButton();
          return;
        }

        let hours = 24;
        if (hoursInput && hoursInput.value) {
          const parsed = Number(hoursInput.value);
          if (Number.isFinite(parsed) && parsed > 0) {
            hours = parsed;
          }
        }

        incidentBtn.disabled = true;
        incidentBtn.textContent = 'Generating…';
        try {
          const params = new URLSearchParams({ siteId: siteId });
          if (Number.isFinite(hours) && hours > 0) {
            params.set('hours', String(Math.round(hours)));
          }
          const res = await fetch('/api/reports/incident?' + params.toString(), { method: 'POST' });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(text || 'Request failed');
          }
          const data = await res.json();
          const target = data.path || data.url || ('/api/reports/' + data.key);
          window.open(target, '_blank', 'noopener');
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          alert('Failed to generate incident report: ' + message);
        } finally {
          incidentBtn.textContent = defaultIncidentLabel || 'Generate Incident PDF';
          syncIncidentButton();
        }
      });
      syncIncidentButton();
    }

    await loadOptions();
    await load();
    setInterval(load, 15000);
  })();
${readOnlySnippet}
`;

const readOnlyScript = readOnlySnippet;

const opsScript = `
(function(){
  const root = document.getElementById('ops-slo');
  if(!root) return;
  const dataEl = document.getElementById('ops-slo-data');
  const fields = {
    burn: root.querySelector('[data-field="burn-rate"]'),
    burnStatus: root.querySelector('[data-field="burn-status"]'),
    totalSuccess: root.querySelector('[data-field="ingest-total-success"]'),
    totalCount: root.querySelector('[data-field="ingest-total-count"]'),
    recentSuccess: root.querySelector('[data-field="ingest-recent-success"]'),
    recentCount: root.querySelector('[data-field="ingest-recent-count"]'),
    heartbeatPct: root.querySelector('[data-field="heartbeat-pct"]'),
    heartbeatCount: root.querySelector('[data-field="heartbeat-count"]'),
    generatedAt: root.querySelector('[data-field="generated-at"]'),
    canary: root.querySelector('[data-field="canary"]')
  };
  const incidentBody = document.getElementById('ops-incidents');

  function pct(value, digits){
    if(typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return value.toFixed(digits);
  }

  function fmt(value){
    if(typeof value !== 'number' || !Number.isFinite(value)) return '0';
    return value.toLocaleString();
  }

  function esc(value){
    return String(value ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function renderCanary(data){
    const el = fields.canary;
    if(!el) return;
    if(!data){
      el.textContent = 'Canary Crit · —';
      el.dataset.state = 'crit';
      return;
    }
    let status = data.status === 'ok' || data.status === 'warn' ? data.status : data.status === 'crit' ? 'crit' : 'crit';
    const minutesRaw = Number(data.minutesSince);
    const hasMinutes = Number.isFinite(minutesRaw);
    const minutes = hasMinutes ? Math.max(0, Math.round(minutesRaw)) : null;
    if(status !== 'ok' && status !== 'warn' && status !== 'crit'){
      status = 'crit';
    }
    const label = status === 'ok' ? 'Canary OK' : status === 'warn' ? 'Canary Warn' : 'Canary Crit';
    el.textContent = label + ' · ' + (minutes != null ? minutes + 'm' : '—');
    el.dataset.state = status;
  }

  function render(data){
    if(!data || !data.ingest || !data.heartbeat) return;
    const burnRate = Number(data.ingest.burnRate ?? 0);
    if(fields.burn) fields.burn.textContent = '×' + burnRate.toFixed(2);
    if(fields.burnStatus){
      fields.burnStatus.textContent = burnRate > 1 ? 'Burning budget' : 'Within budget';
      fields.burnStatus.dataset.state = burnRate > 1 ? 'bad' : 'ok';
    }
    const total = data.ingest.total || {};
    if(fields.totalSuccess) fields.totalSuccess.textContent = pct(total.successPct ?? 0, 2) + '%';
    if(fields.totalCount){
      const totalOk = fmt(total.success ?? 0);
      const totalCount = fmt(total.total ?? 0);
      const totalErr = fmt(total.error ?? Math.max(0, (total.total ?? 0) - (total.success ?? 0)));
      fields.totalCount.textContent = totalOk + ' ok / ' + totalCount + ' total (' + totalErr + ' errors)';
    }
    const windowData = data.ingest.window1k || {};
    if(fields.recentSuccess) fields.recentSuccess.textContent = pct(windowData.successPct ?? 0, 2) + '%';
    if(fields.recentCount){
      const winOk = fmt(windowData.success ?? 0);
      const winTotal = fmt(windowData.total ?? 0);
      const winErr = fmt(windowData.error ?? Math.max(0, (windowData.total ?? 0) - (windowData.success ?? 0)));
      fields.recentCount.textContent = winOk + ' ok / ' + winTotal + ' (' + winErr + ' errors)';
    }
    if(fields.heartbeatPct) fields.heartbeatPct.textContent = pct(data.heartbeat.onlinePct ?? 0, 1) + '%';
    if(fields.heartbeatCount){
      const hbOn = fmt(data.heartbeat.online ?? 0);
      const hbTotal = fmt(data.heartbeat.total ?? 0);
      fields.heartbeatCount.textContent = hbOn + ' / ' + hbTotal + ' devices';
    }
    if(fields.generatedAt){
      try {
        fields.generatedAt.textContent = data.generatedAt ? new Date(data.generatedAt).toLocaleTimeString() : '';
      } catch (err) {
        fields.generatedAt.textContent = data.generatedAt || '';
      }
    }
    }
    renderCanary(data.canary);
  }

  function renderIncidents(rows){
    if(!incidentBody) return;
    if(!Array.isArray(rows) || rows.length === 0){
      incidentBody.innerHTML = '<tr><td colspan="5" class="table-empty">No incidents in window</td></tr>';
      return;
    }
    incidentBody.innerHTML = rows.map(function(row){
      const site = esc(row.siteName || row.siteId || '—');
      const opened = esc(row.startedAt || '—');
      const last = esc(row.lastAlertAt || '—');
      const alerts = row.alerts || {};
      const active = Number(alerts.open || 0) + Number(alerts.ack || 0);
      const badgeState = active > 0 ? 'active' : 'expired';
      const badgeLabel = active > 0 ? 'Active (' + active + ')' : 'Resolved';
      const types = Array.isArray(row.types) && row.types.length > 0
        ? row.types.map(function(t){ return esc(t.type) + ' (' + esc(t.severity) + '×' + esc(String(t.count)) + ')'; })
        : [];
      const typesLabel = types.length ? types.join(', ') : '—';
      return '<tr>'
        + '<td>' + site + '</td>'
        + '<td>' + opened + '</td>'
        + '<td>' + last + '</td>'
        + '<td><span class="badge" data-state="' + badgeState + '">' + esc(badgeLabel) + '</span></td>'
        + '<td>' + typesLabel + '</td>'
        + '</tr>';
    }).join('');
  }

  let initial = null;
  if(dataEl){
    try {
      initial = JSON.parse(dataEl.textContent || '');
    } catch (err) {
      console.warn('ops slo parse failed', err);
    }
  }
  if(initial) render(initial);

  async function refresh(){
    try {
      const res = await fetch('/api/ops/slo');
      if(!res.ok) return;
      const payload = await res.json();
      render(payload);
    } catch (err) {
      console.warn('ops slo refresh failed', err);
    }
  }

  setInterval(refresh, 30000);
  refresh();

  async function refreshCanary(){
    if(!fields.canary) return;
    try {
      const res = await fetch('/api/ops/health');
      if(!res.ok) throw new Error('Request failed');
      const payload = await res.json();
      renderCanary(payload);
    } catch (err) {
      renderCanary(null);
    }
  }

  setInterval(refreshCanary, 30000);
  refreshCanary();

  async function refreshIncidents(){
    if(!incidentBody) return;
    try {
      const res = await fetch('/api/ops/incidents?since=-72 hours');
      if(!res.ok) throw new Error('Failed to load incidents');
      const payload = await res.json();
      renderIncidents(Array.isArray(payload) ? payload : []);
    } catch (err) {
      console.warn('ops incidents refresh failed', err);
    }
  }

  setInterval(refreshIncidents, 60000);
  refreshIncidents();
})();
${readOnlySnippet}
`;

const adminArchiveScript = `
(function(){
  const form = document.getElementById('archive-form');
  if(!form) return;
  const dateInput = form.querySelector('input[name="date"]');
  if(dateInput){
    dateInput.addEventListener('change', function(){
      if(typeof form.requestSubmit === 'function'){
        form.requestSubmit();
      } else {
        form.submit();
      }
    });
  }
})();
${readOnlySnippet}
`;

function SavedViewsControls(props: { formSelector: string }) {
  const formSelector = JSON.stringify(props.formSelector);
  const script = `(function(){
    const sel=document.getElementById('views-select');
    const btn=document.getElementById('save-view');
    const form=document.querySelector(${formSelector});
    if(!sel||!btn||!form) return;
    async function load(){
      try {
        const res=await fetch('/api/me/saved-views');
        if(!res.ok) throw new Error('Failed to load saved views');
        const payload=await res.json();
        const views=Array.isArray(payload)?payload.filter(function(v){ return v && v.route===location.pathname; }):[];
        sel.innerHTML='';
        const placeholder=document.createElement('option');
        placeholder.value='';
        placeholder.textContent='Saved views…';
        sel.appendChild(placeholder);
        views.forEach(function(view){
          const opt=document.createElement('option');
          opt.value=view.id;
          opt.textContent=view.name;
          opt.dataset.params=view.params_json;
          sel.appendChild(opt);
        });
        sel.value='';
      } catch (err) {
        console.error('load saved views failed', err);
      }
    }
    sel.addEventListener('change', function(){
      const opt=sel.selectedOptions[0];
      if(!opt||!opt.dataset.params) return;
      try {
        const params=JSON.parse(opt.dataset.params);
        Object.entries(params).forEach(function(entry){
          const key=entry[0];
          const value=entry[1];
          const control=form.elements.namedItem(key);
          if(!control) return;
          const str=value==null?'':String(value);
          if (typeof RadioNodeList !== 'undefined' && control instanceof RadioNodeList) {
            control.value=str;
          } else if ('value' in control) {
            control.value=str;
          }
        });
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      } catch (err) {
        console.error('apply saved view failed', err);
      }
    });
    btn.addEventListener('click', async function(){
      const params={};
      new FormData(form).forEach(function(value,key){
        if(typeof value==='string'){
          params[key]=value;
        }
      });
      const name=prompt('Name this view');
      if(!name) return;
      try {
        await fetch('/api/me/saved-views',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,route:location.pathname,params:params})});
        await load();
      } catch (err) {
        console.error('save view failed', err);
      }
    });
    load();
  })();`;
  return (
    <>
      <div class="chips" id="saved-views">
        <select id="views-select">
          <option value="">Saved views…</option>
        </select>
        <button class="btn" id="save-view">Save current</button>
      </div>
      <script dangerouslySetInnerHTML={{ __html: script }} />
    </>
  );
}

const adminEmailScript = `
(function(){
  const form = document.getElementById('email-form');
  const status = document.getElementById('email-status');
  async function load(){
    try {
      status.textContent = 'Loading…';
      const res = await fetch('/api/admin/settings');
      const rows = await res.json();
      const map = Object.fromEntries(rows.map(function(row){ return [row.key, row.value]; }));
      form.email_webhook_url.value = map.email_webhook_url || '';
      form.email_from.value = map.email_from || '';
      if(map.email_webhook_url && map.email_from){
        status.textContent = 'Email delivery configured.';
      } else {
        status.textContent = 'Email delivery not configured yet.';
      }
    } catch (err) {
      console.error('load email settings failed', err);
      status.textContent = 'Failed to load email settings.';
    }
  }
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    status.textContent = 'Saving…';
    try {
      await fetch('/api/admin/settings', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'email_webhook_url',value:form.email_webhook_url.value})});
      await fetch('/api/admin/settings', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'email_from',value:form.email_from.value})});
      status.textContent = 'Saved!';
    } catch (err) {
      console.error('save email settings failed', err);
      status.textContent = 'Failed to save settings.';
    }
    load();
  });
  load();
})();
`;

const adminSitesScript = `
(function(){
  const sitesBody = document.getElementById('sites-tbody');
  const mapsBody = document.getElementById('maps-tbody');
  const siteForm = document.getElementById('add-site');
  const mapForm = document.getElementById('add-map');

  async function listSites(){
    const res = await fetch('/api/admin/sites');
    const rows = await res.json();
    sitesBody.innerHTML = rows.map(function(r){
      return '<tr>'
        + '<td>' + r.site_id + '</td>'
        + '<td>' + (r.name ?? '') + '</td>'
        + '<td>' + (r.region ?? '') + '</td>'
        + '<td><button data-del-site="' + r.site_id + '">Delete</button></td>'
        + '</tr>';
    }).join('');
  }

  async function listMaps(){
    const res = await fetch('/api/admin/site-clients');
    const rows = await res.json();
    mapsBody.innerHTML = rows.map(function(r){
      return '<tr>'
        + '<td>' + r.client_id + '</td>'
        + '<td>' + r.site_id + '</td>'
        + '<td><button data-del-map-client="' + r.client_id + '" data-del-map-site="' + r.site_id + '">Remove</button></td>'
        + '</tr>';
    }).join('');
  }

  sitesBody.addEventListener('click', async function(e){
    const btn = e.target.closest('button'); if(!btn) return;
    const siteId = btn.getAttribute('data-del-site');
    if(siteId){
      await fetch('/api/admin/sites?siteId=' + encodeURIComponent(siteId), { method: 'DELETE' });
      listSites();
    }
  });

  mapsBody.addEventListener('click', async function(e){
    const btn = e.target.closest('button'); if(!btn) return;
    const clientId = btn.getAttribute('data-del-map-client');
    const siteId = btn.getAttribute('data-del-map-site');
    if(clientId && siteId){
      await fetch('/api/admin/site-clients?clientId=' + encodeURIComponent(clientId) + '&siteId=' + encodeURIComponent(siteId), { method: 'DELETE' });
      listMaps();
    }
  });

  siteForm.addEventListener('submit', async function(e){
    e.preventDefault();
    const params = new URLSearchParams(new FormData(siteForm));
    await fetch('/api/admin/sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(params)) });
    siteForm.reset();
    listSites();
  });

  mapForm.addEventListener('submit', async function(e){
    e.preventDefault();
    const params = new URLSearchParams(new FormData(mapForm));
    await fetch('/api/admin/site-clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(params)) });
    mapForm.reset();
    listMaps();
  });

  listSites();
  listMaps();
})();
${readOnlySnippet}
`;

const adminReportsScript = `
(function(){
  const clientSelect = document.getElementById('reports-client');
  const sloForm = document.getElementById('slo-form');
  const reportForm = document.getElementById('report-form');
  const reportBody = document.getElementById('reports-tbody');
  const statusEl = document.getElementById('report-status');

  function esc(value){
    return String(value ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function previousMonth(){
    const now = new Date();
    const year = now.getUTCFullYear();
    let month = now.getUTCMonth();
    month -= 1;
    if(month < 0){
      month = 11;
      now.setUTCFullYear(year - 1);
    }
    const target = new Date(Date.UTC(now.getUTCFullYear(), month, 1));
    const y = target.getUTCFullYear();
    const m = String(target.getUTCMonth() + 1).padStart(2,'0');
    return y + '-' + m;
  }

  function syncForms(){
    const hasClient = !!(clientSelect && clientSelect.value);
    if(sloForm){
      sloForm.querySelectorAll('input,button,textarea').forEach(function(el){
        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        const type = el.getAttribute && el.getAttribute('type');
        if(tag === 'input' && type === 'hidden') return;
        el.disabled = !hasClient;
      });
    }
    if(reportForm){
      reportForm.querySelectorAll('button').forEach(function(btn){
        btn.disabled = !hasClient;
      });
    }
  }

  async function loadClients(){
    if(!clientSelect) return;
    try {
      const res = await fetch('/api/admin/distinct/clients');
      if(!res.ok) throw new Error('failed');
      const rows = await res.json();
      clientSelect.innerHTML = '<option value="">Select client…</option>' + rows.map(function(row){
        const id = row.client_id || row.clientId || row.id;
        const name = row.name || id;
        return '<option value="' + esc(id) + '">' + esc(name) + '</option>';
      }).join('');
    } catch (err) {
      console.warn('load clients failed', err);
    }
  }

  async function loadSlo(clientId){
    if(!sloForm || !clientId) return;
    try {
      const res = await fetch('/api/admin/slo?clientId=' + encodeURIComponent(clientId));
      if(!res.ok) throw new Error('failed');
      const rows = await res.json();
      const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
      sloForm.uptimeTarget.value = row && row.uptime_target != null ? row.uptime_target : '';
      sloForm.ingestTarget.value = row && row.ingest_target != null ? row.ingest_target : '';
      sloForm.copTarget.value = row && row.cop_target != null ? row.cop_target : '';
      sloForm.reportRecipients.value = row && row.report_recipients ? row.report_recipients : '';
      if(statusEl) statusEl.textContent = 'Targets loaded';
    } catch (err) {
      console.warn('load slo failed', err);
      if(statusEl) statusEl.textContent = 'Error loading targets';
    }
  }

  async function loadReports(clientId){
    if(!reportBody || !clientId) return;
    try {
      const res = await fetch('/api/reports/client-monthly?client_id=' + encodeURIComponent(clientId));
      if(!res.ok) throw new Error('failed');
      const rows = await res.json();
      if(!Array.isArray(rows) || rows.length === 0){
        reportBody.innerHTML = '<tr><td colspan="3" class="table-empty">No reports generated yet</td></tr>';
        return;
      }
      reportBody.innerHTML = rows.map(function(row){
        const uploaded = row.uploaded ? esc(row.uploaded) : '—';
        const link = '/api/reports/' + row.key;
        return '<tr>'
          + '<td>' + esc(row.key.split('/').pop() || row.key) + '</td>'
          + '<td>' + uploaded + '</td>'
          + '<td><a href="' + esc(link) + '" target="_blank" rel="noopener">Download</a></td>'
          + '</tr>';
      }).join('');
      if(statusEl) statusEl.textContent = 'Reports refreshed';
    } catch (err) {
      console.warn('load reports failed', err);
      reportBody.innerHTML = '<tr><td colspan="3" class="table-empty">Failed to load reports</td></tr>';
      if(statusEl) statusEl.textContent = 'Error loading reports';
    }
  }

  if(reportForm){
    const monthInput = reportForm.querySelector('input[name="month"]');
    if(monthInput && !monthInput.value){
      monthInput.value = previousMonth();
    }
    reportForm.addEventListener('submit', async function(e){
      e.preventDefault();
      if(!clientSelect || !clientSelect.value) return;
      if(statusEl) statusEl.textContent = 'Generating…';
      try {
        const params = new URLSearchParams({ client_id: clientSelect.value, month: reportForm.month.value });
        const res = await fetch('/api/reports/client-monthly?' + params.toString(), { method: 'POST' });
        if(!res.ok){
          const text = await res.text();
          throw new Error(text || 'Request failed');
        }
        await loadReports(clientSelect.value);
        if(statusEl) statusEl.textContent = 'Report generated';
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if(statusEl) statusEl.textContent = 'Error: ' + message;
        console.error('generate report failed', err);
      }
    });
  }

  if(sloForm){
    sloForm.addEventListener('submit', async function(e){
      e.preventDefault();
      if(!clientSelect || !clientSelect.value) return;
      const payload = {
        clientId: clientSelect.value,
        uptimeTarget: sloForm.uptimeTarget.value || null,
        ingestTarget: sloForm.ingestTarget.value || null,
        copTarget: sloForm.copTarget.value || null,
        reportRecipients: sloForm.reportRecipients.value || null
      };
      try {
        const res = await fetch('/api/admin/slo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if(!res.ok){
          const text = await res.text();
          throw new Error(text || 'Request failed');
        }
        if(statusEl) statusEl.textContent = 'Saved SLO targets';
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if(statusEl) statusEl.textContent = 'Error: ' + message;
        console.error('save slo failed', err);
      }
    });
  }

  if(clientSelect){
    clientSelect.addEventListener('change', function(){
      const value = clientSelect.value;
      syncForms();
      if(sloForm){
        sloForm.clientId.value = value || '';
      }
      if(statusEl){
        statusEl.textContent = value ? 'Loading targets…' : 'Select a client to begin.';
      }
      if(value){
        loadSlo(value);
        loadReports(value);
      } else {
        if(reportBody) reportBody.innerHTML = '<tr><td colspan="3" class="table-empty">Select a client to load reports</td></tr>';
        if(sloForm){
          sloForm.uptimeTarget.value = '';
          sloForm.ingestTarget.value = '';
          sloForm.copTarget.value = '';
          sloForm.reportRecipients.value = '';
        }
      }
    });
  }

  loadClients().then(function(){
    syncForms();
  });
})();
${readOnlySnippet}
`;

const reportsOutboxScript = `
(function(){
  const form = document.getElementById('reports-outbox-filters');
  const tbody = document.getElementById('reports-outbox-tbody');
  const statusEl = document.getElementById('reports-outbox-status');
  const dataEl = document.getElementById('reports-outbox-data');

  function esc(value){
    return String(value ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function render(rows){
    if(!tbody) return;
    if(!Array.isArray(rows) || rows.length === 0){
      tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No reports found.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function(row){
      const recipients = Array.isArray(row.recipients) && row.recipients.length
        ? row.recipients.map(esc).join('<br/>')
        : '—';
      const path = row.path ? '<code>' + esc(row.path) + '</code>' : '—';
      const subject = row.subject ? esc(row.subject) : '—';
      const action = row.path
        ? '<button class="btn" type="button" data-action="send-report" data-type="' + esc(row.type) + '" data-client="' + (row.client_id ? esc(row.client_id) : '') + '" data-site="' + (row.site_id ? esc(row.site_id) : '') + '" data-path="' + esc(row.path) + '" data-subject="' + (row.subject ? esc(row.subject) : '') + '">Email now</button>'
        : '—';
      return '<tr>' +
        '<td>' + esc(row.created_at) + '</td>' +
        '<td>' + esc(row.type) + '</td>' +
        '<td>' + esc(row.status) + '</td>' +
        '<td>' + (row.client_id ? esc(row.client_id) : '—') + '</td>' +
        '<td>' + (row.site_id ? esc(row.site_id) : '—') + '</td>' +
        '<td>' + subject + '</td>' +
        '<td>' + recipients + '</td>' +
        '<td>' + path + '</td>' +
        '<td>' + action + '</td>' +
      '</tr>';
    }).join('');
  }

  let initial = null;
  if(dataEl){
    try {
      initial = JSON.parse(dataEl.textContent || 'null');
    } catch (err) {
      console.warn('reports outbox initial parse failed', err);
    }
  }

  if(initial && Array.isArray(initial.rows)){
    render(initial.rows);
  }

  async function load(){
    if(!form) return;
    if(statusEl) statusEl.textContent = 'Refreshing…';
    try {
      const params = new URLSearchParams(new FormData(form));
      const query = params.toString();
      const res = await fetch('/api/reports/history' + (query ? '?' + query : ''));
      if(!res.ok) throw new Error('http');
      const rows = await res.json();
      render(rows);
      if(statusEl) statusEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
    } catch (err) {
      console.warn('reports outbox refresh failed', err);
      if(statusEl) statusEl.textContent = 'Failed to refresh';
    }
  }

  if(form){
    form.addEventListener('submit', function(e){ e.preventDefault(); load(); });
    form.addEventListener('change', function(){ load(); });
  }

  if(tbody){
    tbody.addEventListener('click', function(event){
      const target = event.target;
      if(!target) return;
      const button = target.closest('button[data-action="send-report"]');
      if(!button) return;
      send(button);
    });
  }

  async function send(button){
    const type = button.getAttribute('data-type') || '';
    const path = button.getAttribute('data-path') || '';
    if(!type || !path){
      return;
    }
    const payload = { type: type, path: path };
    const clientId = button.getAttribute('data-client') || '';
    const siteId = button.getAttribute('data-site') || '';
    const subject = button.getAttribute('data-subject') || '';
    if(clientId) payload.client_id = clientId;
    if(siteId) payload.site_id = siteId;
    if(subject) payload.subject = subject;
    if(statusEl) statusEl.textContent = 'Sending email…';
    const originalText = button.textContent;
    button.textContent = 'Sending…';
    button.disabled = true;
    try {
      const res = await fetch('/api/reports/email-existing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if(!res.ok){
        const text = await res.text().catch(function(){ return ''; });
        throw new Error(text || 'http');
      }
      if(statusEl) statusEl.textContent = 'Email sent ' + new Date().toLocaleTimeString();
      load();
    } catch (err) {
      console.warn('reports outbox send failed', err);
      if(statusEl){
        const message = err && err.message ? String(err.message) : '';
        statusEl.textContent = message && message !== 'http' ? 'Failed to send email: ' + message : 'Failed to send email';
      }
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  setInterval(load, 15000);
  if(!initial || !Array.isArray(initial.rows)){
    load();
  }
})();
${readOnlySnippet}
`;

const reportHistoryScript = `
(function(){
  const form = document.getElementById('report-history-filters');
  const tbody = document.getElementById('report-history-tbody');
  const statusEl = document.getElementById('report-history-status');
  const dataEl = document.getElementById('report-history-data');

  function esc(value){
    return String(value ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function render(rows){
    if(!tbody) return;
    if(!Array.isArray(rows) || rows.length === 0){
      tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No deliveries recorded yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function(row){
      const recipients = Array.isArray(row.recipients) && row.recipients.length
        ? row.recipients.map(esc).join('<br/>')
        : '—';
      const meta = row.meta ? esc(JSON.stringify(row.meta)) : '—';
      const path = row.path ? '<code>' + esc(row.path) + '</code>' : '—';
      return '<tr>' +
        '<td>' + esc(row.created_at) + '</td>' +
        '<td>' + esc(row.type) + '</td>' +
        '<td>' + esc(row.status) + '</td>' +
        '<td>' + (row.client_id ? esc(row.client_id) : '—') + '</td>' +
        '<td>' + (row.site_id ? esc(row.site_id) : '—') + '</td>' +
        '<td>' + (row.subject ? esc(row.subject) : '—') + '</td>' +
        '<td>' + recipients + '</td>' +
        '<td>' + path + '</td>' +
        '<td>' + meta + '</td>' +
      '</tr>';
    }).join('');
  }

  let initial = null;
  if(dataEl){
    try {
      initial = JSON.parse(dataEl.textContent || 'null');
    } catch (err) {
      console.warn('report history initial parse failed', err);
    }
  }

  if(initial && Array.isArray(initial.rows)){
    render(initial.rows);
  }

  async function load(){
    if(!form) return;
    if(statusEl) statusEl.textContent = 'Refreshing…';
    try {
      const params = new URLSearchParams(new FormData(form));
      const query = params.toString();
      const res = await fetch('/api/reports/history' + (query ? '?' + query : ''));
      if(!res.ok) throw new Error('http');
      const rows = await res.json();
      render(rows);
      if(statusEl) statusEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
    } catch (err) {
      console.warn('report history refresh failed', err);
      if(statusEl) statusEl.textContent = 'Failed to refresh';
    }
  }

  if(form){
    form.addEventListener('submit', function(e){ e.preventDefault(); load(); });
    form.addEventListener('change', function(){ load(); });
  }

  setInterval(load, 15000);
  if(!initial || !Array.isArray(initial.rows)){
    load();
  }
})();
${readOnlySnippet}
`;

const clientSloScript = `
(function(){
  const form = document.getElementById('client-slo-form');
  const statusEl = document.getElementById('client-slo-status');
  const dataEl = document.getElementById('client-slo-data');
  const spark = document.getElementById('client-slo-sparkline');
  const latestEl = document.querySelector('[data-slo-cop-latest]');
  const rangeEl = document.querySelector('[data-slo-cop-range]');
  const recipientsEl = document.getElementById('client-slo-recipients');
  const metaEl = document.getElementById('client-slo-meta');
  const severityList = document.getElementById('client-slo-alerts-list');
  const heatmapGrid = document.getElementById('client-slo-heatmap');
  const heatmapEmpty = document.getElementById('client-slo-heatmap-empty');
  const heatmapStatus = document.getElementById('client-slo-heatmap-status');
  const heatmapTitle = document.getElementById('client-slo-heatmap-title');

  const valueEls = {
    uptime: document.querySelector('[data-slo-value="uptime"]'),
    ingest: document.querySelector('[data-slo-value="ingest"]'),
    cop: document.querySelector('[data-slo-value="cop"]'),
  };
  const targetEls = {
    uptime: document.querySelector('[data-slo-target="uptime"]'),
    ingest: document.querySelector('[data-slo-target="ingest"]'),
    cop: document.querySelector('[data-slo-target="cop"]'),
  };
  const chipEls = {
    uptime: document.querySelector('[data-slo-chip="uptime"]'),
    ingest: document.querySelector('[data-slo-chip="ingest"]'),
    cop: document.querySelector('[data-slo-chip="cop"]'),
  };
  let heatmapRequestId = 0;

  function esc(value){
    return String(value ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function formatPct(value){
    return value == null || !Number.isFinite(value) ? '—' : (value * 100).toFixed(2) + '%';
  }

  function formatNumber(value, digits){
    return value == null || !Number.isFinite(value) ? '—' : Number(value).toFixed(digits);
  }

  function setChip(el, status){
    if(!el) return;
    el.classList.remove('pass','fail','idle');
    if(status === 'pass'){ el.classList.add('pass'); el.textContent = 'Met'; }
    else if(status === 'fail'){ el.classList.add('fail'); el.textContent = 'Miss'; }
    else { el.classList.add('idle'); el.textContent = '—'; }
  }

  function heatColor(pct){
    const value = Math.max(0, Math.min(1, pct));
    const hue = 120 * value;
    return 'hsl(' + hue.toFixed(0) + ', 70%, 45%)';
  }

  function renderHeatmap(data){
    if(!heatmapGrid) return;
    if(!data || !Array.isArray(data.series) || data.series.length === 0){
      heatmapGrid.innerHTML = '';
      if(heatmapEmpty){
        heatmapEmpty.style.display = '';
        heatmapEmpty.textContent = 'No uptime data yet.';
      }
      return;
    }
    const first = data.series[0];
    let offset = 0;
    if(first && first.date){
      const dt = new Date(first.date + 'T00:00:00Z');
      if(!Number.isNaN(dt.valueOf())){
        offset = dt.getUTCDay();
      }
    }
    const cells = [];
    for(let i=0;i<offset;i++){
      cells.push('<div class="slo-heatmap-cell" data-empty="true"></div>');
    }
    data.series.forEach(function(entry){
      const date = entry && entry.date ? entry.date : '';
      const dt = date ? new Date(date + 'T00:00:00Z') : null;
      const day = dt && !Number.isNaN(dt.valueOf()) ? dt.getUTCDate() : '';
      const pct = typeof entry.uptimePct === 'number' && Number.isFinite(entry.uptimePct)
        ? Math.max(0, Math.min(1, entry.uptimePct))
        : null;
      const color = pct == null ? '#1a2332' : heatColor(pct);
      const tooltip = pct == null ? 'No data' : (pct * 100).toFixed(1) + '%';
      cells.push('<div class="slo-heatmap-cell" style="background:' + color + '" title="' + esc(date + ': ' + tooltip) + '"><span>' + day + '</span></div>');
    });
    heatmapGrid.innerHTML = cells.join('');
    if(heatmapEmpty){
      heatmapEmpty.style.display = 'none';
    }
  }

  async function loadHeatmap(monthKey){
    if(!heatmapGrid || !form) return;
    const clientId = form.getAttribute('data-client');
    if(!clientId) return;
    if(!monthKey){
      if(heatmapEmpty){
        heatmapEmpty.style.display = '';
        heatmapEmpty.textContent = 'Select a month to view uptime.';
      }
      return;
    }
    const requestId = ++heatmapRequestId;
    if(heatmapStatus) heatmapStatus.textContent = 'Loading…';
    if(heatmapGrid){
      heatmapGrid.innerHTML = '';
    }
    if(heatmapEmpty){
      heatmapEmpty.style.display = '';
      heatmapEmpty.textContent = 'Loading…';
    }
    try {
      const res = await fetch('/api/clients/' + encodeURIComponent(clientId) + '/uptime-daily?month=' + encodeURIComponent(monthKey));
      if(!res.ok) throw new Error('http');
      const payload = await res.json();
      if(requestId !== heatmapRequestId) return;
      renderHeatmap(payload);
      if(heatmapStatus) heatmapStatus.textContent = 'Updated ' + new Date().toLocaleTimeString();
    } catch (err) {
      console.warn('client slo heatmap load failed', err);
      if(requestId !== heatmapRequestId) return;
      if(heatmapStatus) heatmapStatus.textContent = 'Failed to load';
      if(heatmapEmpty){
        heatmapEmpty.style.display = '';
        heatmapEmpty.textContent = 'Failed to load uptime data.';
      }
    }
  }

  function renderSparkline(series){
    if(!spark) return;
    const width = 320;
    const height = 80;
    const values = series.map(function(point){ return typeof point.value === 'number' ? point.value : null; }).filter(function(v){ return v != null; });
    if(values.length === 0){
      spark.setAttribute('viewBox','0 0 ' + width + ' ' + height);
      spark.innerHTML = '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="#0b1119" stroke="#1e2632" />';
      if(latestEl) latestEl.textContent = '—';
      if(rangeEl) rangeEl.textContent = '';
      return;
    }
    let min = Math.min.apply(null, values);
    let max = Math.max.apply(null, values);
    if(min === max){
      max = min + 0.1;
    }
    const span = max - min;
    let path = '';
    series.forEach(function(point, idx){
      const value = typeof point.value === 'number' ? point.value : null;
      const x = series.length <= 1 ? width : (idx / (series.length - 1)) * width;
      if(value == null){
        return;
      }
      const y = height - ((value - min) / span) * height;
      path += (path ? ' L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
    });
    spark.setAttribute('viewBox','0 0 ' + width + ' ' + height);
    spark.innerHTML = '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="#0b1119" stroke="#1e2632" />' +
      '<path d="' + path + '" fill="none" stroke="#3fb950" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />';
    if(latestEl){
      for(let i=series.length-1;i>=0;i--){
        const val = series[i] && typeof series[i].value === 'number' ? series[i].value : null;
        if(val != null){ latestEl.textContent = formatNumber(val, 2); break; }
      }
    }
    if(rangeEl){
      rangeEl.textContent = values.length ? formatNumber(Math.min.apply(null, values), 2) + ' – ' + formatNumber(Math.max.apply(null, values), 2) : '';
    }
  }

  function render(summary){
    if(!summary) return;
    if(form && form.month){
      form.month.value = summary.month && summary.month.key ? summary.month.key : '';
    }
    if(metaEl){
      metaEl.textContent = 'Sites ' + summary.siteCount + ' · Devices ' + summary.deviceCount + ' · Window ' + summary.window.start + ' → ' + summary.window.end;
    }
    if(heatmapTitle){
      const label = summary.month && summary.month.label ? summary.month.label : '';
      heatmapTitle.textContent = label ? '(' + label + ')' : '';
    }
    if(valueEls.uptime) valueEls.uptime.textContent = formatPct(summary.metrics.uptimePct);
    if(valueEls.ingest) valueEls.ingest.textContent = formatPct(summary.metrics.ingestSuccessPct);
    if(valueEls.cop) valueEls.cop.textContent = formatNumber(summary.metrics.avgCop, 2);
    if(targetEls.uptime) targetEls.uptime.textContent = summary.targets.uptimeTarget == null ? 'Target: —' : 'Target: ' + (summary.targets.uptimeTarget * 100).toFixed(2) + '%';
    if(targetEls.ingest) targetEls.ingest.textContent = summary.targets.ingestTarget == null ? 'Target: —' : 'Target: ' + (summary.targets.ingestTarget * 100).toFixed(2) + '%';
    if(targetEls.cop) targetEls.cop.textContent = summary.targets.copTarget == null ? 'Target: —' : 'Target: ' + summary.targets.copTarget.toFixed(2);

    const uptimeStatus = summary.targets.uptimeTarget == null || summary.metrics.uptimePct == null
      ? 'idle'
      : summary.metrics.uptimePct >= summary.targets.uptimeTarget ? 'pass' : 'fail';
    const ingestStatus = summary.targets.ingestTarget == null || summary.metrics.ingestSuccessPct == null
      ? 'idle'
      : summary.metrics.ingestSuccessPct >= summary.targets.ingestTarget ? 'pass' : 'fail';
    const copStatus = summary.targets.copTarget == null || summary.metrics.avgCop == null
      ? 'idle'
      : summary.metrics.avgCop >= summary.targets.copTarget ? 'pass' : 'fail';

    setChip(chipEls.uptime, uptimeStatus);
    setChip(chipEls.ingest, ingestStatus);
    setChip(chipEls.cop, copStatus);

    if(recipientsEl){
      recipientsEl.textContent = summary.recipients ? summary.recipients : '—';
    }

    if(severityList){
      const entries = Object.entries(summary.metrics.alertsBySeverity || {});
      if(entries.length === 0){
        severityList.innerHTML = '<li>No alerts recorded for this window.</li>';
      } else {
        severityList.innerHTML = entries
          .sort(function(a,b){ return b[1] - a[1]; })
          .map(function(entry){ return '<li><strong>' + esc(entry[0]) + '</strong>: ' + entry[1] + '</li>'; })
          .join('');
      }
    }

    renderSparkline(summary.copSparkline || []);

    if(statusEl){
      statusEl.textContent = 'Updated ' + new Date(summary.updatedAt || Date.now()).toLocaleTimeString();
    }
  }

  let initial = null;
  if(dataEl){
    try {
      initial = JSON.parse(dataEl.textContent || 'null');
    } catch (err) {
      console.warn('client slo initial parse failed', err);
    }
  }
  if(initial){
    render(initial.summary);
    if(initial.summary && initial.summary.month && initial.summary.month.key){
      loadHeatmap(initial.summary.month.key);
    }
  }

  async function load(){
    if(!form) return;
    const clientId = form.getAttribute('data-client');
    if(!clientId) return;
    if(statusEl) statusEl.textContent = 'Refreshing…';
    try {
      const params = new URLSearchParams(new FormData(form));
      const res = await fetch('/api/clients/' + encodeURIComponent(clientId) + '/slo-summary?' + params.toString());
      if(!res.ok) throw new Error('http');
      const summary = await res.json();
      render(summary);
      if(summary && summary.month && summary.month.key){
        loadHeatmap(summary.month.key);
      }
    } catch (err) {
      console.warn('client slo refresh failed', err);
      if(statusEl) statusEl.textContent = 'Failed to refresh';
    }
  }

  if(form){
    form.addEventListener('submit', function(e){ e.preventDefault(); load(); });
  }
  const refreshBtn = document.getElementById('client-slo-refresh');
  if(refreshBtn){
    refreshBtn.addEventListener('click', function(){ load(); });
  }

  setInterval(load, 60000);
})();
${readOnlySnippet}
`;

const maintenanceScript = `
(function(){
  const form = document.getElementById('maintenance-form');
  const tbody = document.getElementById('maintenance-tbody');

  function esc(value){
    return String(value ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function formatDate(value){
    if(!value) return '—';
    try {
      return new Date(value).toLocaleString();
    } catch (err) {
      return value;
    }
  }

  function render(rows){
    if(!tbody) return;
    if(!Array.isArray(rows) || rows.length === 0){
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No maintenance windows scheduled</td></tr>';
      return;
    }
    const now = Date.now();
    tbody.innerHTML = rows.map(function(row){
      const scope = row.device_id ? 'Device ' + esc(row.device_id) : (row.site_id ? 'Site ' + esc(row.site_id) : 'Global');
      const endMs = row.end_ts ? Date.parse(row.end_ts) : 0;
      let badgeState = row.active ? 'active' : 'scheduled';
      if(!row.active && endMs && endMs < now) badgeState = 'expired';
      const badgeLabel = badgeState === 'active' ? 'Active' : (badgeState === 'expired' ? 'Expired' : 'Scheduled');
      return '<tr>' +
        '<td>' + scope + '</td>' +
        '<td>' + formatDate(row.start_ts) + '</td>' +
        '<td>' + formatDate(row.end_ts) + '</td>' +
        '<td>' + (row.reason ? esc(row.reason) : '—') + '</td>' +
        '<td><span class="badge" data-state="' + badgeState + '">' + badgeLabel + '</span></td>' +
        '<td><button class="btn" type="button" data-del="' + esc(row.id) + '">Remove</button></td>' +
      '</tr>';
    }).join('');
  }

  async function load(){
    if(!tbody) return;
    try {
      const res = await fetch('/api/admin/maintenance');
      if(!res.ok) throw new Error('Request failed');
      const payload = await res.json();
      render(Array.isArray(payload) ? payload : []);
    } catch (err) {
      console.warn('maintenance load failed', err);
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Failed to load windows</td></tr>';
    }
  }

  if(form){
    form.addEventListener('submit', async function(e){
      e.preventDefault();
      const formData = new FormData(form);
      const payload = {};
      const site = formData.get('siteId');
      const device = formData.get('deviceId');
      const reason = formData.get('reason');
      if(site && String(site).trim()) payload.siteId = String(site).trim();
      if(device && String(device).trim()) payload.deviceId = String(device).trim();
      if(reason && String(reason).trim()) payload.reason = String(reason).trim();
      const startRaw = formData.get('startTs');
      const endRaw = formData.get('endTs');
      if(!startRaw || !String(startRaw).trim() || !endRaw || !String(endRaw).trim()){
        alert('Start and end timestamps are required.');
        return;
      }
      const start = new Date(String(startRaw));
      const end = new Date(String(endRaw));
      if(Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())){
        alert('Please provide valid start and end timestamps.');
        return;
      }
      if(start.valueOf() >= end.valueOf()){
        alert('End must be after start.');
        return;
      }
      payload.startTs = start.toISOString();
      payload.endTs = end.toISOString();
      if(!payload.siteId && !payload.deviceId){
        alert('Provide a site or device scope.');
        return;
      }
      const submitBtn = form.querySelector('button[type="submit"]');
      if(submitBtn) submitBtn.disabled = true;
      try {
        const res = await fetch('/api/admin/maintenance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if(!res.ok){
          const text = await res.text();
          throw new Error(text || 'Request failed');
        }
        form.reset();
        await load();
      } catch (err) {
        alert('Failed to create maintenance window: ' + (err && err.message ? err.message : err));
      } finally {
        if(submitBtn) submitBtn.disabled = false;
      }
    });
  }

  if(tbody){
    tbody.addEventListener('click', async function(ev){
      const target = ev.target;
      if(!target || typeof target.closest !== 'function') return;
      const btn = target.closest('button[data-del]');
      if(!btn) return;
      const id = btn.getAttribute('data-del');
      if(!id) return;
      if(!confirm('Remove this maintenance window?')) return;
      try {
        await fetch('/api/admin/maintenance/' + encodeURIComponent(id), { method: 'DELETE' });
        await load();
      } catch (err) {
        alert('Failed to remove maintenance window');
      }
    });
  }

  load();
})();
${readOnlySnippet}
`;

export const renderer = jsxRenderer(({ children }) => {
  const c = useRequestContext();
  const path = c.req.path;
  const isActive = (href: string) => {
    if (href === '/') {
      return path === '/';
    }
    if (href.startsWith('/admin/')) {
      return path === href;
    }
    return path === href || path.startsWith(`${href}/`);
  };

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>GreenBro Control Centre — Devices</title>
        <link rel="icon" href="/brand/logo.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/brand.css" />
        <style>{`
          body{margin:0;background:var(--gb-bg);color:var(--gb-ink);font-family:'Inter',ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
          a{color:var(--gb-primary-500)}
          header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:18px 24px;background:var(--gb-panel);border-bottom:1px solid var(--gb-panel-border);backdrop-filter:blur(12px)}
          nav{display:flex;flex-wrap:wrap;gap:10px}
          nav a{color:rgba(236,247,237,0.75);text-decoration:none;padding:8px 16px;border-radius:999px;transition:background 0.2s ease,color 0.2s ease,box-shadow 0.2s ease}
          nav a:hover{background:rgba(111,219,127,0.18);color:#ffffff}
          nav a.active{background:rgba(57,181,74,0.3);color:#041205;box-shadow:0 14px 28px -20px rgba(57,181,74,0.75)}
          .brand-mark{display:inline-flex;align-items:center;gap:12px;font-size:18px;font-weight:600;color:#ecf7ed;letter-spacing:0.08em;text-transform:uppercase}
          .brand-mark img{width:24px;height:24px;border-radius:8px;display:block;box-shadow:0 12px 24px -16px rgba(57,181,74,0.8)}
          .wrap{max-width:1120px;margin:0 auto;padding:28px 24px 48px}
          .card{background:var(--gb-card);border:1px solid var(--gb-card-border);border-radius:18px;padding:20px;box-shadow:var(--gb-card-shadow)}
          .grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
          .btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 18px;border-radius:999px;border:1px solid rgba(57,181,74,0.35);background:linear-gradient(95deg,var(--gb-primary-700) 0%,var(--gb-primary-300) 100%);color:#041205;font-weight:600;cursor:pointer;box-shadow:0 18px 32px -24px rgba(57,181,74,0.85)}
          table{width:100%;border-collapse:collapse}
          th,td{padding:10px 12px;border-bottom:1px solid rgba(11,14,18,0.08);text-align:left;color:var(--gb-ink)}
          label{display:flex;gap:6px;align-items:center;color:var(--gb-muted)}
          select,input[type=text]{background:#f4f9f6;color:var(--gb-ink);border:1px solid rgba(11,14,18,0.08);border-radius:10px;padding:8px 10px}
          button{cursor:pointer}
          body[data-ro]::after{content:'READ-ONLY';position:fixed;top:10px;right:18px;background:rgba(244,63,94,0.16);color:#b4231a;padding:6px 14px;border-radius:999px;font-weight:700;box-shadow:0 10px 24px -20px rgba(11,14,18,0.6);border:1px solid rgba(244,63,94,0.3)}
          .overview-layout{display:grid;gap:20px}
          .overview-kpis{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
          .kpi-card{display:flex;flex-direction:column;gap:8px}
          .kpi-value{font-size:34px;font-weight:600;color:var(--gb-primary-700)}
          .devices-card{display:flex;flex-direction:column;gap:14px}
          .devices-map-wrap{width:100%;overflow:hidden;border-radius:16px;background:#03130a;border:1px solid rgba(46,158,63,0.2);box-shadow:0 24px 50px -36px rgba(8,12,9,0.85)}
          #devices-map{width:100%;height:auto;display:block}
          .legend{display:flex;flex-wrap:wrap;gap:12px;color:var(--gb-muted);font-size:13px}
          .legend span{display:flex;align-items:center;gap:6px}
          .legend .swatch{width:10px;height:10px;border-radius:50%}
          .devices-sites{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;max-height:200px;overflow:auto}
          .devices-sites li{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--gb-muted)}
          .devices-sites .dot{width:10px;height:10px;border-radius:50%}
          .devices-sites .name{color:var(--gb-ink);font-weight:600}
          .devices-sites .empty{justify-content:center;font-style:italic}
          .sparkline-grid{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
          .sparkline-card{display:flex;flex-direction:column;gap:10px}
          .sparkline-chart{width:100%;height:auto}
          .sparkline-meta{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--gb-muted)}
          .sparkline-meta strong{color:var(--gb-ink);font-weight:600}
          .card-header{display:flex;justify-content:space-between;align-items:center;gap:10px}
          .card-subtle{color:var(--gb-muted);font-size:13px}
          .ops-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
          .ops-header-right{display:flex;align-items:center;gap:12px}
          .ops-grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
          .ops-tile{background:rgba(244,249,246,0.92);border:1px solid rgba(46,158,63,0.15);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:8px;box-shadow:0 20px 40px -34px rgba(8,12,9,0.6)}
          .ops-label{color:var(--gb-muted);font-size:12px;letter-spacing:0.04em;text-transform:uppercase}
          .ops-value{font-size:32px;font-weight:600;color:var(--gb-ink)}
          .ops-status{font-size:13px;color:var(--gb-primary-700)}
          .ops-status[data-state="bad"]{color:#b4231a}
          .ops-subtext{font-size:13px;color:var(--gb-muted)}
          .ops-canary{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase}
          .ops-canary[data-state="ok"]{background:rgba(57,181,74,0.18);color:var(--gb-primary-700)}
          .ops-canary[data-state="warn"]{background:rgba(240,136,62,0.18);color:#b45309}
          .ops-canary[data-state="crit"]{background:rgba(244,63,94,0.16);color:#b4231a}
          .maintenance-form{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 18px}
          .maintenance-form input,.maintenance-form select{min-width:160px}
          #reports-outbox-filters,#report-history-filters{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 18px}
          #reports-outbox-filters input,#report-history-filters input,#report-history-filters select{min-width:150px}
          .reports-outbox-table tbody tr:hover,.report-history-table tbody tr:hover{background:rgba(111,219,127,0.08)}
          .slo-form{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:14px 0 20px}
          .slo-form input[type=month]{min-width:160px}
          .slo-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-bottom:18px}
          .slo-card{background:rgba(244,249,246,0.92);border:1px solid rgba(46,158,63,0.15);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 36px -34px rgba(8,12,9,0.6)}
          .slo-metric-value{font-size:30px;font-weight:600;color:var(--gb-ink)}
          .slo-target{font-size:12px;color:var(--gb-muted)}
          .slo-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em}
          .slo-chip.pass{background:rgba(57,181,74,0.18);color:var(--gb-primary-700)}
          .slo-chip.fail{background:rgba(244,63,94,0.16);color:#b4231a}
          .slo-chip.idle{background:rgba(143,154,166,0.16);color:var(--gb-muted)}
          .slo-spark{background:rgba(244,249,246,0.92);border:1px solid rgba(46,158,63,0.15);border-radius:14px;padding:18px;margin-bottom:16px;box-shadow:0 20px 40px -36px rgba(8,12,9,0.6)}
          #client-slo-sparkline{width:100%;height:auto;display:block}
          .slo-spark-meta{display:flex;justify-content:space-between;font-size:13px;color:var(--gb-muted);margin-top:8px}
          .slo-meta{display:flex;flex-wrap:wrap;gap:12px;font-size:13px;color:var(--gb-muted);margin-bottom:18px}
          .slo-alerts{background:rgba(244,249,246,0.92);border:1px solid rgba(46,158,63,0.15);border-radius:14px;padding:18px;margin-top:18px;box-shadow:0 20px 40px -34px rgba(8,12,9,0.6)}
          .slo-alerts ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--gb-muted)}
          .slo-alerts strong{color:var(--gb-ink)}
          .slo-heatmap{background:rgba(244,249,246,0.92);border:1px solid rgba(46,158,63,0.15);border-radius:14px;padding:18px;margin-top:18px;box-shadow:0 20px 40px -34px rgba(8,12,9,0.6)}
          .slo-heatmap-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;font-size:13px;color:var(--gb-muted)}
          .slo-heatmap-month{font-size:12px;color:var(--gb-muted);margin-left:8px;font-weight:400}
          .slo-heatmap-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
          .slo-heatmap-cell{position:relative;padding-top:100%;border-radius:8px;background:rgba(12,20,14,0.75);overflow:hidden}
          .slo-heatmap-cell span{position:absolute;top:4px;left:6px;font-size:11px;font-weight:600;color:rgba(236,247,237,0.9)}
          .slo-heatmap-cell[data-empty="true"]{background:rgba(4,9,13,0.8)}
          .slo-heatmap-cell:hover{outline:1px solid rgba(111,219,127,0.25)}
          .slo-heatmap-legend{display:flex;align-items:center;gap:10px;margin-top:12px;font-size:11px;color:var(--gb-muted)}
          .slo-heatmap-legend .bar{flex:1;height:8px;border-radius:999px;background:linear-gradient(90deg,#f85149,#f0883e,#fbd25d,#39b54a)}
          .slo-heatmap-empty{font-size:13px;color:var(--gb-muted)}
          .badge{display:inline-block;border-radius:999px;padding:3px 10px;font-size:12px}
          .badge[data-state="active"]{background:rgba(57,181,74,0.18);color:var(--gb-primary-700)}
          .badge[data-state="scheduled"]{background:rgba(240,136,62,0.18);color:#b45309}
          .badge[data-state="expired"]{background:rgba(143,154,166,0.16);color:var(--gb-muted)}
          .table-empty{text-align:center;font-style:italic;color:var(--gb-muted)}
          .archive-form{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 18px}
          .archive-form input[type=date]{min-width:180px}
          .archive-summary{color:var(--gb-muted);font-size:13px;margin:8px 0 4px}
          .archive-table{width:100%;border-collapse:collapse;margin-top:12px}
          .archive-table th,.archive-table td{padding:10px 12px;border-bottom:1px solid rgba(11,14,18,0.08);text-align:left}
        `}</style>
      </head>
      <body>
        <header>
          <span class="brand-mark"><img src="/brand/logo.svg" alt="GreenBro" height="24" width="24" /><span>GreenBro Control Centre</span></span>
          <nav>
            <a href="/" class={isActive('/') ? 'active' : undefined}>
              Overview
            </a>
            <a href="/ops" class={isActive('/ops') ? 'active' : undefined}>
              Ops &amp; Security
            </a>
            <a href="/alerts" class={isActive('/alerts') ? 'active' : undefined}>
              Alerts
            </a>
            <a href="/devices" class={isActive('/devices') ? 'active' : undefined}>
              Devices
            </a>
            <a href="/admin/sites" class={isActive('/admin/sites') ? 'active' : undefined}>
              Admin Sites
            </a>
            <a href="/admin/reports" class={isActive('/admin/reports') ? 'active' : undefined}>
              Reports
            </a>
            <a
              href="/admin/reports/outbox"
              class={isActive('/admin/reports/outbox') ? 'active' : undefined}
            >
              Outbox
            </a>
            <a href="/admin/email" class={isActive('/admin/email') ? 'active' : undefined}>
              Email
            </a>
            <a href="/admin/maintenance" class={isActive('/admin/maintenance') ? 'active' : undefined}>
              Maintenance
            </a>
            <a href="/admin/archive" class={isActive('/admin/archive') ? 'active' : undefined}>
              Archive
            </a>
            <a href="/admin/presets" class={isActive('/admin/presets') ? 'active' : undefined}>
              Presets
            </a>
            <a href="/admin/settings" class={isActive('/admin/settings') ? 'active' : undefined}>
              Admin Settings
            </a>
          </nav>
        </header>
        <div class="wrap">{children}</div>
        <script dangerouslySetInnerHTML={{ __html: readOnlyScript }} />
      </body>
    </html>
  );
});

export function OverviewPage(props: { data: OverviewData }) {
  const { data } = props;
  const deltaLast = latestValue(data.series.deltaT);
  const copLast = latestValue(data.series.cop);
  const deltaRange = rangeLabel(data.series.deltaT, 1);
  const copRange = rangeLabel(data.series.cop, 2);
  const initialJson = encodeJson(data);

  return (
    <div id="overview" class="overview-layout">
      <div class="grid overview-kpis">
        <div class="card kpi-card">
          <h3>Online %</h3>
          <div class="kpi-value" data-kpi="online">
            {Number.isFinite(data.kpis.onlinePct) ? data.kpis.onlinePct.toFixed(1) : '0.0'}%
          </div>
        </div>
        <div class="card kpi-card">
          <h3>Open alerts</h3>
          <div class="kpi-value" data-kpi="alerts">{data.kpis.openAlerts}</div>
        </div>
        <div class="card kpi-card">
          <h3>Avg COP</h3>
          <div class="kpi-value" data-kpi="cop">
            {typeof data.kpis.avgCop === 'number' && Number.isFinite(data.kpis.avgCop)
              ? data.kpis.avgCop.toFixed(2)
              : '—'}
          </div>
        </div>
      </div>

      <div class="card devices-card">
        <div class="card-header">
          <h2>Devices map</h2>
          <span class="card-subtle" data-updated>Updated just now</span>
        </div>
        <div class="devices-map-wrap">
          <svg
            id="devices-map"
            viewBox="0 0 600 360"
            class="devices-map"
            preserveAspectRatio="xMidYMid meet"
          ></svg>
        </div>
        <div class="legend">
          <span>
            <span class="swatch" style="background:#3fb950"></span>
            Healthy
          </span>
          <span>
            <span class="swatch" style="background:#f0883e"></span>
            Major
          </span>
          <span>
            <span class="swatch" style="background:#f85149"></span>
            Critical
          </span>
          <span>
            <span class="swatch" style="background:#3d4b63"></span>
            No devices
          </span>
        </div>
        <ul id="devices-sites" class="devices-sites"></ul>
      </div>

      <div class="grid sparkline-grid">
        <div class="card sparkline-card">
          <h3>Devices ΔT</h3>
          <svg id="sparkline-delta" class="sparkline-chart" viewBox="0 0 320 80" preserveAspectRatio="none"></svg>
          <div class="sparkline-meta">
            <span>
              Now <strong data-sparkline-value="delta">{deltaLast != null ? deltaLast.toFixed(1) : '—'}</strong>°C
            </span>
            <span data-sparkline-range="delta">{deltaRange ? `${deltaRange} °C` : ''}</span>
          </div>
        </div>
        <div class="card sparkline-card">
          <h3>Devices COP</h3>
          <svg id="sparkline-cop" class="sparkline-chart" viewBox="0 0 320 80" preserveAspectRatio="none"></svg>
          <div class="sparkline-meta">
            <span>
              Now COP <strong data-sparkline-value="cop">{copLast != null ? copLast.toFixed(2) : '—'}</strong>
            </span>
            <span data-sparkline-range="cop">{copRange ? `${copRange} COP` : ''}</span>
          </div>
        </div>
      </div>

      <script id="overview-data" type="application/json">{initialJson}</script>
      <script dangerouslySetInnerHTML={{ __html: overviewScript }} />
    </div>
  );
}

export function OpsPage(props: { snapshot: OpsSnapshot }) {
  const snap = props.snapshot;
  const burnRate = snap.ingest.burnRate;
  const burnState = burnRate > 1 ? 'bad' : 'ok';
  const burnLabel = burnRate > 1 ? 'Burning budget' : 'Within budget';
  const total = snap.ingest.total;
  const window1k = snap.ingest.window1k;
  const heartbeat = snap.heartbeat;
  const fmt = (value: number) => (Number.isFinite(value) ? value.toLocaleString() : '0');
  const generatedLabel = (() => {
    try {
      return snap.generatedAt ? new Date(snap.generatedAt).toLocaleTimeString() : '—';
    } catch {
      return snap.generatedAt ?? '—';
    }
  })();
  const canaryInfo = snap.canary ?? { lastAt: null, minutesSince: null, status: 'crit' };
  const canaryState = canaryInfo.status ?? 'crit';
  const canaryMinutes = typeof canaryInfo.minutesSince === 'number' && Number.isFinite(canaryInfo.minutesSince)
    ? Math.max(0, Math.round(canaryInfo.minutesSince))
    : null;
  const canaryLabelBase = canaryState === 'ok' ? 'Canary OK' : canaryState === 'warn' ? 'Canary Warn' : 'Canary Crit';
  const canaryLabel = canaryLabelBase + ' · ' + (canaryMinutes != null ? canaryMinutes + 'm' : '—');
  const initialJson = encodeJson(snap);

  return (
    <div class="card" id="ops-slo">
      <div class="ops-header">
        <h2>Ops SLO snapshot</h2>
        <div class="ops-header-right">
          <span class="ops-canary" data-field="canary" data-state={canaryState}>
            {canaryLabel}
          </span>
          <span class="ops-subtext">
            Updated <span data-field="generated-at">{generatedLabel}</span>
          </span>
        </div>
      </div>
      <div class="ops-grid">
        <div class="ops-tile">
          <span class="ops-label">Ingest burn (1k ev)</span>
          <span class="ops-value" data-field="burn-rate">×{burnRate.toFixed(2)}</span>
          <span class="ops-status" data-field="burn-status" data-state={burnState}>
            {burnLabel}
          </span>
        </div>
        <div class="ops-tile">
          <span class="ops-label">Ingest success (total)</span>
          <span class="ops-value" data-field="ingest-total-success">{total.successPct.toFixed(2)}%</span>
          <span class="ops-subtext" data-field="ingest-total-count">
            {fmt(total.success)} ok / {fmt(total.total)} total ({fmt(total.error)} errors)
          </span>
        </div>
        <div class="ops-tile">
          <span class="ops-label">Ingest success (1k window)</span>
          <span class="ops-value" data-field="ingest-recent-success">{window1k.successPct.toFixed(2)}%</span>
          <span class="ops-subtext" data-field="ingest-recent-count">
            {fmt(window1k.success)} ok / {fmt(window1k.total)} ({fmt(window1k.error)} errors)
          </span>
        </div>
        <div class="ops-tile">
          <span class="ops-label">Heartbeat online now</span>
          <span class="ops-value" data-field="heartbeat-pct">{heartbeat.onlinePct.toFixed(1)}%</span>
          <span class="ops-subtext" data-field="heartbeat-count">
            {fmt(heartbeat.online)} / {fmt(heartbeat.total)} devices
          </span>
        </div>
      </div>
      <div class="card-header" style="margin-top:24px">
        <h3>Incidents (last 72h)</h3>
        <span class="card-subtle">Grouped per site with 10 min gap heuristic</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Site</th>
            <th>Opened</th>
            <th>Last alert</th>
            <th>Status</th>
            <th>Types</th>
          </tr>
        </thead>
        <tbody id="ops-incidents">
          <tr>
            <td colSpan={5} class="table-empty">Loading…</td>
          </tr>
        </tbody>
      </table>
      <script id="ops-slo-data" type="application/json">{initialJson}</script>
      <script dangerouslySetInnerHTML={{ __html: opsScript }} />
    </div>
  );
}

export function AlertsPage(props: { alerts: any[]; filters: { state?: string; severity?: string; type?: string; deviceId?: string } }) {
  const { alerts, filters } = props;
  const S = (v?: string) => v ?? '';
  const types = ['overheat','low_flow_under_load','low_cop','short_cycling','no_heartbeat_warn','no_heartbeat_crit'];
  const severities = ['minor','major','critical'];
  const states = ['open','ack','closed'];
  return (
    <div class="card">
      <h2>Alerts</h2>
      <form id="alert-filters" method="get" action="/alerts" style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 16px">
        <label>State
          <select name="state" value={S(filters.state)}>
            <option value="">All</option>
            {states.map((s) => (
              <option value={s} selected={S(filters.state) === s}>{s}</option>
            ))}
          </select>
        </label>
        <label>Severity
          <select name="severity" value={S(filters.severity)}>
            <option value="">All</option>
            {severities.map((s) => (
              <option value={s} selected={S(filters.severity) === s}>{s}</option>
            ))}
          </select>
        </label>
        <label>Type
          <select name="type" value={S(filters.type)}>
            <option value="">All</option>
            {types.map((t) => (
              <option value={t} selected={S(filters.type) === t}>{t}</option>
            ))}
          </select>
        </label>
        <label>Device
          <input type="text" name="deviceId" placeholder="GBR-HP-12345" value={S(filters.deviceId)} />
        </label>
        <button class="btn" type="submit">Apply</button>
      </form>
      <SavedViewsControls formSelector="#alert-filters" />
      <table>
        <thead><tr><th>Device</th><th>Type</th><th>Severity</th><th>State</th><th>Opened</th><th>Clients</th><th>Action</th></tr></thead>
        <tbody id="alerts-tbody">
          {alerts.map((a) => (
            <tr>
              <td>{a.device_id}</td>
              <td>{a.type}</td>
              <td>{a.severity}</td>
              <td>{a.state}</td>
              <td>{a.opened_at}</td>
              <td>{a.clients ?? '—'}</td>
              <td>
                {a.state !== 'closed' && (
                  <form method="post" action={`/api/alerts/${a.alert_id}/ack`}>
                    <button class="btn" type="submit">Ack</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <script dangerouslySetInnerHTML={{ __html: alertsScript }} />
    </div>
  );
}

export function DevicesPage(props: { rows: any[] }) {
  return (
    <div class="card">
      <h2>Devices</h2>
      <form id="device-filters" style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 16px">
        <label>Site
          <input type="text" id="site-filter" name="site" placeholder="SITE-CT-001" />
        </label>
        <label>Region
          <select id="region-select" name="region">
            <option value="">All regions</option>
          </select>
        </label>
        <label>Client
          <select id="client-select" name="client">
            <option value="">All clients</option>
          </select>
        </label>
        <label>Online
          <select name="online">
            <option value="">All</option>
            <option value="1">Online</option>
            <option value="0">Offline</option>
          </select>
        </label>
        <button class="btn" type="submit">Apply</button>
        <label>Window (h)
          <input type="number" id="incident-hours" min="1" max="168" step="1" value="24" style="width:80px" />
        </label>
        <button class="btn" id="incident-btn" type="button" disabled>Generate Incident PDF</button>
      </form>
      <SavedViewsControls formSelector="#device-filters" />
      <table>
        <thead><tr><th>Device</th><th>Site</th><th>Region</th><th>Clients</th><th>Online</th><th>Last seen</th></tr></thead>
        <tbody id="devices-tbody">
          {props.rows.map((r) => (
            <tr>
              <td>{r.device_id}</td>
              <td>{r.site_name ?? r.site_id}</td>
              <td>{r.region ?? '—'}</td>
              <td>{r.clients ?? '—'}</td>
              <td>{r.online ? 'Yes' : 'No'}</td>
              <td>{r.last_seen_at ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <script dangerouslySetInnerHTML={{ __html: devicesScript }} />
    </div>
  );
}

export function AdminArchivePage(props: { date: string; rows: AdminArchiveRow[] }) {
  const { date, rows } = props;
  const maxDate = new Date().toISOString().slice(0, 10);
  const selectedDate = date || maxDate;
  const totalSize = rows.reduce((sum, row) => sum + (Number.isFinite(row.size) ? row.size : 0), 0);
  const formatSize = (value: number | null | undefined) => {
    if (value == null || Number.isNaN(Number(value))) {
      return '—';
    }
    const bytes = Number(value);
    if (!Number.isFinite(bytes)) {
      return '—';
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unit = 'B';
    for (const next of units) {
      size /= 1024;
      unit = next;
      if (size < 1024) {
        break;
      }
    }
    const digits = size >= 10 ? 0 : 1;
    return `${size.toFixed(digits)} ${unit}`;
  };
  const formatTimestamp = (value: string | null) => {
    if (!value) {
      return '—';
    }
    try {
      const iso = new Date(value).toISOString();
      return iso.replace('T', ' ').replace('.000Z', 'Z');
    } catch {
      return value;
    }
  };
  return (
    <div class="card">
      <h2>Admin — Archive exports</h2>
      <form id="archive-form" class="archive-form" method="get" action="/admin/archive">
        <label>
          Date
          <input type="date" name="date" value={selectedDate} max={maxDate} />
        </label>
        <button class="btn" type="submit">Load</button>
      </form>
      {rows.length ? (
        <>
          <p class="archive-summary">
            {rows.length} exports · Total {formatSize(totalSize)}
          </p>
          <table class="archive-table">
            <thead>
              <tr>
                <th>Table</th>
                <th>Rows</th>
                <th>Size</th>
                <th>Key</th>
                <th>Exported</th>
                <th>Download</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>{row.table}</td>
                  <td>{Number.isFinite(row.rows) ? row.rows.toLocaleString() : row.rows}</td>
                  <td title={Number.isFinite(row.size) ? `${row.size} bytes` : undefined}>{formatSize(row.size)}</td>
                  <td><code>{row.key}</code></td>
                  <td>{formatTimestamp(row.exportedAt)}</td>
                  <td>
                    <a
                      class="btn"
                      href={`/api/admin/archive/download?key=${encodeURIComponent(row.key)}`}
                      target="_blank"
                      rel="noopener"
                    >
                      Download
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p class="archive-summary">No exports recorded for {selectedDate}.</p>
      )}
      <script dangerouslySetInnerHTML={{ __html: adminArchiveScript }} />
    </div>
  );
}

export function AdminPresetsPage() {
  return (
    <div class="card">
      <h2>Admin — Export Presets</h2>
      <p class="muted">
        Define column presets for CSV exports. Stored as <code>export_presets_telemetry</code>,{' '}
        <code>export_presets_alerts</code>, <code>export_presets_incidents</code> in <code>settings</code>.
      </p>

      <form
        id="presets-form"
        style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px"
      >
        <fieldset class="card" style="padding:12px">
          <legend>Telemetry</legend>
          <textarea
            name="telemetry"
            rows="12"
            style="width:100%;font-family:ui-monospace,monospace"
          ></textarea>
        </fieldset>
        <fieldset class="card" style="padding:12px">
          <legend>Alerts</legend>
          <textarea name="alerts" rows="12" style="width:100%;font-family:ui-monospace,monospace"></textarea>
        </fieldset>
        <fieldset class="card" style="padding:12px">
          <legend>Incidents</legend>
          <textarea
            name="incidents"
            rows="12"
            style="width:100%;font-family:ui-monospace,monospace"
          ></textarea>
        </fieldset>
      </form>

      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn" id="btn-validate">
          Validate
        </button>
        <button class="btn btn-primary" id="btn-save">
          Save
        </button>
        <button class="btn" id="btn-example">
          Insert example
        </button>
      </div>
      <pre id="presets-msg" class="muted" style="white-space:pre-wrap;margin-top:8px"></pre>

      <script
        dangerouslySetInnerHTML={{
          __html: `
        (function(){
          const form = document.getElementById('presets-form');
          const msg  = document.getElementById('presets-msg');
          const ex = () => JSON.stringify([{id:'triage',name:'Triage',cols:['ts','device_id']}], null, 2);
          const ok = t => { msg.textContent=t; msg.style.color='var(--gb-text)'; };
          const bad= t => { msg.textContent=t; msg.style.color='#ff4d4f'; };

          async function load(){
            const r = await fetch('/api/admin/presets'); const j = await r.json();
            ['telemetry','alerts','incidents'].forEach(k => form[k].value = JSON.stringify(j[k]||[], null, 2));
          }
          function parse(s){ try{ return JSON.parse(s); }catch(e){ return e; } }
          function v(arr){ if(!Array.isArray(arr)) return 'must be array';
            for(let i=0;i<arr.length;i++){ const p=arr[i];
              if(!p||typeof p!=='object'||!p.id||!p.name||!Array.isArray(p.cols)) return 'id,name,cols[] required';
            } return null;
          }
          document.getElementById('btn-example').onclick = ()=>{ ['telemetry','alerts','incidents'].forEach(k=>{ if(!form[k].value.trim()) form[k].value=ex(); }); ok('Examples inserted.'); };
          document.getElementById('btn-validate').onclick = ()=> {
            const errs = ['telemetry','alerts','incidents'].map(k=>{
              const j = parse(form[k].value); return (j instanceof Error) ? k+': '+j.message : (v(j) ? k+': '+v(j) : null);
            }).filter(Boolean);
            errs.length ? bad('Errors:\\n'+errs.join('\\n')) : ok('Looks valid.');
          };
          document.getElementById('btn-save').onclick = async ()=>{
            for (const k of ['telemetry','alerts','incidents']){
              const j = parse(form[k].value); if (j instanceof Error) return bad('Fix '+k+': '+j.message);
              const e = v(j); if (e) return bad('Fix '+k+': '+e);
            }
            for (const k of ['telemetry','alerts','incidents']){
              await fetch('/api/admin/presets', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({table:k, presets: JSON.parse(form[k].value) })});
            }
            ok('Saved.');
          };
          load();
        })();
      `,
        }}
      />
    </div>
  );
}

export function AdminEmailPage() {
  return (
    <div class="card">
      <h2>Admin — Email delivery</h2>
      <p class="card-subtle" id="email-status">Loading…</p>
      <form id="email-form" style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 16px">
        <label style="flex:1 1 320px">Webhook URL
          <input type="url" name="email_webhook_url" placeholder="https://hooks.example.com/..." required />
        </label>
        <label style="flex:1 1 220px">From address
          <input type="email" name="email_from" placeholder="reports@greenbro.example" required />
        </label>
        <button class="btn" type="submit">Save</button>
      </form>
      <script dangerouslySetInnerHTML={{ __html: adminEmailScript }} />
    </div>
  );
}

export function AdminSettingsPage(){
  return (
    <div class="card">
      <h2>Admin — Settings</h2>
      <form id="ro-form" style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 16px">
        <label><input type="checkbox" name="read_only"/> Read-only mode</label>
        <label>Ops webhook URL <input type="text" name="ops_webhook_url" placeholder="https://hooks.slack.com/..."/></label>
        <button class="btn" type="submit">Save</button>
      </form>
      <script dangerouslySetInnerHTML={{ __html: `
        (async function(){
          const form = document.getElementById('ro-form');
          async function load(){
            const r = await fetch('/api/admin/settings'); const rows = await r.json();
            const map = Object.fromEntries(rows.map(function(row){ return [row.key, row.value]; }));
            form.read_only.checked = map.read_only === '1';
            form.ops_webhook_url.value = map.ops_webhook_url || '';
          }
          form.addEventListener('submit', async function(e){
            e.preventDefault();
            await fetch('/api/admin/settings', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'read_only',value: form.read_only.checked?'1':'0'})});
            await fetch('/api/admin/settings', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'ops_webhook_url',value: form.ops_webhook_url.value})});
            load();
          });
          load();
        })();
      ` }} />
    </div>
  );
}

export function AdminSitesPage() {
  return (
    <div class="card">
      <h2>Admin — Sites Catalog</h2>
      <form id="add-site" style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 16px">
        <label>Site ID <input type="text" name="siteId" placeholder="SITE-CT-001" required /></label>
        <label>Name <input type="text" name="name" placeholder="Cape Town POC" /></label>
        <label>Region <input type="text" name="region" placeholder="Western Cape" /></label>
        <button class="btn" type="submit">Save</button>
      </form>
      <table>
        <thead><tr><th>Site ID</th><th>Name</th><th>Region</th><th>Action</th></tr></thead>
        <tbody id="sites-tbody"></tbody>
      </table>

      <h2 style="margin-top:20px">Site ↔ Client mappings</h2>
      <form id="add-map" style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 16px">
        <label>Client ID <input type="text" name="clientId" placeholder="client_123" required /></label>
        <label>Site ID <input type="text" name="siteId" placeholder="SITE-CT-001" required /></label>
        <button class="btn" type="submit">Add mapping</button>
      </form>
      <table>
        <thead><tr><th>Client</th><th>Site</th><th>Action</th></tr></thead>
        <tbody id="maps-tbody"></tbody>
      </table>
      <script dangerouslySetInnerHTML={{ __html: adminSitesScript }} />
    </div>
  );
}

export function AdminReportsPage() {
  return (
    <div class="card">
      <h2>Admin — Client Reports</h2>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin:10px 0 16px">
        <label style="min-width:220px">Client
          <select id="reports-client">
            <option value="">Loading…</option>
          </select>
        </label>
        <span class="card-subtle" id="report-status">Select a client to begin.</span>
      </div>
      <h3 style="margin-top:0">Service-level targets</h3>
      <form id="slo-form" style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 20px">
        <input type="hidden" name="clientId" value="" />
        <label>Uptime target
          <input type="number" name="uptimeTarget" step="0.001" min="0" max="1" placeholder="0.999" disabled />
        </label>
        <label>Ingest success target
          <input type="number" name="ingestTarget" step="0.001" min="0" max="1" placeholder="0.999" disabled />
        </label>
        <label>COP target
          <input type="number" name="copTarget" step="0.01" min="0" max="10" placeholder="3.5" disabled />
        </label>
        <label style="flex:1 1 320px">Report recipients
          <textarea name="reportRecipients" rows={2} placeholder="ops@example.com" disabled style="width:100%"></textarea>
        </label>
        <button class="btn" type="submit" disabled>Save targets</button>
      </form>
      <h3>Generate monthly report</h3>
      <form id="report-form" style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 20px">
        <label>Month
          <input type="month" name="month" required />
        </label>
        <button class="btn" type="submit" disabled>Generate PDF</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Report</th>
            <th>Generated</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="reports-tbody">
          <tr>
            <td colSpan={3} class="table-empty">Select a client to list reports</td>
          </tr>
        </tbody>
      </table>
      <script dangerouslySetInnerHTML={{ __html: adminReportsScript }} />
    </div>
  );
}

type AdminReportsOutboxProps = {
  rows: ReportHistoryRow[];
  filters: { clientId: string; siteId: string; type: string; status: string; limit: string };
};

export function AdminReportsOutboxPage(props: AdminReportsOutboxProps) {
  const statusText = props.rows.length === 0 ? 'No reports ready to send.' : `Showing ${props.rows.length} deliveries.`;
  const initialPayload = encodeJson({ rows: props.rows, filters: props.filters });
  const body =
    props.rows.length === 0
      ? (
          <tr>
            <td colSpan={9} class="table-empty">
              No reports found.
            </td>
          </tr>
        )
      : (
          props.rows.map((row) => {
            const recipients = row.recipients.length > 0 ? row.recipients : null;
            return (
              <tr>
                <td>{row.created_at}</td>
                <td>{row.type}</td>
                <td>{row.status}</td>
                <td>{row.client_id ?? '—'}</td>
                <td>{row.site_id ?? '—'}</td>
                <td>{row.subject ?? '—'}</td>
                <td>
                  {recipients
                    ? recipients.map((value, idx) => (
                        <div key={idx}>{value}</div>
                      ))
                    : '—'}
                </td>
                <td>{row.path ? <code>{row.path}</code> : '—'}</td>
                <td>
                  {row.path ? (
                    <button
                      class="btn"
                      type="button"
                      data-action="send-report"
                      data-type={row.type}
                      data-client={row.client_id ?? ''}
                      data-site={row.site_id ?? ''}
                      data-path={row.path}
                      data-subject={row.subject ?? ''}
                    >
                      Email now
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            );
          })
        );

  return (
    <div class="card">
      <h2>Admin — Reports Outbox</h2>
      <form id="reports-outbox-filters" class="reports-outbox-filters">
        <label>
          Type
          <input type="text" name="type" placeholder="monthly" value={props.filters.type} />
        </label>
        <label>
          Status
          <input type="text" name="status" placeholder="generated" value={props.filters.status || 'generated'} />
        </label>
        <label>
          Client
          <input type="text" name="client_id" placeholder="client_123" value={props.filters.clientId} />
        </label>
        <label>
          Site
          <input type="text" name="site_id" placeholder="SITE-001" value={props.filters.siteId} />
        </label>
        <label>
          Limit
          <input type="number" name="limit" min="1" max="200" value={props.filters.limit || '50'} />
        </label>
        <button class="btn" type="submit">
          Apply
        </button>
      </form>
      <p class="card-subtle" id="reports-outbox-status">
        {statusText}
      </p>
      <table class="reports-outbox-table">
        <thead>
          <tr>
            <th>Created</th>
            <th>Type</th>
            <th>Status</th>
            <th>Client</th>
            <th>Site</th>
            <th>Subject</th>
            <th>Recipients</th>
            <th>Path</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="reports-outbox-tbody">{body}</tbody>
      </table>
      <script id="reports-outbox-data" type="application/json">
        {initialPayload}
      </script>
      <script dangerouslySetInnerHTML={{ __html: reportsOutboxScript }} />
    </div>
  );
}

type AdminReportsHistoryProps = { rows: ReportHistoryRow[]; filters: ReportHistoryFilters };

export function AdminReportsHistoryPage(props: AdminReportsHistoryProps) {
  const statusText = props.rows.length === 0 ? 'No deliveries logged yet.' : `Showing ${props.rows.length} deliveries.`;
  const initialPayload = encodeJson({ rows: props.rows, filters: props.filters });

  const body = props.rows.length === 0 ? (
    <tr>
      <td colSpan={9} class="table-empty">
        No deliveries recorded yet.
      </td>
    </tr>
  ) : (
    props.rows.map((row) => {
      const recipients = row.recipients.length > 0 ? row.recipients.join('\n') : null;
      const meta = row.meta ? JSON.stringify(row.meta) : null;
      return (
        <tr>
          <td>{row.created_at}</td>
          <td>{row.type}</td>
          <td>{row.status}</td>
          <td>{row.client_id ?? '—'}</td>
          <td>{row.site_id ?? '—'}</td>
          <td>{row.subject ?? '—'}</td>
          <td>
            {recipients
              ? recipients.split('\n').map((value, idx) => (
                  <div key={idx}>{value}</div>
                ))
              : '—'}
          </td>
          <td>{row.path ? <code>{row.path}</code> : '—'}</td>
          <td>{meta ? <code>{meta}</code> : '—'}</td>
        </tr>
      );
    })
  );

  return (
    <div class="card">
      <h2>Admin — Report Delivery History</h2>
      <form id="report-history-filters" class="report-history-filters">
        <label>
          Client
          <input type="text" name="client_id" placeholder="client_123" value={props.filters.clientId} />
        </label>
        <label>
          Site
          <input type="text" name="site_id" placeholder="SITE-001" value={props.filters.siteId} />
        </label>
        <label>
          Type
          <input type="text" name="type" placeholder="monthly" value={props.filters.type} />
        </label>
        <label>
          Status
          <input type="text" name="status" placeholder="generated" value={props.filters.status} />
        </label>
        <label>
          Limit
          <input type="number" name="limit" min="1" max="500" value={props.filters.limit || '100'} />
        </label>
        <button class="btn" type="submit">
          Apply
        </button>
      </form>
      <p class="card-subtle" id="report-history-status">
        {statusText}
      </p>
      <table class="report-history-table">
        <thead>
          <tr>
            <th>Created</th>
            <th>Type</th>
            <th>Status</th>
            <th>Client</th>
            <th>Site</th>
            <th>Subject</th>
            <th>Recipients</th>
            <th>Path</th>
            <th>Meta</th>
          </tr>
        </thead>
        <tbody id="report-history-tbody">{body}</tbody>
      </table>
      <script id="report-history-data" type="application/json">
        {initialPayload}
      </script>
      <script dangerouslySetInnerHTML={{ __html: reportHistoryScript }} />
    </div>
  );
}

type ClientSloPageProps = { summary: ClientSloSummary; filters: { month: string } };

function buildSparklinePath(series: Array<{ value: number | null }>, width: number, height: number) {
  const values = series
    .map((point) => (typeof point.value === 'number' && Number.isFinite(point.value) ? point.value : null))
    .filter((value): value is number => value != null);
  if (values.length === 0) {
    return { path: '', width, height };
  }
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    max = min + 0.1;
  }
  const span = max - min;
  let path = '';
  series.forEach((point, idx) => {
    if (typeof point.value !== 'number' || !Number.isFinite(point.value)) {
      return;
    }
    const x = series.length <= 1 ? width : (idx / (series.length - 1)) * width;
    const y = height - ((point.value - min) / span) * height;
    path += `${path ? ' L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return { path, width, height };
}

export function ClientSloPage({ summary, filters }: ClientSloPageProps) {
  const monthValue = filters.month || summary.month.key;
  const uptimeValue = summary.metrics.uptimePct;
  const ingestValue = summary.metrics.ingestSuccessPct;
  const copValue = summary.metrics.avgCop;

  const uptimeTarget = summary.targets.uptimeTarget;
  const ingestTarget = summary.targets.ingestTarget;
  const copTarget = summary.targets.copTarget;

  const uptimeStatus =
    uptimeTarget == null || uptimeValue == null ? 'idle' : uptimeValue >= uptimeTarget ? 'pass' : 'fail';
  const ingestStatus =
    ingestTarget == null || ingestValue == null ? 'idle' : ingestValue >= ingestTarget ? 'pass' : 'fail';
  const copStatus = copTarget == null || copValue == null ? 'idle' : copValue >= copTarget ? 'pass' : 'fail';

  const uptimeDisplay = uptimeValue == null ? '—' : `${(uptimeValue * 100).toFixed(2)}%`;
  const ingestDisplay = ingestValue == null ? '—' : `${(ingestValue * 100).toFixed(2)}%`;
  const copDisplay = copValue == null ? '—' : copValue.toFixed(2);

  const uptimeTargetLabel = uptimeTarget == null ? 'Target: —' : `Target: ${(uptimeTarget * 100).toFixed(2)}%`;
  const ingestTargetLabel = ingestTarget == null ? 'Target: —' : `Target: ${(ingestTarget * 100).toFixed(2)}%`;
  const copTargetLabel = copTarget == null ? 'Target: —' : `Target: ${copTarget.toFixed(2)}`;

  const spark = buildSparklinePath(summary.copSparkline, 320, 80);
  const copLatest = latestValue(summary.copSparkline);
  const copRangeText = rangeLabel(summary.copSparkline, 2);

  const severityEntries = Object.entries(summary.metrics.alertsBySeverity).sort((a, b) => b[1] - a[1]);
  const recipients = summary.recipients ?? '—';
  const statusText = `Updated ${summary.updatedAt}`;
  const initialPayload = encodeJson({ summary });

  return (
    <div class="card">
      <h2>Client SLO — {summary.clientName}</h2>
      <div class="slo-meta" id="client-slo-meta">
        Sites {summary.siteCount} · Devices {summary.deviceCount} · Window {summary.window.start} → {summary.window.end}
      </div>
      <form id="client-slo-form" class="slo-form" data-client={summary.clientId}>
        <label>
          Month
          <input type="month" name="month" value={monthValue} />
        </label>
        <button class="btn" type="submit">
          Apply
        </button>
        <button class="btn" type="button" id="client-slo-refresh">
          Refresh
        </button>
      </form>
      <p class="card-subtle" id="client-slo-status">
        {statusText}
      </p>
      <div class="slo-grid">
        <div class="slo-card">
          <span>Uptime</span>
          <span class="slo-metric-value" data-slo-value="uptime">
            {uptimeDisplay}
          </span>
          <span class={`slo-chip ${uptimeStatus}`} data-slo-chip="uptime">
            {uptimeStatus === 'pass' ? 'Met' : uptimeStatus === 'fail' ? 'Miss' : '—'}
          </span>
          <span class="slo-target" data-slo-target="uptime">
            {uptimeTargetLabel}
          </span>
        </div>
        <div class="slo-card">
          <span>Ingest success</span>
          <span class="slo-metric-value" data-slo-value="ingest">
            {ingestDisplay}
          </span>
          <span class={`slo-chip ${ingestStatus}`} data-slo-chip="ingest">
            {ingestStatus === 'pass' ? 'Met' : ingestStatus === 'fail' ? 'Miss' : '—'}
          </span>
          <span class="slo-target" data-slo-target="ingest">
            {ingestTargetLabel}
          </span>
        </div>
        <div class="slo-card">
          <span>Average COP</span>
          <span class="slo-metric-value" data-slo-value="cop">
            {copDisplay}
          </span>
          <span class={`slo-chip ${copStatus}`} data-slo-chip="cop">
            {copStatus === 'pass' ? 'Met' : copStatus === 'fail' ? 'Miss' : '—'}
          </span>
          <span class="slo-target" data-slo-target="cop">
            {copTargetLabel}
          </span>
        </div>
      </div>
      <div class="slo-spark">
        <h3 style="margin-top:0">COP trend (last 7 days)</h3>
        <svg id="client-slo-sparkline" viewBox={`0 0 ${spark.width} ${spark.height}`}>
          <rect x="0" y="0" width={spark.width} height={spark.height} fill="#0b1119" stroke="#1e2632" />
          {spark.path ? (
            <path
              d={spark.path}
              fill="none"
              stroke="#3fb950"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
        </svg>
        <div class="slo-spark-meta">
          <span>
            Latest: <strong data-slo-cop-latest>{copLatest != null ? copLatest.toFixed(2) : '—'}</strong>
          </span>
          <span data-slo-cop-range>{copRangeText}</span>
        </div>
      </div>
      <div class="slo-heatmap">
        <div class="slo-heatmap-header">
          <h3 style="margin:0">
            Uptime calendar
            <span class="slo-heatmap-month" id="client-slo-heatmap-title">
              ({summary.month.label})
            </span>
          </h3>
          <span id="client-slo-heatmap-status">Loading…</span>
        </div>
        <div class="slo-heatmap-grid" id="client-slo-heatmap"></div>
        <div class="slo-heatmap-empty" id="client-slo-heatmap-empty">Loading…</div>
        <div class="slo-heatmap-legend">
          <span>0%</span>
          <div class="bar" />
          <span>100%</span>
        </div>
      </div>
      <div class="slo-alerts">
        <h3 style="margin-top:0">Alerts by severity</h3>
        <ul id="client-slo-alerts-list">
          {severityEntries.length === 0 ? (
            <li>No alerts recorded for this window.</li>
          ) : (
            severityEntries.map(([severity, count]) => (
              <li>
                <strong>{severity}</strong>: {count}
              </li>
            ))
          )}
        </ul>
      </div>
      <div class="slo-meta" style="margin-top:16px">
        Recipients: <span id="client-slo-recipients">{recipients}</span>
      </div>
      <script id="client-slo-data" type="application/json">
        {initialPayload}
      </script>
      <script dangerouslySetInnerHTML={{ __html: clientSloScript }} />
    </div>
  );
}

export function AdminMaintenancePage() {
  return (
    <div class="card">
      <h2>Admin — Maintenance windows</h2>
      <form id="maintenance-form" class="maintenance-form">
        <label>Site
          <input type="text" name="siteId" placeholder="SITE-CT-001" />
        </label>
        <label>Device
          <input type="text" name="deviceId" placeholder="GBR-HP-12345" />
        </label>
        <label>Start
          <input type="datetime-local" name="startTs" required />
        </label>
        <label>End
          <input type="datetime-local" name="endTs" required />
        </label>
        <label style="flex:1">Reason
          <input type="text" name="reason" placeholder="Firmware rollout" />
        </label>
        <button class="btn" type="submit">Schedule window</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Scope</th>
            <th>Start</th>
            <th>End</th>
            <th>Reason</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="maintenance-tbody">
          <tr>
            <td colSpan={6} class="table-empty">Loading…</td>
          </tr>
        </tbody>
      </table>
      <script dangerouslySetInnerHTML={{ __html: maintenanceScript }} />
    </div>
  );
}
