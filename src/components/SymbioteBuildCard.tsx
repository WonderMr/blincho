import React, { useId } from 'react';
import { useI18n } from '../i18n/useI18n';
import { t } from '../i18n/runtime';
import { getSymbioteName, SYMBIOTE_PERKS } from '../utils/symbiote';
import type { SymbioteBuild } from '../utils/symbiote';
import { SymbioteIcon } from './SymbioteIcon';

export const SymbioteBuildCard: React.FC<{ build: SymbioteBuild }> = ({ build }) => {
  useI18n();
  const headingId = useId();
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
    </div>
  </section>;
};
