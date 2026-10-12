import { useSyncExternalStore } from 'react';
import { t, getLocale, getLanguagePreference, getSuggestedLocale, hasLanguageDecision, setLanguagePreference,
  acceptLanguageSuggestion, subscribeLanguage, getLanguageSnapshot, SUPPORTED_LANGUAGES, formatNumber, formatDate } from './runtime';

export function useI18n() {
  useSyncExternalStore(subscribeLanguage, getLanguageSnapshot, getLanguageSnapshot);
  return { t, locale: getLocale(), preference: getLanguagePreference(), suggestedLocale: getSuggestedLocale(),
    hasDecision: hasLanguageDecision(), setLanguagePreference, acceptLanguageSuggestion, SUPPORTED_LANGUAGES, formatNumber, formatDate };
}
