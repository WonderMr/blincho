import en from './locales/en.json';
import ru from './locales/ru.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import it from './locales/it.json';
import pt from './locales/pt.json';
import zh from './locales/zh.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import ar from './locales/ar.json';
import hi from './locales/hi.json';
import tr from './locales/tr.json';
import pl from './locales/pl.json';
import uk from './locales/uk.json';

import hy from './locales/hy.json';
import bn from './locales/bn.json';
import id from './locales/id.json';
import vi from './locales/vi.json';
import th from './locales/th.json';
import fa from './locales/fa.json';
import ur from './locales/ur.json';
import he from './locales/he.json';
import nl from './locales/nl.json';
import sv from './locales/sv.json';
import cs from './locales/cs.json';
import ro from './locales/ro.json';
import el from './locales/el.json';
import ta from './locales/ta.json';
import te from './locales/te.json';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English', locale: 'en', dir: 'ltr' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', locale: 'ru', dir: 'ltr' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', locale: 'es', dir: 'ltr' },
  { code: 'fr', name: 'French', nativeName: 'Français', locale: 'fr', dir: 'ltr' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', locale: 'de', dir: 'ltr' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', locale: 'it', dir: 'ltr' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português (Brasil)', locale: 'pt-BR', dir: 'ltr' },
  { code: 'zh', name: 'Chinese', nativeName: '简体中文', locale: 'zh-CN', dir: 'ltr' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', locale: 'ja', dir: 'ltr' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', locale: 'ko', dir: 'ltr' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', locale: 'ar', dir: 'rtl' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', locale: 'hi', dir: 'ltr' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', locale: 'tr', dir: 'ltr' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski', locale: 'pl', dir: 'ltr' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська', locale: 'uk', dir: 'ltr' },
  { code: 'hy', name: 'Armenian', nativeName: 'Հայերեն', locale: 'hy', dir: 'ltr' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', locale: 'bn', dir: 'ltr' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', locale: 'id', dir: 'ltr' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', locale: 'vi', dir: 'ltr' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย', locale: 'th', dir: 'ltr' },
  { code: 'fa', name: 'Persian', nativeName: 'فارسی', locale: 'fa', dir: 'rtl' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو', locale: 'ur', dir: 'rtl' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית', locale: 'he', dir: 'rtl' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', locale: 'nl', dir: 'ltr' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska', locale: 'sv', dir: 'ltr' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština', locale: 'cs', dir: 'ltr' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română', locale: 'ro', dir: 'ltr' },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά', locale: 'el', dir: 'ltr' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', locale: 'ta', dir: 'ltr' },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు', locale: 'te', dir: 'ltr' },
] as const;

export type Locale = typeof SUPPORTED_LANGUAGES[number]['code'];
export type LanguagePreference = Locale | 'auto';
export type TranslationVariables = Record<string, string | number>;
const catalogs: Record<Locale, Record<string, string>> = { en, ru, es, fr, de, it, pt, zh, ja, ko, ar, hi, tr, pl, uk, hy, bn, id, vi, th, fa, ur, he, nl, sv, cs, ro, el, ta, te };
export const LANGUAGE_STORAGE_KEY = 'blincho-language-v1';
const listeners = new Set<() => void>();
let revision = 0;
let systemLanguages: string[] = [];
let initialization: Promise<void> | undefined;

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && SUPPORTED_LANGUAGES.some(language => language.code === value);
}

/** Match regional/script BCP 47 preferences in their original priority order. */
export function resolveLocale(preferences: readonly string[]): Locale {
  for (const preference of preferences) {
    if (typeof preference !== 'string') continue;
    const base = preference.trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(base)) return base;
  }
  return 'en';
}

function browserLanguages(): string[] {
  if (typeof navigator === 'undefined') return [];
  return [...(navigator.languages || []), navigator.language].filter(value => typeof value === 'string' && value.length > 0);
}

function readPreference(): { preference: LanguagePreference; acknowledged: boolean } {
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage?.getItem(LANGUAGE_STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && (saved.preference === 'auto' || isLocale(saved.preference))) {
      return { preference: saved.preference, acknowledged: saved.acknowledged === true };
    }
  } catch { /* A denied or corrupt store must not prevent startup. */ }
  return { preference: 'auto', acknowledged: false };
}

