import { useI18n } from '../i18n/useI18n';
import { t, formatNumber, formatDate } from '../i18n/runtime';
import React, { useState } from 'react';
import { DayStats, CVSSurveyResult, ActivityState } from '../types';
import { analyzeDayActivity, summarizeWeek } from '../utils/activity';
import { analyzeDayMeetings, summarizeWeekMeetings } from '../utils/meetings';
import { MeetingHistoryControls } from './MeetingHistoryControls';
import { HistoryDatePicker } from './HistoryDatePicker';
import { InputActivityView } from './InputActivityView';
import type { MeetingHistoryControlsProps } from './MeetingHistoryControls';
import { Trophy, Flame, CheckCircle2, Clock, Calendar, Zap, LockKeyhole, Activity, Monitor, Coffee, Pause, ChevronDown, Phone } from 'lucide-react';

interface StatisticsViewProps {
  todayStats: DayStats;
  allStats: DayStats[];
  cvsResult: CVSSurveyResult | null;
  meetingApplications?: string[];
  meetingHistoryControls?: Omit<MeetingHistoryControlsProps, 'id'>;
}

const localDayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const emptyDay = (date: string): DayStats => ({ date, breaksCompleted: 0, exercisesCompleted: 0, focusMinutes: 0 });
const formatTime = (time: number) => formatDate(time, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const formatDuration = (minutes: number) => {
  const seconds = Math.max(0, Math.round(minutes * 60));
  if (seconds < 60) return t("{value0} с", { value0: seconds });
  const hours = Math.floor(seconds / 3600);
  const remainder = Math.floor(seconds % 3600 / 60);
  return hours > 0 ? t("{value0} ч {value1} мин", { value0: hours, value1: remainder }) : t("{value0} мин", { value0: remainder });
};

type TimelineState = ActivityState | 'unknown' | 'future';
const stateLabel = (state: TimelineState) => {
  switch (state) {
    case 'work': return t("Работа за компьютером");
    case 'idle': return t("Нет активности");
    case 'locked': return t("Экран заблокирован");
    case 'suspended': return t("Компьютер спит");
    case 'hidden': return t("Вкладка скрыта");
    case 'unconfirmed': return t("Активность не подтверждена");
    case 'manual': return t("Ручная пауза");
    case 'break': return t("Перерыв");
    case 'exercise': return t("Упражнение");
    case 'unknown': return t("Нет записи");
    case 'future': return t("Ещё не наступило");
  }
};
const stateCategory = (state: TimelineState) => {
  if (['idle', 'locked', 'suspended'].includes(state)) return 'away';
  if (state === 'hidden') return 'unconfirmed';
  if (state === 'break' || state === 'exercise') return 'rest';
  return state;
};

export const StatisticsView: React.FC<StatisticsViewProps> = ({ todayStats, allStats, cvsResult, meetingApplications = [], meetingHistoryControls }) => {
  useI18n();
  const [selectedDate, setSelectedDate] = useState(todayStats.date);
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
    date.setDate(date.getDate() - (6 - index));
    const dateStr = localDayKey(date);
    return {
      dateStr, dateLabel: formatDate(date, { day: 'numeric', month: 'long' }),
      dayName: formatDate(date, { weekday: 'short' }), dayNumber: formatDate(date, { day: 'numeric' }),
      count: history.get(dateStr)?.breaksCompleted ?? 0, isToday: index === 6,
    };
  });
  const availableDates = [...new Set([...last7Days.map(day => day.dateStr), ...history.keys()])].sort().reverse();
  const displayedDate = availableDates.includes(selectedDate) ? selectedDate : todayStats.date;
  const selectedDay = history.get(displayedDate) ?? emptyDay(displayedDate);
  const activity = analyzeDayActivity(selectedDay);
  const meetings = analyzeDayMeetings(selectedDay);
  const meetingWeek = summarizeWeekMeetings(days, todayStats.date);
  const appLabel = (app: string) => app === 'unknown' ? t("Неизвестное приложение") : app;
  const lastMeetingEndByApp = new Map<string, number>();
  for (const span of meetings.spans) lastMeetingEndByApp.set(span.app, span.end);
  const hasConfirmedActivity = activity.recordedMinutes > 0;
  const week = summarizeWeek(days, todayStats.date);
  const dayLength = activity.end - activity.start;
  const timeTicks = [0, 6, 12, 18, 24].map(hour => {
    const date = new Date(activity.start);
    date.setHours(hour, 0, 0, 0);
    return { hour, position: (date.getTime() - activity.start) / dayLength * 100 };
  });
  const recordedSegments = activity.segments.filter(segment => segment.state !== 'future');
  const hasTimeline = recordedSegments.some(segment => segment.state !== 'unknown');
  const timelineMinutes = recordedSegments.filter(segment => segment.state !== 'unknown').reduce((sum, segment) => sum + (segment.end - segment.start) / 60000, 0);
  const unknownMinutes = recordedSegments.filter(segment => segment.state === 'unknown').reduce((sum, segment) => sum + (segment.end - segment.start) / 60000, 0);
  const selectedDayLabel = formatDate(displayedDate, { weekday: 'long', day: 'numeric', month: 'long' });
  const segmentTime = (time: number) => time === activity.end ? '24:00' : formatTime(time);
  const maximum = Math.max(1, ...last7Days.map(day => day.count));
  const totalBreaks = days.reduce((sum, day) => sum + day.breaksCompleted, 0);
  const techniqueCount = (id: string) => days.reduce((sum, day) => sum + (day.techniqueCounts?.[id] ?? 0), 0);
  const achievements = [
    { title: t("Осознанное моргание"), description: t("Завершить упражнение на моргание"), earned: techniqueCount('donald-korb-blinking') > 0, Icon: Zap },
    { title: t("Пять перерывов"), description: t("Завершить 5 перерывов · {value0}/5", { value0: Math.min(5, totalBreaks) }), earned: totalBreaks >= 5, Icon: CheckCircle2 },
    { title: t("Отдых с закрытыми глазами"), description: t("Завершить упражнение на расслабление"), earned: techniqueCount('palming-relaxation') > 0, Icon: Flame },
  ];
  const metrics = [
    { label: t("Перерывы сегодня"), value: formatNumber(todayStats.breaksCompleted), note: t("Завершённые перерывы"), Icon: CheckCircle2 },
    { label: t("Упражнения сегодня"), value: formatNumber(todayStats.exercisesCompleted), note: t("Завершённые упражнения"), Icon: Zap },
    { label: t("Рабочее время"), value: formatDuration(todayStats.focusMinutes), note: t("По записи таймера"), Icon: Clock },
    { label: t("Серия дней"), value: t("{value0} дн.", { value0: streak }), note: t("С перерывами или упражнениями"), Icon: Flame },
  ];
  const dailyMetrics = [
    { label: t("Работа за компьютером"), minutes: activity.workMinutes, category: 'work', Icon: Monitor },
    { label: t("Отсутствие"), minutes: activity.awayMinutes, category: 'away', Icon: Clock },
    { label: t("Ручная пауза"), minutes: activity.pauseMinutes, category: 'manual', Icon: Pause },
    { label: t("Перерывы и упражнения"), minutes: activity.restMinutes, category: 'rest', Icon: Coffee },
  ];
  const legend = [
    { category: 'work', label: t("Работа") }, { category: 'away', label: t("Отсутствие") },
    { category: 'manual', label: t("Ручная пауза") }, { category: 'rest', label: t("Отдых") },
    { category: 'unconfirmed', label: t("Не подтверждено") }, { category: 'unknown', label: t("Нет записи") },
  ];

  return (
    <section className="statistics-view" aria-labelledby="statistics-title">
      <header className="view-header">
        <span className="section-eyebrow">{t("Прогресс и привычки")}</span>
        <h2 id="statistics-title">{t("Ваш ритм работы и отдыха")}</h2>
        <p>{t("Следите за регулярностью перерывов. Эти показатели описывают использование приложения и не оценивают здоровье глаз.")}</p>
      </header>
      <div className="statistics-metrics">
        {metrics.map(({ label, value, note, Icon }) => <div className="glass-card statistics-metric" key={label}>
          <div className="statistics-metric-heading"><span>{label}</span><Icon size={18} aria-hidden="true" /></div>
          <div className="metric-val">{value}</div><p>{note}</p>
        </div>)}
      </div>

      <section className="glass-card statistics-activity-card" aria-labelledby="daily-activity-title">
        <div className="statistics-detail-header">
          <div><h3 id="daily-activity-title" className="card-title"><Activity size={19} aria-hidden="true" />{t("Активность по времени")}</h3>
            <p className="statistics-detail-note">{t("Когда вы работали, отходили от компьютера и отдыхали.")}</p>
          </div>
          <HistoryDatePicker value={displayedDate} dates={availableDates} label={t("Выбрать день")}
            formatLabel={date => `${formatDate(date, { day: 'numeric', month: 'long', year: 'numeric' })}${date === todayStats.date ? t(" (сегодня)") : ''}`}
            onChange={setSelectedDate} />
        </div>
        <div className="statistics-day-selector" role="group" aria-label={t("Последние 7 дней")}>
          {last7Days.map(day => <button key={day.dateStr} type="button" className={`statistics-day-button ${day.dateStr === displayedDate ? 'is-selected' : ''}`}
            aria-pressed={day.dateStr === displayedDate} aria-label={`${day.dateLabel}${day.isToday ? t(" (сегодня)") : ''}`} aria-controls="daily-activity-detail"
            onClick={() => setSelectedDate(day.dateStr)}>
            <span>{day.dayName}</span><strong>{day.dayNumber}</strong><span className="statistics-day-dot" data-recorded={(history.get(day.dateStr)?.activity?.length ?? 0) > 0 || (history.get(day.dateStr)?.meetings?.length ?? 0) > 0} aria-hidden="true" />
          </button>)}
        </div>
        <div id="daily-activity-detail" className="statistics-daily-detail">
          <div className="statistics-selected-day"><h4>{selectedDayLabel}</h4>
            <span>{hasTimeline ? t("Записано: {value0}", { value0: formatDuration(timelineMinutes) }) : t("Нет подробной записи")}</span>
          </div>
          <dl className="statistics-daily-metrics">
            {dailyMetrics.map(({ label, minutes, category, Icon }) => <div key={category} className={`statistics-daily-metric activity-${category}`}>
              <dt><Icon size={15} aria-hidden="true" />{label}</dt><dd>{hasConfirmedActivity ? formatDuration(minutes) : t("Нет данных")}</dd>
            </div>)}
          </dl>
          <figure className="statistics-timeline" aria-labelledby="daily-timeline-caption">
            <div className="statistics-timeline-track" aria-hidden="true" dir="ltr">
              {activity.segments.map((segment, index) => <span key={`${segment.start}-${index}`} className={`statistics-timeline-segment activity-${stateCategory(segment.state)}`}
                data-activity-state={segment.state}
                style={{ left: `${(segment.start - activity.start) / dayLength * 100}%`, width: `${(segment.end - segment.start) / dayLength * 100}%` }}
                title={t("{value0}, с {value1} до {value2}: {value3}", { value0: stateLabel(segment.state), value1: segmentTime(segment.start), value2: segmentTime(segment.end), value3: formatDuration((segment.end - segment.start) / 60000) })} />)}
            </div>
            <div className="statistics-timeline-axis" aria-hidden="true" dir="ltr">{timeTicks.map(tick => <span key={tick.hour} style={{ left: `${tick.position}%` }}>{`${String(tick.hour).padStart(2, '0')}:00`}</span>)}</div>
            <figcaption id="daily-timeline-caption" className="statistics-timeline-legend">
              {legend.map(item => <span key={item.category}><i className={`activity-${item.category}`} aria-hidden="true" />{item.label}</span>)}
            </figcaption>
          </figure>
          {!hasTimeline && <p className="statistics-history-note">{selectedDay.focusMinutes > 0 || selectedDay.breaksCompleted > 0 || selectedDay.exercisesCompleted > 0
            ? t("За этот день сохранены только итоги. Время активности и отсутствия неизвестно.")
            : t("За этот день пока нет записи активности. Запись появится при использовании приложения.")}</p>}
          {hasTimeline && <p className="statistics-history-note">{t("Нет записи: {value0}. Эти интервалы не считаются отсутствием.", { value0: formatDuration(unknownMinutes) })}</p>}
          {hasTimeline && activity.sessionCount > 0 && <dl className="statistics-session-summary">
            <div><dt>{t("Рабочие интервалы")}</dt><dd>{formatNumber(activity.sessionCount)}</dd></div>
            <div><dt>{t("Средний рабочий интервал")}</dt><dd>{formatDuration(activity.averageSessionMinutes)}</dd></div>
            <div><dt>{t("Самый длинный интервал")}</dt><dd>{formatDuration(activity.longestSessionMinutes)}</dd></div>
            <div><dt>{t("Начало и конец работы")}</dt><dd>{activity.firstActiveAt === null || activity.lastActiveAt === null ? t("Нет данных") : t("С {value0} до {value1}", { value0: formatTime(activity.firstActiveAt), value1: segmentTime(activity.lastActiveAt) })}</dd></div>
          </dl>}
          {hasTimeline && <details className="statistics-interval-details">
            <summary>{t("Все интервалы")}<ChevronDown size={16} aria-hidden="true" /></summary>
            <div className="statistics-interval-scroll"><table className="statistics-interval-table">
              <caption className="sr-only">{t("Запись активности за {value0}", { value0: selectedDayLabel })}</caption>
              <thead><tr><th scope="col">{t("Время")}</th><th scope="col">{t("Состояние")}</th><th scope="col">{t("Длительность")}</th></tr></thead>
              <tbody>{recordedSegments.map((segment, index) => <tr key={`${segment.start}-${index}`}>
                <td><bdi>{t("С {value0} до {value1}", { value0: segmentTime(segment.start), value1: segmentTime(segment.end) })}</bdi></td>
                <td><span className="statistics-interval-state"><i className={`activity-${stateCategory(segment.state)}`} aria-hidden="true" />{stateLabel(segment.state)}</span></td>
                <td>{formatDuration((segment.end - segment.start) / 60000)}</td>
              </tr>)}</tbody>
            </table></div>
          </details>}
          <InputActivityView day={selectedDay} />
          <section className="statistics-meetings" aria-labelledby="daily-meetings-title">
            {meetingHistoryControls && <MeetingHistoryControls id="statistics-meeting-history" {...meetingHistoryControls} />}
            <div className="statistics-meetings-heading">
              <h4 id="daily-meetings-title"><Phone size={17} aria-hidden="true" />{t("Созвоны")}</h4>
              <span>{t("Созвонов: {value0}", { value0: meetings.callCount })}</span>
            </div>
            <dl className="statistics-session-summary statistics-meeting-metrics">
              <div><dt>{t("Время в созвонах")}</dt><dd>{formatDuration(meetings.totalMinutes)}</dd></div>
              <div><dt>{t("Средняя длительность созвона")}</dt><dd>{meetings.callCount ? formatDuration(meetings.averageCallMinutes) : t("Нет данных")}</dd></div>
              <div><dt>{t("Самый длинный созвон")}</dt><dd>{meetings.callCount ? formatDuration(meetings.longestCallMinutes) : t("Нет данных")}</dd></div>
            </dl>
            {meetings.callCount > 0 ? <>
              <figure className="statistics-timeline statistics-meeting-timeline" aria-labelledby="daily-meetings-caption">
                {meetings.applications.map(application => <div className="statistics-meeting-lane" key={application.app}>
                  <span className="statistics-meeting-lane-label"><bdi>{appLabel(application.app)}</bdi></span>
                  <div className="statistics-timeline-track" aria-hidden="true" dir="ltr">
                    {meetings.spans.filter(span => span.app === application.app).map(span => <span key={span.start}
                      className="statistics-timeline-segment activity-meeting"
                      style={{ left: `${(span.start - activity.start) / dayLength * 100}%`, width: `${(span.end - span.start) / dayLength * 100}%` }}
                      title={t("{value0}, с {value1} до {value2}: {value3}", { value0: appLabel(span.app), value1: segmentTime(span.start), value2: segmentTime(span.end), value3: formatDuration((span.end - span.start) / 60000) })} />)}
                  </div>
                </div>)}
                <div className="statistics-meeting-axis-row"><span aria-hidden="true" />
                  <div className="statistics-timeline-axis" aria-hidden="true" dir="ltr">{timeTicks.map(tick => <span key={tick.hour} style={{ left: `${tick.position}%` }}>{`${String(tick.hour).padStart(2, '0')}:00`}</span>)}</div>
                </div>
                <figcaption id="daily-meetings-caption" className="sr-only">{t("Созвоны за {value0}", { value0: selectedDayLabel })}</figcaption>
              </figure>
              <div className="statistics-interval-scroll statistics-meeting-list"><table className="statistics-interval-table">
                <caption className="sr-only">{t("Созвоны за {value0}", { value0: selectedDayLabel })}</caption>
                <thead><tr><th scope="col">{t("Время")}</th><th scope="col">{t("Приложение")}</th><th scope="col">{t("Длительность")}</th></tr></thead>
                <tbody>{meetings.spans.map(span => <tr key={`${span.app}-${span.start}`}>
                  <td><bdi>{t("С {value0} до {value1}", { value0: segmentTime(span.start), value1: segmentTime(span.end) })}</bdi></td>
                  <td><span className="statistics-meeting-app"><bdi>{appLabel(span.app)}</bdi>{displayedDate === todayStats.date && meetingApplications.includes(span.app) && span.end === lastMeetingEndByApp.get(span.app) && <span className="statistics-meeting-live-badge"><i className="statistics-meeting-live" aria-hidden="true" />{t("Созвон продолжается")}</span>}</span></td>
                  <td>{formatDuration((span.end - span.start) / 60000)}</td>
                </tr>)}</tbody>
              </table></div>
              <div className="statistics-meeting-app-totals"><h5>{t("По приложениям")}</h5>
                <dl>{meetings.applications.map(application => <div key={application.app}><dt><bdi>{appLabel(application.app)}</bdi></dt>
                  <dd>{formatDuration(application.totalMinutes)}<span>{t("Созвонов: {value0}", { value0: application.callCount })}</span></dd></div>)}</dl>
              </div>
            </> : <p className="statistics-history-note">{t("В этот день созвоны не записаны.")}</p>}
            <p className="statistics-detail-note">{t("Созвоны записываются только при включённом сохранении истории, пока Blincho запущен.")}</p>
            <p className="statistics-detail-note">{t("Для звонков в браузере показывается название браузера.")} {t("Время определяется по системным признакам и может быть приблизительным.")}</p>
            {meetings.callCount > 0 && <p className="statistics-detail-note">{t("Пересекающиеся созвоны учитываются в общем времени один раз.")}</p>}
          </section>
        </div>
        <p className="statistics-detail-note statistics-recording-note">{t("Активность записывается, пока Blincho запущен. В браузере скрытая вкладка отмечается отдельно.")}</p>
        <p className="statistics-detail-note">{t("Скрытая вкладка и неподтверждённая активность не включаются в работу или отсутствие.")}</p>
      </section>

      <section className="glass-card statistics-week-summary" aria-labelledby="weekly-summary-title">
        <h3 id="weekly-summary-title" className="card-title"><Clock size={19} aria-hidden="true" />{t("В среднем за последние 7 дней")}</h3>
        <div className="statistics-average-grid">
          <div className="statistics-average-card"><span>{t("За календарный день")}</span><strong>{formatDuration(week.averageFocusMinutes)}</strong><p>{t("Рабочее время, всего за неделю поделено на 7.")}</p>
            <span className="statistics-average-breaks">{t("Перерывов в день: {value0}", { value0: Number(week.averageBreaks.toFixed(1)) })}</span></div>
          <div className="statistics-average-card"><span>{t("За день использования")}</span><strong>{week.usedDays > 0 ? formatDuration(week.averageFocusMinutesPerUsedDay) : t("Нет данных")}</strong><p>{t("Только дни с записанной работой, перерывами или упражнениями: {value0} из 7.", { value0: week.usedDays })}</p>
            <span className="statistics-average-breaks">{week.usedDays > 0 ? t("Перерывов в день: {value0}", { value0: Number(week.averageBreaksPerUsedDay.toFixed(1)) }) : t("Пока нет дней использования")}</span></div>
        </div>
        <p className="statistics-week-total">{t("Всего за неделю: {value0} работы, {value1} перерывов, {value2} упражнений.", { value0: formatDuration(week.totalFocusMinutes), value1: week.totalBreaks, value2: week.totalExercises })}</p>
        <p className="statistics-detail-note">{t("Рабочее время взято из записи таймера. Старые итоги сохраняются в средних значениях.")}</p>
        <div className="statistics-week-meetings"><h4><Phone size={16} aria-hidden="true" />{t("Созвоны за неделю")}</h4>
          <strong>{formatDuration(meetingWeek.totalMinutes)}</strong>
          <p>{t("Всего за неделю: {value0} в созвонах, {value1} созвонов.", { value0: formatDuration(meetingWeek.totalMinutes), value1: meetingWeek.callCount })}</p>
          <span>{t("В среднем в день: {value0}", { value0: formatDuration(meetingWeek.averageMinutesPerDay) })}</span>
        </div>
      </section>

      <div className="glass-card">
        <h3 className="card-title"><Calendar size={19} aria-hidden="true" />{t("Перерывы за последние 7 дней")}</h3>
        <figure className="weekly-chart" aria-labelledby="weekly-chart-caption">
          <div className="weekly-chart-bars" aria-hidden="true">{last7Days.map(day => <div key={day.dateStr} className={`weekly-chart-column ${day.isToday ? 'is-today' : ''}`}>
            <span className="weekly-chart-count">{formatNumber(day.count)}</span><div className="weekly-chart-track"><div className="weekly-chart-bar" style={{ height: `${day.count / maximum * 100}%` }} /></div>
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
        <div className="achievement-grid">{achievements.map(({ title, description, earned, Icon }) => <div key={title} className={`achievement-card ${earned ? 'earned' : 'pending'}`}>
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
