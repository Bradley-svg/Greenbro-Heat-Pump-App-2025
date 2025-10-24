import { useQuery } from '@tanstack/react-query';
import { Sparkline } from '@components/charts/Sparkline';
import { useBurnNotifier } from '@hooks/useBurnNotifier';

type DeviationCounters = Record<'delta_t' | 'cop' | 'current', { warning: number; critical: number }>;

type DeviationHotlistEntry = {
  device_id: string;
  kind: 'delta_t' | 'cop' | 'current';
  any_crit: number;
  since: string;
  coverage: number | null;
  drift: number | null;
  site_id: string | null;
  site_name: string | null;
  region: string | null;
};

function useDeviationCounters() {
  return useQuery<DeviationCounters>({
    queryKey: ['ops:dev-counters'],
    queryFn: async () => {
      const response = await fetch('/api/ops/deviation-counters');
      if (!response.ok) {
        throw new Error('Failed to load deviation counters');
      }
      return (await response.json()) as DeviationCounters;
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

function useDeviationHotlist() {
  return useQuery<DeviationHotlistEntry[]>({
    queryKey: ['ops:dev-hotlist'],
    queryFn: async () => {
      const response = await fetch('/api/ops/deviation-hotlist?limit=5');
      if (!response.ok) {
        throw new Error('Failed to load deviation hotlist');
      }
      return (await response.json()) as DeviationHotlistEntry[];
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

function DeviationHotlistCard() {
  const { data } = useDeviationHotlist();
  if (!data?.length) {
    return null;
  }

  return (
    <div className="card">
      <h3>Deviation hotlist (60 min)</h3>
      <ul className="hotlist">
        {data.map((entry) => {
          const key = `${entry.device_id}:${entry.kind}`;
          const label = entry.site_name ?? entry.site_id ?? entry.device_id;
          const coverage = typeof entry.coverage === 'number' ? Math.round(entry.coverage * 100) : null;
          const drift = typeof entry.drift === 'number' ? entry.drift : null;
          const driftSuffix = entry.kind === 'cop' ? '' : entry.kind === 'current' ? 'A' : '°C';
          const driftDigits = entry.kind === 'current' ? 1 : 2;
          return (
            <li key={key}>
              <a href={`/devices/${encodeURIComponent(entry.device_id)}?range=1h`}>
                <span className={`dot ${entry.any_crit ? 'crit' : 'warn'}`} />
                <strong>{label}</strong>
                <span className="muted"> · {entry.region ?? '—'}</span>
                <span className="pill">{entry.kind === 'delta_t' ? 'ΔT' : entry.kind.toUpperCase()}</span>
                {coverage != null && <span className="chip chip-ghost">{coverage}% in-range</span>}
                {drift != null && (
                  <span className="chip chip-ghost">
                    drift {drift >= 0 ? '+' : ''}
                    {drift.toFixed(driftDigits)}
                    {driftSuffix}
                  </span>
                )}
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DeviationCountersCard() {
  const { data } = useDeviationCounters();
  if (!data) {
    return null;
  }

  const renderKind = (kind: 'delta_t' | 'cop' | 'current') => {
    const label = kind === 'delta_t' ? 'ΔT' : kind === 'cop' ? 'COP' : 'Current';
    const entry = data[kind];
    return (
      <div className="kpi" key={kind}>
        <div className="kpi-title">{label}</div>
        <div className="kpi-row">
          <span className="chip warn">Warn {entry.warning}</span>
          <span className="chip crit">Crit {entry.critical}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="card" style={{ padding: 12 }}>
      <h3 style={{ marginTop: 0 }}>Baseline deviations (24 h)</h3>
      <div className="kpi-grid">{renderKind('delta_t')}{renderKind('cop')}{renderKind('current')}</div>
    </div>
  );
}

export default function OpsPage(){
  useBurnNotifier({ refetchMs: 60000 }); // keep in sync with wallboard cadence
  const slo = useQuery({
    queryKey:['ops-slo'],
    queryFn: async ()=> (await (await fetch('/api/ops/slo')).json()),
    refetchInterval: 10000
  });
  const burn = useQuery({
    queryKey:['burn-series'],
    queryFn: async ()=>{
      const r = await fetch('/api/ops/burn-series?window=10m&step=1m');
      if (!r.ok) return [];
      const j = await r.json();
      return (j.series ?? []) as number[];
    },
    refetchInterval: 10000
  });

  const d = slo.data || {};
  const burnSeries = burn.data || [];
  const burnLast = burnSeries.at(-1) ?? 0;
  const burnKind = burnLast > 2 ? 'crit' : burnLast > 1 ? 'warn' : 'ok';
  const baseline = d.baselineDeviation || { window: '24h', warning: 0, critical: 0 };

  return (
    <div style={{ display:'grid', gap:12 }}>
      <h2>Ops — Reliability</h2>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12 }}>
        <GaugeCard title="Ingest success"          value={d.ingest_success_pct}     target={0.999} subtitle="Target 99.9%" />
        <GaugeCard title="Heartbeat freshness"     value={d.heartbeat_freshness_pct} target={0.98}  subtitle="Target 98%" />
        <GaugeCard title="p95 ingest→cache"        value={d.p95_ingest_latency_ms}  target={300}    invert subtitle="Target ≤ 300 ms" fmt={(n)=> n==null? '—' : `${n.toFixed(0)} ms`} />
        <GaugeCard title="Burn rate (10m)"         value={d.burn}                    target={1.0}    invert subtitle="Target ≤ 1.0" fmt={(n)=> n==null? '—' : n.toFixed(2)} />
      </div>

      <div className="card" style={{ padding:12 }}>
        <h3 style={{ marginTop:0 }}>Burn (last 10 minutes)</h3>
        <div style={{ display:'flex', alignItems:'center', gap:16, justifyContent:'space-between' }}>
          <Sparkline data={burnSeries} width={600} height={64} kind={burnKind} showArea ariaLabel="Burn rate trend" />
          <span className={`chip ${burnKind}`}>
            {Number.isFinite(burnLast) ? `${burnLast.toFixed(2)}×` : '—'}
          </span>
        </div>
        <small className="muted">Target ≤ 1.0× (SLO 99.9%)</small>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:12 }}>
        <div className="card" style={{ padding:12 }}>
          <h3 style={{ marginTop:0 }}>Baseline deviation (last 24 h)</h3>
          <div style={{ display:'flex', gap:8 }}>
            <span className={`chip ${baseline.critical > 0 ? 'crit' : 'ok'}`}>
              Critical {baseline.critical}
            </span>
            <span className={`chip ${baseline.warning > 0 ? 'warn' : 'ok'}`}>
              Warning {baseline.warning}
            </span>
          </div>
        </div>
        <DeviationCountersCard />
        <DeviationHotlistCard />
      </div>

      <div className="card">
        <h3>Snapshot</h3>
        <pre style={{ background:'#0b1119', color:'#e6edf3', padding:12, borderRadius:8 }}>{JSON.stringify(d, null, 2)}</pre>
      </div>
    </div>
  );
}
function pct(n?:number){ return n==null? '—' : `${(n*100).toFixed(2)}%`; }
function GaugeCard({ title, value, target, invert=false, fmt=pct, subtitle }:{
  title:string; value?:number; target:number; invert?:boolean; fmt?:(n?:number)=>string; subtitle?: string
}){
  const v = value==null? null : Number(value);
  const pass = v==null? null : (invert? v<=target : v>=target);
  const frac = v==null? 0 : (invert? Math.max(0, Math.min(1, 1 - (v/target))) : Math.max(0, Math.min(1, v/target)));
  const bar = <div style={{ height:8, background:'#e5e7eb', borderRadius:999 }}>
    <div style={{ width:`${(frac*100).toFixed(1)}%`, height:8, borderRadius:999, background: pass==null? '#94a3b8' : pass? '#22c55e' : '#ef4444' }} />
  </div>;
  const display = fmt(v ?? undefined);
  return (
    <div style={{ border:'1px solid #ddd', padding:12, borderRadius:8 }}>
      <div style={{ color:'#666' }}>{title}</div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
        <div
          style={{ fontSize:24 }}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={`${title}: ${display}`}
        >
          {display}
        </div>
        <div style={{ fontSize:12, color:'#666' }}>{subtitle ?? `target ${fmt(target)}`}</div>
      </div>
      {bar}
    </div>
  );
}
