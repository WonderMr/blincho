import { useI18n } from '../i18n/useI18n';
import { LanguagePicker } from './LanguagePicker';
import { t, formatNumber } from '../i18n/runtime';
import React, { useEffect, useRef, useState } from 'react';
import { AppSettings } from '../types';
import { soundSynth } from '../audio/soundSynth';
import { showEyeBreakNotification, requestNotificationPermission } from '../utils/notifications';
import { X, Volume2, Shield, Check, Clock, Monitor } from 'lucide-react';

interface SettingsModalProps {
  settings: AppSettings;
  onUpdateSettings: (newSettings: AppSettings) => void;
  onClose: () => void;
}

interface ToggleRowProps {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children?: React.ReactNode;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ id, title, description, checked, onChange, disabled = false, children }) => (
  <div className={`settings-toggle-row ${disabled ? 'feature-unavailable' : ''}`}>
    <div className="settings-toggle-copy">
      <label htmlFor={id} className="settings-toggle-title">{title}</label>
      <p id={`${id}-description`} className="settings-description">{description}</p>
    </div>
    <div className="settings-toggle-actions">
      {children}
      <label className="switch">
        <input id={id} type="checkbox" checked={checked} disabled={disabled}
          aria-describedby={`${id}-description`} onChange={e => onChange(e.target.checked)} />
        <span className="slider" aria-hidden="true" />
      </label>
    </div>
  </div>
);

