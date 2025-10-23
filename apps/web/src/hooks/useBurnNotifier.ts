import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useToast } from '@app/providers/ToastProvider';
import { authFetch } from '@api/client';

// Helper: banding to mirror your pill colours
function band(burn: number){
  if (!isFinite(burn)) return 'unknown';
  if (burn <= 1.0) return 'green';
  if (burn <= 2.0) return 'amber';
  return 'red';
}

type BurnPoint = { ts: string; burn: number; errRate?: number };
async function fetchBurnSeries(): Promise<BurnPoint[]> {
  const r = await authFetch('/api/ops/burn-series?minutes=10'); // existing Worker endpoint
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export function useBurnNotifier(opts: { refetchMs?: number } = {}){
  const toast = useToast();
  const refetchMs = opts.refetchMs ?? 60000; // poll every 60s
  const lastBand = useRef<string>('unknown');
  const lastToastKey = useRef<string>('');   // avoid duplicate spam
  const lastToastAt = useRef<number>(0);

  const q = useQuery({
    queryKey: ['ops','burn-series','10m'],
    queryFn: fetchBurnSeries,
    refetchInterval: refetchMs,
    staleTime: 0,
  });

  const latest = useMemo(() => {
    const arr = q.data ?? [];
    return arr.length ? arr[arr.length - 1] : undefined;
  }, [q.data]);

  useEffect(() => {
    if (!latest) return;
    const b = band(latest.burn);
    const was = lastBand.current;

    // Flip -> RED (≥2x): warn once
    if (was !== 'red' && b === 'red') {
      const key = `red:${Math.round(latest.burn*100)}`;
      const now = Date.now();
      if (lastToastKey.current !== key || now - lastToastAt.current > 5*60_000) {
        // show % error too (friendly)
        const errPct = latest.errRate != null ? ` — errors ${(latest.errRate*100).toFixed(1)}%` : '';
        toast.warning(`Fast burn ≥2× (10-min window)${errPct}`);
        lastToastKey.current = key;
        lastToastAt.current = now;
      }
    }

    // Recovery -> GREEN (≤1x): success once
    if (was === 'red' && b === 'green') {
      const key = `green:${Math.round((latest.errRate ?? 0)*1000)}`;
      const now = Date.now();
      if (lastToastKey.current !== key || now - lastToastAt.current > 5*60_000) {
        toast.success('Burn recovered ≤1× (10-min window)');
        lastToastKey.current = key;
        lastToastAt.current = now;
      }
    }

    lastBand.current = b;
  }, [latest, toast]);

  return { loading: q.isLoading, error: q.error as Error|undefined, latest };
}
