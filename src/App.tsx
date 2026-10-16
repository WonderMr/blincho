import { useI18n } from './i18n/useI18n';
import { watchAppearance } from './utils/appearance';
import { t, getLocale, formatNumber } from './i18n/runtime';
import React, { useState, useEffect, useRef } from 'react';
import {
  AppSettings, DayStats, ExerciseTechnique, CVSSurveyResult, TimerPreset, ActivitySpan, MeetingSpan
} from './types';
import {
  loadSettings, saveSettings, loadTodayStats, loadAllStats,
  loadCVSResult, recordBreakCompleted, recordExerciseCompleted, recordTimerProgress, getTodayDateString, clearMeetingHistory
} from './utils/storage';
import { soundSynth } from './audio/soundSynth';
import { showEyeBreakNotification } from './utils/notifications';
import { MEDICAL_TECHNIQUES } from './data/medicalTechniques';
import { getSystemIdleSeconds, detectActiveMeeting, hasSystemIdleDetection, hasMeetingDetection, markPageActivity } from './utils/detector';
import { checkCameraPresence } from './utils/cameraPresence';
import { TimerSession, PresenceReason, normalizeTimerSettings } from './utils/timerSession';
import { normalizeMeetingApplications, splitMeetingsByDay } from './utils/meetings';

import { Navbar, ActiveTab } from './components/Navbar';
import { TimerWidget } from './components/TimerWidget';
import { ExerciseLibrary } from './components/ExerciseLibrary';
import { ExercisePlayer } from './components/ExercisePlayer';
import { BreakOverlay } from './components/BreakOverlay';
import { CVSSurvey } from './components/CVSSurvey';
import { ErgonomicsGuide } from './components/ErgonomicsGuide';
import { StatisticsView } from './components/StatisticsView';
import { SettingsModal } from './components/SettingsModal';
import type { MeetingHistoryControlsProps } from './components/MeetingHistoryControls';
import { LanguageSuggestion } from './components/LanguageSuggestion';
import { TransientNotice } from './components/TransientNotice';
import { UpdateNotice } from './components/UpdateSettings';
import { useUpdates } from './utils/updates';
import { hasNativeTimer, NativeTimerSession, NativeTimerSnapshot, readNativeTimer, subscribeNativeTimer, synchronizeNativeTimer, clearNativeMeetingHistory } from './utils/tauriBridge';

import {
  BookOpen, Play, Lock, Video, UserCheck
} from 'lucide-react';

