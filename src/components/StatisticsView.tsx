import { useI18n } from '../i18n/useI18n';
import { t, formatNumber, formatDate } from '../i18n/runtime';
import React from 'react';
import { DayStats, CVSSurveyResult } from '../types';
import { Trophy, Flame, CheckCircle2, Clock, Calendar, Zap, LockKeyhole } from 'lucide-react';

interface StatisticsViewProps {
  todayStats: DayStats;
  allStats: DayStats[];
  cvsResult: CVSSurveyResult | null;
}

const localDayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;

export const StatisticsView: React.FC<StatisticsViewProps> = ({ todayStats, allStats, cvsResult }) => {
  useI18n();
  const history = new Map(allStats.map(day => [day.date, day]));
  history.set(todayStats.date, todayStats);
  const days = [...history.values()];
  const activeDays = new Set(days.filter(day => day.breaksCompleted > 0 || day.exercisesCompleted > 0).map(day => day.date));
  const referenceDate = new Date(`${todayStats.date}T12:00:00`);
  const checkDate = new Date(referenceDate);
  if (!activeDays.has(localDayKey(checkDate))) checkDate.setDate(checkDate.getDate() - 1);
  let streak = 0;
  while (activeDays.has(localDayKey(checkDate))) { streak++; checkDate.setDate(checkDate.getDate() - 1); }
  const last7Days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(referenceDate);
    date.setDate(date.getDate() - (6-index));
    const dateStr = localDayKey(date);
    return { dateStr, dateLabel: formatDate(date,{ day:'numeric', month:'long' }),
      dayName: formatDate(date,{ weekday:'short' }), count: history.get(dateStr)?.breaksCompleted ?? 0, isToday:index === 6 };
  });
  const maximum = Math.max(1, ...last7Days.map(day => day.count));
  const totalBreaks = days.reduce((sum,day) => sum + day.breaksCompleted, 0);
  const techniqueCount = (id: string) => days.reduce((sum,day) => sum + (day.techniqueCounts?.[id] ?? 0), 0);
  const achievements = [
    { title: t("Осознанное моргание"), description:t("Завершить упражнение на моргание"), earned:techniqueCount('donald-korb-blinking') > 0, Icon:Zap },
    { title:t("Пять перерывов"), description:t("Завершить 5 перерывов · {value0}/5", { value0: Math.min(5,totalBreaks) }), earned:totalBreaks >= 5, Icon:CheckCircle2 },
    { title:t("Отдых с закрытыми глазами"), description:t("Завершить упражнение на расслабление"), earned:techniqueCount('palming-relaxation') > 0, Icon:Flame },
  ];
  const metrics = [
    { label:t("Перерывы сегодня"), value:formatNumber(todayStats.breaksCompleted), note:t("Завершённые перерывы"), Icon:CheckCircle2 },
    { label:t("Упражнения сегодня"), value:formatNumber(todayStats.exercisesCompleted), note:t("Завершённые упражнения"), Icon:Zap },
    { label:t("Рабочее время"), value:t("{value0} мин", { value0: Number(todayStats.focusMinutes.toFixed(1)) }), note:t("По записи таймера"), Icon:Clock },
    { label:t("Серия дней"), value:t("{value0} дн.", { value0: streak }), note:t("С перерывами или упражнениями"), Icon:Flame },
  ];

  return (
    <section className="statistics-view" aria-labelledby="statistics-title">
      <header className="view-header"><span className="section-eyebrow">{t("Прогресс и привычки")}</span><h2 id="statistics-title">{t("Ваш ритм работы и отдыха")}</h2>
        <p>{t("Следите за регулярностью перерывов. Эти показатели описывают использование приложения и не оценивают здоровье глаз.")}</p>
      </header>
      <div className="statistics-metrics">{metrics.map(({ label,value,note,Icon }) => <div className="glass-card statistics-metric" key={label}>
        <div className="statistics-metric-heading"><span>{label}</span><Icon size={18} aria-hidden="true" /></div><div className="metric-val">{value}</div><p>{note}</p>
      </div>)}</div>
      <div className="glass-card">
        <h3 className="card-title"><Calendar size={19} aria-hidden="true" />{t("Перерывы за последние 7 дней")}</h3>
        <figure className="weekly-chart" aria-labelledby="weekly-chart-caption">
          <div className="weekly-chart-bars" aria-hidden="true">{last7Days.map(day => <div key={day.dateStr} className={`weekly-chart-column ${day.isToday ? 'is-today' : ''}`}>
            <span className="weekly-chart-count">{formatNumber(day.count)}</span><div className="weekly-chart-track"><div className="weekly-chart-bar" style={{ height:`${day.count / maximum * 100}%` }} /></div>
            <span className="weekly-chart-day">{day.dayName}{day.isToday && <span className="weekly-chart-today">{t("сегодня")}</span>}</span>
          </div>)}</div>
          <figcaption id="weekly-chart-caption" className="sr-only">{t("Количество завершённых перерывов по дням.")}</figcaption>
          <table className="sr-only"><caption>{t("Перерывы за неделю")}</caption><thead><tr><th scope="col">{t("День")}</th><th scope="col">{t("Перерывы")}</th></tr></thead>
            <tbody>{last7Days.map(day => <tr key={day.dateStr}><th scope="row">{day.dateLabel}{day.isToday ? t(" (сегодня)") : ''}</th><td>{formatNumber(day.count)}</td></tr>)}</tbody>
          </table>
        </figure>
        {last7Days.every(day => day.count === 0) && <p className="statistics-empty-note">{t("Здесь появятся завершённые перерывы. Начните с одного удобного рабочего интервала.")}</p>}
      </div>
      <div className="glass-card"><h3 className="card-title"><Trophy size={19} aria-hidden="true" />{t("Небольшие достижения")}</h3>
        <p className="statistics-section-note">{t("Выдаются по сохранённой истории. Старые записи без вида упражнения не подтверждают его выполнение.")}</p>
        <div className="achievement-grid">{achievements.map(({ title,description,earned,Icon }) => <div key={title} className={`achievement-card ${earned ? 'earned' : 'pending'}`}>
          <span className="achievement-icon" aria-hidden="true">{earned ? <Icon size={23} /> : <LockKeyhole size={21} />}</span>
          <div><span className="achievement-state">{earned ? t("Получено") : t("Ещё впереди")}</span><h4>{title}</h4><p>{description}</p></div>
        </div>)}</div>
      </div>
      {cvsResult && <div className="glass-card statistics-self-check"><div><span className="section-eyebrow">{t("Последняя самопроверка")}</span><h3>{t("Сумма ответов: {value0} / {value1}", { value0: cvsResult.score, value1: cvsResult.maxScore })}</h3>
        <p>{t("Запись от {value0}. Эта сумма не является диагнозом или оценкой риска.", { value0: formatDate(cvsResult.date) })}</p></div>
      </div>}
      <p className="statistics-storage-note">{t("История хранится локально в этом браузере или приложении.")}</p>
    </section>
  );
};
