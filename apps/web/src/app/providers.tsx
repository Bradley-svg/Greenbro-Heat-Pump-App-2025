import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppConfigProvider } from './providers/ConfigProvider';
import { AuthProvider } from './providers/AuthProvider';
import { ToastProvider } from './providers/ToastProvider';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      staleTime: 30_000,
      retry: (failureCount, error) => {
        if (error instanceof Response && error.status === 404) {
          return false;
        }
        return failureCount < 3;
      },
    },
    mutations: {
      retry: 0,
    },
  },
});

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>
      <AppConfigProvider>
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </AppConfigProvider>
    </QueryClientProvider>
  );
}
