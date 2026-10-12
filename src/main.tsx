import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';
import './styles/themes.css';
import './styles/appearance.css';
import './styles/compact-sidebar.css';
import './styles/compact-layout.css';
import './styles/compact-timer.css';
import './styles/notice.css';
import { initializeLanguage } from './i18n/runtime';
import { loadSettings } from './utils/storage';
import { applyAppearance } from './utils/appearance';
import { initializeTauriBridge, scheduleLegacyHistoryExport } from './utils/tauriBridge';

const initialAppearance = loadSettings();
applyAppearance(initialAppearance.theme, initialAppearance.colorPalette);

if (import.meta.env.PROD && !window.electronAPI && 'serviceWorker' in navigator && ['http:', 'https:'].includes(location.protocol)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(error => {
      console.warn('Blincho: offline shell registration failed', error);
    });
  }, { once: true });
}

const rootElement = document.getElementById('root');
if (rootElement) {
  void initializeTauriBridge().then(async () => {
    const appearance = loadSettings();
    applyAppearance(appearance.theme, appearance.colorPalette);
    await initializeLanguage();
    // i18n's module may have loaded before the first-start import.
    if (window.__TAURI__) window.dispatchEvent(new StorageEvent('storage', { key: null }));
    scheduleLegacyHistoryExport();
    ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
    );
  }).catch(error => {
    console.error('Blincho: Desktop initialization failed:', error);
    rootElement.textContent = 'Не удалось открыть приложение или перенести историю. Исходные данные сохранены.';
  });
}
