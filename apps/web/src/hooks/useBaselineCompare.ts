import { useQuery } from '@tanstack/react-query';

export function useBaselineCompare(
  deviceId: string,
  kind: 'delta_t' | 'cop' | 'current',
  domain: [number, number] | null,
) {
  return useQuery({
    queryKey: ['baseline:cmp', deviceId, kind, domain?.[0], domain?.[1]],
    enabled: Boolean(deviceId && domain),
    queryFn: async () => {
      const [from, to] = domain!;
      const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
      const url = new URL(`/api/devices/${deviceId}/baseline-compare`, origin);
      url.searchParams.set('kind', kind);
      url.searchParams.set('from', String(from));
      url.searchParams.set('to', String(to));
      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error('Failed to load baseline comparison');
      }
      return response.json();
    },
    staleTime: 10_000,
  });
}
