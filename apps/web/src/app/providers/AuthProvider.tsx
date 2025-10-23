import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { fetchMe, loadStoredSession, login as apiLogin, logout as apiLogout, refresh as apiRefresh, storeSession } from '@api/auth';
import { setAuthToken } from '@api/client';
import type { AuthStatus, Role, User } from '@utils/types';
import type { AuthTokens } from '@utils/types';
import type { LoginInput } from '@api/auth';

interface AuthContextValue {
  user: User | null;
  status: AuthStatus;
  accessToken: string | null;
  refreshToken: string | null;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<string | null>;
  hasRole: (roles: Role | Role[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function hasRequiredRole(user: User | null, allowed: Role | Role[]): boolean {
  if (!user) return false;
  const required = Array.isArray(allowed) ? allowed : [allowed];
  if (required.length === 0) return true;
  return user.roles.some((role) => required.includes(role));
}

export function AuthProvider({ children }: PropsWithChildren): JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [tokens, setTokens] = useState<AuthTokens | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const refreshPromiseRef = useRef<Promise<string | null> | null>(null);

  const establishSession = useCallback(async (nextTokens: AuthTokens) => {
    try {
      const me = await fetchMe(nextTokens.accessToken);
      setUser(me);
      setTokens(nextTokens);
      setAuthToken(nextTokens.accessToken);
      setStatus('authenticated');
    } catch (error) {
      if (nextTokens.refreshToken) {
        try {
          const refreshed = await apiRefresh(nextTokens.refreshToken);
          const mergedTokens: AuthTokens = {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? nextTokens.refreshToken,
          };
          const resolvedUser = refreshed.user ?? (await fetchMe(refreshed.accessToken));
          setUser(resolvedUser);
          setTokens(mergedTokens);
          setAuthToken(mergedTokens.accessToken);
          setStatus('authenticated');
        } catch (refreshError) {
          console.error('Failed to refresh session', refreshError);
          setUser(null);
          setTokens(null);
          setAuthToken(null);
          setStatus('unauthenticated');
        }
      } else {
        console.error('Failed to establish session', error);
        setUser(null);
        setTokens(null);
        setAuthToken(null);
        setStatus('unauthenticated');
      }
    }
  }, []);

  useEffect(() => {
    const stored = loadStoredSession();
    if (stored?.tokens?.accessToken) {
      setTokens(stored.tokens);
      setAuthToken(stored.tokens.accessToken);
      setUser(stored.user);
      void establishSession(stored.tokens);
    } else {
      setStatus('unauthenticated');
    }
  }, [establishSession]);

  useEffect(() => {
    if (user && tokens) {
      storeSession({ user, tokens });
    } else {
      storeSession(null);
    }
  }, [tokens, user]);

  const login = useCallback(async (input: LoginInput) => {
    setStatus('loading');
    const session = await apiLogin(input);
    setUser(session.user);
    setTokens(session.tokens);
    setAuthToken(session.tokens.accessToken);
    setStatus('authenticated');
    storeSession(session);
  }, []);

  const logout = useCallback(async () => {
    const accessToken = tokens?.accessToken;
    setStatus('loading');
    try {
      await apiLogout(accessToken ?? undefined);
    } finally {
      setUser(null);
      setTokens(null);
      setAuthToken(null);
      setStatus('unauthenticated');
      storeSession(null);
    }
  }, [tokens]);

  const refresh = useCallback(async () => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    if (!tokens?.refreshToken) {
      return null;
    }

    const promise = apiRefresh(tokens.refreshToken)
      .then(async (res) => {
        const mergedTokens: AuthTokens = {
          accessToken: res.accessToken,
          refreshToken: res.refreshToken ?? tokens.refreshToken,
        };
        const nextUser = res.user ?? (await fetchMe(res.accessToken));
        setTokens(mergedTokens);
        setUser(nextUser);
        setAuthToken(mergedTokens.accessToken);
        setStatus('authenticated');
        storeSession({ user: nextUser, tokens: mergedTokens });
        return res.accessToken;
      })
      .catch((error) => {
        console.error('Failed to refresh auth token', error);
        setUser(null);
        setTokens(null);
        setAuthToken(null);
        setStatus('unauthenticated');
        storeSession(null);
        return null;
      })
      .finally(() => {
        refreshPromiseRef.current = null;
      });

    refreshPromiseRef.current = promise;
    return promise;
  }, [tokens, user]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      accessToken: tokens?.accessToken ?? null,
      refreshToken: tokens?.refreshToken ?? null,
      login,
      logout,
      refresh,
      hasRole: (roles) => hasRequiredRole(user, roles),
    }),
    [login, logout, refresh, status, tokens, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
