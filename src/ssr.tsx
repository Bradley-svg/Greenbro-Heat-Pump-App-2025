/** @jsxImportSource hono/jsx */
/** @jsxRuntime automatic */
import { jsxRenderer } from 'hono/jsx-renderer';

const alertTableScript = `
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

export const renderer = jsxRenderer(({ children }) => (
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
      `}</style>
    </head>
    <body>
      <header>
        <strong>GreenBro</strong>
        <nav>
          <a href="/" class="active">
            Overview
          </a>
          <a href="/alerts">Alerts</a>
          <a href="/devices">Devices</a>
        </nav>
      </header>
      <div class="wrap">{children}</div>
    </body>
  </html>
));

export function OverviewPage(props: {
  kpis: { onlinePct: number; openAlerts: number; avgCop?: number | null };
}) {
  const { kpis } = props;
  return (
    <div class="grid">
      <div class="card">
        <h3>Online %</h3>
        <div style="font-size:28px">{kpis.onlinePct.toFixed(1)}%</div>
      </div>
      <div class="card">
        <h3>Open alerts</h3>
        <div style="font-size:28px">{kpis.openAlerts}</div>
      </div>
      <div class="card">
        <h3>Avg COP</h3>
        <div style="font-size:28px">{kpis.avgCop ?? '—'}</div>
      </div>
    </div>
  );
}

export function AlertsPage(props: {
  alerts: Array<Record<string, unknown>>;
  filters: { state?: string; severity?: string; type?: string; deviceId?: string };
}) {
  const { alerts, filters } = props;
  const S = (v?: string) => v ?? '';
  const types = [
    'overheat',
    'low_flow_under_load',
    'low_cop',
    'short_cycling',
    'no_heartbeat_warn',
    'no_heartbeat_crit',
  ];
  const severities = ['minor', 'major', 'critical'];
  const states = ['open', 'ack', 'closed'];
  return (
    <div class="card">
      <h2>Alerts</h2>
      <form
        id="alert-filters"
        method="get"
        action="/alerts"
        style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 16px"
      >
        <label>
          State
          <select name="state" value={S(filters.state)}>
            <option value="">All</option>
            {states.map((s) => (
              <option value={s} selected={S(filters.state) === s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Severity
          <select name="severity" value={S(filters.severity)}>
            <option value="">All</option>
            {severities.map((s) => (
              <option value={s} selected={S(filters.severity) === s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type
          <select name="type" value={S(filters.type)}>
            <option value="">All</option>
            {types.map((t) => (
              <option value={t} selected={S(filters.type) === t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Device
          <input type="text" name="deviceId" placeholder="GBR-HP-12345" value={S(filters.deviceId)} />
        </label>
        <button class="btn" type="submit">
          Apply
        </button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Device</th>
            <th>Type</th>
            <th>Severity</th>
            <th>State</th>
            <th>Opened</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="alerts-tbody">
          {alerts.map((a) => (
            <tr>
              <td>{a['device_id'] as string}</td>
              <td>{a['type'] as string}</td>
              <td>{a['severity'] as string}</td>
              <td>{a['state'] as string}</td>
              <td>{a['opened_at'] as string}</td>
              <td>
                {a['state'] !== 'closed' && (
                  <form method="post" action={`/api/alerts/${a['alert_id'] as string}/ack`}>
                    <button class="btn" type="submit">
                      Ack
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <script dangerouslySetInnerHTML={{ __html: alertTableScript }} />
    </div>
  );
}
