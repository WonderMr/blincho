import { useI18n } from '../i18n/useI18n';
import { t, getLocale } from '../i18n/runtime';
import React, { useState } from 'react';
import { MEDICAL_TECHNIQUES } from '../data/medicalTechniques';
import { ExerciseTechnique } from '../types';
import { Play, Search, Clock, BookOpen, ArrowRight, X } from 'lucide-react';

interface ExerciseLibraryProps {
  onSelectTechnique: (technique: ExerciseTechnique) => void;
  onStartFullRoutine: () => void;
}

const categories = [
  { id: 'all', label: 'Все' }, { id: 'ciliary', label: 'Перефокусировка' },
  { id: 'dry-eye', label: 'Моргание' }, { id: 'extraocular', label: 'Движения глаз' },
  { id: 'relaxation', label: 'Расслабление' },
];
const routineIds = ['donald-korb-blinking', 'figure-8-pursuit', 'near-far-tromboning', 'palming-relaxation'];
const formatDuration = (seconds: number) => seconds >= 60
  ? t("{value0} мин{value1}", { value0: Math.floor(seconds / 60), value1: seconds % 60 ? ` ${t('{value0} сек', { value0: seconds % 60 })}` : '' }) : t("{value0} сек", { value0: seconds });

export const ExerciseLibrary: React.FC<ExerciseLibraryProps> = ({ onSelectTechnique, onStartFullRoutine }) => {
  useI18n();
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const query = searchQuery.trim().toLocaleLowerCase(getLocale());
  const filteredTechniques = MEDICAL_TECHNIQUES.filter(technique =>
    (selectedCategory === 'all' || technique.category === selectedCategory) &&
    `${t(technique.title)} ${t(technique.shortDesc)} ${t(technique.clinicalMechanism)}`.toLocaleLowerCase(getLocale()).includes(query));
  const routineSeconds = MEDICAL_TECHNIQUES.filter(technique => routineIds.includes(technique.id))
    .reduce((total, technique) => total + technique.steps.reduce((sum, step) => sum + step.durationSeconds, 0), 0);

  return (
    <section className="library-view" aria-labelledby="library-title">
      <header className="view-header"><span className="section-eyebrow">{t("Отведите взгляд от экрана")}</span>
        <h2 id="library-title">{t("Упражнения для перерыва")}</h2>
        <p>{t("Выберите короткое упражнение или пройдите последовательность из четырёх. Делайте только то, что комфортно.")}</p>
      </header>
      <div className="glass-card library-routine-banner">
        <div><span className="technique-badge badge-ciliary"><BookOpen size={13} aria-hidden="true" />{t("4 упражнения ·")} {formatDuration(routineSeconds)}</span>
          <h3>{t("Перерыв с упражнениями")}</h3><p>{t("Осознанное моргание, плавное слежение, смена фокуса и отдых с закрытыми глазами.")}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={onStartFullRoutine}><Play size={18} aria-hidden="true" />{t("Начать комплекс")}<ArrowRight size={17} aria-hidden="true" /></button>
      </div>
      <p className="library-safety-note">{t("Эти упражнения не заменяют диагностику и лечение. При боли, двоении или усилении дискомфорта прекратите упражнение.")}</p>
      <div className="library-toolbar">
        <div className="library-filter-pills" role="group" aria-label={t("Категория упражнений")}>
          {categories.map(category => <button type="button" key={category.id} aria-pressed={selectedCategory === category.id}
            className={`nav-tab-btn ${selectedCategory === category.id ? 'active' : ''}`} onClick={() => setSelectedCategory(category.id)}>{t(category.label)}</button>)}
        </div>
        <div className="library-search"><Search size={18} aria-hidden="true" />
          <label className="sr-only" htmlFor="technique-search">{t("Поиск упражнений")}</label>
          <input id="technique-search" type="search" className="form-control" placeholder={t("Поиск упражнений")} value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          {searchQuery && <button type="button" className="search-clear" onClick={() => setSearchQuery('')} aria-label={t("Очистить поиск")}><X size={16} /></button>}
        </div>
      </div>
      <p className="library-results-count" role="status">{t("Найдено упражнений: {value0}", { value0: filteredTechniques.length })}</p>
      <div className="exercise-grid">
        {filteredTechniques.map(technique => (
          <article key={technique.id} className="technique-card" aria-labelledby={`technique-${technique.id}`}>
            <div>
              <div className="technique-card-meta"><span className={`technique-badge ${technique.badgeClass}`}>{t(categories.find(category => category.id === technique.category)?.label ?? technique.categoryLabel)}</span>
                <span className="technique-duration"><Clock size={14} aria-hidden="true" />{formatDuration(technique.steps.reduce((sum, step) => sum + step.durationSeconds, 0))}</span>
              </div>
              <h3 id={`technique-${technique.id}`}>{t(technique.title)}</h3>
              <p className="technique-desc">{t(technique.shortDesc)}</p>
              <ul className="technique-details">{technique.indications.slice(0,2).map((indication, index) => <li key={index}>{t(indication)}</li>)}</ul>
            </div>
            <div className="technique-card-footer"><details className="technique-source-details"><summary><BookOpen size={14} aria-hidden="true" />{t("Источники и ограничения")}</summary><p className="medical-source-tag">{t(technique.scientificReference)}</p></details>
              <button type="button" className="btn btn-secondary" onClick={() => onSelectTechnique(technique)} aria-label={t("Начать: {value0}", { value0: t(technique.title) })}><Play size={16} aria-hidden="true" />{t("Начать упражнение")}</button>
            </div>
          </article>
        ))}
      </div>
      {filteredTechniques.length === 0 && <div className="glass-card library-empty-state"><Search size={26} aria-hidden="true" /><h3>{t("Ничего не найдено")}</h3>
        <p>{t("Попробуйте другое слово или откройте все категории.")}</p><button type="button" className="btn btn-secondary" onClick={() => { setSearchQuery(''); setSelectedCategory('all'); }}>{t("Сбросить фильтры")}</button>
      </div>}
    </section>
  );
};
