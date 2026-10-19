import React from 'react';
import type { DayStats } from '../types';
import { INPUT_FIELDS, normalizeInputActivity } from '../utils/inputActivity';
import { t, formatNumber, formatDate } from '../i18n/runtime';

export const InputActivityView: React.FC<{ day: DayStats }> = ({ day }) => {
  const buckets = normalizeInputActivity(day.inputActivity, day.date);
  const labels = [t("Нажатия клавиш"), t("Клики"), t("Прокрутки"), t("Движения мыши")];
  const totals = INPUT_FIELDS.map(field => buckets.reduce((sum, bucket) => sum + bucket[field], 0));
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: buckets.filter(bucket => new Date(bucket.start).getHours() === hour)
    .reduce((sum, bucket) => sum + INPUT_FIELDS.reduce((total, field) => total + bucket[field], 0), 0) }));
  const maximum = Math.max(1, ...hours.map(hour => hour.count));
  const exportCsv = () => {
    const rows = [['date', 'interval_start', ...INPUT_FIELDS], ...buckets.map(bucket => [day.date, new Date(bucket.start).toISOString(), ...INPUT_FIELDS.map(field => bucket[field])])];
    const url = URL.createObjectURL(new Blob([rows.map(row => row.join(',')).join('\n')], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `blincho-input-${day.date}.csv`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="statistics-input" aria-labelledby="input-activity-title">
    <h4 id="input-activity-title">{t("Профиль активности ввода")}</h4>
    <p className="statistics-detail-note">{t("Только локальные счётчики событий по 5 минут. Без текста, приложений и координат. Частота событий зависит от устройства. Эти данные не устанавливают диагноз.")}</p>
    {!buckets.length ? <p>{t("Нет записи")}</p> : <>
      <dl className="statistics-session-summary">{labels.map((label, index) => <div key={label}><dt>{label}</dt><dd>{formatNumber(totals[index])}</dd></div>)}</dl>
      <div className="input-activity-chart" role="img" aria-label={t("Профиль активности ввода")}>
        {hours.map(({ hour, count }) => <div key={hour} title={`${String(hour).padStart(2, '0')}:00: ${formatNumber(count)}`}>
          <i style={{ height: `${count / maximum * 100}%` }} /><span>{hour % 6 === 0 ? `${hour}:00` : ''}</span>
        </div>)}
      </div>
      <button type="button" className="btn btn-secondary" onClick={exportCsv}>{t("Скачать CSV")}</button>
      <details className="statistics-interval-details"><summary>{t("Все интервалы")}</summary>
        <div className="statistics-interval-scroll"><table className="statistics-interval-table">
          <caption className="sr-only">{t("Профиль активности ввода")}</caption>
          <thead><tr><th scope="col">{t("Время")}</th>{labels.map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{buckets.map(bucket => <tr key={bucket.start}><td>{formatDate(bucket.start, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</td>
            {INPUT_FIELDS.map(field => <td key={field}>{formatNumber(bucket[field])}</td>)}</tr>)}</tbody>
        </table></div>
      </details>
    </>}
  </section>;
};