let { preference, acknowledged } = readPreference();
let suggestedLocale = resolveLocale(browserLanguages());
let locale: Locale = preference === 'auto' ? suggestedLocale : preference;

function persistPreference() {
  try {
    if (typeof window !== 'undefined') window.localStorage?.setItem(LANGUAGE_STORAGE_KEY, JSON.stringify({ preference, acknowledged }));
  } catch { /* Keep the user's selection usable for this session. */ }
}

function publish() {
  if (typeof document !== 'undefined') {
    const language = SUPPORTED_LANGUAGES.find(value => value.code === locale)!;
    document.documentElement.lang = language.locale;
    document.documentElement.dir = language.dir;
    document.title = t("Blincho: Перерывы и комфорт при работе за экраном");
    document.querySelector?.('meta[name="description"]')?.setAttribute('content', t("Чередуйте работу с коротким отдыхом. Таймер учитывает активность и ваши паузы."));
  }
  if (typeof window !== 'undefined') {
    try { void window.electronAPI?.setLocale?.(locale)?.catch(() => {}); }
    catch { /* Native menu availability cannot block the renderer. */ }
  }
  revision += 1;
  for (const listener of listeners) listener();
}

function updateDetectedLanguages() {
  suggestedLocale = resolveLocale([...systemLanguages, ...browserLanguages()]);
  locale = preference === 'auto' ? suggestedLocale : preference;
  publish();
}

export function getLocale(): Locale { return locale; }
export function getLanguagePreference(): LanguagePreference { return preference; }
export function getSuggestedLocale(): Locale { return suggestedLocale; }
export function hasLanguageDecision(): boolean { return acknowledged; }
export function getLanguageSnapshot(): number { return revision; }
export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setLanguagePreference(value: LanguagePreference): void {
  if (value !== 'auto' && !isLocale(value)) throw new TypeError('Unsupported language preference');
  preference = value;
  acknowledged = true;
  locale = preference === 'auto' ? suggestedLocale : preference;
  persistPreference();
  publish();
}

export function acceptLanguageSuggestion(): void {
  setLanguagePreference(suggestedLocale);
}

function loadSystemLanguages(): Promise<void> {
  if (typeof window === 'undefined' || !window.electronAPI?.getPreferredLanguages) return Promise.resolve();
  // A failing/unresponsive native bridge must not prevent the app from opening.
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, 1500);
    Promise.resolve().then(() => window.electronAPI!.getPreferredLanguages!()).then(languages => {
      if (Array.isArray(languages)) systemLanguages = languages.filter(value => typeof value === 'string').slice(0, 50);
      updateDetectedLanguages();
    }).catch(() => {}).finally(() => { clearTimeout(timeout); resolve(); });
  });
}

export function initializeLanguage(): Promise<void> {
  if (initialization) return initialization;
  publish();
  if (typeof window !== 'undefined') {
    window.addEventListener('languagechange', () => { updateDetectedLanguages(); void loadSystemLanguages(); });
    window.addEventListener('storage', event => {
      if (event.key !== LANGUAGE_STORAGE_KEY && event.key !== null) return;
      ({ preference, acknowledged } = readPreference());
      updateDetectedLanguages();
    });
  }
  initialization = loadSystemLanguages();
  return initialization;
}

export function t(source: string, variables?: TranslationVariables): string {
  const own = (catalog: Record<string, string>) => Object.prototype.hasOwnProperty.call(catalog, source) ? catalog[source] : undefined;
  const translated = own(catalogs[locale]) || own(catalogs.en) || source;
  return translated.replace(/\{([\w]+)\}/g, (placeholder, name: string) =>
    variables && Object.prototype.hasOwnProperty.call(variables, name) ? (typeof variables[name] === 'number' ? formatNumber(variables[name]) : String(variables[name])) : placeholder);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  const language = SUPPORTED_LANGUAGES.find(item => item.code === locale)!;
  return new Intl.NumberFormat(language.locale, options).format(value);
}

export function formatDate(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  const language = SUPPORTED_LANGUAGES.find(item => item.code === locale)!;
  const date = typeof value === 'string' ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value) : new Date(value);
  // Older profiles accepted arbitrary date strings; display an unknown date safely.
  if (!Number.isFinite(date.getTime())) return '-';
  return new Intl.DateTimeFormat(language.locale, options).format(date);
}
