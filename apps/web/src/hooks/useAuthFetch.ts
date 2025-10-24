import { useCallback } from 'react';
import { authFetch } from '@api/client';

export function useAuthFetch() {
  return useCallback(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => authFetch(input, init),
    [],
  );
}
