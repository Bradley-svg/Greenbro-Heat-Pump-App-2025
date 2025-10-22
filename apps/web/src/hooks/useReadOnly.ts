import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@api/client';
import type { PublicSettings } from '@api/types';
import { useAuthFetch } from './useAuthFetch';

export function useReadOnly() {
  const authFetch = useAuthFetch();
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ['settings', 'public'],
    queryFn: () => apiFetch<PublicSettings>('/api/settings/public', undefined, authFetch),
    refetchInterval: 60_000,
    staleTime: 55_000,
  });

  const mutation = useMutation({
    mutationFn: async (next: boolean) =>
      apiFetch<PublicSettings>(
        '/api/admin/settings',
        {
          method: 'POST',
          body: JSON.stringify({ readOnly: next }),
        },
        authFetch,
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(['settings', 'public'], data);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'public'] });
    },
  });

  const toggle = useCallback(() => {
    if (settingsQuery.data && !mutation.isPending) {
      mutation.mutate(!settingsQuery.data.readOnly);
    }
  }, [mutation, settingsQuery.data]);

  return {
    ro: settingsQuery.data?.readOnly ?? false,
    canToggle: Boolean(settingsQuery.data?.canToggle),
    toggle,
    isPending: settingsQuery.isPending || mutation.isPending,
    error: settingsQuery.error ?? mutation.error ?? null,
  };
}
