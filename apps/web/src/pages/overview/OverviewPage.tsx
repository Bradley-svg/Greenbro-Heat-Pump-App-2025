import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Sparkline } from '@components/charts/Sparkline';
import { SADevicesMap } from '@components/map/SADevicesMap';
import { useMemo, useState } from 'react';

export default function OverviewPage(){
  const nav = useNavigate();
  const [onlyBad, setOnlyBad] = useState(false);

  const kpi = useQuery({
    queryKey:['kpis'],
    queryFn: async ()=> (await (await fetch('/api/overview/kpis')).json()),
    refetchInterval: 10000
  });
  const sites = useQuery({
    queryKey:['sites', { onlyBad }],
    queryFn: async ()=>{
      const url = onlyBad
        ? '/api/sites/search?only_unhealthy=1&limit=500&offset=0'
        : '/api/sites';
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Failed to load sites');
      }
      const payload = await response.json();
      if (onlyBad) {
        return Array.isArray(payload?.results) ? payload.results : [];
      }
      return Array.isArray(payload) ? payload : [];
    },
    refetchInterval: 10000
  });
  const sparks = useQuery({
    queryKey:['sparks'],
    queryFn: async ()=> (await (await fetch('/api/overview/sparklines')).json()) as { cop:number[]; delta_t:number[] },
    refetchInterval: 10000
  });

  const sdataRaw = (sites.data||[]) as any[];
  const sdata = useMemo(
    ()=> onlyBad
      ? sdataRaw.filter(s=> s.health==='unhealthy' || !s.online)
      : sdataRaw,
    [sdataRaw, onlyBad]
  );

  function onMarkerClick(siteId: string){ nav(`/devices?site=${encodeURIComponent(siteId)}`); }

  return (
    <div style={{ display:'grid', gap:12 }}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12 }}>
        <Card title="Online %"   value={fmtPct(kpi.data?.online_pct)} />
        <Card title="Open alerts" value={kpi.data?.open_alerts ?? '—'} />
        <Card title="Avg COP"     value={kpi.data?.avg_cop?.toFixed?.(2) ?? '—'} />
        <Card title="Low ΔT"      value={kpi.data?.low_dt ?? '—'} />
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 320px', gap:12 }}>
        <div style={{ border:'1px solid #ddd', borderRadius:8, padding:8 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
            <h3 style={{ margin:0 }}>Devices map</h3>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <label style={{ fontSize:12 }}>
                <input type="checkbox" checked={onlyBad} onChange={e=> setOnlyBad(e.target.checked)} /> show only unhealthy
              </label>
              <RegionChips
                sites={sdataRaw}
                onClickRegion={(r)=> nav(`/devices?region=${encodeURIComponent(r)}`)}
              />
            </div>
          </div>
          <SADevicesMap sites={sdata} width={820} height={420} onClickMarker={onMarkerClick} />
        </div>

        <div style={{ display:'grid', gap:12 }}>
          <div className="card">
            <h4>Devices ΔT</h4>
            <Sparkline
              data={sparks.data?.delta_t || []}
              width={300}
              height={60}
              kind="warn"
              showArea
              ariaLabel="Devices delta T trend"
            />
          </div>
          <div className="card">
            <h4>Devices COP</h4>
            <Sparkline
              data={sparks.data?.cop || []}
              width={300}
              height={60}
              kind="ok"
              showArea
              ariaLabel="Devices COP trend"
            />
          </div>
        </div>
      </div>

      <div>
        <h3>Sites</h3>
        <ul>
          {sdata.map((s:any)=> <li key={s.site_id}><Link to={`/devices?site=${s.site_id}`}>{s.name ?? s.site_id}</Link></li>)}
        </ul>
      </div>
    </div>
  );
}
function Card({ title, value }:{title:string; value:any}){
  return <div style={{ border:'1px solid #ddd', padding:12, borderRadius:8 }}>
    <div style={{ color:'#666' }}>{title}</div>
    <div style={{ fontSize:24 }}>{value}</div>
  </div>;
}
function fmtPct(n?: number){ return n==null? '—' : `${(n*100).toFixed(1)}%`; }

function RegionChips({ sites, onClickRegion }:{ sites:any[]; onClickRegion:(r:string)=>void }){
  const grouped = sites.reduce((acc:any, s:any)=>{
    const k = s.region || '—';
    acc[k] = acc[k] || { total:0, bad:0 };
    acc[k].total++;
    if (s.health==='unhealthy' || !s.online) acc[k].bad++;
    return acc;
  }, {});
  const keys = Object.keys(grouped);
  return (
    <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
      {keys.map(k => (
        <button key={k} onClick={()=> onClickRegion(k)} style={{ padding:'4px 8px', border:'1px solid #ccc', borderRadius:999 }}>
          {k}: {grouped[k].total} {grouped[k].bad? `• ${grouped[k].bad} ⚠︎` : ''}
        </button>
      ))}
    </div>
  );
}
