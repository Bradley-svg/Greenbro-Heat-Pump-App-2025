import { useQuery } from '@tanstack/react-query';
import { Sparkline } from '@components/charts/Sparkline';

export default function OpsPage(){
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
        <Sparkline data={burn.data || []} width={600} height={64} />
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
  return (
    <div style={{ border:'1px solid #ddd', padding:12, borderRadius:8 }}>
      <div style={{ color:'#666' }}>{title}</div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
        <div style={{ fontSize:24 }}>{fmt(v ?? undefined)}</div>
        <div style={{ fontSize:12, color:'#666' }}>{subtitle ?? `target ${fmt(target)}`}</div>
      </div>
      {bar}
    </div>
  );
}
