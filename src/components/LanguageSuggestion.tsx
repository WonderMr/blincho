import React from 'react';
import { Languages, Check } from 'lucide-react';
import { useI18n } from '../i18n/useI18n';

export function LanguageSuggestion({ onChooseLanguage }: { onChooseLanguage: () => void }) {
  const { t, hasDecision, suggestedLocale, SUPPORTED_LANGUAGES, acceptLanguageSuggestion } = useI18n();
  if (hasDecision) return null;
  const suggested = SUPPORTED_LANGUAGES.find(language => language.code === suggestedLocale)!;
  return (
    <aside className="language-suggestion" aria-labelledby="language-suggestion-title">
      <span className="language-suggestion-icon" aria-hidden="true"><Languages size={22} /></span>
      <div className="language-suggestion-copy">
        <h2 id="language-suggestion-title">{t('Выберите язык')}</h2>
        <p>{t('Рекомендуемый язык: {language}', { language: `\u2068${suggested.nativeName}\u2069` })} {t('Язык можно изменить в любой момент.')}</p>
      </div>
      <div className="language-suggestion-actions">
        <button type="button" className="btn btn-primary" onClick={acceptLanguageSuggestion}><Check size={16} aria-hidden="true" />{t('Сохранить выбор')}</button>
        <button type="button" className="btn btn-secondary" onClick={onChooseLanguage}>{t('Другой язык')}</button>
      </div>
    </aside>
  );
}
