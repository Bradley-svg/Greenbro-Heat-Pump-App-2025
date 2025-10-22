import { useCallback } from 'react';
import { useAuth } from '@app/providers/AuthProvider';

export function useAuthFetch() {
  const { accessToken, refresh, logout } = useAuth();

  return useCallback(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const makeRequest = async (token?: string) => {
        const headers = new Headers(init?.headers ?? {});
        if (token) {
          headers.set('Authorization', `Bearer ${token}`);
        }
        return fetch(input, {
          ...init,
          headers,
        });
      };

      let token = accessToken ?? null;
      if (!token) {
        token = (await refresh()) ?? null;
      }

      if (!token) {
        void logout();
        throw new Response('Unauthorized', { status: 401 });
      }

      let response = await makeRequest(token);

      if (response.status === 401) {
        const refreshed = await refresh();
        if (!refreshed) {
          void logout();
          throw response;
        }
        response = await makeRequest(refreshed);
      }

      return response;
    },
    [accessToken, logout, refresh],
  );
}
