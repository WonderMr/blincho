import { useI18n } from '../i18n/useI18n';
import { subscribeAppearance } from '../utils/appearance';
import { t as translate } from '../i18n/runtime';
import React, { useEffect, useRef, useState } from 'react';
import { ExerciseTechnique, ExerciseStep } from '../types';
import { soundSynth } from '../audio/soundSynth';
import confetti from 'canvas-confetti';
import { useModalFocus } from '../utils/useModalFocus';
import {
  Play, Pause, SkipForward, X, Volume2, VolumeX,
  CheckCircle2, Sparkles, Eye, ShieldCheck, Info
} from 'lucide-react';

interface ExercisePlayerProps {
  technique: ExerciseTechnique;
  routine?: ExerciseTechnique[];
  onClose: () => void;
  onFinished?: (techniqueId: string) => void;
}

export const ExercisePlayer: React.FC<ExercisePlayerProps> = ({
  technique: initialTechnique,
  routine,
  onClose,
  onFinished,
}) => {
  useI18n();
  const [routineIndex, setRoutineIndex] = useState(0);
  const techniques = routine?.length ? routine : [initialTechnique];
  const technique = techniques[routineIndex] || initialTechnique;
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [secondsRemaining, setSecondsRemaining] = useState(
    technique.steps[0]?.durationSeconds || 15
  );
  const [isPaused, setIsPaused] = useState(false);
  const [soundActive, setSoundActive] = useState(soundSynth.enabled);
  const [isCompleted, setIsCompleted] = useState(false);
  const [showClinicalInfo, setShowClinicalInfo] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef);
  const animFrameId = useRef<number | null>(null);
  const timeRef = useRef<number>(0);
  const advancingRef = useRef(false);
  const skippedRef = useRef(false);
  const completedTechniquesRef = useRef(new Set<number>());
  const onFinishedRef = useRef(onFinished);
  const soundActiveRef = useRef(soundActive);

  useEffect(() => { onFinishedRef.current = onFinished; }, [onFinished]);
  useEffect(() => { soundActiveRef.current = soundActive; }, [soundActive]);

  const currentStep: ExerciseStep = technique.steps[currentStepIndex] || technique.steps[0];
  const visualCaptions = (() => {
    switch (currentStep.visualMode) {
      case 'near-far':
        return [(currentStep.focus ?? (currentStepIndex % 2 === 0 ? 'near' : 'far')) === 'near'
          ? translate("Посмотрите на предмет рядом") : translate("Отведите взгляд от экрана вдаль")];
      case 'blink':
        return [translate("Мягко сомкните веки • Не сжимайте и не давите на глаза")];
      case 'dot-figure8':
      case 'dot-circle':
      case 'dot-saccades':
      case 'palming':
        return [];
      default:
        return [translate("Смотрите вдаль на расстояние 6+ метров"), translate("Взгляд за окно, на облака или в дальний угол комнаты")];
    }
  })();

  // Sound toggle
  const toggleSound = () => {
    soundActiveRef.current = !soundActiveRef.current;
    setSoundActive(soundActiveRef.current);
    if (soundActiveRef.current) soundSynth.playSoftBeep(520, true);
  };

  // Step countdown timer
  useEffect(() => {
    advancingRef.current = false;
    if (isPaused || isCompleted) return;

    if (soundActiveRef.current) soundSynth.playSoftBeep(520, soundActiveRef.current);
    const endsAt = Date.now() + Math.max(1, secondsRemaining) * 1000;
    const timer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      setSecondsRemaining(remaining);
      if (remaining === 0) handleNextStep();
    }, 500);

    return () => clearInterval(timer);
  }, [routineIndex, currentStepIndex, isPaused, isCompleted]);

  const handleNextStep = (skipped = false) => {
    if (advancingRef.current || isCompleted) return;
    advancingRef.current = true;
    if (skipped) skippedRef.current = true;
    if (currentStepIndex + 1 < technique.steps.length) {
      setCurrentStepIndex(currentStepIndex + 1);
      setSecondsRemaining(technique.steps[currentStepIndex + 1].durationSeconds);
      if (soundActiveRef.current) soundSynth.playSoftBeep(640, soundActiveRef.current);
    } else {
      if (!skippedRef.current && !completedTechniquesRef.current.has(routineIndex)) {
        completedTechniquesRef.current.add(routineIndex);
        onFinishedRef.current?.(technique.id);
      }
      if (routineIndex + 1 < techniques.length) {
        const next = techniques[routineIndex + 1];
        skippedRef.current = false;
        setRoutineIndex(routineIndex + 1);
        setCurrentStepIndex(0);
        setSecondsRemaining(next.steps[0]?.durationSeconds || 15);
      } else {
        finishExercise();
      }
    }
  };

  const finishExercise = () => {
    setIsCompleted(true);
    if (soundActiveRef.current) soundSynth.playCompletionChime(soundActiveRef.current);
    if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) confetti({
      particleCount: 80,
      spread: 70,
      origin: { y: 0.6 },
      colors: ['#38bdf8', '#10b981', '#6366f1', '#f59e0b'],
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === 'Space' && event.target instanceof HTMLElement && event.target.closest('button, a, input, textarea, select, [contenteditable="true"]')) return;
      if (event.code === 'Space' && !isCompleted) {
        event.preventDefault();
        setIsPaused(value => !value);
      }
      if (event.code === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isCompleted, onClose]);

  // Canvas visual rendering loop based on step visualMode
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Resolve theme tokens once per appearance change, never in the animation loop.
    const colors: Record<string, string> = {};
    const readColors = () => {
      const style = window.getComputedStyle(document.documentElement);
      for (const token of ['bg', 'grid', 'track', 'target', 'target-secondary', 'target-tertiary', 'pupil', 'cue']) {
        colors[token] = style.getPropertyValue(`--exercise-${token}`).trim();
      }
    };
    readColors();
    const unsubscribeAppearance = subscribeAppearance(readColors);

    let width = 0;
    let height = 0;
    let centerX = 0;
    let centerY = 0;

    const updateDimensions = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      width = rect.width;
      height = rect.height;
      centerX = width / 2;
      centerY = height / 2;
    };

    updateDimensions();

    const resizeObserver = new ResizeObserver(() => {
      updateDimensions();
    });
    resizeObserver.observe(canvas);

    let lastFrame = performance.now();
    timeRef.current = 0;
    const render = (timestamp: number) => {
      if (width === 0 || height === 0) {
        updateDimensions();
      }
      if (!isPaused) {
        const elapsed = Math.min(0.1, Math.max(0, (timestamp - lastFrame) / 1000));
        timeRef.current = (timeRef.current + elapsed * 1.5) % (Math.PI * 200);
      }
      lastFrame = timestamp;
      const t = timeRef.current;
      const directedTime = t * (currentStep.direction ?? (currentStepIndex % 2 === 0 ? 1 : -1));

      // Clear with dark ambient backdrop
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, width, height);

      // Grid background effect
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      const step = 40;
      for (let x = 0; x < width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y < height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      const mode = currentStep.visualMode;

      if (mode === 'dot-figure8') {
        // Draw Figure-8 path
        const a = Math.min(width * 0.38, 160);
        ctx.beginPath();
        ctx.strokeStyle = colors.track;
        ctx.lineWidth = 3;
        for (let angle = 0; angle <= Math.PI * 2; angle += 0.05) {
          const denom = 1 + Math.sin(angle) * Math.sin(angle);
          const px = centerX + (a * Math.cos(angle)) / denom;
          const py = centerY + (a * Math.sin(angle) * Math.cos(angle)) / denom;
          if (angle === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();

        // Calculate moving particle position
        const denom = 1 + Math.sin(directedTime) * Math.sin(directedTime);
        const dotX = centerX + (a * Math.cos(directedTime)) / denom;
        const dotY = centerY + (a * Math.sin(directedTime) * Math.cos(directedTime)) / denom;

        drawGlowingOrb(ctx, dotX, dotY, colors.target, 16);
      } else if (mode === 'dot-circle') {
        // Circular smooth pursuit
        const radius = Math.min(width * 0.32, height * 0.32, 130);
        ctx.beginPath();
        ctx.strokeStyle = colors.track;
        ctx.lineWidth = 3;
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.stroke();

        const dotX = centerX + radius * Math.cos(directedTime);
        const dotY = centerY + radius * Math.sin(directedTime);

        drawGlowingOrb(ctx, dotX, dotY, colors['target-secondary'], 16);
      } else if (mode === 'dot-saccades') {
        // Saccades between 8 cardinal targets
        const radius = Math.min(width * 0.35, height * 0.35, 130);
        const allTargets = [
          { x: centerX, y: centerY - radius }, // Top
          { x: centerX, y: centerY },          // Center
          { x: centerX, y: centerY + radius }, // Bottom
          { x: centerX, y: centerY },          // Center
          { x: centerX - radius, y: centerY }, // Left
          { x: centerX, y: centerY },          // Center
          { x: centerX + radius, y: centerY }, // Right
          { x: centerX, y: centerY },          // Center
          { x: centerX - radius * 0.7, y: centerY - radius * 0.7 }, // Top-Left
          { x: centerX + radius * 0.7, y: centerY + radius * 0.7 }, // Bottom-Right
          { x: centerX + radius * 0.7, y: centerY - radius * 0.7 }, // Top-Right
          { x: centerX - radius * 0.7, y: centerY + radius * 0.7 }, // Bottom-Left
        ];
        const path = currentStep.path ?? (currentStepIndex === 0 ? 'horizontal' : 'diagonal');
        const targets = path === 'diagonal' ? allTargets.slice(8)
          : path === 'vertical' ? allTargets.slice(0, 4) : allTargets.slice(4, 8);

        // Draw target dots faintly
        targets.forEach((tgt) => {
          ctx.beginPath();
          ctx.arc(tgt.x, tgt.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = colors.track;
          ctx.fill();
        });

        const targetIndex = Math.floor(t * 1.5) % targets.length;
        const currentTarget = targets[targetIndex];

        // Pulse ring around active target
        const pulse = (Math.sin(t * 8) + 1) * 6;
        ctx.beginPath();
        ctx.arc(currentTarget.x, currentTarget.y, 16 + pulse, 0, Math.PI * 2);
        ctx.strokeStyle = colors.track;
        ctx.lineWidth = 2;
        ctx.stroke();

        drawGlowingOrb(ctx, currentTarget.x, currentTarget.y, colors['target-tertiary'], 14);
      } else if (mode === 'near-far') {
        // Accommodative Tromboning / Depth pulsing
        const focus = currentStep.focus ?? (currentStepIndex % 2 === 0 ? 'near' : 'far');
        const depth = focus === 'near' ? 1 : -1;
        const scale = 14 + (depth + 1) * 22; // 14 to 58 px
        const alpha = 0.5 + (depth + 1) * 0.25;

        // Concentric depth rings
        for (let r = 1; r <= 3; r++) {
          ctx.beginPath();
          ctx.arc(centerX, centerY, scale * (r * 0.7), 0, Math.PI * 2);
          ctx.strokeStyle = colors.track;
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        drawGlowingOrb(ctx, centerX, centerY, depth > 0 ? colors.target : colors['target-secondary'], scale);

      } else if (mode === 'blink') {
        // Donald Korb conscious blink animation
        const blinkCycle = Math.sin(t * 2); // smooth loop
        const lidY = Math.max(0, blinkCycle * 50); // lid position

        ctx.strokeStyle = colors['target-secondary'];
        ctx.lineWidth = 3;

        // Eye outline
        ctx.beginPath();
        ctx.ellipse(centerX, centerY, 70, 42, 0, 0, Math.PI * 2);
        ctx.stroke();

        // Iris
        ctx.beginPath();
        ctx.arc(centerX, centerY, 22, 0, Math.PI * 2);
        ctx.fillStyle = colors['target-secondary'];
        ctx.fill();

        // Pupil
        ctx.beginPath();
        ctx.arc(centerX, centerY, 10, 0, Math.PI * 2);
        ctx.fillStyle = colors.pupil;
        ctx.fill();

        // Simulated closing eyelids
        ctx.fillStyle = colors.bg;
        ctx.beginPath();
        ctx.rect(centerX - 80, centerY - 50, 160, lidY);
        ctx.fill();
        ctx.beginPath();
        ctx.rect(centerX - 80, centerY + 50 - lidY, 160, lidY);
        ctx.fill();

      } else if (mode === 'palming') {
        // Palming dark field & breathing glow
        const breathe = (Math.sin(t * 0.8) + 1) * 0.5; // 0 to 1
        const rad = 50 + breathe * 55;

        // A quiet breathing cue, without a therapeutic claim.
        const grad = ctx.createRadialGradient(centerX, centerY, 10, centerX, centerY, rad);
        grad.addColorStop(0, colors.grid);
        grad.addColorStop(0.5, colors.bg);
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(centerX, centerY, rad, 0, Math.PI * 2);
        ctx.fill();

        ctx.font = '600 15px Plus Jakarta Sans, sans-serif';
        ctx.fillStyle = colors.cue;
        ctx.textAlign = 'center';
        ctx.fillText(
          breathe > 0.5 ? translate("Спокойный вдох") : translate("Спокойный выдох"),
          centerX,
          Math.min(centerY + 95, height - 20)
        );
      } else {
        // Zen horizon
        // Gentle distant horizon line
        ctx.strokeStyle = colors.track;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(centerX - 140, centerY + 55);
        ctx.lineTo(centerX + 140, centerY + 55);
        ctx.stroke();
      }

      animFrameId.current = requestAnimationFrame(render);
    };

    animFrameId.current = requestAnimationFrame(render);

    return () => {
      unsubscribeAppearance();
      resizeObserver.disconnect();
      if (animFrameId.current) cancelAnimationFrame(animFrameId.current);
    };
  }, [routineIndex, currentStepIndex, isPaused]);

  // Helper to draw a glowing orb
  const drawGlowingOrb = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    color: string,
    radius: number
  ) => {
    // Outer glow
    const glowGrad = ctx.createRadialGradient(x, y, 0, x, y, radius * 2.8);
    glowGrad.addColorStop(0, color);
    glowGrad.addColorStop(0.4, color);
    glowGrad.addColorStop(1, 'rgba(0,0,0,0)');

    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = glowGrad;
    ctx.beginPath();
    ctx.arc(x, y, radius * 2.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
    // The target stays distinct on both light and dark exercise surfaces.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.65, 0, Math.PI * 2);
    ctx.fill();
  };

  return (
    <div className="exercise-modal-overlay">
      <div ref={dialogRef} className="exercise-modal-card" role="dialog" aria-modal="true" aria-label={translate(technique.title)} tabIndex={-1}>
        {/* Header */}
        <div className="exercise-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div className="exercise-header-meta" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className={`technique-badge ${technique.badgeClass}`} style={{ marginBottom: 0 }}>
                {translate(technique.categoryLabel)}
              </span>
              <button
                className="btn-secondary"
                style={{ padding: '3px 8px', fontSize: '0.75rem', borderRadius: 6 }}
                onClick={() => setShowClinicalInfo(!showClinicalInfo)}
                aria-expanded={showClinicalInfo}
              >
                <Info size={13} style={{ marginRight: 4 }} />
                {showClinicalInfo ? translate("Скрыть пояснение") : translate("О рекомендации")}
              </button>
            </div>
            <h2 style={{ fontSize: '1.45rem', marginTop: 6 }}>{translate(technique.title)}</h2>
          </div>

          <div className="exercise-header-controls" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              className="btn-icon"
              onClick={toggleSound}
              title={soundActive ? translate("Отключить звук") : translate("Включить звук")}
              aria-label={soundActive ? translate("Отключить звук упражнения") : translate("Включить звук упражнения")}
              aria-pressed={soundActive}
            >
              {soundActive ? <Volume2 size={18} /> : <VolumeX size={18} />}
            </button>
            <button className="btn-icon" onClick={onClose} title={translate("Закрыть")} aria-label={translate("Закрыть упражнение")}>
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Clinical Info Drawer */}
        {showClinicalInfo && (
          <div
            style={{
              background: 'var(--status-info-bg)',
              border: '1px solid var(--border-active)',
              borderRadius: 12,
              padding: 16,
              fontSize: '0.86rem',
              color: 'var(--text-secondary)'
            }}
          >
            <div style={{ fontWeight: 700, color: 'var(--accent-primary)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
              <ShieldCheck size={16} /> {translate("Источник и ограничения:")}</div>
            <p style={{ marginBottom: 8, color: 'var(--text-primary)', lineHeight: 1.5 }}>
              {translate(technique.clinicalMechanism)}
            </p>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
              <strong>{translate("Источник:")}</strong> {translate(technique.scientificReference).split(/(https?:\/\/[^\s;]*[^\s;.,)])/g).map((part, index) =>
                /^https?:\/\//.test(part)
                  ? <a key={index} href={part} target="_blank" rel="noopener noreferrer">{part}</a>
                  : <React.Fragment key={index}>{part}</React.Fragment>
              )}
            </div>
          </div>
        )}

        {/* Canvas or Completion Screen */}
        {!isCompleted ? (
          <>
            {/* Step Breadcrumb Indicators */}
            {techniques.length > 1 && <p className="exercise-progress-label">{translate("Упражнение {value0} из {value1}", { value0: routineIndex + 1, value1: techniques.length })}</p>}
            <div className="exercise-step-indicators" aria-label={translate("Шаги упражнения")}>
              {technique.steps.map((step, idx) => {
                const isPassed = idx < currentStepIndex;
                const isCurrent = idx === currentStepIndex;
                return (
                  <div
                    key={idx}
                    className={`step-indicator-pill ${isCurrent ? 'active' : isPassed ? 'completed' : ''}`}
                    title={translate("Шаг {value0}: {value1}", { value0: idx + 1, value1: translate(step.instruction) })} aria-current={isCurrent ? 'step' : undefined}
                  >
                    <span className="step-indicator-dot" />
                    <span className="step-indicator-label">{translate("Шаг {value0}", { value0: idx + 1 })}</span>
                  </div>
                );
              })}
            </div>

            <div className="exercise-canvas-container">
              <canvas ref={canvasRef} className="exercise-canvas" aria-label={translate(currentStep.instruction)} aria-describedby={visualCaptions.length ? 'exercise-visual-caption' : undefined} />
            </div>
            {visualCaptions.length > 0 && <p id="exercise-visual-caption" className="exercise-visual-caption">
              {visualCaptions.map(caption => <span key={caption}>{caption}</span>)}
            </p>}

            {/* Instruction banner */}
            <div className="exercise-instruction-banner">
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span className="exercise-step-badge">{translate("Шаг {value0} из {value1}", { value0: currentStepIndex + 1, value1: technique.steps.length })}</span>
                <span style={{ fontSize: '0.94rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {translate(currentStep.instruction)}
                </span>
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontSize: '1.75rem',
                  fontWeight: 800,
                  color: 'var(--accent-primary)',
                  minWidth: 48,
                  textAlign: 'right'
                }}
              >{translate("{value0} с", { value0: secondsRemaining })}</div>
            </div>

            {/* Bottom Controls */}
            <div className="exercise-actions" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  className="btn btn-secondary"
                  onClick={() => setIsPaused(!isPaused)}
                  title={translate("Пауза / Продолжить (Пробел)")}
                >
                  {isPaused ? <Play size={16} /> : <Pause size={16} />}
                  {isPaused ? translate("Возобновить") : translate("Пауза")}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => handleNextStep(true)}
                  title={translate("Перейти к следующему шагу")}
                >
                  <SkipForward size={16} />{translate("Следующий шаг")}</button>
              </div>

              <button
                className="btn btn-danger"
                style={{ padding: '8px 16px', fontSize: '0.85rem' }}
                onClick={onClose}
              >{translate("Закончить без записи")}</button>
            </div>
          </>
        ) : (
          /* Completion Celebration View */
          <div style={{ textAlign: 'center', padding: '36px 16px' }}>
            <div
              style={{
                width: 76,
                height: 76,
                borderRadius: '50%',
                background: 'var(--status-success-bg)',
                border: '2px solid var(--border-active)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 20px',
                color: 'var(--status-success)'
              }}
            >
              <CheckCircle2 size={44} />
            </div>
            <h2 style={{ fontSize: '1.8rem', marginBottom: 8 }}>{translate("Перерыв завершён")}</h2>
            <p style={{ color: 'var(--text-secondary)', maxWidth: 460, margin: '0 auto 24px' }}>{translate("{value0} Можно вернуться к работе в удобном темпе.", { value0: techniques.length > 1 ? translate('Последовательность перерыва завершена.') : translate('Вы завершили «{value0}».', { value0: translate(technique.title) }) })}</p>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
              <button className="btn btn-primary" onClick={onClose}>
                <Sparkles size={16} />{translate("Вернуться к работе")}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
