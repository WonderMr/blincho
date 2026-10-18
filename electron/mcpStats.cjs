const COUNTERS = ['breaksCompleted', 'exercisesCompleted', 'focusMinutes', 'workMinutes',
  'awayMinutes', 'pauseMinutes', 'restMinutes', 'recordedMinutes'];
const zero = () => Object.fromEntries(COUNTERS.map(key => [key, 0]));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function dayNumber(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date.getTime() / 86400000 : null;
}
const dateString = day => new Date(day * 86400000).toISOString().slice(0, 10);
const statsInputSchema = { type: 'object', properties: {
  startDate: { type: 'string', format: 'date', description: 'First included local date, YYYY-MM-DD. Defaults to the first saved date.' },
  endDate: { type: 'string', format: 'date', description: 'Last included local date, YYYY-MM-DD. Defaults to the last saved date.' },
  groupBy: { type: 'string', enum: ['day', 'week'], default: 'day', description: 'Calendar weeks begin on Monday. Periods are clipped to the requested range.' },
  offset: { type: 'integer', minimum: 0, default: 0 },
  limit: { type: 'integer', minimum: 1, maximum: 366, default: 100 },
}, additionalProperties: false };

function validStatsArguments(args) {
  return object(args) && Object.keys(args).every(key => Object.hasOwn(statsInputSchema.properties, key)) &&
    ['startDate', 'endDate'].every(key => !Object.hasOwn(args, key) || dayNumber(args[key]) !== null) &&
    (!Object.hasOwn(args, 'groupBy') || ['day', 'week'].includes(args.groupBy)) &&
    (!Object.hasOwn(args, 'offset') || (Number.isSafeInteger(args.offset) && args.offset >= 0)) &&
    (!Object.hasOwn(args, 'limit') || (Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 366)) &&
    !(args.startDate && args.endDate && args.startDate > args.endDate);
}

function dataRange(stats) {
  if (!object(stats) || Object.keys(stats).length !== 3 || typeof stats.timeZone !== 'string' ||
    !stats.timeZone.trim() || !Array.isArray(stats.days)) return null;
  let previous = '';
  for (const day of stats.days) {
    if (!object(day) || Object.keys(day).length !== 9 || dayNumber(day.date) === null || day.date <= previous ||
      !COUNTERS.every(key => typeof day[key] === 'number' && Number.isFinite(day[key]) && day[key] >= 0) ||
      !Number.isSafeInteger(day.breaksCompleted) || !Number.isSafeInteger(day.exercisesCompleted)) return null;
    previous = day.date;
  }
  const dataStartDate = stats.days[0]?.date ?? null, dataEndDate = stats.days.at(-1)?.date ?? null;
  if (stats.activityStartDate !== null && (dayNumber(stats.activityStartDate) === null ||
    !stats.days.some(day => day.date === stats.activityStartDate))) return null;
  return { timeZone: stats.timeZone, dataStartDate, dataEndDate, activityStartDate: stats.activityStartDate,
    recordedDays: stats.days.length };
}

function queryStats(stats, args, range = dataRange(stats)) {
  if (!range) return { error: 'Statistics are not available yet.' };
  const startDate = args.startDate ?? range.dataStartDate ?? args.endDate ?? null;
  const endDate = args.endDate ?? range.dataEndDate ?? args.startDate ?? null;
  if (startDate !== null && endDate !== null && startDate > endDate) return { invalidArguments: true };
  const start = dayNumber(startDate), end = dayNumber(endDate), groupBy = args.groupBy ?? 'day';
  const totals = zero(), groups = new Map();
  let recordedDays = 0;
  for (const day of stats.days) {
    if (day.date < startDate || day.date > endDate) continue;
    const ordinal = dayNumber(day.date);
    const key = groupBy === 'day' ? ordinal : ordinal - ((ordinal + 3) % 7 + 7) % 7;
    let period = groups.get(key);
    if (!period) {
      const first = Math.max(start, key), last = Math.min(end, key + (groupBy === 'day' ? 0 : 6));
      period = { startDate: dateString(first), endDate: dateString(last), calendarDays: last - first + 1, recordedDays: 0, totals: zero() };
      groups.set(key, period);
    }
    recordedDays++; period.recordedDays++;
    for (const counter of COUNTERS) {
      totals[counter] += day[counter]; period.totals[counter] += day[counter];
      if (!Number.isFinite(totals[counter]) || !Number.isFinite(period.totals[counter]) ||
        (COUNTERS.indexOf(counter) < 2 && !Number.isSafeInteger(totals[counter])))
        return { error: 'Statistics totals exceed the supported numeric range.' };
    }
  }
  const offset = args.offset ?? 0, limit = args.limit ?? 100, totalPeriods = groups.size;
  return { ...range, startDate, endDate, groupBy, calendarDays: start === null || end === null ? 0 : end - start + 1,
    recordedDays, totals, periods: [...groups.values()].slice(offset, offset + limit), totalPeriods, offset,
    hasMore: offset + limit < totalPeriods };
}

module.exports = { statsInputSchema, validStatsArguments, dataRange, queryStats };
