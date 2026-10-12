import React from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { t, formatDate } from '../i18n/runtime';
import { UpdateControls, UpdatePolicy } from '../utils/updates';

export const UpdateSettings: React.FC<{ updates: UpdateControls }> = ({ updates }) => {
  const { state, pending, failed } = updates;
  const busy = pending || state?.status === 'checking' || state?.status === 'downloading';
  const notificationOnly = state?.checkSupported && !state.supported;
  return <section className="settings-section-card" aria-labelledby="updates-title">
    <h3 id="updates-title" tabIndex={-1} className="settings-section-title"><RefreshCw size={18} aria-hidden="true" /> {t('Обновления')}</h3>
    {!state ? <p className="settings-description">{failed ? t('Не удалось проверить обновления. Попробуйте ещё раз позже.') : t('Обновления доступны в установленном приложении.')}</p> : <>
      <p className="settings-section-subtitle">{t('Установлена версия {version}', { version: state.currentVersion })}</p>
      <div className="form-group">
        <label htmlFor="update-policy">{t('Новые версии')}</label>
        <select id="update-policy" className="form-control" value={state.policy}
          onChange={event => { void updates.setPolicy(event.target.value as UpdatePolicy); }}>
          <option value="ask">{notificationOnly ? t('Уведомлять о новых версиях') : t('Спрашивать перед загрузкой')}</option>
          <option value="auto" disabled={!state.supported}>{t('Обновлять автоматически')}</option>
          <option value="off">{t('Не проверять и не показывать')}</option>
        </select>
        <p className="settings-description">{state.policy === 'off'
          ? t('Фоновые проверки и уведомления отключены. Вы можете проверить обновления вручную.')
          : notificationOnly ? t('Blincho проверяет новые версии и показывает уведомления. Новую версию нужно скачать с сайта и установить вручную.')
          : !state.supported ? t('Эта сборка обновляется вручную. Скачайте новую версию с сайта Blincho.')
          : state.policy === 'auto' ? t('Разрешаю загрузку новых версий в фоне и установку при выходе из Blincho. Приложение не прервёт работу.')
          : t('Blincho проверяет новые версии и спрашивает перед загрузкой. Установка происходит при выходе из приложения.')}</p>
      </div>
      <div className="update-status" role="status" aria-live="polite">
        {failed || state.status === 'error' ? <p>{state.errorCode === 'preferences-failed'
          ? t('Не удалось сохранить выбор обновлений. Попробуйте ещё раз.')
          : t('Не удалось проверить или загрузить обновление. Попробуйте ещё раз позже.')}</p> : null}
        {state.status === 'checking' && <p>{t('Проверяем обновления…')}</p>}
        {state.status === 'up-to-date' && <p>{t('У вас последняя версия.')}</p>}
        {state.status === 'available' && <p>{t('Доступна версия {version}', { version: state.availableVersion ?? '' })}</p>}
        {state.status === 'downloading' && <>
          <p>{t('Загрузка обновления: {percent}%', { percent: Math.round(state.progress ?? 0) })}</p>
          <progress max={100} value={state.progress ?? 0} aria-label={t('Загрузка обновления')} />
        </>}
        {state.status === 'ready' && state.installOnQuit && <p>{t('Обновление готово. Оно установится, когда вы выберете «Выйти» в меню Blincho.')}</p>}
      </div>
      <div className="update-actions">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { void updates.check(); }}>
          <RefreshCw size={16} aria-hidden="true" />{t('Проверить обновления')}
        </button>
        {state.supported && state.status === 'available' && <>
          <button type="button" className="btn btn-primary" disabled={pending} onClick={() => { void updates.download(); }}>
            <Download size={16} aria-hidden="true" />{t('Скачать обновление')}
          </button>
          <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => { void updates.skip(); }}>{t('Пропустить эту версию')}</button>
        </>}
        {!state.supported && <button type="button" className="btn btn-secondary" onClick={() => { void updates.openDownload(); }}>{t('Скачать с сайта')}</button>}
        {(state.status === 'downloading' || state.installOnQuit) && <button type="button" className="btn btn-secondary"
          onClick={() => { void updates.setPolicy('off'); }}>{t('Отменить и отключить обновления')}</button>}
      </div>
      {state.lastCheckedAt && <p className="settings-description update-last-check">{t('Последняя проверка: {date}', { date: formatDate(state.lastCheckedAt, { dateStyle: 'short', timeStyle: 'short' }) })}</p>}
      <p className="settings-description">{t('Для проверки обновлений Blincho обращается к blincho.app, для загрузки к GitHub. Статистика и ответы анкеты не отправляются.')}</p>
    </>}
  </section>;
};

export const UpdateNotice: React.FC<{ updates: UpdateControls; suspended: boolean; onSettings: () => void }> = ({ updates, suspended, onSettings }) => {
  const [dismissedVersion, setDismissedVersion] = React.useState<string | null>(null);
  const { state, pending } = updates;
  if (!state || !state.checkSupported || suspended || state.policy !== 'ask' || state.manualCheck || state.status !== 'available' ||
      !state.availableVersion || state.availableVersion === state.skippedVersion || state.availableVersion === dismissedVersion) return null;
  return <aside className="update-notice" aria-labelledby="update-notice-title">
    <div className="update-notice-copy">
      <strong id="update-notice-title">{t('Доступна версия {version}', { version: state.availableVersion })}</strong>
      <p>{state.supported ? t('Скачать сейчас и установить при выходе из Blincho?')
        : t('Скачайте новую версию с сайта Blincho и установите её вручную.')}</p>
    </div>
    <div className="update-actions">
      <button type="button" className="btn btn-primary" disabled={pending} onClick={() => { void (state.supported ? updates.download() : updates.openDownload()); }}>
        {state.supported ? t('Скачать обновление') : t('Скачать с сайта')}
      </button>
      <button type="button" className="btn btn-secondary" onClick={() => setDismissedVersion(state.availableVersion)}>{t('Позже')}</button>
      <button type="button" className="update-text-button" disabled={pending} onClick={() => { void updates.setPolicy('off'); }}>{t('Больше не показывать обновления')}</button>
      <button type="button" className="update-text-button" onClick={onSettings}>{t('Настройки')}</button>
    </div>
  </aside>;
};
