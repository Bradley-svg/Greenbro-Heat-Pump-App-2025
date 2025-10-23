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

type ToastKind = 'default' | 'success' | 'warning' | 'error';

type ToastOptions = {
  kind?: ToastKind;
  duration?: number;
  dismissible?: boolean;
};

type ToastRecord = {
  id: number;
  message: string;
  kind: ToastKind;
  dismissible: boolean;
  duration: number;
  state: 'open' | 'closing';
};

type ToastApi = {
  push: (message: string, options?: ToastOptions) => number;
  success: (message: string, options?: Omit<ToastOptions, 'kind'>) => number;
  warning: (message: string, options?: Omit<ToastOptions, 'kind'>) => number;
  error: (message: string, options?: Omit<ToastOptions, 'kind'>) => number;
  dismiss: (id: number) => void;
  clear: () => void;
  muted: boolean;
  setMuted: (muted: boolean) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const TOAST_DURATION = 6000;
const EXIT_DURATION = 180;
const MUTE_KEY = 'toast_muted';

export function ToastProvider({ children }: PropsWithChildren): JSX.Element {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const [muted, setMutedState] = useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    try {
      return window.localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const exitTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const hoveredToasts = useRef(new Set<number>());
  const focusedToasts = useRef(new Set<number>());

  const finalizeRemoval = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    exitTimers.current.delete(id);
    hoveredToasts.current.delete(id);
    focusedToasts.current.delete(id);
  }, []);

  const startClosing = useCallback((id: number) => {
    hoveredToasts.current.delete(id);
    focusedToasts.current.delete(id);
    setToasts((current) =>
      current.map((toast) => (toast.id === id ? { ...toast, state: 'closing' } : toast)),
    );
    if (!exitTimers.current.has(id)) {
      const timeout = setTimeout(() => finalizeRemoval(id), EXIT_DURATION);
      exitTimers.current.set(id, timeout);
    }
  }, [finalizeRemoval]);

  const clearTimer = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      clearTimer(id);
      hoveredToasts.current.delete(id);
      focusedToasts.current.delete(id);
      startClosing(id);
    },
    [clearTimer, startClosing],
  );

  const scheduleAutoDismiss = useCallback(
    (id: number, duration: number) => {
      clearTimer(id);
      const timeout = setTimeout(() => {
        timers.current.delete(id);
        startClosing(id);
      }, duration);
      timers.current.set(id, timeout);
    },
    [clearTimer, startClosing],
  );

  const push = useCallback(
    (message: string, options?: ToastOptions) => {
      if (muted) {
        return -1;
      }
      const id = nextId.current++;
      const kind = options?.kind ?? 'default';
      const dismissible = options?.dismissible ?? true;
      const duration = options?.duration ?? TOAST_DURATION;
      setToasts((current) => [
        ...current,
        {
          id,
          message,
          kind,
          dismissible,
          duration,
          state: 'open',
        },
      ]);
      if (duration > 0) {
        scheduleAutoDismiss(id, duration);
      }
      return id;
    },
    [muted, scheduleAutoDismiss],
  );

  const clear = useCallback(() => {
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current.clear();
    exitTimers.current.forEach((timer) => clearTimeout(timer));
    exitTimers.current.clear();
    hoveredToasts.current.clear();
    focusedToasts.current.clear();
    setToasts([]);
  }, []);

  useEffect(() => () => clear(), [clear]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {
      // ignore persistence errors
    }
  }, [muted]);

  const setMuted = useCallback(
    (value: boolean) => {
      setMutedState(value);
      if (value) {
        clear();
      }
    },
    [clear],
  );

  const pauseToast = useCallback(
    (id: number) => {
      clearTimer(id);
    },
    [clearTimer],
  );

  const resumeToast = useCallback(
    (toast: ToastRecord) => {
      if (
        toast.duration > 0 &&
        toast.state === 'open' &&
        !exitTimers.current.has(toast.id) &&
        !hoveredToasts.current.has(toast.id) &&
        !focusedToasts.current.has(toast.id)
      ) {
        scheduleAutoDismiss(toast.id, toast.duration);
      }
    },
    [scheduleAutoDismiss],
  );

  const contextValue = useMemo<ToastApi>(() => {
    const factory = (kind: ToastKind) =>
      (message: string, options?: Omit<ToastOptions, 'kind'>) => push(message, { ...options, kind });
    return {
      push,
      success: factory('success'),
      warning: factory('warning'),
      error: factory('error'),
      dismiss,
      clear,
      muted,
      setMuted,
    };
  }, [clear, dismiss, muted, push, setMuted]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <section className="toast-container" aria-live="polite" aria-atomic="false" role="region">
        {toasts.map((toast) => (
          <article
            key={toast.id}
            className={`toast toast--${toast.kind}`}
            data-state={toast.state}
            role="status"
            onMouseEnter={() => {
              hoveredToasts.current.add(toast.id);
              pauseToast(toast.id);
            }}
            onMouseLeave={() => {
              hoveredToasts.current.delete(toast.id);
              resumeToast(toast);
            }}
            onFocus={() => {
              focusedToasts.current.add(toast.id);
              pauseToast(toast.id);
            }}
            onBlur={() => {
              focusedToasts.current.delete(toast.id);
              resumeToast(toast);
            }}
          >
            <div className="toast__body">{toast.message}</div>
            {toast.dismissible ? (
              <button
                type="button"
                className="toast__dismiss"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss notification"
              >
                ×
              </button>
            ) : null}
          </article>
        ))}
      </section>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}
