import React, { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/runtime';
import { useI18n } from '../i18n/useI18n';
import { useModalFocus } from '../utils/useModalFocus';

export interface MeetingBreakWarningState { version: number; epoch: number; endAt: number }
interface Props { warning: MeetingBreakWarningState; busy: boolean; error: boolean; onDefer: (minutes: number | null) => void }

/**
 * Show the native strict-break deadline and the available meeting deferrals.
 * Send 5, 10 or 15 minutes to onDefer, or null to pause until meeting end.
 * Disable actions while submitting or after the deadline; the native timer owns expiry.
 */
export function MeetingBreakWarning({ warning, busy, error, onDefer }: Props) {
  useI18n();
  const [now, setNow] = useState(Date.now());
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((warning.endAt - now) / 1000));
  return <div className="modal-backdrop" style={{ zIndex: 1100 }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="meeting-warning-title" tabIndex={-1}
      style={{ width: 'min(440px, calc(100vw - 32px))', padding: 24, borderRadius: 18, background: 'var(--bg-card)', border: '1px solid var(--border-control)', boxShadow: 'var(--shadow-lg)' }}>
      <h2 id="meeting-warning-title" style={{ fontSize: '1.15rem', marginBottom: 12 }}>{t('Перерыв начнётся через {seconds} с.', { seconds })}</h2>
      <p>{t('Вы на встрече? Отложите перерыв или приостановите напоминания до её окончания.')}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 18 }}>
        {[5, 10, 15].map(minutes => <button key={minutes} className="btn btn-secondary" disabled={busy || seconds === 0}
          onClick={() => onDefer(minutes)}>{t('{value0} мин', { value0: minutes })}</button>)}
        <button className="btn btn-primary" disabled={busy || seconds === 0} onClick={() => onDefer(null)}>{t('До конца встречи')}</button>
      </div>
      {error && <p role="alert">{t('Не удалось отложить перерыв. Попробуйте ещё раз.')}</p>}
    </div>
  </div>;
}
