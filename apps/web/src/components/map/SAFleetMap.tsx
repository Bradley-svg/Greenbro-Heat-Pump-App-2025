interface FleetMapSite {
  siteId: string;
  name: string;
  region: string;
  lat: number;
  lon: number;
  online: boolean;
}

interface SAFleetMapProps {
  sites: FleetMapSite[];
  onSelectSite?: (siteId: string) => void;
}

const MAP_WIDTH = 420;
const MAP_HEIGHT = 360;
const LAT_RANGE = { min: -35.0, max: -22.0 };
const LON_RANGE = { min: 16.0, max: 33.0 };

function project(lat: number, lon: number) {
  const clampedLat = Math.min(Math.max(lat, LAT_RANGE.min), LAT_RANGE.max);
  const clampedLon = Math.min(Math.max(lon, LON_RANGE.min), LON_RANGE.max);
  const x = ((clampedLon - LON_RANGE.min) / (LON_RANGE.max - LON_RANGE.min)) * MAP_WIDTH;
  const y = ((LAT_RANGE.max - clampedLat) / (LAT_RANGE.max - LAT_RANGE.min)) * MAP_HEIGHT;
  return { x, y };
}

export function SAFleetMap({ sites, onSelectSite }: SAFleetMapProps): JSX.Element {
  const markers = sites.filter((site) => Number.isFinite(site.lat) && Number.isFinite(site.lon));

  return (
    <div className="fleet-map">
      <svg
        className="fleet-map__svg"
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        role="img"
        aria-label="South African fleet map"
      >
        <defs>
          <radialGradient id="map-glow" cx="50%" cy="40%" r="70%">
            <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect x="0" y="0" width={MAP_WIDTH} height={MAP_HEIGHT} rx="16" fill="#0f172a" />
        <rect x="1" y="1" width={MAP_WIDTH - 2} height={MAP_HEIGHT - 2} rx="15" fill="#111c32" stroke="#1f2937" />
        <ellipse cx={MAP_WIDTH / 2} cy={MAP_HEIGHT / 2} rx={MAP_WIDTH * 0.45} ry={MAP_HEIGHT * 0.55} fill="url(#map-glow)" />
        {markers.map((site) => {
          const { x, y } = project(site.lat, site.lon);
          const tone = site.online ? '#22c55e' : '#f97316';
          return (
            <g
              key={site.siteId}
              className="fleet-map__marker"
              transform={`translate(${x}, ${y})`}
              onClick={() => onSelectSite?.(site.siteId)}
              role="button"
            >
              <circle r="6" fill="#0f172a" stroke={tone} strokeWidth="2" />
              <circle r="3" fill={tone} />
              <text x="10" y="4" className="fleet-map__label">
                {site.name}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="fleet-map__legend" aria-hidden="true">
        <span className="fleet-map__dot fleet-map__dot--online" /> Online
        <span className="fleet-map__dot fleet-map__dot--offline" /> Offline
      </div>
    </div>
  );
}
