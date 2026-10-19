import React, { useEffect, useId, useState } from 'react';
import { FolderOpen, MonitorDown } from 'lucide-react';
import type { SymbioteShortcutStatus } from '../utils/notifications';
import { useI18n } from '../i18n/useI18n';
import { t } from '../i18n/runtime';
import { getSymbioteName, SYMBIOTE_PERKS } from '../utils/symbiote';
import type { SymbioteBuild } from '../utils/symbiote';
import { SymbioteIcon } from './SymbioteIcon';

export const SymbioteBuildCard: React.FC<{ build: SymbioteBuild }> = ({ build }) => {
  useI18n();
  const headingId = useId();
  const name = getSymbioteName(build.mask, t);
  const [shortcut, setShortcut] = useState<SymbioteShortcutStatus>({ supported: false, exists: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.getSymbioteShortcutStatus?.().then(value => { if (!cancelled) setShortcut(value); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [build.mask, name]);
  const createShortcut = async () => {
    setSaving(true); setError(false);
    try {
      const value = await window.electronAPI?.createSymbioteShortcut?.(build.mask, name);
      if (!value?.supported || !value.exists) throw new Error('Shortcut unavailable');
      setShortcut(value);
    } catch { setError(true); }
    finally { setSaving(false); }
  };
  const showShortcut = async () => {
    setError(false);
    try { if (!await window.electronAPI?.showSymbioteShortcut?.()) throw new Error('Shortcut unavailable'); }
    catch { setError(true); }
  };
  return <section className="settings-section-card symbiote-build-card" aria-labelledby={headingId} data-symbiote-build={build.mask}>
    <SymbioteIcon mask={build.mask} size={128} />
    <div className="symbiote-build-copy">
      <span className="section-eyebrow">{t('Ваша сборка')}</span>
      <h3 id={headingId} className="symbiote-build-name">{getSymbioteName(build.mask, t)}</h3>
      <p className="symbiote-build-count">{t('Модули: {count} из {total}', { count: build.perks.length, total: SYMBIOTE_PERKS.length })}</p>
      <p className="settings-description">{t('Внешний вид и название зависят от включённых возможностей.')}</p>
      {build.perks.length ? <ul className="symbiote-perk-list" aria-label={t('Ваша сборка')}>
        {build.perks.map(perk => <li key={perk.id}>{t(perk.label)}</li>)}
      </ul> : <p className="symbiote-build-base">{t('Базовая комплектация')}</p>}
      {(shortcut.supported || error) && <div className="symbiote-shortcut-controls">
        <p className="settings-description">{t('Ярлык на рабочем столе меняется вместе со сборкой.')}</p>
        <div className="symbiote-shortcut-actions">
          <button type="button" className="btn btn-secondary" onClick={() => { void createShortcut(); }}
            disabled={saving} aria-busy={saving} data-shortcut-create>
            <MonitorDown size={16} aria-hidden="true" />{t(shortcut.exists ? 'Обновить ярлык' : 'Создать ярлык')}
          </button>
          {shortcut.exists && <button type="button" className="btn btn-ghost" onClick={() => { void showShortcut(); }}
            disabled={saving} title={shortcut.path ?? undefined} data-shortcut-show>
            <FolderOpen size={16} aria-hidden="true" />{t('Показать ярлык')}
          </button>}
        </div>
        {error && <p className="settings-description" role="alert">{t('Не удалось сохранить ярлык.')}</p>}
      </div>}
    </div>
  </section>;
};
