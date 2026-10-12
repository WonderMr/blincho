import { t } from '../i18n/runtime';
import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RotateCcw, Settings } from 'lucide-react';

interface Props { children: ReactNode; }
interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false, error: null };
  public static getDerivedStateFromError(error: Error): State { return { hasError: true, error }; }
  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Blincho ErrorBoundary caught an unhandled error:', error, errorInfo);
  }
  private handleReset = () => { window.location.reload(); };
  private handleResetSettings = () => {
    try { localStorage.removeItem('myeyes_settings_v1'); } catch { /* Reload remains available when storage is restricted. */ }
    window.location.reload();
  };
  public render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <main className="error-screen">
        <div className="glass-card error-card" role="alert">
          <span className="error-icon" aria-hidden="true"><AlertTriangle size={30} /></span>
          <h1>{t("Не удалось открыть Blincho")}</h1>
          <p>{t("Попробуйте перезагрузить приложение. Если ошибка повторяется, верните настройки к исходным значениям.")}</p>
          <p className="error-data-note">{t("История перерывов и результаты самопроверки сохранятся.")}</p>
          {this.state.error && <details className="error-details"><summary>{t("Технические подробности")}</summary><pre>{this.state.error.message}</pre></details>}
          <div className="error-actions"><button type="button" className="btn btn-primary" onClick={this.handleReset}><RotateCcw size={18} aria-hidden="true" />{t("Перезагрузить")}</button>
            <button type="button" className="btn btn-secondary" onClick={this.handleResetSettings}><Settings size={17} aria-hidden="true" />{t("Сбросить только настройки")}</button>
          </div>
        </div>
      </main>
    );
  }
}
