
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

const overviewScript = `
(function(){
  const root = document.getElementById('overview');
  if(!root) return;

  const dataEl = document.getElementById('overview-data');
  const mapSvg = root.querySelector('#fleet-map');
  const updatedEl = root.querySelector('[data-updated]');
  const listEl = root.querySelector('#fleet-sites');
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
`;

export const renderer = jsxRenderer(({ children }) => {
  const c = useRequestContext();
  const path = c.req.path;
  const isActive = (href: string) => {
    if (href === '/') {
      return path === '/';
    }
    if (href === '/admin/sites') {
      return path === '/admin' || path.startsWith('/admin/');
    }
    return path === href || path.startsWith(`${href}/`);
  };

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>GreenBro Dashboard</title>
      <style>{`
        :root{--bg:#0b0e12;--card:#121721;--text:#e6edf3;--muted:#91a0b4;--accent:#3fb950}
        body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,Segoe UI,Roboto}
        header{display:flex;gap:12px;align-items:center;padding:14px 18px;background:#0d131b;border-bottom:1px solid #1e2632}
        nav a{color:var(--muted);text-decoration:none;margin-right:14px}
        nav a.active{color:var(--text)}
        .wrap{max-width:1100px;margin:0 auto;padding:18px}
        .card{background:var(--card);border:1px solid #1e2632;border-radius:14px;padding:16px}
        .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
        .btn{background:var(--accent);color:#04110a;border:none;padding:8px 12px;border-radius:10px;cursor:pointer}
        table{width:100%;border-collapse:collapse}
        th,td{padding:8px 10px;border-bottom:1px solid #1e2632}
        label{display:flex;gap:6px;align-items:center;color:var(--muted)}
        select,input[type=text]{background:#0b1119;color:var(--text);border:1px solid #1e2632;border-radius:8px;padding:6px}
        button{cursor:pointer}
        .overview-layout{display:grid;gap:16px}
        .overview-kpis{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
        .kpi-card{display:flex;flex-direction:column;gap:6px}
        .kpi-value{font-size:32px;font-weight:600}
        .fleet-card{display:flex;flex-direction:column;gap:12px}
        .fleet-map-wrap{width:100%;overflow:hidden;border-radius:14px}
        .fleet-map{width:100%;height:auto;display:block}
        .legend{display:flex;flex-wrap:wrap;gap:12px;color:var(--muted);font-size:13px}
        .legend span{display:flex;align-items:center;gap:6px}
        .legend .swatch{width:10px;height:10px;border-radius:50%}
        .fleet-sites{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:180px;overflow:auto}
        .fleet-sites li{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--muted)}
        .fleet-sites .dot{width:10px;height:10px;border-radius:50%}
        .fleet-sites .name{color:var(--text);font-weight:600}
        .fleet-sites .empty{justify-content:center;font-style:italic}
        .sparkline-grid{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
        .sparkline-card{display:flex;flex-direction:column;gap:10px}
        .sparkline-chart{width:100%;height:auto}
        .sparkline-meta{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--muted)}
        .sparkline-meta strong{color:var(--text);font-weight:600}
        .card-header{display:flex;justify-content:space-between;align-items:center;gap:10px}
        .card-subtle{color:var(--muted);font-size:13px}
      `}</style>
      </head>
      <body>
        <header>
          <strong>GreenBro</strong>
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
              Admin
            </a>
          </nav>
        </header>
        <div class="wrap">{children}</div>
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

      <div class="card fleet-card">
        <div class="card-header">
          <h2>Fleet map</h2>
          <span class="card-subtle" data-updated>Updated just now</span>
        </div>
        <div class="fleet-map-wrap">
          <svg
            id="fleet-map"
            viewBox="0 0 600 360"
            class="fleet-map"
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
        <ul id="fleet-sites" class="fleet-sites"></ul>
      </div>

      <div class="grid sparkline-grid">
        <div class="card sparkline-card">
          <h3>ΔT last 24h</h3>
          <svg id="sparkline-delta" class="sparkline-chart" viewBox="0 0 320 80" preserveAspectRatio="none"></svg>
          <div class="sparkline-meta">
            <span>
              Now <strong data-sparkline-value="delta">{deltaLast != null ? deltaLast.toFixed(1) : '—'}</strong>°C
            </span>
            <span data-sparkline-range="delta">{deltaRange ? `${deltaRange} °C` : ''}</span>
          </div>
        </div>
        <div class="card sparkline-card">
          <h3>COP last 24h</h3>
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

export function OpsPage(props: { gauges: { ingestSuccessPct: number; p95IngestMs: number; heartbeatFreshnessMin: number } }) {
  const g = props.gauges;
  return (
    <div class="grid">
      <div class="card"><h3>Ingest success %</h3><div style="font-size:28px">{g.ingestSuccessPct.toFixed(1)}%</div></div>
      <div class="card"><h3>p95 ingest→cache</h3><div style="font-size:28px">{Math.round(g.p95IngestMs)} ms</div></div>
      <div class="card"><h3>Heartbeat freshness</h3><div style="font-size:28px">{Math.round(g.heartbeatFreshnessMin)} min</div></div>
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