export const SettingsModal: React.FC<SettingsModalProps> = ({ settings, onUpdateSettings, onClose }) => {
  const { preference, suggestedLocale, SUPPORTED_LANGUAGES, setLanguagePreference } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [notificationFeedback, setNotificationFeedback] = useState('');
  const [notificationPending, setNotificationPending] = useState(false);
  const nativeApi = window.electronAPI as (NonNullable<Window['electronAPI']> & { meetingDetectionSupported?: boolean }) | undefined;
  const isNative = nativeApi?.isElectron === true;
  const meetingSupported = isNative && nativeApi?.meetingDetectionSupported === true;
  const notificationsSupported = isNative || 'Notification' in window;
  const notificationsBlocked = !isNative && 'Notification' in window && Notification.permission === 'denied';

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  const handleChange = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    onUpdateSettings({ ...settings, [key]: value,
      ...(key === 'workMinutes' || key === 'breakSeconds' ? { timerPreset: 'custom' as const } : {}) });
  };
  const selectPreset = (preset: AppSettings['timerPreset']) => {
    onUpdateSettings({ ...settings, timerPreset: preset,
      ...(preset === '20-20-20' ? { workMinutes: 20, breakSeconds: 20 } : preset === 'pomodoro' ? { workMinutes: 25, breakSeconds: 300 } : {}) });
  };
  const testSound = () => {
    const enabled = soundSynth.enabled;
    soundSynth.enabled = true;
    soundSynth.playZenBowl();
    soundSynth.enabled = enabled;
  };
  const showSection = (id: string) => {
    const heading = dialogRef.current?.querySelector<HTMLElement>(`#${id}`);
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus({ preventScroll: true });
  };
  const testNotification = async () => {
    setNotificationPending(true);
    try {
      if (await requestNotificationPermission()) {
        showEyeBreakNotification(t("Тестовое уведомление Blincho"), t("Так будет выглядеть напоминание о перерыве."));
        setNotificationFeedback("Уведомление отправлено. Его показ зависит от настроек браузера или системы, включая режим «Не беспокоить».");
      } else {
        setNotificationFeedback("Разрешение не получено. Разрешите уведомления в настройках браузера или системы.");
      }
    } catch {
      setNotificationFeedback("Не удалось отправить уведомление. Проверьте разрешения браузера или системы.");
    } finally {
      setNotificationPending(false);
    }
  };

  return (
    <div className="modal-backdrop settings-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="modal-box settings-dialog" role="dialog" aria-modal="true"
        aria-labelledby="settings-dialog-title" aria-describedby="settings-save-description">
        <header className="settings-dialog-header">
          <div><span className="section-eyebrow">{t("Удобный ритм")}</span><h2 id="settings-dialog-title">{t("Настройки")}</h2></div>
          <button type="button" className="btn-icon" onClick={onClose} title={t("Закрыть (Esc)")} aria-label={t("Закрыть настройки")}><X size={20} /></button>
        </header>
        <p id="settings-save-description" className="settings-save-note">{t("Изменения применяются сразу. Новый интервал работы начинает отсчёт заново.")}</p>
        <nav className="settings-section-nav" aria-label={t("Разделы настроек")}>
          <button type="button" onClick={() => showSection('language-title')}>{t('Язык интерфейса')}</button>
          <button type="button" onClick={() => showSection('appearance-title')}><Monitor size={15} aria-hidden="true" />{t("Оформление")}</button>
          <button type="button" onClick={() => showSection('timing-title')}><Clock size={15} aria-hidden="true" />{t("Ритм")}</button>
          <button type="button" onClick={() => showSection('alerts-title')}><Volume2 size={15} aria-hidden="true" />{t("Напоминания")}</button>
          <button type="button" onClick={() => showSection('automation-title')}><Shield size={15} aria-hidden="true" />{t("Автопауза")}</button>
        </nav>
        <div className="settings-scroll-body">
          <section className="settings-section-card" aria-labelledby="language-title">
            <h3 id="language-title" tabIndex={-1} className="settings-section-title">{t('Язык и регион')}</h3>
            <LanguagePicker value={preference} languages={[...SUPPORTED_LANGUAGES]} detectedLanguage={suggestedLocale}
              onChange={value => setLanguagePreference(value as typeof preference)}
              labels={{ label: t('Язык интерфейса'), description: t('Предпочтение сохранится на этом устройстве.'),
                automaticLabel: t('Автоматически (язык системы)'), detectedLabel: t('Язык системы') }} />
          </section>
          <section className="settings-section-card" aria-labelledby="appearance-title">
            <h3 id="appearance-title" tabIndex={-1} className="settings-section-title">{t("Оформление")}</h3>
            <p className="settings-section-subtitle">{t("В режиме «Как в системе» оформление меняется вместе с темой ОС. Цветовая гамма сохраняется.")}</p>
            <fieldset className="appearance-fieldset">
              <legend>{t("Режим оформления")}</legend>
              <div className="appearance-options">
                {([['system', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']] as const).map(([value, label]) => (
                  <label className="appearance-choice" key={value}>
                    <input type="radio" name="appearance-mode" value={value} checked={settings.theme === value} onChange={() => handleChange('theme', value)} />
                    <span>{t(label)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="appearance-fieldset">
              <legend>{t("Цветовая гамма")}</legend>
              <div className="appearance-options">
                {([['sage', 'Шалфей'], ['ocean', 'Океан'], ['lavender', 'Лаванда']] as const).map(([value, label]) => (
                  <label className="appearance-choice palette-choice" key={value}>
                    <input type="radio" name="color-palette" value={value} checked={settings.colorPalette === value} onChange={() => handleChange('colorPalette', value)} />
                    <span><i className={`palette-swatch swatch-${value}`} aria-hidden="true" />{t(label)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </section>
          <section className="settings-section-card" aria-labelledby="timing-title">
            <div className="settings-section-header"><div className="settings-section-icon"><Clock size={18} /></div>
              <div><h3 id="timing-title" tabIndex={-1} className="settings-section-title">{t("Работа и перерыв")}</h3><p className="settings-section-subtitle">{t("Ручное изменение времени включает свой режим.")}</p></div>
            </div>
            <div className="form-group"><label htmlFor="timer-preset">{t("Режим таймера")}</label>
              <select id="timer-preset" className="form-control" value={settings.timerPreset} onChange={e => selectPreset(e.target.value as AppSettings['timerPreset'])}>
                <option value="20-20-20">{t("20–20–20 · 20 минут / 20 секунд")}</option><option value="pomodoro">{t("Помодоро · 25 минут / 5 минут")}</option><option value="custom">{t("Свой режим")}</option>
              </select>
            </div>
            <div className="settings-form-grid">
              <div className="form-group"><label htmlFor="work-minutes">{t("Работа, минуты")}</label>
                <select id="work-minutes" className="form-control" value={settings.workMinutes} onChange={e => handleChange('workMinutes', Number(e.target.value))}>
                  {Array.from(new Set([10, 15, 20, 25, 30, 45, 60, settings.workMinutes])).sort((a,b) => a-b).map(value => <option key={value} value={value}>{t("{value0} мин", { value0: value })}</option>)}
                </select>
              </div>
              <div className="form-group"><label htmlFor="break-seconds">{t("Перерыв")}</label>
                <select id="break-seconds" className="form-control" value={settings.breakSeconds} onChange={e => handleChange('breakSeconds', Number(e.target.value))}>
                  {Array.from(new Set([15, 20, 30, 45, 60, 120, 300, settings.breakSeconds])).sort((a,b) => a-b).map(value => <option key={value} value={value}>{value >= 60 ? t("{value0} мин", { value0: value / 60 }) : t("{value0} сек", { value0: value })}</option>)}
                </select>
              </div>
            </div>
          </section>
          <section className="settings-section-card" aria-labelledby="alerts-title">
            <div className="settings-section-header"><div className="settings-section-icon"><Volume2 size={18} /></div>
              <div><h3 id="alerts-title" tabIndex={-1} className="settings-section-title">{t("Напоминания")}</h3><p className="settings-section-subtitle">{t("Звук, уведомление и экран отдыха.")}</p></div>
            </div>
            <ToggleRow id="sound-enabled" title={t("Звуковой сигнал")} description={t("Мягкий сигнал в начале и конце перерыва.")} checked={settings.soundEnabled}
              onChange={value => { soundSynth.enabled = value; handleChange('soundEnabled', value); }}>
              <button type="button" className="btn btn-secondary settings-test-button" onClick={testSound}>{t("Прослушать")}</button>
            </ToggleRow>
            {settings.soundEnabled && <div className="form-group"><label htmlFor="sound-volume">{t("Громкость: {value0}%", { value0: settings.soundVolume ?? 80 })}</label>
              <input id="sound-volume" type="range" min="10" max="100" step="5" value={settings.soundVolume ?? 80} onChange={e => { soundSynth.volume = Number(e.target.value) / 100; handleChange('soundVolume', Number(e.target.value)); }} />
            </div>}
            <ToggleRow id="notifications-enabled" title={t("Системные уведомления")}
              description={!notificationsSupported ? t("Этот браузер не поддерживает уведомления.") : notificationsBlocked ? t("Уведомления заблокированы в браузере. Разрешите их в настройках сайта.") : isNative ? t("Показ зависит от разрешений и настроек системы.") : t("Для показа нужно разрешение браузера. Вкладка должна оставаться открытой.")}
              checked={notificationsSupported && settings.notificationsEnabled} disabled={!notificationsSupported} onChange={value => handleChange('notificationsEnabled', value)}>
              <button type="button" className="btn btn-secondary settings-test-button" onClick={testNotification} disabled={!notificationsSupported || notificationPending}>{notificationPending ? t("Проверка…") : t("Проверить")}</button>
            </ToggleRow>
            {notificationFeedback && <p className="settings-feedback" role="status">{t(notificationFeedback)}</p>}
            <ToggleRow id="takeover-enabled" title={t("Экран отдыха по таймеру")} description={t("Показывает перерыв внутри окна Blincho. При выключении остаются выбранные напоминания.")}
              checked={settings.autoTakeoverModal} onChange={value => handleChange('autoTakeoverModal', value)} />
          </section>
          <section className="settings-section-card" aria-labelledby="automation-title">
            <div className="settings-section-header"><div className="settings-section-icon"><Shield size={18} /></div>
              <div><h3 id="automation-title" tabIndex={-1} className="settings-section-title">{t("Пауза и режим отдыха")}</h3><p className="settings-section-subtitle">{isNative ? t("Настольная версия") : t("Браузерная версия: доступна только активность этой страницы.")}</p></div>
            </div>
            <ToggleRow id="meeting-detection" title={t("Откладывать перерыв во время звонка")}
              description={meetingSupported ? t("При системных признаках звонка перерыв откладывается. Детектор может ошибаться.") : t("Недоступно в этой версии. Системный детектор звонков поддерживается в приложении для macOS.")}
              checked={meetingSupported && settings.meetingDetectionEnabled} disabled={!meetingSupported} onChange={value => handleChange('meetingDetectionEnabled', value)} />
            <ToggleRow id="idle-detection" title={t("Автопауза без активности")}
              description={isNative ? t("Отсутствие мыши и клавиатуры не означает, что вы отошли: чтение тоже считается неактивностью.") : t("Учитывает ввод только на этой странице и скрытие вкладки. Активность в других приложениях недоступна.")}
              checked={settings.idleDetectionEnabled} onChange={value => handleChange('idleDetectionEnabled', value)} />
            {settings.idleDetectionEnabled && <div className="settings-nested-fields">
              <div className="settings-form-grid">
                <div className="form-group"><label htmlFor="idle-action">{t("Без активности")}</label><select id="idle-action" className="form-control" value={settings.idleAction || 'pause'} onChange={e => handleChange('idleAction', e.target.value as AppSettings['idleAction'])}>
                  <option value="pause">{t("Поставить на паузу")}</option><option value="reset">{t("Начать интервал заново")}</option></select></div>
                <div className="form-group"><label htmlFor="idle-threshold">{t("Через")}</label><select id="idle-threshold" className="form-control" value={settings.idleThresholdMinutes ?? 1} onChange={e => handleChange('idleThresholdMinutes', Number(e.target.value))}>
                  {[...new Set([0.5,1,3,5,10,15,20,30,60,settings.idleThresholdMinutes ?? 1])].sort((a,b) => a-b).map(value => <option key={value} value={value}>{t("{value0} мин", { value0: formatNumber(value) })}</option>)}</select></div>
              </div>
              <p className="settings-section-subtitle">{t("Автопауза действует и в строгом режиме.")}</p>
            </div>}
            <ToggleRow id="strict-mode" title={t("Строгий режим")} description={isNative ? t("В течение перерыва окно остаётся поверх остальных, а пропуск недоступен.") : t("В течение перерыва пропуск недоступен. Браузер не блокирует другие приложения.")}
              checked={settings.strictMode} onChange={value => handleChange('strictMode', value)} />
          </section>
        </div>
        <footer className="settings-dialog-footer"><span><Monitor size={14} aria-hidden="true" />{isNative ? t("Настольная версия") : t("Браузерная версия")}</span>
          <button type="button" className="btn btn-primary" onClick={onClose}><Check size={17} aria-hidden="true" />{t("Готово")}</button>
        </footer>
      </div>
    </div>
  );
};
