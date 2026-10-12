import React, { useRef, useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useI18n } from '../i18n/useI18n';
import { historyErrorDetail } from '../utils/historyRecovery';

interface Props {
  error: unknown;
  onRetry: () => Promise<void>;
  onContinue?: () => Promise<void>;
}

export function HistoryRecovery({ error, onRetry, onContinue }: Props) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const detail = historyErrorDetail(error);
  async function act(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try { await action(); }
    finally { running.current = false; setBusy(false); }
  }
  return (
    <main className="error-screen">
      <div className="glass-card error-card" role="alert" aria-busy={busy}>
        <span className="error-icon" aria-hidden="true"><AlertTriangle size={30} /></span>
        <h1>{t("Не удалось перенести историю")}</h1>
        <p>{t("Закройте прежнее приложение Blincho (Electron), затем повторите перенос.")}</p>
        <p className="error-data-note">{t("Исходная история в прежнем приложении сохранена. До вашего выбора новые записи не создаются.")}</p>
        {onContinue && <p className="error-data-note">{t("Если продолжить без истории, её автоматический перенос будет отключён для этого профиля. Новые записи сохранятся в этом приложении.")}</p>}
        <details className="error-details"><summary>{t("Технические подробности")}</summary><pre>{detail || t("Причина не указана.")}</pre></details>
        <div className="error-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { void act(onRetry); }}>
            <RotateCcw size={18} aria-hidden="true" />{t("Повторить перенос")}
          </button>
          {onContinue && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { void act(onContinue); }}>{t("Продолжить без истории")}</button>}
        </div>
        {busy && <p role="status">{t("Подготавливаем приложение…")}</p>}
      </div>
    </main>
  );
}
