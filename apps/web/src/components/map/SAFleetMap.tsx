import React from 'react';

export function SAFleetMap({ sites, width = 820, height = 420, onClickMarker }:{
  sites:any[]; width?:number; height?:number; onClickMarker:(siteId:string)=>void
}){
  const pts = sites.filter(s=> s.lat!=null && s.lon!=null);
  if (!pts.length) return <div style={{ padding:12, color:'#666' }}>No geo-tagged sites yet.</div>;

  const minLat = Math.min(...pts.map(p=> p.lat)), maxLat = Math.max(...pts.map(p=> p.lat));
  const minLon = Math.min(...pts.map(p=> p.lon)), maxLon = Math.max(...pts.map(p=> p.lon));
  const pad = 12;
  function xy(lat:number, lon:number){
    const x = pad + ( (lon - minLon) / (maxLon - minLon || 1) ) * (width - pad*2);
    const y = pad + ( 1 - (lat - minLat) / (maxLat - minLat || 1) ) * (height - pad*2);
    return { x, y };
  }
  const circles = pts.map(p=>{
    const {x,y} = xy(p.lat, p.lon);
    const color = p.health==='unhealthy' || !p.online ? '#ef4444' : '#22c55e';
    const name = p.name || p.site_id;
    const alerts = p.open_alerts ?? 'n/a';
    const fresh = p.freshness_min != null ? `${p.freshness_min} min` : 'n/a';
    return { x, y, id:p.site_id, color, name, alerts, fresh };
  });
  return (
    <svg width={width} height={height} style={{ width:'100%', height:'auto' }}>
      <rect x={0} y={0} width={width} height={height} fill="#f8fafc" stroke="#e2e8f0"/>
      {circles.map(c => (
        <g key={c.id} onClick={()=> onClickMarker(c.id)} style={{ cursor:'pointer' }}>
          <circle cx={c.x} cy={c.y} r={7} fill={c.color} stroke="#0b0e12" strokeWidth={1}/>
          <title>{`${c.name}\nOnline: ${c.color==='#22c55e'?'Yes':'No'}\nOpen alerts: ${c.alerts}\nLast heartbeat: ${c.fresh}`}</title>
          <text x={c.x+10} y={c.y+4} fontSize={12} fill="#0b0e12">{c.name}</text>
        </g>
      ))}
    </svg>
  );
}
