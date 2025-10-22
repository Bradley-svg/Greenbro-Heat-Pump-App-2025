import { apiFetch } from './client';
import type { SiteSummary } from './types';

interface SiteApiResponse {
  site_id: string;
  name: string;
  region: string;
  lat: number;
  lon: number;
  online: boolean;
  health?: 'good' | 'warning' | 'critical' | 'unknown';
}

export async function getSites(fetchImpl?: typeof fetch) {
  const sites = await apiFetch<SiteApiResponse[]>('/api/sites', undefined, fetchImpl);
  return sites.map<SiteSummary>((site) => ({
    siteId: site.site_id,
    name: site.name,
    region: site.region,
    lat: site.lat,
    lon: site.lon,
    online: site.online,
    health: site.health,
  }));
}
