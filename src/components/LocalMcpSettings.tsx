import React, { useEffect, useState } from 'react';
import { t } from '../i18n/runtime';
import { localMcpConnection } from '../utils/localMcp';
import type { LocalMcpState } from '../utils/localMcp';

export const LocalMcpSettings: React.FC<{ enabled: boolean; onChange: (enabled: boolean) => void }> = ({ enabled, onChange }) => {
  const [state, setState] = useState<LocalMcpState | null>(null);
  const [feedback, setFeedback] = useState('');
  const supported = typeof window.desktopAPI?.configureLocalMcp === 'function';
  useEffect(() => {
    if (!supported) return;
    let active = true;
    const read = () => { void window.desktopAPI?.getLocalMcpState?.().then(value => { if (active) setState(value); })
      .catch(() => { if (active) setFeedback('Не удалось получить состояние MCP.'); }); };
    read(); const timer = setInterval(read, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [enabled, supported]);
  const copy = async () => {
    if (!enabled || !state?.running || !state.url || !state.token) return;
    try { await navigator.clipboard.writeText(localMcpConnection(state)); setFeedback('Настройки подключения скопированы.'); }
    catch { setFeedback('Не удалось скопировать. Выделите настройки подключения ниже.'); }
  };
  return <section className="settings-section-card" aria-labelledby="local-mcp-title">
    <h3 id="local-mcp-title" tabIndex={-1} className="settings-section-title">{t('Локальный MCP')}</h3>
    <div className="settings-toggle-row">
      <div className="settings-toggle-copy">
        <label htmlFor="local-mcp-enabled" className="settings-toggle-title">{t('Подключение AI-клиентов')}</label>
        <p id="local-mcp-description" className="settings-description">{t(supported
          ? 'Позволяет читать состояние, настройки и итоги дня, запускать перерыв и управлять таймером. Доступ только с этого компьютера по токену. Выключение закрывает сервер.'
          : 'MCP доступен в настольном приложении.')}</p>
      </div>
      <label className="switch"><input id="local-mcp-enabled" type="checkbox" checked={supported && enabled} disabled={!supported}
        aria-describedby="local-mcp-description" onChange={event => { setFeedback(''); setState(null); onChange(event.target.checked); }} /><span className="slider" aria-hidden="true" /></label>
    </div>
    {enabled && supported && <>
      <p className="settings-feedback" role="status">{state?.running ? t('MCP работает: {url}', { url: state.url ?? '' }) : t('MCP не запущен.')}</p>
      {state?.error && <p className="settings-feedback" role="alert">{t('Не удалось запустить MCP. Попробуйте выключить и включить его снова.')}</p>}
      {state?.running && <>
        <button type="button" className="btn btn-secondary settings-test-button" onClick={() => { void copy(); }}>{t('Копировать подключение')}</button>
        <details><summary>{t('Настройки подключения')}</summary>
          <p className="settings-description">{t('Токен даёт доступ к управлению Blincho. При повторном включении он меняется.')}</p>
          <textarea className="form-control" readOnly rows={10} aria-label={t('Настройки подключения')} value={localMcpConnection(state)} spellCheck={false} />
        </details>
      </>}
    </>}
    {feedback && <p className="settings-feedback" role="status">{t(feedback)}</p>}
  </section>;
};
