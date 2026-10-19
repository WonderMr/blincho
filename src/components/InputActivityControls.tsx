import React, { useState } from 'react';
import { t } from '../i18n/runtime';
import type { InputActivitySnapshot } from '../utils/inputActivity';
import { configureInputActivity } from '../utils/inputActivity';

export interface InputActivityControlsProps {
  enabled: boolean;
  status: InputActivitySnapshot['status'];
  hasHistory: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onDelete: () => Promise<boolean>;
}
export const InputActivityControls: React.FC<InputActivityControlsProps> = ({ enabled, status, hasHistory, onEnabledChange, onDelete }) => {
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState('');
  const supported = !!window.__TAURI__;
  const change = async (value: boolean) => {
    setPending(true); setFeedback('');
    try {
      if (!value) { onEnabledChange(false); return; }
      const snapshot = await configureInputActivity(true, true);
      onEnabledChange(snapshot.status === 'active');
      setFeedback(snapshot.status === 'active' ? '' : snapshot.status === 'permissionRequired'
        ? "Разрешите мониторинг ввода в настройках системы и включите сбор снова."
        : "Системный сбор ввода недоступен в этой среде.");
    } catch { setFeedback("Системный сбор ввода недоступен в этой среде."); }
    finally { setPending(false); }
  };
  return <div className="meeting-history-controls">
    <div className="settings-toggle-row"><div className="settings-toggle-copy">
      <label htmlFor="input-activity-enabled" className="settings-toggle-title">{t("Собирать счётчики ввода")}</label>
      <p id="input-activity-description" className="settings-description">{t("Только локальные счётчики событий по 5 минут. Без текста, приложений и координат. Частота событий зависит от устройства. Эти данные не устанавливают диагноз.")}</p>
    </div><label className="switch"><input id="input-activity-enabled" type="checkbox" checked={enabled && supported}
      disabled={!supported || pending} aria-describedby="input-activity-description" onChange={event => { void change(event.target.checked); }} /><span className="slider" aria-hidden="true" /></label></div>
    {(!supported || (enabled && status !== 'active')) && <p className="settings-feedback" role="status">{status === 'permissionRequired'
      ? t("Разрешите мониторинг ввода в настройках системы и включите сбор снова.") : t("Системный сбор ввода недоступен в этой среде.")}</p>}
    {confirming ? <div className="meeting-history-actions"><span>{t("Удалить статистику ввода")}</span>
      <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => setConfirming(false)}>{t("Отмена")}</button>
      <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => {
        setPending(true); void onDelete().then(ok => { setFeedback(ok ? "Готово" : "Не удалось удалить статистику ввода."); setConfirming(false); }).finally(() => setPending(false));
      }}>{t("Удалить записи")}</button></div> : <button type="button" className="btn btn-secondary" disabled={!hasHistory || pending} onClick={() => setConfirming(true)}>{t("Удалить статистику ввода")}</button>}
    {feedback && <p className="settings-feedback" role="status">{t(feedback)}</p>}
  </div>;
};
