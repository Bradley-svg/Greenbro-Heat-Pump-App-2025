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
import { fetchMe, login as apiLogin, logout as apiLogout, refresh as apiRefresh } from '@api/auth';
import { onAuthChange } from '@api/client';
import type { AuthStatus, Role, User } from '@utils/types';
import type { LoginInput } from '@api/auth';

interface AuthContextValue {
  user: User | null;
  status: AuthStatus;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<boolean>;
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
  const [status, setStatus] = useState<AuthStatus>('loading');
  const refreshPromiseRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const initialise = async () => {
      try {
        const me = await fetchMe();
        if (cancelled) return;
        setUser(me);
        setStatus('authenticated');
      } catch {
        if (cancelled) return;
        setUser(null);
        setStatus('unauthenticated');
      }
    };
    void initialise();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthChange((payload) => {
      if (payload?.user) {
        setUser(payload.user);
        setStatus('authenticated');
      }
    });
    return () => {
      void unsubscribe();
    };
  }, []);

  const login = useCallback(async (input: LoginInput) => {
    setStatus('loading');
    try {
      const session = await apiLogin(input);
      setUser(session.user);
      setStatus('authenticated');
    } catch (error) {
      setUser(null);
      setStatus('unauthenticated');
      throw error;
    }
  }, []);

  const logout = useCallback(async () => {
    setStatus('loading');
    try {
      await apiLogout();
    } finally {
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  const refresh = useCallback(async () => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    const promise = apiRefresh()
      .then(async (res) => {
        if (res.user) {
          setUser(res.user);
          setStatus('authenticated');
          return true;
        }
        try {
          const me = await fetchMe();
          setUser(me);
          setStatus('authenticated');
          return true;
        } catch (error) {
          console.error('Failed to load user after refresh', error);
          setUser(null);
          setStatus('unauthenticated');
          return false;
        }
      })
      .catch((error) => {
        console.error('Failed to refresh auth session', error);
        setUser(null);
        setStatus('unauthenticated');
        return false;
      })
      .finally(() => {
        refreshPromiseRef.current = null;
      });

    refreshPromiseRef.current = promise;
    return promise;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      login,
      logout,
      refresh,
      hasRole: (roles) => hasRequiredRole(user, roles),
    }),
    [login, logout, refresh, status, user],
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
