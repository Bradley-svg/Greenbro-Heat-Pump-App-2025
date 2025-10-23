import type { ToastOptions } from './toast.types';

type ToastSubscriber = (message: string, options?: ToastOptions) => number | void;

const subscribers = new Set<ToastSubscriber>();

function notify(message: string, options?: ToastOptions): number {
  let id = -1;
  subscribers.forEach((listener) => {
    const result = listener(message, options);
    if (id === -1 && typeof result === 'number') {
      id = result;
    }
  });
  return id;
}

export const toast = {
  subscribe(listener: ToastSubscriber): () => void {
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  },
  push(message: string, options?: ToastOptions): number {
    return notify(message, options);
  },
  info(message: string, options?: Omit<ToastOptions, 'kind'>): number {
    return notify(message, { ...options, kind: 'default' });
  },
  success(message: string, options?: Omit<ToastOptions, 'kind'>): number {
    return notify(message, { ...options, kind: 'success' });
  },
  warning(message: string, options?: Omit<ToastOptions, 'kind'>): number {
    return notify(message, { ...options, kind: 'warning' });
  },
  error(message: string, options?: Omit<ToastOptions, 'kind'>): number {
    return notify(message, { ...options, kind: 'error' });
  },
};
