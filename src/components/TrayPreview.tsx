import { useEffect, useState } from 'react';
import type { NativeTimerSnapshot } from '../utils/tauriBridge';
import '../styles/tray-preview.css';

interface TraySummary {
  date: string; focusMinutes: number; breaksCompleted: number; locale: string;
  title: string; nextBreakLabel: string; focusLabel: string; breaksLabel: string;
  pausedLabel: string; absentLabel: string; breakLabel: string; exerciseLabel: string;
  readyLabel: string; focusValue: string; breaksValue: string; todayLabel: string;
  theme?: string; colorPalette?: string;
}
interface PreviewState { timer: NativeTimerSnapshot; summary: TraySummary | null }

export function previewCountdown(timer: NativeTimerSnapshot, now = Date.now()): string {
  const remaining = timer.breakActive && typeof timer.breakEndAt === 'number'
    ? timer.breakEndAt - now : timer.remainingMs;
  const seconds = Math.ceil(Math.max(0, Number.isFinite(remaining) ? remaining : 0) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function timerLabel(summary: TraySummary, timer: NativeTimerSnapshot): string {
  if (timer.exercising) return summary.exerciseLabel;
  if (timer.breakActive) return summary.breakLabel;
  if (timer.manualPaused) return summary.pausedLabel;
  if (timer.reasons.length > 0) return summary.absentLabel;
  if (timer.expiryPending) return summary.readyLabel;
  return summary.nextBreakLabel;
}

/** A display-only renderer. All localized text and daily totals come from main. */
export default function TrayPreview() {
  const [timer, setTimer] = useState<NativeTimerSnapshot | null>(null);
  const [summary, setSummary] = useState<TraySummary | null>(null);
  useEffect(() => {
    const api = window.__TAURI__;
    if (!api) return;
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const collect = (unsubscribe: () => void) => disposed ? unsubscribe() : unlisten.push(unsubscribe);
    void (async () => {
      collect(await api.event.listen<NativeTimerSnapshot>('native-timer', event => {
        if (!disposed) setTimer(event.payload);
      }));
      collect(await api.event.listen<TraySummary>('tray-preview-summary', event => {
        if (!disposed) setSummary(event.payload);
      }));
      const initial = await api.core.invoke<PreviewState>('tray_preview_state');
      if (!disposed) { setTimer(initial.timer); setSummary(initial.summary); }
    })().catch(error => console.warn('Blincho: Tray preview unavailable:', error));
    return () => { disposed = true; for (const unsubscribe of unlisten) unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!summary) return;
    document.documentElement.lang = summary.locale;
    document.documentElement.dir = ['ar', 'fa', 'he', 'ur'].includes(summary.locale) ? 'rtl' : 'ltr';
    document.documentElement.dataset.palette = ['sage', 'ocean', 'lavender'].includes(summary.colorPalette || '') ? summary.colorPalette : 'sage';
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = summary.theme === 'dark' || (summary.theme !== 'light' && media.matches);
      document.documentElement.dataset.appearance = dark ? 'dark' : 'light';
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    };
    apply();
    if (summary.theme === 'light' || summary.theme === 'dark') return;
    media.addEventListener?.('change', apply);
    return () => media.removeEventListener?.('change', apply);
  }, [summary]);

  if (!summary || !timer) return <div className="tray-preview-shell" aria-busy="true" />;
  const progress = timer.totalMs > 0 ? Math.max(0, Math.min(1, 1 - timer.remainingMs / timer.totalMs)) : 0;
  return (
    <section className="tray-preview-shell" aria-label={summary.title}>
      <header className="tray-preview-heading"><span className="tray-preview-brand" aria-hidden="true">B</span><strong>Blincho</strong><span>{summary.todayLabel}</span></header>
      <div className="tray-preview-clock-row"><span>{timerLabel(summary, timer)}</span><strong className="tray-preview-countdown">{previewCountdown(timer)}</strong></div>
      <div className="tray-preview-progress" aria-hidden="true"><span style={{ width: `${progress * 100}%` }} /></div>
      <dl className="tray-preview-totals">
        <div><dt>{summary.focusLabel}</dt><dd>{summary.focusValue}</dd></div>
        <div><dt>{summary.breaksLabel}</dt><dd>{summary.breaksValue}</dd></div>
      </dl>
    </section>
  );
}
