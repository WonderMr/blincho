import React, { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/runtime';
import type { SyncControls } from '../utils/accountSync';
import { generateRecoveryKey } from '../utils/syncCrypto';

interface SyncSettingsProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  sync: SyncControls;
}

export const SyncSettings: React.FC<SyncSettingsProps> = ({ enabled, onEnabledChange, sync }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [registrationCode, setRegistrationCode] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [keyVisible, setKeyVisible] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [pending, setPending] = useState<'connect' | 'delete' | null>(null);
  const [feedback, setFeedback] = useState('');
  const [localError, setLocalError] = useState('');
  const mounted = useRef(false);
  const busy = useRef(false);
  const disabled = pending !== null || sync.status === 'connecting';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const clearSecrets = () => {
    setPassword('');
    setRegistrationCode('');
    setRecoveryKey('');
    setDeletePassword('');
    setKeySaved(false);
    setKeyVisible(false);
  };
  const updateKey = (value: string) => {
    setRecoveryKey(value);
    setKeySaved(false);
    setFeedback('');
    setLocalError('');
  };
  const createKey = () => {
    try { updateKey(generateRecoveryKey()); }
    catch { setLocalError('Неверный ключ шифрования или повреждённые данные.'); }
  };
  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey.trim());
      if (mounted.current) setFeedback('Ключ скопирован.');
    } catch {
      if (mounted.current) setFeedback('Не удалось скопировать ключ. Покажите и скопируйте его вручную.');
    }
  };
  const connect = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current || disabled || !enabled || (mode === 'register' && !keySaved)) return;
    const key = recoveryKey.trim();
    // A 256-bit base64url value has 43 characters and canonical final padding bits.
    if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(key)) {
      setLocalError('Ключ должен содержать 43 символа base64url.');
      return;
    }
    busy.current = true;
    setPending('connect');
    setFeedback('');
    setLocalError('');
    try {
      await sync.connect(mode, email.trim(), password, key, mode === 'register' ? registrationCode.trim() : '');
      if (mounted.current) clearSecrets();
    } catch {
      if (mounted.current) setLocalError('Не удалось подключиться. Проверьте данные и соединение.');
    } finally {
      busy.current = false;
      if (mounted.current) setPending(null);
    }
  };
  const deleteAccount = async () => {
    if (busy.current || disabled || !deletePassword || !window.confirm(t('Удалить аккаунт и все его данные на сервере? Локальные данные сохранятся.'))) return;
    busy.current = true;
    setPending('delete');
    setFeedback('');
    setLocalError('');
    try {
      await sync.deleteAccount(deletePassword);
      if (mounted.current) clearSecrets();
    } catch {
      if (mounted.current) setLocalError('Не удалось удалить аккаунт. Проверьте пароль и соединение.');
    } finally {
      busy.current = false;
      if (mounted.current) setPending(null);
    }
  };
  const error = sync.error === 'key' ? 'Неверный ключ шифрования или повреждённые данные.'
    : localError || (sync.error === 'connection' ? 'Не удалось подключиться. Проверьте данные и соединение.' : '');

  return <section className="settings-section-card" aria-labelledby="account-sync-title">
    <h3 id="account-sync-title" tabIndex={-1} className="settings-section-title">{t('Синхронизация устройств')}</h3>
    <div className="settings-toggle-row">
      <div className="settings-toggle-copy">
        <label htmlFor="account-sync-enabled" className="settings-toggle-title">{t('Экспериментальная синхронизация')}</label>
        <p id="account-sync-description" className="settings-description">{t('Настройки оформления и ритма, итоги дня и общий перерыв на ваших устройствах.')}</p>
      </div>
      <label className="switch"><input id="account-sync-enabled" type="checkbox" checked={enabled} disabled={disabled}
        aria-describedby="account-sync-description" onChange={event => {
          setFeedback(''); setLocalError('');
          if (!event.target.checked) { clearSecrets(); sync.disconnect(); }
          onEnabledChange(event.target.checked);
        }} /><span className="slider" aria-hidden="true" /></label>
    </div>
    {enabled && <>
      <details>
        <summary>{t('Конфиденциальность и ограничения')}</summary>
        <p className="settings-description">{t('Синхронизируются только выбранные настройки оформления и ритма, а также дневные итоги статистики. Журнал, интервалы активности, звонки, ввод и кадры камеры не передаются. Строгий режим, присутствие и настройки приватности остаются локальными.')}</p>
        <p className="settings-description">{t('Итоги суммируют активность устройств. Одновременная работа на нескольких устройствах может учитываться несколько раз.')}</p>
        <p className="settings-description">{t('Общий блокирующий перерыв действует на активных устройствах в сети. Устройства без сети, во время звонка или при отсутствии могут пропустить его. Возможна задержка сети.')}</p>
        <p className="settings-description">{t('Ключ шифрования не отправляется серверу. Без него данные не восстановить. Пароль и ключ хранятся только в памяти: вводите их после перезапуска.')}</p>
      </details>
      <p className="settings-description">{t('Сервер: {url}', { url: 'https://back.blincho.app' })}</p>
      {sync.account !== null ? <>
        <p className="settings-feedback" role="status">{t('Подключено: {email}', { email: sync.account ?? '' })}</p>
        <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => {
          clearSecrets(); setFeedback(''); setLocalError(''); sync.disconnect();
        }}>{t('Выйти из аккаунта')}</button>
        <details>
          <summary>{t('Удалить аккаунт и облачные данные')}</summary>
          <div className="form-group">
            <label htmlFor="account-sync-delete-password">{t('Пароль для удаления аккаунта')}</label>
            <input id="account-sync-delete-password" className="form-control" type="password" autoComplete="current-password"
              value={deletePassword} maxLength={256} disabled={disabled} onChange={event => setDeletePassword(event.target.value)} />
          </div>
          <button type="button" className="btn btn-danger" disabled={disabled || !deletePassword} onClick={() => { void deleteAccount(); }}>
            {t(pending === 'delete' ? 'Удаление…' : 'Удалить аккаунт и облачные данные')}
          </button>
        </details>
      </> : <form onSubmit={event => { void connect(event); }}>
        <fieldset className="appearance-fieldset" disabled={disabled}>
          <legend>{t('Синхронизация устройств')}</legend>
          <div className="appearance-options">
            {(['login', 'register'] as const).map(value => <label className="appearance-choice" key={value}>
              <input type="radio" name="account-sync-mode" value={value} checked={mode === value} onChange={() => {
                setMode(value); setKeySaved(false); setRegistrationCode(''); setFeedback(''); setLocalError('');
              }} /><span>{t(value === 'login' ? 'Войти' : 'Создать аккаунт')}</span>
            </label>)}
          </div>
        </fieldset>
        <div className="settings-form-grid">
          <div className="form-group">
            <label htmlFor="account-sync-email">{t('Электронная почта')}</label>
            <input id="account-sync-email" className="form-control" type="email" autoComplete="username" autoCapitalize="none"
              required maxLength={254} value={email} disabled={disabled} onChange={event => setEmail(event.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="account-sync-password">{t('Пароль')}</label>
            <input id="account-sync-password" className="form-control" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required minLength={12} maxLength={256} value={password} disabled={disabled} onChange={event => setPassword(event.target.value)} />
          </div>
        </div>
        {mode === 'register' && <div className="form-group">
          <label htmlFor="account-sync-code">{t('Код приглашения')}</label>
          <p id="account-sync-code-description" className="settings-description">{t('Регистрация доступна по коду приглашения администратора.')}</p>
          <input id="account-sync-code" className="form-control" type="password" autoComplete="off" required maxLength={256}
            aria-describedby="account-sync-code-description" value={registrationCode} disabled={disabled} onChange={event => setRegistrationCode(event.target.value)} />
        </div>}
        <div className="form-group">
          <label htmlFor="account-sync-key">{t('Ключ шифрования')}</label>
          <input id="account-sync-key" className="form-control" type={keyVisible ? 'text' : 'password'} autoComplete="off" autoCapitalize="none"
            spellCheck={false} required maxLength={43} value={recoveryKey} disabled={disabled} onChange={event => updateKey(event.target.value)} />
          <p className="settings-description">{t('Ключ шифрования не отправляется серверу. Без него данные не восстановить. Пароль и ключ хранятся только в памяти: вводите их после перезапуска.')}</p>
          <label><input type="checkbox" checked={keyVisible} disabled={disabled} onChange={event => setKeyVisible(event.target.checked)} /> {t('Показать ключ')}</label>
          <div className="appearance-options">
            {mode === 'register' && <button type="button" className="btn btn-secondary" disabled={disabled} onClick={createKey}>{t('Создать ключ')}</button>}
            <button type="button" className="btn btn-secondary" disabled={disabled || !recoveryKey.trim()} onClick={() => { void copyKey(); }}>{t('Копировать ключ')}</button>
          </div>
        </div>
        {mode === 'register' && <div className="form-group">
          <label><input type="checkbox" checked={keySaved} required disabled={disabled || !recoveryKey.trim()} onChange={event => setKeySaved(event.target.checked)} /> {t('Я сохранил ключ в надёжном месте.')}</label>
        </div>}
        <button type="submit" className="btn btn-primary" disabled={disabled || (mode === 'register' && !keySaved)}>
          {t(disabled ? 'Подключение…' : mode === 'register' ? 'Создать аккаунт' : 'Войти')}
        </button>
      </form>}
      {!disabled && error && <p className="settings-feedback" role="alert">{t(error)}</p>}
      {feedback && <p className="settings-feedback" role="status">{t(feedback)}</p>}
    </>}
  </section>;
};