export const App: React.FC = () => {
  useI18n();
  const updates = useUpdates();
  const [settings, setSettings] = useState<AppSettings>(() => normalizeTimerSettings(loadSettings()));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [allStats, setAllStats] = useState<DayStats[]>(loadAllStats);
  const [todayStats, setTodayStats] = useState<DayStats>(() => loadTodayStats(allStats));
  const [cvsResult, setCvsResult] = useState<CVSSurveyResult | null>(loadCVSResult);
  const [activeTab, setActiveTab] = useState<ActiveTab>('timer');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeTechnique, setActiveTechnique] = useState<ExerciseTechnique | null>(null);
  const [activeRoutine, setActiveRoutine] = useState<ExerciseTechnique[] | undefined>();
  const [isBreakActive, setIsBreakActive] = useState(false);
  const [activeBreakSeconds, setActiveBreakSeconds] = useState(settings.breakSeconds);
  const [notice, setNotice] = useState<{ id: number; message: string; canUndo: boolean } | null>(null);
  const noticeRef = useRef(notice);
  const noticeSequence = useRef(0);
  const setNoticeMessage = (message: string | null, canUndo = false) => {
    const next = message ? { id: ++noticeSequence.current, message, canUndo } : null;
    noticeRef.current = next;
    setNotice(next);
  };
  const [inMeetingActive, setInMeetingActive] = useState(false);
  const [currentMeetingApplications, setCurrentMeetingApplications] = useState<string[]>([]);
  const [savedRemainingBeforeReset, setSavedRemainingBeforeReset] = useState<number | null>(null);
  const undoRef = useRef<{ remainingMs: number; totalMs: number } | null>(null);
  const resetOnReturnRef = useRef(false);
  const sessionRef = useRef<TimerSession | null>(null);
  if (!sessionRef.current) sessionRef.current = hasNativeTimer() ? new NativeTimerSession(settings.workMinutes * 60, Date.now()) : new TimerSession(settings.workMinutes * 60, Date.now());
  const session = sessionRef.current;
  const nativeFocusRef = useRef(new Map<string, number>());
  const nativeActivityEndRef = useRef(0);
  const nativeMeetingEndsRef = useRef(new Map<string, number>());
  const pendingActivityRef = useRef<ActivitySpan[]>([]);
  const pendingMeetingsRef = useRef<MeetingSpan[]>([]);
  const lastActivityFlushRef = useRef(Date.now());
  const nativeAbsenceEpochRef = useRef(0);
  const nativeTickRef = useRef(0);
  const nativeMeetingEpochRef = useRef(0);
  const nativeHistoryEpochRef = useRef(0);
  const nativeHistoryMinimumEpochRef = useRef(0);
  const nativeHistoryConsentGenerationRef = useRef(0);
  const nativeHistoryAcknowledgedGenerationRef = useRef<number | null>(null);
  const nativeMeetingSinceRef = useRef(settings.meetingHistoryEnabled ? 0 : Infinity);
  const clearingMeetingsRef = useRef(false);
  const applyNativeRef = useRef<(snapshot: NativeTimerSnapshot) => void>(() => {});
  const [meetingHistoryPending, setMeetingHistoryPending] = useState(false);
  const [meetingHistoryFeedback, setMeetingHistoryFeedback] = useState<'deleted' | 'failed' | null>(null);
  const [, publish] = useState(0);
  const breakIdRef = useRef<string | null>(null);
  const pendingBreakRef = useRef<{ eventId: string; deadlineMonotonicAt: number } | null>(null);
  const exerciseIdRef = useRef<string | null>(null);
  const exerciseStartPendingRef = useRef(false);
  const exerciseCompletionsRef = useRef(new Map<string, { eventId: string; promise: Promise<void> }>());
  const breakEventId = breakIdRef.current;
  const exerciseEventId = exerciseIdRef.current;
  const mountedRef = useRef(false);
  const presenceInFlightRef = useRef<Promise<boolean> | null>(null);
  const presenceRefreshRef = useRef(false);
  const expiryInFlightRef = useRef(false);
  const cameraCheckedVersionRef = useRef<number | null>(null);
  const cameraAbortRef = useRef<AbortController | null>(null);
  const cameraAccessPendingRef = useRef(false);
  const handleCameraAccessPendingChange = (pending: boolean) => {
    cameraAccessPendingRef.current = pending;
    if (pending) cameraAbortRef.current?.abort();
    // A crash during a system prompt must not turn a temporary grant into opt-in.
    saveSettings(pending ? { ...settingsRef.current, cameraLockEnabled: false } : settingsRef.current);
    // Modal cleanup can run after App's own unmount guard has closed sync().
    if (!pending && hasNativeTimer()) synchronizeTimer();
  };
  const dateRef = useRef(getTodayDateString());
  const eventCounterRef = useRef(0);
  const sessionIdRef = useRef(`${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const nextEventId = (kind: string) => `${sessionIdRef.current}:${kind}:${++eventCounterRef.current}`;
  const totalSeconds = session.totalMs / 1000;
  const secondsRemaining = Math.ceil(session.remainingMs / 1000);
  const isRunning = !session.manualPaused && !session.breakActive && !session.exercising;
  const isIdlePaused = !session.present;
  const phase = session.reasons.has('suspended') ? 'suspended' : session.reasons.has('locked') ? 'locked' :
    session.reasons.has('hidden') ? 'hidden' : !session.present ? 'idle' : session.breakActive ? 'break' :
      session.exercising ? 'exercise' : session.manualPaused ? 'manual' : 'work';
  const statusLabel = phase === 'suspended' ? t("Пауза: сон устройства") : phase === 'locked' ? t("Пауза: экран заблокирован") :
    phase === 'hidden' ? t("Пауза: вкладка скрыта") : phase === 'idle' ?
      (session.reasons.has('unconfirmed') ? t("Пауза: присутствие не подтверждено") : t("Пауза: нет активности")) :
      phase === 'break' ? t("Перерыв для глаз") : phase === 'exercise' ? t("Выполняется упражнение") :
        phase === 'manual' ? t("Таймер на ручной паузе") : inMeetingActive ? t("Перерыв отложен: встреча") : t("Рабочий цикл");

  const refreshStats = () => {
    const stats = loadAllStats();
    setTodayStats(loadTodayStats(stats));
    setAllStats(stats);
  };
  const canRecordMeetingHistory = () => settingsRef.current.meetingHistoryEnabled && !clearingMeetingsRef.current &&
    (!hasNativeTimer() || nativeHistoryAcknowledgedGenerationRef.current === nativeHistoryConsentGenerationRef.current);
  const flushFocus = () => {
    const focus = session.drainFocus();
    pendingActivityRef.current.push(...session.drainActivity());
    if (focus.length === 0 && ((pendingActivityRef.current.length === 0 && pendingMeetingsRef.current.length === 0) || Date.now() - lastActivityFlushRef.current < 5000)) return;
    const activity = pendingActivityRef.current.splice(0);
    const meetings = pendingMeetingsRef.current.splice(0).filter(canRecordMeetingHistory);
    lastActivityFlushRef.current = Date.now();
    recordTimerProgress(focus, activity, meetings);
    refreshStats();
  };
  const synchronizeTimer = () => {
    const generation = nativeHistoryConsentGenerationRef.current;
    const historyEnabled = settingsRef.current.meetingHistoryEnabled;
    synchronizeNativeTimer(session, settingsRef.current, snapshot => {
      // Only the acknowledgement of this consent generation can open recording.
      if (!mountedRef.current || !historyEnabled || !settingsRef.current.meetingHistoryEnabled ||
        generation !== nativeHistoryConsentGenerationRef.current) return;
      const epoch = snapshot.meetingHistoryEpoch ?? 0;
      if (epoch < nativeHistoryMinimumEpochRef.current) return;
      nativeHistoryMinimumEpochRef.current = Math.max(nativeHistoryMinimumEpochRef.current, epoch);
      nativeHistoryEpochRef.current = Math.max(nativeHistoryEpochRef.current, epoch);
      nativeHistoryAcknowledgedGenerationRef.current = generation;
    });
  };
  const sync = () => {
    if (mountedRef.current) {
      synchronizeTimer();
      publish(value => value + 1);
    }
  };
  const sendDesktopCommand = (name: string, operation: () => unknown) => {
    try {
      Promise.resolve(operation()).catch(error => console.warn(`Blincho: Desktop command ${name} failed:`, error));
    } catch (error) {
      console.warn(`Blincho: Desktop command ${name} failed:`, error);
    }
  };
  const releaseDesktopBreak = () => {
    sendDesktopCommand('setStrictLock', () => window.electronAPI?.setStrictLock?.(false));
    sendDesktopCommand('setAlwaysOnTop', () => window.electronAPI?.setAlwaysOnTop?.(false));
    sendDesktopCommand('setBreakFullscreen', () => window.electronAPI?.setBreakFullscreen?.(false));
  };
  const restartWork = (seconds = settingsRef.current.workMinutes * 60) => {
    cameraAbortRef.current?.abort();
    session.restart(seconds, Date.now());
    setInMeetingActive(false);
    sync();
  };
  const endBreak = (preservePending = false) => {
    if (!session.breakActive) return;
    session.advance(Date.now());
    flushFocus();
    session.breakActive = false;
    breakIdRef.current = null;
    if (!preservePending) pendingBreakRef.current = null;
    setIsBreakActive(false);
    releaseDesktopBreak();
    restartWork();
  };
  const cancelAbsentActivity = () => {
    pendingBreakRef.current = null;
    if (session.breakActive) endBreak();
    if (session.exercising) {
      session.exercising = false;
      exerciseIdRef.current = null;
      setActiveTechnique(null);
      setActiveRoutine(undefined);
    }
  };
  const finishReturn = () => {
    if (!session.present || session.absentSince === null) return;
    const awaySeconds = (Date.now() - session.absentSince) / 1000;
    session.absentSince = null;
    const resetOnReturn = resetOnReturnRef.current;
    resetOnReturnRef.current = false;
    if (awaySeconds >= 180 || resetOnReturn) {
      undoRef.current = { remainingMs: session.remainingMs, totalMs: session.totalMs };
      setSavedRemainingBeforeReset(Math.ceil(session.remainingMs / 1000));
      restartWork();
      setNoticeMessage("Активность возобновилась. Начат новый рабочий цикл; прежний отсчёт можно восстановить.", true);
    } else {
      session.lastUpdated = Date.now();
      setNoticeMessage(session.manualPaused ? "Активность возобновилась. Ручная пауза сохранена." : "Активность возобновилась. Отсчёт продолжен.");
    }
    refreshStats();
    sync();
  };
  const setPresenceReason = (reason: PresenceReason, active: boolean, startedAt = Date.now()) => {
    if (session.reasons.has(reason) === active) return;
    session.setReason(reason, active, Date.now(), startedAt);
    if (active) {
      cameraAbortRef.current?.abort();
      if (reason === 'idle' && settingsRef.current.idleAction === 'reset') resetOnReturnRef.current = true;
      cancelAbsentActivity();
      flushFocus();
    }
    finishReturn();
    sync();
  };
  const samplePresence = (refresh = false): Promise<boolean> => {
    if (presenceInFlightRef.current) {
      if (refresh) presenceRefreshRef.current = true;
      return presenceInFlightRef.current;
    }
    const query = async (): Promise<boolean> => {
      for (let attempt = 0; mountedRef.current && attempt < 2; attempt += 1) {
        presenceRefreshRef.current = false;
        const sampledVersion = session.version;
        const sampledAt = Date.now();
        const sampledMonotonicAt = performance.now();
        const sampledBreakEventId = breakIdRef.current ?? pendingBreakRef.current?.eventId ?? null;
        const systemPresenceRequired = hasSystemIdleDetection() || !!window.electronAPI?.isElectron;
        const readPowerState = async () => {
          if (!systemPresenceRequired) return null;
          try {
            const power = await Promise.resolve().then(() => window.electronAPI?.getPowerState?.());
            if (power && typeof power.suspended === 'boolean' && typeof power.locked === 'boolean') return power;
            console.warn('Blincho: Invalid or unavailable power state; presence is unconfirmed.');
          } catch (error) {
            console.warn('Blincho: Power state query failed; presence is unconfirmed:', error);
          }
          return null;
        };
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const [idle, power] = await Promise.race([
          Promise.all([getSystemIdleSeconds(), readPowerState()]),
          new Promise<[null, null]>(resolve => {
            timeout = setTimeout(() => {
              console.warn('Blincho: Presence query timed out; presence is unconfirmed.');
              resolve([null, null]);
            }, 3000);
          }),
        ]);
        if (timeout !== undefined) clearTimeout(timeout);
        if (!mountedRef.current) return false;
        if (idle === null || !Number.isFinite(idle) || (systemPresenceRequired && !power)) {
          setPresenceReason('unconfirmed', true, session.lastUpdated);
          return false;
        }
        const threshold = settingsRef.current.idleThresholdMinutes * 60;
        const sampledAbsence = power?.suspended || power?.locked ||
          (settingsRef.current.idleDetectionEnabled && idle >= threshold);
        // Closing the elapsed overlay changes the work-session version, but
        // cannot discard absence already sampled for that same break event.
        if (sampledAbsence && sampledBreakEventId) {
          if (pendingBreakRef.current?.eventId === sampledBreakEventId) pendingBreakRef.current = null;
          if (breakIdRef.current === sampledBreakEventId) {
            if (power?.suspended) setPresenceReason('suspended', true, sampledAt);
            if (power?.locked) setPresenceReason('locked', true, sampledAt);
            if (settingsRef.current.idleDetectionEnabled && idle >= threshold) {
              setPresenceReason('idle', true, sampledAt - Math.max(0, idle - threshold) * 1000);
            }
          }
        }
        // A failed sample must settle even when activity keeps requesting refresh.
        // One queued fresh sample avoids stale responses without starving callbacks.
        if (sampledVersion !== session.version) {
          if (attempt === 0) continue;
          setPresenceReason('unconfirmed', true, session.lastUpdated);
          return false;
        }
        // Fresh input can restore current presence, but cannot erase absence
        // already observed while this activity was running.
        if (power?.suspended) setPresenceReason('suspended', true, sampledAt);
        if (power?.locked) setPresenceReason('locked', true, sampledAt);
        if (settingsRef.current.idleDetectionEnabled && idle >= threshold) {
          setPresenceReason('idle', true, sampledAt - Math.max(0, idle - threshold) * 1000);
        }
        if (presenceRefreshRef.current && attempt === 0) continue;
        if (Date.now() - session.lastUpdated > 5000 && !session.reasons.has('unconfirmed')) {
          setPresenceReason('unconfirmed', true, session.lastUpdated);
        }
        if (power) {
          if (power.suspended !== session.reasons.has('suspended')) setPresenceReason('suspended', power.suspended);
          if (power.locked !== session.reasons.has('locked')) setPresenceReason('locked', power.locked);
        }
        const isIdle = settingsRef.current.idleDetectionEnabled &&
          (idle >= threshold || (session.reasons.has('idle') && idle >= Math.min(threshold, 5)));
        if (isIdle !== session.reasons.has('idle')) {
          setPresenceReason('idle', isIdle, Date.now() - Math.max(0, idle - threshold) * 1000);
        }
        if (session.reasons.has('unconfirmed') && idle < Math.min(threshold, 5)) setPresenceReason('unconfirmed', false);
        // Electron visibility describes this app, not activity in other desktop apps.
        if (!systemPresenceRequired) {
          const hidden = document.visibilityState === 'hidden';
          if (hidden !== session.reasons.has('hidden')) setPresenceReason('hidden', hidden);
        }
        finishReturn();
        const pendingBreak = pendingBreakRef.current;
        if (pendingBreak) {
          // A short return window avoids crediting a break after a later return
          // within the much longer work-idle grace period.
          if (performance.now() - pendingBreak.deadlineMonotonicAt > 15_000) pendingBreakRef.current = null;
          else if (session.present && sampledMonotonicAt - (idle + 1) * 1000 > pendingBreak.deadlineMonotonicAt) {
            // Native idle is rounded down to seconds. Subtract another second
            // and use the query start time, so earlier input and slow IPC cannot
            // masquerade as activity after the rest deadline.
            pendingBreakRef.current = null;
            recordBreakCompleted(0, pendingBreak.eventId);
            refreshStats();
            setNoticeMessage("Перерыв записан. Рабочий цикл продолжается.");
          }
        }
        return session.present;
      }
      return false;
    };
    const pending = query().finally(() => {
      if (presenceInFlightRef.current === pending) presenceInFlightRef.current = null;
    });
    presenceInFlightRef.current = pending;
    return pending;
  };
  const beginBreak = () => {
    if (!session.present || session.breakActive || session.exercising) return;
    cameraAbortRef.current?.abort();
    session.advance(Date.now());
    flushFocus();
    session.breakActive = true;
    session.expiryPending = false;
    session.version += 1;
    breakIdRef.current = nextEventId('break');
    pendingBreakRef.current = null;
    setNoticeMessage(null);
    setActiveBreakSeconds(settingsRef.current.breakSeconds);
    soundSynth.playZenBowl();
    setIsBreakActive(true);
    sendDesktopCommand('setBreakFullscreen', () => window.electronAPI?.setBreakFullscreen?.(true));
    sendDesktopCommand('bringToFront', () => window.electronAPI?.bringToFront?.({ alwaysOnTop: settingsRef.current.strictMode }));
    sendDesktopCommand('setStrictLock', () => window.electronAPI?.setStrictLock?.(settingsRef.current.strictMode));
    sync();
  };
  const checkCameraAndLock = async (version: number, requireExpiry = false): Promise<boolean> => {
    const controller = new AbortController();
    const captureStartedAt = performance.now();
    const isCurrent = () => mountedRef.current && version === session.version && session.counting &&
      (!requireExpiry || session.expiryPending) && !controller.signal.aborted &&
      !cameraAccessPendingRef.current && settingsRef.current.cameraLockEnabled;
    if (!isCurrent() || !window.electronAPI?.lockComputer) return false;
    cameraAbortRef.current?.abort();
    cameraAbortRef.current = controller;
    try {
      const camera = await checkCameraPresence(controller.signal);
      if (camera !== 'absent' || !isCurrent()) return false;
      if (!(await samplePresence()) || !isCurrent()) return false;
      if (hasNativeTimer()) {
        const snapshot = await readNativeTimer();
        if (!snapshot || snapshot.version !== version || snapshot.manualPaused || snapshot.breakActive ||
          snapshot.exercising || snapshot.reasons.length || (requireExpiry && !snapshot.expiryPending)) return false;
      }
      const idle = await getSystemIdleSeconds();
      const sampledAt = performance.now();
      // Input may have resumed in another app after the fullscreen break closed.
      // Query completion and rounded-down idle give an upper bound on input time.
      // Defer locking whenever that bound could fall after capture started.
      if (idle === null || !Number.isFinite(idle) || idle < 0 || sampledAt - idle * 1000 > captureStartedAt) return false;
      if (!isCurrent()) return false;
      if (await window.electronAPI.lockComputer()) {
        if (mountedRef.current) {
          setPresenceReason('locked', true);
          setNoticeMessage("Камера не обнаружила человека. Компьютер заблокирован.");
        }
        return true;
      }
      console.warn('Blincho: Computer lock was not confirmed.');
      if (mountedRef.current) setNoticeMessage("Не удалось заблокировать компьютер.");
    } catch (error) {
      console.warn('Blincho: Computer lock failed:', error);
      if (isCurrent()) setNoticeMessage("Не удалось заблокировать компьютер.");
    } finally {
      if (cameraAbortRef.current === controller) cameraAbortRef.current = null;
    }
    return false;
  };
  const handleTimerExpired = async () => {
    if (expiryInFlightRef.current) return;
    expiryInFlightRef.current = true;
    try {
      const version = session.version;
      const present = await samplePresence();
      if (!present || version !== session.version || !session.counting || !session.expiryPending) return;
      const current = settingsRef.current;
      if (current.meetingDetectionEnabled && hasMeetingDetection()) {
        const meeting = await detectActiveMeeting();
        if (!mountedRef.current || version !== session.version || !session.counting) return;
        if (meeting.inMeeting && settingsRef.current.meetingDetectionEnabled) {
          session.postpone(300, Date.now());
          setInMeetingActive(true);
          setNoticeMessage("Обнаружена активная встреча. Перерыв отложен на 5 минут.");
          if (settingsRef.current.notificationsEnabled) showEyeBreakNotification(t("Blincho: встреча активна"), t("Перерыв отложен на 5 минут."));
          sync();
          return;
        }
      }
      if (!cameraAccessPendingRef.current && settingsRef.current.cameraLockEnabled && window.electronAPI?.lockComputer && cameraCheckedVersionRef.current !== version) {
        cameraCheckedVersionRef.current = version;
        if (await checkCameraAndLock(version, true)) return;
      }
      if (!(await samplePresence()) || !mountedRef.current || version !== session.version || !session.counting) return;
      setInMeetingActive(false);
      if (settingsRef.current.notificationsEnabled) showEyeBreakNotification(t("Время сделать перерыв"), t("Отведите взгляд от экрана и дайте глазам отдохнуть."));
      if (settingsRef.current.autoTakeoverModal || settingsRef.current.strictMode) beginBreak();
      else { soundSynth.playZenBowl(); restartWork(); }
    } finally { expiryInFlightRef.current = false; }
  };
  const handleTriggerInstantBreak = async () => {
    if (await samplePresence()) beginBreak();
  };
  const handleBreakElapsed = (eventId: string | null, deadlineMonotonicAt = performance.now()) => {
    if (!mountedRef.current || !eventId || breakIdRef.current !== eventId || !session.breakActive) return;
    soundSynth.playCompletionChime();
    pendingBreakRef.current = { eventId, deadlineMonotonicAt };
    endBreak(true);
    setNoticeMessage("Перерыв завершён. Рабочий цикл начат автоматически.");
    void checkCameraAndLock(session.version);
  };
  const handleCloseBreakOverlay = async (eventId = breakIdRef.current) => {
    if (settingsRef.current.strictMode || !eventId || breakIdRef.current !== eventId) return;
    if (mountedRef.current && breakIdRef.current === eventId) endBreak();
  };
  const handlePostponeBreak = async (minutes: number, eventId: string | null) => {
    if (settingsRef.current.strictMode || !eventId || breakIdRef.current !== eventId || !session.breakActive) return;
    if (!mountedRef.current || breakIdRef.current !== eventId || !session.breakActive) return;
    session.advance(Date.now());
    flushFocus();
    session.breakActive = false;
    breakIdRef.current = null;
    pendingBreakRef.current = null;
    setIsBreakActive(false);
    releaseDesktopBreak();
    session.postpone(minutes * 60, Date.now());
    sync();
  };
  const handleResetTimer = () => {
    setNoticeMessage(null);
    pendingBreakRef.current = null;
    session.advance(Date.now());
    flushFocus();
    session.manualPaused = true;
    restartWork();
    undoRef.current = null;
    setSavedRemainingBeforeReset(null);
  };
  const handleTogglePlay = () => {
    cameraAbortRef.current?.abort();
    session.advance(Date.now());
    flushFocus();
    session.manualPaused = !session.manualPaused;
    session.expiryPending = false;
    session.version += 1;
    session.lastUpdated = Date.now();
    sync();
  };
  const handleUndoReset = () => {
    const saved = undoRef.current;
    if (!saved) return;
    session.totalMs = saved.totalMs;
    session.postpone(saved.remainingMs / 1000, Date.now());
    undoRef.current = null;
    setSavedRemainingBeforeReset(null);
    setNoticeMessage("Сброс отменён: прежний отсчёт восстановлен.");
    sync();
  };
  const handleUpdateSettings = (nextSettings: AppSettings) => {
    const previous = settingsRef.current;
    let updated = { ...nextSettings };
    if (updated.timerPreset === previous.timerPreset &&
      (updated.workMinutes !== previous.workMinutes || updated.breakSeconds !== previous.breakSeconds)) updated.timerPreset = 'custom';
    updated = normalizeTimerSettings(updated);
    if (updated.meetingHistoryEnabled !== previous.meetingHistoryEnabled) {
      // Discard buffered calls and require observations after this opt-in boundary.
      nativeHistoryConsentGenerationRef.current += 1;
      nativeHistoryAcknowledgedGenerationRef.current = null;
      pendingMeetingsRef.current = [];
      nativeMeetingSinceRef.current = updated.meetingHistoryEnabled ? Date.now() : Infinity;
      nativeHistoryMinimumEpochRef.current = nativeHistoryEpochRef.current + 1;
      nativeMeetingEndsRef.current.clear();
      setCurrentMeetingApplications([]);
      setMeetingHistoryFeedback(null);
    }
    session.advance(Date.now());
    flushFocus();
    settingsRef.current = updated;
    if (!updated.cameraLockEnabled) cameraAbortRef.current?.abort();
    setSettings(updated);
    if (!updated.meetingHistoryEnabled) setCurrentMeetingApplications([]);
    saveSettings(cameraAccessPendingRef.current ? { ...updated, cameraLockEnabled: false } : updated);
    if (updated.workMinutes !== previous.workMinutes || updated.timerPreset !== previous.timerPreset) {
      setNoticeMessage(null);
      pendingBreakRef.current = null;
      restartWork(updated.workMinutes * 60);
      undoRef.current = null;
      setSavedRemainingBeforeReset(null);
    }
    if (!updated.idleDetectionEnabled) setPresenceReason('idle', false);
    void samplePresence();
    if (session.breakActive) sendDesktopCommand('setStrictLock', () => window.electronAPI?.setStrictLock?.(updated.strictMode));
    sync();
  };
  const handleClearMeetingHistory = async () => {
    if (clearingMeetingsRef.current) return;
    clearingMeetingsRef.current = true;
    pendingMeetingsRef.current = [];
    nativeMeetingSinceRef.current = Date.now();
    setCurrentMeetingApplications([]);
    setMeetingHistoryPending(true);
    setMeetingHistoryFeedback(null);
    try {
      // Native invalidation must complete before removing persisted records.
      const snapshot = await clearNativeMeetingHistory();
      if (snapshot) {
        nativeHistoryMinimumEpochRef.current = Math.max(nativeHistoryMinimumEpochRef.current, snapshot.meetingHistoryEpoch ?? 0);
        nativeHistoryEpochRef.current = Math.max(nativeHistoryEpochRef.current, snapshot.meetingHistoryEpoch ?? 0);
        applyNativeRef.current(snapshot);
        nativeTickRef.current = Math.max(nativeTickRef.current, snapshot.tickCount);
      }
      pendingMeetingsRef.current = [];
      nativeMeetingEndsRef.current.clear();
      if (!clearMeetingHistory()) throw new Error('Call history storage deletion failed');
      if (mountedRef.current) { refreshStats(); setMeetingHistoryFeedback('deleted'); }
    } catch (error) {
      console.warn('Blincho: Call history deletion failed:', error);
      if (mountedRef.current) setMeetingHistoryFeedback('failed');
    } finally {
      clearingMeetingsRef.current = false;
      if (mountedRef.current) setMeetingHistoryPending(false);
    }
  };
  const meetingHistoryControls: Omit<MeetingHistoryControlsProps, 'id'> = {
    enabled: settings.meetingHistoryEnabled,
    supported: hasNativeTimer() && hasMeetingDetection(),
    hasHistory: allStats.some(day => (day.meetings?.length ?? 0) > 0),
    pending: meetingHistoryPending,
    feedback: meetingHistoryFeedback,
    onEnabledChange: enabled => handleUpdateSettings({ ...settingsRef.current, meetingHistoryEnabled: enabled }),
    onDelete: handleClearMeetingHistory,
  };
  const handleSelectPreset = (preset: TimerPreset) => {
    setNoticeMessage(null);
    undoRef.current = null;
    setSavedRemainingBeforeReset(null);
    pendingBreakRef.current = null;
    handleUpdateSettings(normalizeTimerSettings({ ...settingsRef.current, timerPreset: preset }));
    // Selecting the current preset is still an explicit restart.
    session.manualPaused = false;
    restartWork();
  };
  const startTechnique = async (technique: ExerciseTechnique, routine?: ExerciseTechnique[]) => {
    if (!mountedRef.current || session.exercising || exerciseStartPendingRef.current) return;
    exerciseStartPendingRef.current = true;
    try {
      // A failed pre-click query must not consume this explicit start request.
      const previousPresence = presenceInFlightRef.current;
      if (previousPresence) await previousPresence;
      if (!mountedRef.current || session.exercising) return;
      if (!(await samplePresence(true)) || !mountedRef.current || session.exercising) return;
      cameraAbortRef.current?.abort();
      session.advance(Date.now());
      flushFocus();
      session.exercising = true;
      session.expiryPending = false;
      session.version += 1;
      exerciseIdRef.current = nextEventId('exercise');
      setActiveTechnique(technique);
      setActiveRoutine(routine);
      sync();
    } finally {
      exerciseStartPendingRef.current = false;
    }
  };
  const handleStartFullRoutine = () => {
    const ids = ['donald-korb-blinking', 'figure-8-pursuit', 'near-far-tromboning', 'palming-relaxation'];
    const routine = ids.map(id => MEDICAL_TECHNIQUES.find(technique => technique.id === id)).filter((technique): technique is ExerciseTechnique => !!technique);
    if (routine.length) return startTechnique(routine[0], routine);
  };
  const closeTechnique = async (eventId = exerciseIdRef.current) => {
    if (!eventId || exerciseIdRef.current !== eventId) return;
    const completions = [...exerciseCompletionsRef.current.values()].filter(completion => completion.eventId === eventId);
    if (completions.length) await Promise.all(completions.map(completion => completion.promise));
    if (!mountedRef.current || exerciseIdRef.current !== eventId) return;
    session.advance(Date.now());
    flushFocus();
    session.exercising = false;
    exerciseIdRef.current = null;
    session.lastUpdated = Date.now();
    setActiveTechnique(null);
    setActiveRoutine(undefined);
    sync();
  };
  const handleExerciseFinished = (techniqueId: string, eventId: string | null): Promise<void> => {
    if (!eventId || exerciseIdRef.current !== eventId || !session.exercising ||
      !(activeRoutine ?? (activeTechnique ? [activeTechnique] : [])).some(technique => technique.id === techniqueId)) return Promise.resolve();
    const key = `${eventId}:${techniqueId}`;
    const existing = exerciseCompletionsRef.current.get(key);
    if (existing) return existing.promise;
    const completion = {
      eventId,
      promise: (async () => {
        if (!(await samplePresence()) || !mountedRef.current || exerciseIdRef.current !== eventId || !session.exercising) return;
        recordExerciseCompleted(techniqueId, key);
        refreshStats();
      })().finally(() => {
        if (exerciseCompletionsRef.current.get(key) === completion) exerciseCompletionsRef.current.delete(key);
      }),
    };
    exerciseCompletionsRef.current.set(key, completion);
    return completion.promise;
  };
  const handlersRef = useRef({ handleTriggerInstantBreak, handleTimerExpired, samplePresence, setPresenceReason, closeTechnique, handleCloseBreakOverlay, handleResetTimer, handleTogglePlay });
  handlersRef.current = { handleTriggerInstantBreak, handleTimerExpired, samplePresence, setPresenceReason, closeTechnique, handleCloseBreakOverlay, handleResetTimer, handleTogglePlay };

  useEffect(() => {
    soundSynth.enabled = settings.soundEnabled;
    soundSynth.volume = settings.soundVolume / 100;
  }, [settings.soundEnabled, settings.soundVolume]);
  useEffect(() => watchAppearance(settings.theme, settings.colorPalette), [settings.theme, settings.colorPalette]);
  useEffect(() => {
    if (!hasNativeTimer()) return;
    const summary = {
      date: todayStats.date, focusMinutes: todayStats.focusMinutes, breaksCompleted: todayStats.breaksCompleted,
      locale: getLocale(), title: t("Сегодня"), nextBreakLabel: t("До перерыва"),
      focusLabel: t("Рабочее время"), breaksLabel: t("Перерывы сегодня"), pausedLabel: t("Таймер на ручной паузе"),
      absentLabel: t("Пауза: нет активности"), breakLabel: t("Перерыв для глаз"),
      exerciseLabel: t("Выполняется упражнение"), readyLabel: t("Пора отдохнуть"),
      meetingLabel: t("Звонок"), meetingInactiveLabel: t("Нет активного звонка"),
      meetingUnknownLabel: t("Статус звонка неизвестен"), meetingDisabledLabel: t("Определение звонков отключено"),
      unknownMeetingAppLabel: t("Неизвестное приложение"),
      focusValue: t("{value0} мин", { value0: Math.floor(todayStats.focusMinutes) }),
      breaksValue: formatNumber(todayStats.breaksCompleted), todayLabel: t("Сегодня"),
      theme: settings.theme, colorPalette: settings.colorPalette,
    };
    void window.__TAURI__!.core.invoke('tray_preview_summary', { summary })
      .catch(error => console.warn('Blincho: Tray summary failed:', error));
  }, [todayStats.date, Math.floor(todayStats.focusMinutes), todayStats.breaksCompleted, statusLabel, getLocale(), settings.theme, settings.colorPalette]);
  useEffect(() => {
    mountedRef.current = true;
    markPageActivity();
    session.lastUpdated = Date.now();
    let polling = false;
    const nativeFocus = nativeFocusRef.current;
    const applyNative = (snapshot: NativeTimerSnapshot) => {
      if (!mountedRef.current || snapshot.totalMs < 1000 || snapshot.tickCount <= nativeTickRef.current) return;
      nativeTickRef.current = snapshot.tickCount;
      if (snapshot.version >= session.version) {
        session.totalMs = snapshot.totalMs;
        session.remainingMs = snapshot.remainingMs;
        session.manualPaused = snapshot.manualPaused;
        session.expiryPending = snapshot.expiryPending;
        session.version = snapshot.version;
      }
      if ((snapshot.meetingPostponedEpoch ?? 0) > nativeMeetingEpochRef.current) {
        nativeMeetingEpochRef.current = snapshot.meetingPostponedEpoch ?? 0;
        setInMeetingActive(true);
        setNoticeMessage("Обнаружена активная встреча. Перерыв отложен на 5 минут.");
        if (settingsRef.current.notificationsEnabled) showEyeBreakNotification(t("Blincho: встреча активна"), t("Перерыв отложен на 5 минут."));
      }
      if (snapshot.absenceEpoch > nativeAbsenceEpochRef.current) {
        nativeAbsenceEpochRef.current = snapshot.absenceEpoch;
        const beganAt = snapshot.absentSince ?? Date.now();
        // A hidden renderer must observe even an absence that ended before this frame arrived.
        handlersRef.current.setPresenceReason('unconfirmed', true, beganAt);
        if (session.absentSince !== null) session.absentSince = Math.min(session.absentSince, beganAt);
        cancelAbsentActivity();
      }
      for (const [date, seconds] of Object.entries(snapshot.focusByDate)) {
        const previous = nativeFocus.get(date) ?? 0;
        if (seconds > previous) { session.ingestNativeFocus(date, seconds - previous); nativeFocus.set(date, seconds); }
      }
      const activity = (snapshot.activitySpans ?? []).filter(span => span.end > nativeActivityEndRef.current)
        .map(span => ({ ...span, start: Math.max(span.start, nativeActivityEndRef.current) }));
      if (activity.length) {
        pendingActivityRef.current.push(...activity);
        nativeActivityEndRef.current = Math.max(...activity.map(span => span.end));
      }
      const meetingSpans = [...splitMeetingsByDay(snapshot.meetingSpans ?? []).values()].flat()
        .sort((a, b) => a.start - b.start || a.end - b.end);
      const historyEpoch = snapshot.meetingHistoryEpoch ?? 0;
      nativeHistoryEpochRef.current = Math.max(nativeHistoryEpochRef.current, historyEpoch);
      const canRecordMeetings = canRecordMeetingHistory() && hasMeetingDetection() &&
        historyEpoch >= nativeHistoryMinimumEpochRef.current;
      for (const span of canRecordMeetings ? meetingSpans : []) {
        // One application's watermark cannot discard an overlapping call in another.
        const previous = Math.max(nativeMeetingEndsRef.current.get(span.app) ?? 0, nativeMeetingSinceRef.current);
        if (span.end <= previous) continue;
        if (canRecordMeetings) pendingMeetingsRef.current.push({ ...span, start: Math.max(span.start, previous) });
        nativeMeetingEndsRef.current.set(span.app, span.end);
      }
      const meetingApplications = canRecordMeetings ? normalizeMeetingApplications(snapshot.meetingApplications) : [];
      setCurrentMeetingApplications(previous => previous.length === meetingApplications.length &&
        previous.every((app, index) => app === meetingApplications[index]) ? previous : meetingApplications);
      session.lastUpdated = Date.now();
      // Add the new pause causes before removing old ones, avoiding a false return between causes.
      for (const active of [true, false]) for (const reason of ['suspended', 'locked', 'unconfirmed', 'idle'] as PresenceReason[]) {
        if (snapshot.reasons.includes(reason) === active) handlersRef.current.setPresenceReason(reason, active, snapshot.absentSince ?? Date.now());
      }
      flushFocus();
      const today = getTodayDateString();
      if (today !== dateRef.current) { dateRef.current = today; refreshStats(); }
      publish(value => value + 1);
      if (snapshot.breakElapsed && session.breakActive) {
        const deadline = performance.now() - Math.max(0, Date.now() - (snapshot.breakEndAt ?? Date.now()));
        handleBreakElapsed(breakIdRef.current, deadline);
      }
      if (snapshot.expiryPending && snapshot.version === session.version && session.counting) void handlersRef.current.handleTimerExpired();
    };
    applyNativeRef.current = applyNative;
    const unsubscribeNative = hasNativeTimer() ? subscribeNativeTimer(applyNative) : undefined;
    if (hasNativeTimer()) synchronizeTimer();
    const tick = async () => {
      if (polling) return;
      polling = true;
      try {
        if (hasNativeTimer()) {
          const snapshot = await readNativeTimer();
          if (snapshot) applyNative(snapshot);
          await handlersRef.current.samplePresence();
          return;
        }
        const now = Date.now();
        if (now - session.lastUpdated > 5000) handlersRef.current.setPresenceReason('unconfirmed', true, session.lastUpdated);
        await handlersRef.current.samplePresence();
        if (!mountedRef.current) return;
        const previousSeconds = Math.ceil(session.remainingMs / 1000);
        const expired = session.advance(Date.now());
        flushFocus();
        const today = getTodayDateString();
        if (today !== dateRef.current) {
          dateRef.current = today;
          refreshStats();
        }
        if (previousSeconds !== Math.ceil(session.remainingMs / 1000)) sync();
        if (expired) void handlersRef.current.handleTimerExpired();
      } finally { polling = false; }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, 1000);
    const unsubscribeBreak = window.electronAPI?.onTriggerBreak?.(() => { void handlersRef.current.handleTriggerInstantBreak(); });
    const unsubscribePower = window.electronAPI?.onPowerStateChange?.(state => {
      if (state === 'suspend') handlersRef.current.setPresenceReason('suspended', true);
      if (state === 'lock-screen') handlersRef.current.setPresenceReason('locked', true);
      if (state === 'resume') {
        handlersRef.current.setPresenceReason('unconfirmed', true, session.absentSince ?? Date.now());
        handlersRef.current.setPresenceReason('suspended', false);
        void handlersRef.current.samplePresence(true);
      }
      if (state === 'unlock-screen') {
        handlersRef.current.setPresenceReason('unconfirmed', true, session.absentSince ?? Date.now());
        handlersRef.current.setPresenceReason('locked', false);
        void handlersRef.current.samplePresence(true);
      }
    });
    const activity = (event: Event) => {
      // macOS fullscreen transitions can emit a stationary mousemove.
      if (event.type === 'mousemove' && (event as MouseEvent).movementX === 0 && (event as MouseEvent).movementY === 0) return;
      cameraAbortRef.current?.abort();
      markPageActivity();
      if (!hasSystemIdleDetection() && !window.electronAPI?.isElectron) {
        handlersRef.current.setPresenceReason('idle', false);
        handlersRef.current.setPresenceReason('unconfirmed', false);
      }
      void handlersRef.current.samplePresence(true);
    };
    const visibility = () => {
      if (!hasSystemIdleDetection() && !window.electronAPI?.isElectron) handlersRef.current.setPresenceReason('hidden', document.visibilityState === 'hidden');
      if (document.visibilityState === 'visible') { refreshStats(); void handlersRef.current.samplePresence(true); }
    };
    const focus = () => { refreshStats(); void handlersRef.current.samplePresence(true); };
    for (const name of ['mousemove', 'keydown', 'mousedown', 'touchstart']) window.addEventListener(name, activity, { passive: true });
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      cameraAbortRef.current?.abort();
      session.advance(Date.now());
      const finalActivity = [...pendingActivityRef.current.splice(0), ...session.drainActivity()];
      const finalMeetings = pendingMeetingsRef.current.splice(0).filter(canRecordMeetingHistory);
      if (finalActivity.length || finalMeetings.length) recordTimerProgress([], finalActivity, finalMeetings);
      mountedRef.current = false;
      pendingBreakRef.current = null;
      clearInterval(timer);
      unsubscribeBreak?.();
      unsubscribePower?.();
      unsubscribeNative?.();
      for (const name of ['mousemove', 'keydown', 'mousedown', 'touchstart']) window.removeEventListener(name, activity);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
      releaseDesktopBreak();
    };
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const interactive = target?.isContentEditable || target?.closest?.('button, a, input, select, textarea, summary, [contenteditable="true"], [contenteditable=""]');
      if (interactive && (event.code === 'Space' || event.code === 'KeyR')) return;
      if (event.code === 'Escape') {
        if (activeTechnique) handlersRef.current.closeTechnique();
        else if (isBreakActive) handlersRef.current.handleCloseBreakOverlay();
        if (isSettingsOpen) setIsSettingsOpen(false);
      } else if (!activeTechnique && !isBreakActive && !isSettingsOpen) {
        if (event.code === 'Space') { event.preventDefault(); handlersRef.current.handleTogglePlay(); }
        if (event.code === 'KeyR') { event.preventDefault(); handlersRef.current.handleResetTimer(); }
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [activeTechnique, isBreakActive, isSettingsOpen]);

  return (
    <div className="app-container">
      {/* macOS Draggable Titlebar (for Electron desktop) */}
      <div className="mac-titlebar-drag">
        <div style={{ marginLeft: 68, fontSize: '0.78rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t("Blincho: Перерывы и комфорт при работе за экраном")}</div>
      </div>

      <div className="app-workspace">
        {/* Navigation */}
        <Navbar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onTriggerInstantBreak={handleTriggerInstantBreak}
          statusLabel={statusLabel}
          statusTone={isIdlePaused ? 'absence' : isBreakActive ? 'break' : isRunning ? 'working' : 'paused'}
          instantBreakDisabled={isIdlePaused || isBreakActive || !!activeTechnique}
          soundEnabled={settings.soundEnabled}
          onToggleSound={() => handleUpdateSettings({ ...settings, soundEnabled: !settings.soundEnabled })}
        />

        <main className="main-content">
          <LanguageSuggestion onChooseLanguage={() => setIsSettingsOpen(true)} />
          <UpdateNotice updates={updates} suspended={isIdlePaused || isSettingsOpen || isBreakActive || !!activeTechnique}
            onSettings={() => setIsSettingsOpen(true)} />

          {activeTab === 'timer' && <div className="dashboard-header">
            <span className="dashboard-eyebrow">{t("Сегодня")}</span>
            <h1 className="dashboard-title">{t("Таймер")}</h1>
          </div>}
          {/* Tab 1: Dashboard / Timer View */}
          {activeTab === 'timer' && (
            <div className="hero-dashboard-grid">
              <TimerWidget
                phase={phase}
                statusLabel={statusLabel}
                breakSeconds={settings.breakSeconds}
                controlsDisabled={isBreakActive || !!activeTechnique}
                onOpenSettings={() => setIsSettingsOpen(true)}
                totalSeconds={totalSeconds}
                secondsRemaining={secondsRemaining}
                isRunning={isRunning}
                isIdlePaused={isIdlePaused}
                preset={settings.timerPreset}
                onTogglePlay={handleTogglePlay}
                onReset={handleResetTimer}
                onTriggerInstantBreak={handleTriggerInstantBreak}
                onSelectPreset={handleSelectPreset}
              />

              <section className="daily-summary" aria-labelledby="daily-summary-title">
                <h2 id="daily-summary-title">{t("Сегодня")}</h2>
                <div className="daily-metrics">
                  <div><strong>{todayStats.breaksCompleted}</strong><span>{t("Перерывов")}</span></div>
                  <div><strong>{todayStats.exercisesCompleted}</strong><span>{t("Упражнений")}</span></div>
                </div>
              </section>
              <section className="recommended-exercise" aria-labelledby="recommended-exercise-title">
                <BookOpen size={20} aria-hidden="true" />
                <div className="recommended-exercise-copy">
                  <span>{t("Рекомендация дня")}</span>
                  <h2 id="recommended-exercise-title">{t("Осознанное моргание")}</h2>
                </div>
                <button type="button" className="btn btn-secondary" onClick={() => startTechnique(MEDICAL_TECHNIQUES[1])}>
                  <Play size={15} aria-hidden="true" />{t("Выполнить сейчас")}
                </button>
              </section>
          <div className="feature-status-list">
            {settings.meetingDetectionEnabled && (
              <span className="feature-status-row">
                <Video size={12} /> {hasMeetingDetection() ? t("Детекция встреч: macOS") : t("Детекция встреч недоступна")}
              </span>
            )}
            {settings.idleDetectionEnabled && (
              <span className="feature-status-row">
                <UserCheck size={12} /> {isIdlePaused ? statusLabel : t("{value0}: {value1} мин", { value0: hasSystemIdleDetection() ? t('Системная активность') : t('Активность вкладки'), value1: settings.idleThresholdMinutes })}
              </span>
            )}
            {settings.strictMode && (
              <span className="feature-status-row">
                <Lock size={12} /> {t("Строгий режим активен")}</span>
            )}
          </div>


            </div>
          )}

          {/* Tab 2: Exercise Library */}
          {activeTab === 'library' && (
            <ExerciseLibrary
              onSelectTechnique={startTechnique}
              onStartFullRoutine={handleStartFullRoutine}
            />
          )}

          {/* Tab 3: CVS Diagnostic Survey */}
          {activeTab === 'survey' && (
            <CVSSurvey onResult={setCvsResult} />
          )}

          {/* Tab 4: Ergonomics & Blue Light Guide */}
          {activeTab === 'ergonomics' && (
            <ErgonomicsGuide />
          )}

          {/* Tab 5: Statistics & Streaks */}
          {activeTab === 'stats' && (
            <StatisticsView
              todayStats={todayStats}
              allStats={allStats}
              cvsResult={cvsResult}
              meetingApplications={currentMeetingApplications}
              meetingHistoryControls={meetingHistoryControls}
            />
          )}
        </main>
      </div>

      {notice && <TransientNotice key={notice.id} message={notice.message}
        durationMs={notice.canUndo ? 15000 : 6000}
        suspended={isIdlePaused || isSettingsOpen || isBreakActive || !!activeTechnique}
        onUndo={notice.canUndo && savedRemainingBeforeReset !== null ? handleUndoReset : undefined}
        onDismiss={() => {
          if (noticeRef.current?.id !== notice.id) return;
          if (notice.canUndo) { undoRef.current = null; setSavedRemainingBeforeReset(null); }
          setNoticeMessage(null);
        }}
      />}

      {/* Full-Screen Break Overlay (When timer finishes or triggered) */}
      {isBreakActive && (
        <BreakOverlay
          initialSeconds={activeBreakSeconds}
          strictMode={settings.strictMode}
            onElapsed={deadlineMonotonicAt => handleBreakElapsed(breakEventId, deadlineMonotonicAt)}
          onClose={() => handleCloseBreakOverlay(breakEventId)}
          onPostpone={minutes => handlePostponeBreak(minutes, breakEventId)}
          onOpenExercises={async () => {
            if (!breakEventId || breakIdRef.current !== breakEventId) return;
            if (!settingsRef.current.strictMode) await handleCloseBreakOverlay(breakEventId);
            if (!mountedRef.current) return;
            await handleStartFullRoutine();
          }}
        />
      )}

      {/* Guided Visual Exercise Player */}
      {activeTechnique && (
        <ExercisePlayer
          technique={activeTechnique}
          routine={activeRoutine}
          onClose={() => closeTechnique(exerciseEventId)}
          onFinished={techniqueId => handleExerciseFinished(techniqueId, exerciseEventId)}
        />
      )}

      {/* Settings Modal */}
      {isSettingsOpen && (
        <SettingsModal
          updates={updates}
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
          onCameraAccessPendingChange={handleCameraAccessPendingChange}
          onClose={() => setIsSettingsOpen(false)}
          meetingHistoryControls={meetingHistoryControls}
        />
      )}
    </div>
  );
};

export default App;
