import type { AppSettings } from '../types';

export const SYMBIOTE_PERKS = [
  { id: 'presence', bit: 1, label: 'Присутствие' },
  { id: 'lock', bit: 2, label: 'Автоблокировка' },
  { id: 'calls', bit: 4, label: 'История звонков' },
  { id: 'input', bit: 8, label: 'Статистика ввода' },
  { id: 'strict', bit: 16, label: 'Строгий режим' },
  { id: 'mcp', bit: 32, label: 'Связь с помощником' },
] as const;

export type SymbiotePerk = typeof SYMBIOTE_PERKS[number];
export interface SymbioteBuild {
  mask: number;
  perks: readonly SymbiotePerk[];
}
export interface SymbioteCapabilities {
  presence: boolean;
  lock: boolean;
  calls: boolean;
  input: boolean;
  mcp: boolean;
}

// The first five bits describe the base persona. The connection bit adds a
// localized modifier, with three deliberately named character combinations.
export const SYMBIOTE_NAME_KEYS = [
  'Блинчо', 'Наблюдатель', 'Хранитель', 'Страж',
  'Хронист', 'Внимательный хронист', 'Хранитель хроники', 'Страж хроники',
  'Трекер', 'Внимательный трекер', 'Хранитель ритма', 'Страж ритма',
  'Аналитик', 'Внимательный аналитик', 'Хранитель данных', 'Киберстраж',
  'Мастер пауз', 'Смотритель пауз', 'Хранитель пауз', 'Страж пауз',
  'Хронист фокуса', 'Внимательный хронист фокуса', 'Хранитель распорядка', 'Страж распорядка',
  'Наставник ритма', 'Внимательный наставник', 'Хранитель рабочего ритма', 'Страж рабочего ритма',
  'Аналитик фокуса', 'Внимательный аналитик фокуса', 'Куратор фокуса', 'Симбиот',
] as const;

export function getSymbioteName(mask: number,
  translate: (key: string, variables?: Record<string, string | number>) => string): string {
  const known = mask & 63;
  if (known === 32) return translate('Спутник');
  if (known === 48) return translate('Напарник');
  if (known === 63) return translate('Блинчиборг');
  const name = translate(SYMBIOTE_NAME_KEYS[known & 31]);
  return known & 32 ? translate('{name} на связи', { name }) : name;
}

export function getSymbioteBuild(settings: AppSettings, capabilities: SymbioteCapabilities,
  cameraPending = false): SymbioteBuild {
  const presence = !cameraPending && capabilities.presence && settings.enhancedPresenceEnabled;
  const enabled = [
    presence,
    !cameraPending && capabilities.lock && (settings.cameraLockEnabled || (presence && settings.absenceLockEnabled)),
    capabilities.calls && settings.meetingHistoryEnabled,
    capabilities.input && settings.inputActivityEnabled,
    settings.strictMode,
    capabilities.mcp && settings.localMcpEnabled,
  ];
  const perks = SYMBIOTE_PERKS.filter((_, index) => enabled[index]);
  return { mask: perks.reduce((mask, perk) => mask | perk.bit, 0), perks };
}

// Read capabilities only. Rendering a character must never open a device,
// request consent, start recording or configure the local MCP server.
export function readSymbioteCapabilities(inputActive = false): SymbioteCapabilities {
  const api = typeof window === 'undefined' ? undefined : window.electronAPI;
  const nativeTimer = typeof window !== 'undefined' && !!window.__TAURI__;
  const camera = typeof api?.lockComputer === 'function' &&
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
  const meetings = api?.meetingDetectionSupported === true;
  return {
    presence: nativeTimer && meetings && camera,
    lock: camera,
    calls: nativeTimer && meetings,
    input: nativeTimer && inputActive,
    mcp: typeof api?.configureLocalMcp === 'function',
  };
}
