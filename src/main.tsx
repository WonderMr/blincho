import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HistoryRecovery } from './components/HistoryRecovery';
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
import { initializeTauriBridge, initializeTauriHistory, continueWithoutTauriHistory, scheduleLegacyHistoryExport } from './utils/tauriBridge';

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
  const root = ReactDOM.createRoot(rootElement);
  async function mountApp() {
    const appearance = loadSettings();
    applyAppearance(appearance.theme, appearance.colorPalette);
    await initializeLanguage();
    // i18n's module may have loaded before the first-start import.
    if (window.__TAURI__) window.dispatchEvent(new StorageEvent('storage', { key: null }));
    scheduleLegacyHistoryExport();
    root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
    );
  }
  async function showRecovery(error: unknown, onRetry: () => Promise<void>, onContinue?: () => Promise<void>) {
    await initializeLanguage();
    root.render(<React.StrictMode><HistoryRecovery error={error} onRetry={onRetry} onContinue={onContinue} /></React.StrictMode>);
  }
  async function attemptImport() {
    try {
      await initializeTauriHistory();
      await mountApp();
    } catch (error) {
      console.error('Blincho: History initialization failed:', error);
      await showRecovery(error, attemptImport, continueWithoutHistory);
    }
  }
  async function continueWithoutHistory() {
    try {
      await continueWithoutTauriHistory();
      await mountApp();
    } catch (error) {
      await showRecovery(error, attemptImport, continueWithoutHistory);
    }
  }
  async function initialize() {
    try { await initializeTauriBridge(); }
    catch (error) {
      console.error('Blincho: Desktop initialization failed:', error);
      await showRecovery(error, initialize);
      return;
    }
    await attemptImport();
  }
  void initialize();
}
