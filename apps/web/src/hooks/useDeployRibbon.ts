import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authFetch } from '@api/client';
import { useAuth } from '@app/providers/AuthProvider';

type DeployMeta = { color: 'blue' | 'green'; msg?: string } | null;

async function fetchReadiness(): Promise<{ deploy: DeployMeta } | null> {
  const response = await authFetch('/api/ops/readiness');
  if (!response.ok) {
    return null;
  }
  const json = await response.json();
  return { deploy: (json.deploy as DeployMeta) ?? null };
}

export function useDeployRibbon(pollMs = 60_000) {
  const { user } = useAuth();
  const isAllowed = Boolean(user && (user.roles?.includes('admin') || user.roles?.includes('ops')));
  const query = useQuery({
    queryKey: ['ops', 'readiness', 'deploy'],
    queryFn: fetchReadiness,
    refetchInterval: isAllowed ? pollMs : undefined,
    enabled: isAllowed,
    staleTime: 0,
  });

  const key = useMemo(() => {
    const deploy = query.data?.deploy;
    return deploy ? `deploy_ribbon_hide:${deploy.color}:${deploy.msg ?? ''}` : '';
  }, [query.data?.deploy]);

  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!key) {
      setDismissed(false);
      return;
    }
    try {
      const hidden = sessionStorage.getItem(key) === '1';
      setDismissed(hidden);
    } catch {
      setDismissed(false);
    }
  }, [key]);

  function dismiss() {
    if (key) {
      try {
        sessionStorage.setItem(key, '1');
      } catch {
        /* ignore storage errors */
      }
    }
    setDismissed(true);
  }

  const deploy = dismissed ? null : query.data?.deploy ?? null;

  return { deploy, dismiss, loading: query.isLoading, error: query.error as Error | undefined };
}
