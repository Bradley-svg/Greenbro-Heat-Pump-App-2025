import { useQuery } from '@tanstack/react-query';
import { useAppConfig } from '@app/providers/ConfigProvider';

export function useBaselineCompare(
  deviceId: string,
  kind: 'delta_t' | 'cop' | 'current',
  domain: [number, number] | null,
) {
  const { workerOrigin } = useAppConfig();

  return useQuery({
    queryKey: ['baseline:cmp', deviceId, kind, domain?.[0], domain?.[1]],
    enabled: Boolean(deviceId && domain),
    queryFn: async () => {
      const [from, to] = domain!;
      const path = `/api/devices/${deviceId}/baseline-compare`;
      const search = new URLSearchParams();
      search.set('kind', kind);
      search.set('from', String(from));
      search.set('to', String(to));
      const absoluteUrl = workerOrigin
        ? `${new URL(path, workerOrigin).toString()}?${search.toString()}`
        : `${path}?${search.toString()}`;
      const response = await fetch(absoluteUrl);
      if (!response.ok) {
        throw new Error('Failed to load baseline comparison');
      }
      return response.json();
    },
    staleTime: 10_000,
  });
}
