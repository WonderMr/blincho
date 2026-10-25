import React, { useRef, useState } from 'react';
import { useI18n } from '../i18n/useI18n';
import { useModalFocus } from '../utils/useModalFocus';

interface Props {
  onRetry: () => Promise<void>;
  onDiscard: () => Promise<void>;
  onCancel: () => void;
}

export function StatisticsQuitError({ onRetry, onDiscard, onCancel }: Props) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDivElement>(null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  useModalFocus(dialog);
  async function act(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true);
    try { await action(); }
    catch (error) { console.warn('Blincho: Statistics exit choice failed:', error); }
    finally { running.current = false; setBusy(false); }
  }
  return <div className="exercise-modal-overlay statistics-quit-overlay">
    <div className="glass-card error-card" ref={dialog} role="alertdialog" aria-modal="true"
      aria-labelledby="statistics-quit-error" aria-busy={busy} tabIndex={-1}>
      <p id="statistics-quit-error">{t("Не удалось сохранить статистику. При выходе последние несохранённые изменения будут потеряны.")}</p>
      <div className="error-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { void act(onRetry); }}>{t("Повторить сохранение")}</button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => { void act(onDiscard); }}>{t("Выйти без сохранения")}</button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>{t("Отмена")}</button>
      </div>
    </div>
  </div>;
}
