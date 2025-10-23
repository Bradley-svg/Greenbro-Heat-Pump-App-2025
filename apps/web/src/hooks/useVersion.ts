import { useQuery } from '@tanstack/react-query';
import { authFetch } from '@api/client';
import { useAuth } from '@app/providers/AuthProvider';

type Version = { build_sha: string; build_date?: string; schema_ok?: boolean };

export function useVersion(pollMs = 300_000) {
  const { user } = useAuth();
  const allowed = !!user && (user.roles?.includes('admin') || user.roles?.includes('ops'));
  return useQuery<Version | null>({
    queryKey: ['ops', 'version'],
    queryFn: async () => {
      const response = await authFetch('/api/ops/version');
      if (!response.ok) {
        return null;
      }
      return response.json();
    },
    enabled: allowed,
    refetchInterval: allowed ? pollMs : undefined,
    staleTime: 0,
  });
}
