export type ToastKind = 'default' | 'success' | 'warning' | 'error';

export type ToastAction = {
  label: string;
  onClick: () => void;
};

export type ToastOptions = {
  kind?: ToastKind;
  duration?: number;
  dismissible?: boolean;
  action?: ToastAction;
};
