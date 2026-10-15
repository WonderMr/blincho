import { useI18n } from '../i18n/useI18n';
import { t } from '../i18n/runtime';
import React from 'react';
import { Clock, BookOpen, HeartPulse, Monitor, TrendingUp, Settings, Volume2, VolumeX, Coffee } from 'lucide-react';

export type ActiveTab = 'timer' | 'library' | 'survey' | 'ergonomics' | 'stats';

interface NavbarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onOpenSettings: () => void;
  onTriggerInstantBreak: () => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
  statusLabel?: string;
  statusTone?: 'working' | 'paused' | 'absence' | 'break';
  instantBreakDisabled?: boolean;
}

const sections = [
  { id: 'timer' as const, label: 'Таймер', Icon: Clock },
  { id: 'library' as const, label: 'Упражнения', Icon: BookOpen },
  { id: 'survey' as const, label: 'Самочувствие', Icon: HeartPulse },
  { id: 'ergonomics' as const, label: 'Эргономика', Icon: Monitor },
  { id: 'stats' as const, label: 'Статистика', Icon: TrendingUp },
];

export const Navbar: React.FC<NavbarProps> = ({
  activeTab, onSelectTab, onOpenSettings, onTriggerInstantBreak, soundEnabled,
  onToggleSound, statusLabel = t("Напоминания о перерывах"), statusTone = 'paused',
  instantBreakDisabled = false,
}) => {
  useI18n();
  return (
  <nav className="nav-bar" aria-label={t("Главная навигация")}>
    <div className="nav-logo-group">
      <div className="nav-logo-badge" aria-hidden="true">
        <img src="./icon.png" width="44" height="44" alt="" draggable={false} />
      </div>
      <div className="nav-brand-copy">
        <div className="nav-brand-title">Blincho</div>
        <span className={`nav-status-badge status-${statusTone}`} title={statusLabel}>
          <span className="nav-status-dot" aria-hidden="true" /><span className="nav-status-copy">{statusLabel}</span>
        </span>
      </div>
    </div>
    <div className="nav-tabs" role="group" aria-label={t("Разделы приложения")}>
      {sections.map(({ id, label, Icon }) => (
        <button type="button" key={id} aria-current={activeTab === id ? 'page' : undefined}
          className={`nav-tab-btn ${activeTab === id ? 'active' : ''}`} onClick={() => onSelectTab(id)}>
          <Icon size={17} aria-hidden="true" /><span className="nav-tab-label">{t(label)}</span>
        </button>
      ))}
    </div>
    <div className="nav-utilities">
      <div className="nav-actions">
        <button type="button" className="nav-settings-button" onClick={onOpenSettings} aria-label={t("Открыть настройки приложения")}>
          <Settings size={18} aria-hidden="true" /><span>{t("Настройки")}</span>
        </button>
        <button type="button" className="btn-icon" onClick={onToggleSound} aria-pressed={soundEnabled}
          title={soundEnabled ? t("Отключить звук") : t("Включить звук")} aria-label={soundEnabled ? t("Отключить звук") : t("Включить звук")}>
          {soundEnabled ? <Volume2 size={18} aria-hidden="true" /> : <VolumeX size={18} aria-hidden="true" />}
        </button>
      </div>
      {activeTab !== 'timer' && (
        <button type="button" className="btn btn-secondary nav-break-button" onClick={onTriggerInstantBreak}
          disabled={instantBreakDisabled} title={t("Начать перерыв сейчас")}>
          <Coffee size={17} aria-hidden="true" /><span>{t("Перерыв сейчас")}</span>
        </button>
      )}
    </div>
  </nav>
  );
};
