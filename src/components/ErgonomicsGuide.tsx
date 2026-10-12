import { useI18n } from '../i18n/useI18n';
import { t } from '../i18n/runtime';
import React, { useState } from 'react';
import {
  Monitor, Compass, Sun, Eye, Activity,
  CheckSquare, Square, ShieldCheck
} from 'lucide-react';

const CHECKLIST_STORAGE_KEY = 'myeyes_ergonomics_checklist_v1';

const DEFAULT_CHECKLIST: Record<string, boolean> = {
  distance: false,
  angle: false,
  glare: false,
  font: false,
  nightShift: false,
  humidity: false,
};

export const ErgonomicsGuide: React.FC = () => {
  useI18n();
  const [checklist, setChecklist] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(CHECKLIST_STORAGE_KEY);
      if (raw) return { ...DEFAULT_CHECKLIST, ...JSON.parse(raw) };
    } catch {}
    return DEFAULT_CHECKLIST;
  });

  const toggleCheck = (id: string) => {
    setChecklist((prev) => {
      const updated = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(updated));
      } catch {}
      return updated;
    });
  };

  return (
    <section className="ergonomics-view" aria-labelledby="ergonomics-title">
      {/* Header */}
      <header className="view-header">
        <div className="view-eyebrow-row">
          <Monitor size={20} style={{ color: 'var(--accent-primary)' }} />
          <span className="section-eyebrow">{t("Комфорт рабочего места")}</span>
        </div>
        <h2 id="ergonomics-title">{t("Настройте рабочее место под себя")}</h2>
        <p>{t("Расстояние, читаемый текст, меньше бликов и регулярная смена позы помогают сделать работу удобнее. Отмечайте пункты после проверки своего рабочего места.")}</p>
      </header>

      {/* 4 Cards Grid of Core Principles */}
      <div className="ergonomics-principles-grid">
        {/* Angle Principle */}
        <div className="glass-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--status-info-bg)', color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Compass size={22} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.08rem' }}>{t("Угол взгляда 15–20° вниз")}</h3>
              <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>{t("Ориентир для центра экрана")}</span>
            </div>
          </div>
          <p style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t("AOA рекомендует разместить центр экрана примерно на 15–20° ниже уровня глаз. Верхний край обычно оказывается на уровне глаз или ниже. Подберите высоту так, чтобы смотреть слегка вниз без наклона головы; при прогрессивных очках положение может отличаться.")}</p>
        </div>

        {/* Distance Principle */}
        <div className="glass-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--status-success-bg)', color: 'var(--status-success)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Eye size={22} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.08rem' }}>{t("Расстояние 50–70 см")}</h3>
              <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>{t("Длина вытянутой руки")}</span>
            </div>
          </div>
          <p style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t("Для обычного монитора начните с расстояния около 50–70 см и подберите его под размер экрана и свои очки. Увеличьте текст или масштаб, если приходится прищуриваться или наклоняться вперёд.")}</p>
        </div>

        {/* 20-8-2 Cornell Rule */}
        <div className="glass-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--surface-selected)', color: 'var(--accent-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Activity size={22} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.08rem' }}>{t("Меняйте позу и двигайтесь")}</h3>
              <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>{t("Ориентир Cornell 20-8-2")}</span>
            </div>
          </div>
          <p style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t("Cornell предлагает примерный ритм: 20 минут сидеть, 8 минут стоять при наличии подходящего стола и 2 минуты двигаться. Это ориентир для разнообразия поз, а не обязательная дозировка или лечение глаз. Выбирайте доступные вам движения и не стойте через боль.")}</p>
        </div>

        {/* Lighting & Blue Light */}
        <div className="glass-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--status-warning-bg)', color: 'var(--status-warning)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Sun size={22} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.08rem' }}>{t("Удобная яркость и меньше бликов")}</h3>
              <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>{t("Под условия освещения")}</span>
            </div>
          </div>
          <p style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t("Подберите яркость и контраст для лёгкого чтения без бликов. Избегайте резкого контраста между ярким экраном и тёмной комнатой. Повреждение глаз от синего света обычных экранов не подтверждено. Вечером тёплые цвета можно выбрать для комфорта; они не гарантируют улучшения сна.")}</p>
        </div>
      </div>

      {/* Interactive Workplace Checklist */}
      <div className="glass-card" style={{ borderColor: 'var(--border-active)' }}>
        <div className="ergonomics-checklist-header">
          <h3 style={{ fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldCheck size={20} style={{ color: 'var(--accent-primary)' }} /> {t("Мой чеклист рабочего места")}</h3>
          <span style={{ fontSize: '0.82rem', color: 'var(--accent-primary)', fontWeight: 600 }}>{t("Выполнено: {value0} из {value1}", { value0: Object.values(checklist).filter(Boolean).length, value1: Object.keys(checklist).length })}</span>
        </div>

        <div className="ergonomics-checklist-grid">
          {[
            {
              id: 'distance',
              title: t("Удобное расстояние до экрана (ориентир 50–70 см)"),
              desc: t("Текст читается без наклона вперёд; расстояние подходит вашим очкам и экрану"),
            },
            {
              id: 'angle',
              title: t("Верхняя рамка монитора на уровне глаз или чуть ниже"),
              desc: t("Глаза смотрят слегка вниз, веки расслаблены"),
            },
            {
              id: 'glare',
              title: t("Отсутствие бликов от окон и ламп на дисплее"),
              desc: t("Экран расположен перпендикулярно окну, а не напротив него"),
            },
            {
              id: 'font',
              title: t("Комфортный масштаб шрифтов в IDE и браузере"),
              desc: t("Текст читается без прищуривания и наклона головы вперед"),
            },
            {
              id: 'nightShift',
              title: t("Вечерняя яркость и время за экраном подходят мне"),
              desc: t("Тёплый режим по желанию; перед сном полезнее сократить время за экраном"),
            },
            {
              id: 'humidity',
              title: t("Нет сухого воздуха и прямого потока в лицо"),
              desc: t("При сухом воздухе можно использовать увлажнитель; регулярно очищайте его"),
            },
          ].map((item) => (
            <button type="button" className="ergonomics-checklist-item"
              key={item.id}
              onClick={() => toggleCheck(item.id)}
              aria-pressed={checklist[item.id]}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '12px 14px',
                borderRadius: 10,
                background: checklist[item.id] ? 'var(--status-success-bg)' : 'var(--surface-muted)',
                border: `1px solid ${checklist[item.id] ? 'var(--border-active)' : 'var(--border-subtle)'}`,
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              <div style={{ marginTop: 2, color: checklist[item.id] ? 'var(--status-success)' : 'var(--text-muted)' }}>
                {checklist[item.id] ? <CheckSquare size={18} /> : <Square size={18} />}
              </div>
              <div>
                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: checklist[item.id] ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                  {item.title}
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                  {item.desc}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
      <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{t("Источники:")} <a href="https://www.aoa.org/healthy-eyes/eye-and-vision-conditions/computer-vision-syndrome" target="_blank" rel="noreferrer">AOA</a>,{' '}
        <a href="https://www.nhs.uk/symptoms/dry-eyes/" target="_blank" rel="noreferrer">NHS</a>,{' '}
        <a href="https://ergo.human.cornell.edu/CUESitStandPrograms.html" target="_blank" rel="noreferrer">Cornell</a>,{' '}
        <a href="https://www.aao.org/eye-health/tips-prevention/blue-light-digital-eye-strain" target="_blank" rel="noreferrer">AAO</a>,{' '}
        <a href="https://pubmed.ncbi.nlm.nih.gov/33867308/" target="_blank" rel="noreferrer">{t("исследование Night Shift")}</a>.
      </p>
    </section>
  );
};
