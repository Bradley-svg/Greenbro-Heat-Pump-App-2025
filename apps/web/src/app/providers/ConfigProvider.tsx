import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';

interface AppConfig {
  workerOrigin: string | null;
}

const AppConfigContext = createContext<AppConfig | null>(null);

function resolveWorkerOrigin(): string | null {
  if (typeof globalThis !== 'undefined') {
    const fromGlobal = (globalThis as { __APP_CONFIG__?: { workerOrigin?: unknown } }).__APP_CONFIG__;
    if (fromGlobal && typeof fromGlobal.workerOrigin === 'string' && fromGlobal.workerOrigin) {
      return fromGlobal.workerOrigin;
    }
    const fromKey = (globalThis as { __WORKER_ORIGIN__?: unknown }).__WORKER_ORIGIN__;
    if (typeof fromKey === 'string' && fromKey) {
      return fromKey;
    }
  }

  if (
    typeof import.meta !== 'undefined' &&
    typeof (import.meta as unknown as { env?: { VITE_WORKER_ORIGIN?: unknown } }).env?.VITE_WORKER_ORIGIN === 'string'
  ) {
    const envValue = (import.meta as unknown as { env: { VITE_WORKER_ORIGIN: string } }).env.VITE_WORKER_ORIGIN;
    if (envValue) {
      return envValue;
    }
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }

  return null;
}

export function AppConfigProvider({ children }: PropsWithChildren): JSX.Element {
  const value = useMemo<AppConfig>(
    () => ({
      workerOrigin: resolveWorkerOrigin(),
    }),
    [],
  );

  return <AppConfigContext.Provider value={value}>{children}</AppConfigContext.Provider>;
}

export function useAppConfig(): AppConfig {
  const context = useContext(AppConfigContext);
  if (!context) {
    throw new Error('useAppConfig must be used within an AppConfigProvider');
  }
  return context;
}
