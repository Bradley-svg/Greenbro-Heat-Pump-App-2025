import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppProviders } from '@app/providers';
import { AppRouter } from '@app/router';
import '@app/styles.css';

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
  });
}
