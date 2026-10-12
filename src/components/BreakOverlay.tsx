import { useI18n } from '../i18n/useI18n';
import { t } from '../i18n/runtime';
import React, { useEffect, useRef, useState } from 'react';
import { soundSynth } from '../audio/soundSynth';
import { Eye, Clock, X, ChevronRight, Check, Lock } from 'lucide-react';
import confetti from 'canvas-confetti';
import { useModalFocus } from '../utils/useModalFocus';

interface BreakOverlayProps {
  initialSeconds?: number;
  workMinutesGained?: number;
  strictMode?: boolean;
  onClose: () => void;
  onElapsed?: (deadlineMonotonicAt: number) => void;
  onPostpone: (minutes: number) => void;
  onOpenExercises: () => void;
}

export const BreakOverlay: React.FC<BreakOverlayProps> = ({
  initialSeconds = 20,
  strictMode = false,
  onClose,
  onElapsed,
  onPostpone,
  onOpenExercises,
}) => {
  useI18n();
  const [secondsLeft, setSecondsLeft] = useState(initialSeconds);
  const [isFinished, setIsFinished] = useState(false);
  const completedRef = useRef(false);
  const elapsedCallbackRef = useRef(onElapsed);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef);

  useEffect(() => {
    elapsedCallbackRef.current = onElapsed;
  }, [onElapsed]);

  useEffect(() => {
    const duration = Math.max(1, Number.isFinite(initialSeconds) ? initialSeconds : 20);
    const endsMonotonicAt = performance.now() + duration * 1000;
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((endsMonotonicAt - performance.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0 && !completedRef.current) {
        completedRef.current = true;
        clearInterval(interval);
        setIsFinished(true);
        soundSynth.playCompletionChime();
        if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
          confetti({ particleCount: 40, spread: 50, origin: { y: 0.6 }, colors: ['#38bdf8', '#10b981'] });
        }
        elapsedCallbackRef.current?.(endsMonotonicAt);
      }
    }, 500);

    return () => {
      clearInterval(interval);
    };
  }, [initialSeconds]);

  return (
    <div ref={dialogRef} className="fullscreen-break-takeover" role="dialog" aria-modal="true" aria-label={t("Перерыв для отдыха глаз")} tabIndex={-1}>
      {/* Top right postpone / close */}
      <div
        style={{
          position: 'absolute',
          top: 24,
          right: 24,
          display: 'flex',
          alignItems: 'center',
          gap: 12
        }}
      >
        {strictMode && !isFinished ? (
          <span
            style={{
              fontSize: '0.82rem',
              color: 'var(--status-warning)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: 'var(--status-warning-bg)',
              border: '1px solid var(--status-warning)',
              padding: '6px 14px',
              borderRadius: 999,
              fontWeight: 600
            }}
          >
            <Lock size={14} /> {t("Строгий режим активен")}</span>
        ) : (
          <>
            <button
              className="btn btn-secondary"
              style={{ fontSize: '0.82rem', padding: '6px 14px' }}
              onClick={() => onPostpone(5)}
            >
              <Clock size={14} /> {t("Отложить на 5 мин")}</button>
            <button
              className="btn-icon"
              onClick={onClose}
              title={t("Закрыть")}
              aria-label={t("Закрыть перерыв без записи")}
            >
              <X size={18} />
            </button>
          </>
        )}
      </div>

      {/* Calming Breathing Aura */}
      <div className="break-orb-pulse" />

      {!isFinished ? (
        <>
          <div className="break-countdown-large" role="timer" aria-label={t("До конца перерыва {value0} секунд", { value0: secondsLeft })}>
            {initialSeconds >= 60 ? `${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(secondsLeft % 60).padStart(2, '0')}` : secondsLeft}
            {initialSeconds < 60 && <span style={{ fontSize: '1.8rem', color: 'var(--accent-primary)', marginLeft: 4 }}>{t("с")}</span>}
          </div>

          <h2 className="break-content" style={{ fontSize: '2.1rem', marginBottom: 12 }}>{t("Пора отдохнуть от экрана")}</h2>

          <p className="break-hint" style={{ maxWidth: 560, color: 'var(--text-secondary)', fontSize: '1.08rem', lineHeight: 1.6, marginBottom: 32 }}>{t("Сделайте паузу в работе с экраном. Посмотрите на удалённый объект, например за окном, и спокойно поморгайте.")}</p>

          <div className="break-actions" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <button className="btn btn-primary" onClick={onOpenExercises}>
              <Eye size={18} />{t("Открыть упражнение")}<ChevronRight size={16} />
            </button>
            {!strictMode ? (
              <button className="btn btn-secondary" onClick={() => onPostpone(2)}>{t("Отложить на 2 мин")}</button>
            ) : (
              <div
                style={{
                  fontSize: '0.82rem',
                  color: 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '8px 14px',
                  background: 'var(--surface-muted)',
                  borderRadius: 10,
                  border: '1px solid var(--border-subtle)'
                }}
              >
                <Lock size={13} style={{ color: 'var(--status-warning)' }} />{t("Пропуск заблокирован (")}{secondsLeft} {t("с)")}</div>
            )}
          </div>
        </>
      ) : (
        <div style={{ textAlign: 'center', animation: 'fadeIn 0.25s ease' }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: '50%',
              background: 'var(--status-success-bg)',
              border: '2px solid var(--border-active)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 18px',
              color: 'var(--status-success)'
            }}
          >
            <Check size={40} />
          </div>
          <h2 style={{ fontSize: '2.2rem', marginBottom: 10 }}>{t("Перерыв завершён")}</h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: 440, margin: '0 auto 14px' }}>{t("Можно продолжить работу.")}</p>
        </div>
      )}
    </div>
  );
};
