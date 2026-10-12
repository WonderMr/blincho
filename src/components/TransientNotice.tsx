import React, { useEffect, useRef, useState } from 'react';
import { Info, RotateCcw, X } from 'lucide-react';
import { useI18n } from '../i18n/useI18n';
import { t } from '../i18n/runtime';

interface TransientNoticeProps {
  message: string;
  durationMs: number;
  suspended?: boolean;
  onDismiss: () => void;
  onUndo?: () => void;
}

/** Mount with a new key for each event, even when its message repeats. */
export const TransientNotice: React.FC<TransientNoticeProps> = ({
  message, durationMs, suspended = false, onDismiss, onUndo,
}) => {
  useI18n();
  const remaining = useRef(durationMs);
  const dismissed = useRef(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const [seconds, setSeconds] = useState(Math.ceil(durationMs / 1000));
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(document.visibilityState === 'hidden');
  const paused = suspended || hovered || focused || hidden;

  useEffect(() => {
    const visibility = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);

  useEffect(() => {
    if (paused || dismissed.current) return;
    let lastTick = performance.now();
    const consumeElapsed = () => {
      const now = performance.now();
      remaining.current = Math.max(0, remaining.current - (now - lastTick));
      lastTick = now;
    };
    const timer = setInterval(() => {
      consumeElapsed();
      setSeconds(Math.ceil(remaining.current / 1000));
      if (remaining.current === 0 && !dismissed.current) {
        dismissed.current = true;
        clearInterval(timer);
        dismissRef.current();
      }
    }, 250);
    return () => { clearInterval(timer); consumeElapsed(); };
  }, [paused]);

  return (
    <div className="app-toast" hidden={suspended}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}>
      <Info className="app-toast-icon" size={17} aria-hidden="true" />
      <div className="app-toast-copy">
        <p className="app-toast-message" role="status">{t(message)}</p>
        <span className="app-toast-expiry" aria-live="off">
          {paused ? t("Исчезновение приостановлено") : t("Исчезнет через {value0} с", { value0: seconds })}
        </span>
        {onUndo && <button type="button" className="app-toast-undo" onClick={onUndo}
          title={t("Восстановить прежний отсчет времени")}>
          <RotateCcw size={13} aria-hidden="true" />{t("Отменить сброс")}
        </button>}
      </div>
      <button type="button" className="btn-icon app-toast-close" onClick={onDismiss} aria-label={t("Закрыть сообщение")}>
        <X size={17} aria-hidden="true" />
      </button>
    </div>
  );
};
