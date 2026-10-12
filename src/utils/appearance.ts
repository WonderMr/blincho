import { AppearanceMode, ColorPalette } from '../types';

const listeners = new Set<() => void>();
export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function normalizeAppearance(value: { theme?: unknown; colorPalette?: unknown }): { theme: AppearanceMode; colorPalette: ColorPalette } {
  // Preserve an existing explicit dark preference while migrating old palette names.
  if (['midnight', 'oled', 'forest'].includes(String(value.theme))) {
    return { theme: 'dark', colorPalette: value.theme === 'forest' ? 'sage' : 'ocean' };
  }
  return {
    theme: ['system', 'light', 'dark'].includes(String(value.theme)) ? value.theme as AppearanceMode : 'system',
    colorPalette: ['sage', 'ocean', 'lavender'].includes(String(value.colorPalette)) ? value.colorPalette as ColorPalette : 'sage',
  };
}

export function resolveAppearance(mode: AppearanceMode, systemDark: boolean): 'light' | 'dark' {
  return mode === 'system' ? systemDark ? 'dark' : 'light' : mode;
}

export function applyAppearance(mode: AppearanceMode, palette: ColorPalette, systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false): void {
  const resolved = resolveAppearance(mode, systemDark);
  const root = document.documentElement;
  root.setAttribute('data-appearance', resolved);
  root.setAttribute('data-palette', palette);
  root.style.colorScheme = resolved;
  // Existing installations may still have the previous CSS classes during hot updates.
  root.classList?.remove('theme-midnight', 'theme-oled', 'theme-forest');
  listeners.forEach(listener => listener());
}

export function watchAppearance(mode: AppearanceMode, palette: ColorPalette): () => void {
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  const update = () => applyAppearance(mode, palette, media?.matches ?? false);
  update();
  if (mode !== 'system' || !media) return () => {};
  media.addEventListener?.('change', update);
  return () => media.removeEventListener?.('change', update);
}
