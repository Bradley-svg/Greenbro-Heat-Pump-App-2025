import { useQuery } from '@tanstack/react-query';
import type { OverviewKpis, OverviewSparklineResponse } from '@api/types';

type UseOverviewDataOptions = {
  onlyBad?: boolean;
};

export type SiteSearchResult = {
  site_id?: string | null;
  siteId?: string | null;
  name?: string | null;
  region?: string | null;
  lat?: number | null;
  lon?: number | null;
  total_devices?: number | null;
  online_devices?: number | null;
  offline_devices?: number | null;
  open_alerts?: number | null;
  freshness_min?: number | null;
  health?: 'healthy' | 'unhealthy' | 'empty';
};

export type OverviewKpisExtended = OverviewKpis & {
  heartbeat_fresh_min?: number;
  heartbeat_freshness_min?: number;
  low_delta_count?: number;
};

export function useOverviewData(options: UseOverviewDataOptions = {}) {
  const { onlyBad = false } = options;

  const kpiQuery = useQuery({
    queryKey: ['overview-kpis'],
    queryFn: async (): Promise<OverviewKpisExtended> => {
      const res = await fetch('/api/overview/kpis');
      if (!res.ok) {
        throw new Error('Failed to load KPIs');
      }
      return res.json();
    },
    refetchInterval: 10_000,
  });

  const burnQuery = useQuery({
    queryKey: ['ops-burn'],
    queryFn: async (): Promise<number[]> => {
      const res = await fetch('/api/ops/burn-series?window=10m&step=1m');
      if (!res.ok) {
        return [];
      }
      const json = await res.json();
      const series: unknown[] = Array.isArray(json?.series) ? json.series : [];
      return series.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    },
    refetchInterval: 10_000,
  });

  const sparkQuery = useQuery({
    queryKey: ['overview-sparklines'],
    queryFn: async (): Promise<OverviewSparklineResponse> => {
      const res = await fetch('/api/overview/sparklines');
      if (!res.ok) {
        return { cop: [], delta_t: [] } satisfies OverviewSparklineResponse;
      }
      return res.json();
    },
    refetchInterval: 10_000,
  });

  const sitesQuery = useQuery({
    queryKey: ['sites', { onlyBad }],
    queryFn: async (): Promise<SiteSearchResult[]> => {
      const params = new URLSearchParams({ limit: '500', offset: '0' });
      if (onlyBad) {
        params.set('only_unhealthy', '1');
      }
      const res = await fetch(`/api/sites/search?${params.toString()}`);
      if (!res.ok) {
        throw new Error('Failed to load sites');
      }
      const json = await res.json();
      if (Array.isArray(json?.results)) {
        return json.results as SiteSearchResult[];
      }
      if (Array.isArray(json)) {
        return json as SiteSearchResult[];
      }
      return [];
    },
    refetchInterval: 10_000,
  });

  return { kpiQuery, burnQuery, sparkQuery, sitesQuery } as const;
}
