import React, { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/runtime';
import { useI18n } from '../i18n/useI18n';

export interface MeetingHistoryControlsProps {
  id: string;
  enabled: boolean;
  supported: boolean;
  hasHistory: boolean;
  pending: boolean;
  feedback: 'deleted' | 'failed' | null;
  onEnabledChange: (enabled: boolean) => void;
  onDelete: () => Promise<void>;
}

export const MeetingHistoryControls: React.FC<MeetingHistoryControlsProps> = ({
  id, enabled, supported, hasHistory, pending, feedback, onEnabledChange, onDelete,
}) => {
  useI18n();
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const restoreFocusRef = useRef<'delete' | 'result' | null>(null);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (restoreFocusRef.current && !pending) {
      if (restoreFocusRef.current === 'result' && feedback === 'deleted') feedbackRef.current?.focus();
      else deleteRef.current?.focus();
      restoreFocusRef.current = null;
    }
  }, [confirming, pending, feedback]);
  const cancel = () => { if (!pending) { restoreFocusRef.current = 'delete'; setConfirming(false); } };
  return <div className="meeting-history-controls">
    <div className={`settings-toggle-row ${!supported ? 'feature-unavailable' : ''}`}>
      <div className="settings-toggle-copy">
        <label htmlFor={`${id}-enabled`} className="settings-toggle-title">{t("Сохранять историю созвонов")}</label>
        <p id={`${id}-description`} className="settings-description">{supported
          ? t("Выключено по умолчанию. Запись новых созвонов не зависит от откладывания перерывов.")
          : t("Запись созвонов доступна только в настольном приложении Blincho.")}</p>
      </div>
      <label className="switch">
        <input id={`${id}-enabled`} type="checkbox" checked={supported && enabled} disabled={!supported || pending}
          aria-describedby={`${id}-description ${id}-privacy`} onChange={event => onEnabledChange(event.target.checked)} />
        <span className="slider" aria-hidden="true" />
      </label>
    </div>
    <p id={`${id}-privacy`} className="settings-description">{t("Локально сохраняются начало, конец, длительность и стандартное название приложения. Содержимое, звук, участники, названия встреч и ссылки не сохраняются. Статистика никуда не отправляется.")}</p>
    <p className="settings-description">{t("Выключение останавливает новую запись, но сохраняет прежнюю историю. Удаление очищает только историю созвонов.")}</p>
    {confirming ? <div className="meeting-history-confirm" role="group" aria-labelledby={`${id}-confirm`} data-escape-confirmation="true"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
      <p id={`${id}-confirm`}>{t("Удалить все записи созвонов? Остальная статистика сохранится.")}</p>
      <div className="meeting-history-actions">
        <button ref={cancelRef} type="button" className="btn btn-secondary" disabled={pending} onClick={cancel}>{t("Отмена")}</button>
        <button id={`${id}-confirm-delete`} type="button" className="btn btn-secondary" disabled={pending} onClick={() => {
          void onDelete().then(() => { restoreFocusRef.current = 'result'; setConfirming(false); });
        }}>{pending ? t("Удаление…") : t("Удалить записи")}</button>
      </div>
    </div> : <button id={`${id}-delete`} ref={deleteRef} type="button" className="btn btn-secondary meeting-history-delete"
      disabled={!hasHistory || pending} onClick={() => setConfirming(true)}>{t("Удалить историю созвонов")}</button>}
    {feedback && <p id={`${id}-feedback`} ref={feedbackRef} tabIndex={-1} className="settings-feedback" role={feedback === 'failed' ? 'alert' : 'status'}>{feedback === 'deleted'
      ? t("История созвонов удалена.") : t("Не удалось удалить историю созвонов. Попробуйте ещё раз.")}</p>}
  </div>;
};
