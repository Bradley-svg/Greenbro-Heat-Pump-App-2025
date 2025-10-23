import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppProviders } from '@app/providers';
import { AppRouter } from '@app/router';
import '@app/styles.css';
import './components/brand.css';
import { toast } from '@app/providers/toast';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AppProviders>
      <AppRouter />
    </AppProviders>
  </React.StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/brand-sw.js')
      .catch((error) => console.error('Failed to register brand service worker', error));

    navigator.serviceWorker
      .register('/app-sw.js')
      .then((registration) => {
        function promptUpdate(sw: ServiceWorker | null) {
          if (!sw) {
            return;
          }
          toast.info('New version available', {
            duration: 0,
            action: {
              label: 'Refresh',
              onClick: () => {
                sw.postMessage('SKIP_WAITING');
                sw.addEventListener('statechange', () => {
                  if (sw.state === 'activated') {
                    window.location.reload();
                  }
                });
              },
            },
          });
        }

        if (registration.waiting) {
          promptUpdate(registration.waiting);
        }

        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) {
            return;
          }
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              promptUpdate(newWorker);
            }
          });
        });
      })
      .catch(() => {
        /* ignore */
      });
  });
}
