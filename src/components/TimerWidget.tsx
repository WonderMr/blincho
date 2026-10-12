import { useI18n } from '../i18n/useI18n';
import { t } from '../i18n/runtime';
import React from 'react';
import { TimerPreset } from '../types';
import { Play, Pause, RotateCcw, Coffee, SlidersHorizontal } from 'lucide-react';

interface TimerWidgetProps {
  totalSeconds: number;
  secondsRemaining: number;
  isRunning: boolean;
  isIdlePaused?: boolean;
  preset: TimerPreset;
  onTogglePlay: () => void;
  onReset: () => void;
  onTriggerInstantBreak: () => void;
  onSelectPreset: (preset: TimerPreset) => void;
  phase?: 'work' | 'break' | 'manual' | 'idle' | 'locked' | 'suspended' | 'hidden' | 'exercise';
  statusLabel?: string;
  breakSeconds?: number;
  controlsDisabled?: boolean;
  onOpenSettings?: () => void;
}

export const TimerWidget: React.FC<TimerWidgetProps> = ({
  totalSeconds, secondsRemaining, isRunning, isIdlePaused = false, preset,
  onTogglePlay, onReset, onTriggerInstantBreak, onSelectPreset, phase,
  statusLabel, breakSeconds = 20, controlsDisabled = false, onOpenSettings,
}) => {
  useI18n();
  const effectivePhase = phase ?? (isIdlePaused ? 'idle' : isRunning ? 'work' : 'manual');
  const phaseLabels = {
    work: t("Рабочий интервал"), break: t("Время перерыва"), manual: t("Таймер на паузе"),
    idle: t("Пауза: нет активности"), locked: t("Пауза: экран заблокирован"),
    suspended: t("Пауза: компьютер спит"), hidden: t("Пауза: вкладка скрыта"), exercise: t("Упражнение"),
  };
  const label = statusLabel ?? phaseLabels[effectivePhase];
  const tone = effectivePhase === 'work' ? 'working' : effectivePhase === 'break' || effectivePhase === 'exercise' ? 'break' : effectivePhase === 'manual' ? 'paused' : 'absence';
  const radius = 110;
  const circumference = 2 * Math.PI * radius;
  const remaining = Math.max(0, Math.ceil(secondsRemaining));
  const progressRatio = totalSeconds > 0 ? Math.min(1, remaining / totalSeconds) : 0;
  const formattedTime = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  const actionLabel = isRunning ? t("Пауза") : remaining < totalSeconds ? t("Продолжить") : t("Начать работу");
  const restLabel = breakSeconds >= 60 ? t("{value0} мин", { value0: breakSeconds / 60 }) : t("{value0} сек", { value0: breakSeconds });

  return (
    <section className={`timer-card compact-timer timer-state-${tone}`} aria-label={t("Таймер перерывов")}>
      <div className="timer-workspace">
        <div className="timer-face">
          <div className={`timer-state-label status-${tone}`} role="status">
            <span className="status-indicator" aria-hidden="true" />{label}
          </div>
          <button type="button" className="timer-circle-wrap" onClick={onTogglePlay} disabled={controlsDisabled}
            title={t("{value0} (Пробел)", { value0: actionLabel })} aria-keyshortcuts="Space" aria-label={t("{value0}. Осталось {value1} мин {value2} сек", { value0: actionLabel, value1: Math.floor(remaining / 60), value2: remaining % 60 })}>
            <svg className="timer-svg" viewBox="0 0 240 240" aria-hidden="true">
              <defs><linearGradient id="timerGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="var(--accent-primary)" /><stop offset="100%" stopColor="var(--accent-secondary)" />
              </linearGradient></defs>
              <circle className="timer-svg-bg" cx="120" cy="120" r={radius} strokeWidth="5" fill="transparent" />
              <circle className="timer-svg-progress" cx="120" cy="120" r={radius} strokeWidth="5" fill="transparent"
                strokeDasharray={circumference} strokeDashoffset={circumference * (1 - progressRatio)} />
            </svg>
            <span className="timer-center-content">
              <span className="timer-digits">{formattedTime}</span>
              <span className="timer-sublabel">{effectivePhase === 'break' ? t("до конца перерыва") : t("до перерыва")}</span>
            </span>
          </button>
        </div>
        <div className="timer-action-panel">
          <div className="timer-interval-summary">
            <span><strong>{t("{value0} мин", { value0: totalSeconds / 60 })}</strong> {t("работы")}</span>
            <span><strong>{restLabel}</strong> {t("отдыха")}</span>
          </div>
          <div className="timer-controls">
            <button type="button" className="btn btn-primary timer-primary-action"
              onClick={onTogglePlay} disabled={controlsDisabled}>
              {isRunning ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}{actionLabel}
            </button>
            <button type="button" className="btn btn-secondary" onClick={onTriggerInstantBreak} disabled={controlsDisabled}>
              <Coffee size={17} aria-hidden="true" />{t("Перерыв сейчас")}</button>
          </div>
          <p className="timer-help">{preset === '20-20-20'
            ? t("Во время перерыва переведите взгляд на удалённый предмет примерно на 20 секунд.")
            : t("Выберите удобный ритм работы и отдыха. На перерыве отведите взгляд от экрана.")}</p>
        </div>
      </div>
      <div className="timer-utility-row">
        <div className="timer-mode-pills" role="group" aria-label={t("Режим таймера")}>
          {([
            ['20-20-20', '20–20–20'], ['pomodoro', t("Помодоро")], ['custom', t("Свой режим")],
          ] as const).map(([id, title]) => (
            <button type="button" key={id} className={`timer-mode-btn ${preset === id ? 'active' : ''}`}
              aria-pressed={preset === id} disabled={controlsDisabled} onClick={() => onSelectPreset(id)}>{title}</button>
          ))}
        </div>
        <button type="button" className="timer-reset-action" onClick={onReset} disabled={controlsDisabled}
          title={t("Начать рабочий интервал заново (R)")} aria-keyshortcuts="R" aria-label={t("Начать рабочий интервал заново")}>
          <RotateCcw size={14} aria-hidden="true" />{t("заново")}
        </button>
        {preset === 'custom' && onOpenSettings && (
          <button type="button" className="timer-settings-link" onClick={onOpenSettings}><SlidersHorizontal size={14} aria-hidden="true" />{t("Изменить")}</button>
        )}
        <div className="timer-shortcuts-hint" aria-hidden="true">
          <span className="kbd-badge"><kbd>{t("Пробел")}</kbd> {isRunning ? t("пауза") : t("старт")}</span><span className="kbd-badge"><kbd>R</kbd> {t("заново")}</span>
        </div>
      </div>
    </section>
  );
};
