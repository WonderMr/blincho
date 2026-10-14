// Run the real view and aggregation code with React and a small DOM boundary.
// These checks cover semantics and interaction; they do not claim browser layout QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { React, ReactDOMClient, ReactDOM, doc, DOMNode, transformer } = require('./support/syntheticDom.cjs');
const { renderToStaticMarkup } = require('react-dom/server');
const repo = path.resolve(__dirname, '..');
const cache = new Map();
const FakeDate = class extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-10-14T12:00:00'])); }
  static now() { return new Date('2026-10-14T12:00:00').getTime(); }
};
function load(relative) {
  const file = path.resolve(repo, relative);
  if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8'));
  if (cache.has(file)) return cache.get(file);
  const module = { exports: {} }; cache.set(file, module.exports);
  let source = transformer.transformSync(file, fs.readFileSync(file, 'utf8'), { jsx: { runtime: 'classic' } }).code;
  const names = [...source.matchAll(/export (?:const|function|class)\s+(\w+)/g)].map(match => match[1]);
  source = source.replace(/import (\w+), \{([^}]+)\} from "([^"]+)";/g, 'const $1=require("$3");const {$2}=$1;')
    .replace(/import \{([^}]+)\} from "([^"]+)";/g, 'const {$1}=require("$2");')
    .replace(/import (\w+) from "([^"]+)";/g, 'const $1=require("$2");')
    .replace(/export (const|function|class) /g, '$1 ') + `\nObject.assign(module.exports,{${names.join(',')}});`;
  const requireLocal = name => {
    if (name === 'react') return React;
    if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
    const base = path.resolve(path.dirname(file), name);
    return load(path.relative(repo, path.extname(base) ? base : fs.existsSync(base + '.ts') ? base + '.ts' : base + '.tsx'));
  };
  vm.runInNewContext(source, { module, require: requireLocal, console, Date: FakeDate, Intl, window, document: doc, HTMLElement: DOMNode, localStorage: window.localStorage }, { filename: file });
  return module.exports;
}
const { StatisticsView } = load('src/components/StatisticsView.tsx');
const i18n = load('src/i18n/runtime.ts');
i18n.setLanguagePreference('ru');
const zero = date => ({ date, breaksCompleted: 0, exercisesCompleted: 0, focusMinutes: 0 });
const span = (date, start, end, state) => ({ start: new Date(`${date}T${start}:00`).getTime(), end: new Date(`${date}T${end}:00`).getTime(), state });
const date = '2026-10-13';
const recorded = { ...zero(date), activity: [
  span(date, '09:00', '10:00', 'work'), span(date, '10:00', '10:15', 'idle'),
  span(date, '10:15', '10:30', 'manual'), span(date, '10:30', '10:35', 'break'),
  span(date, '10:35', '10:40', 'exercise'), span(date, '10:40', '10:50', 'locked'),
  span(date, '10:50', '11:00', 'suspended'), span(date, '11:00', '11:15', 'hidden'),
  span(date, '11:15', '11:30', 'unconfirmed'), span(date, '11:30', '12:00', 'work'),
] };
const legacy = { ...zero('2025-05-01'), focusMinutes: 60, breaksCompleted: 3 };
const today = { ...zero('2026-10-14'), focusMinutes: 14, breaksCompleted: 7 };
const props = { todayStats: today, allStats: [recorded, legacy], cvsResult: null };
const host = doc.createElement('div'); doc.body.appendChild(host);
const root = ReactDOMClient.createRoot(host);
const render = value => ReactDOM.flushSync(() => root.render(value));
const all = predicate => {
  const found = []; const visit = node => { if (predicate(node)) found.push(node); node.childNodes.forEach(visit); }; visit(host); return found;
};
const find = predicate => all(predicate)[0];
const reactProps = node => node[Object.keys(node).find(key => key.startsWith('__reactProps'))];
const invoke = (node, event, value) => { assert(node, 'control exists'); ReactDOM.flushSync(() => reactProps(node)[event](value)); };
const results = [];
try {
  render(React.createElement(StatisticsView, props));
  const selector = () => find(node => node.tagName === 'SELECT');
  const dayButtons = () => all(node => node.tagName === 'BUTTON' && node.getAttribute('aria-controls') === 'daily-activity-detail');
  assert.equal(dayButtons().length, 7);
  assert.equal(dayButtons().filter(node => node.getAttribute('aria-pressed') === 'true').length, 1);
  assert(selector().options.some(option => option.getAttribute('value') === legacy.date), 'older saved days remain selectable');
  assert(host.textContent.includes('За этот день сохранены только итоги'));
  assert.equal(all(node => node.getAttribute('data-activity-state') === 'work').length, 0, 'aggregate focus must not invent timed work spans');
  const averageCards = all(node => reactProps(node)?.className === 'statistics-average-card');
  assert(averageCards[0].textContent.includes('2 мин'), 'calendar average divides 14 minutes by all 7 days');
  assert(averageCards[1].textContent.includes('7 мин'), 'used-day average includes the second recorded work day');
  assert(averageCards[1].textContent.includes('2 из 7'));
  results.push('calendar versus used-day averages include saved aggregate history and absent days without fabricated spans');

  invoke(selector(), 'onChange', { target: { value: recorded.date } });
  assert.equal(dayButtons().filter(node => node.getAttribute('aria-pressed') === 'true').length, 1);
  const durationValues = all(node => node.tagName === 'DD').map(node => node.textContent);
  assert.deepEqual(durationValues.slice(0, 4), ['1 ч 30 мин', '35 мин', '15 мин', '10 мин']);
  assert.deepEqual(durationValues.slice(4), ['2', '45 мин', '1 ч 0 мин', 'С 09:00 до 12:00']);
  assert(host.textContent.includes('Записано: 3 ч 0 мин'));
  assert(host.textContent.includes('Нет записи: 21 ч 0 мин'));
  for (const state of ['work', 'idle', 'locked', 'suspended', 'hidden', 'unconfirmed', 'manual', 'break', 'exercise', 'unknown']) {
    assert(find(node => node.getAttribute('data-activity-state') === state), `${state} remains visible in timeline`);
  }
  assert.equal(reactProps(find(node => node.getAttribute('data-activity-state') === 'hidden')).className, 'statistics-timeline-segment activity-unconfirmed');
  const details = find(node => node.tagName === 'DETAILS');
  assert(details.textContent.includes('Экран заблокирован'));
  assert(details.textContent.includes('Компьютер спит'));
  assert(details.textContent.includes('Вкладка скрыта'));
  assert(details.textContent.includes('Длительность'));
  results.push('day selection reveals accurate work, absence, pause and rest durations, session summary and semantic interval table');

  invoke(selector(), 'onChange', { target: { value: legacy.date } });
  assert(host.textContent.includes('За этот день сохранены только итоги'));
  assert.equal(dayButtons().filter(node => node.getAttribute('aria-pressed') === 'true').length, 0, 'older day does not falsely select a recent day');
  assert.equal(all(node => node.getAttribute('data-activity-state') === 'work').length, 0);
  assert.equal(find(node => node.tagName === 'DETAILS'), undefined);
  invoke(dayButtons()[6], 'onClick');
  assert.equal(reactProps(selector()).value, today.date, 'native button restores selected recent day');
  assert.equal(dayButtons()[6].getAttribute('aria-pressed'), 'true');
  results.push('older aggregate-only records stay unknown and recent-day native buttons restore selection');

  render(null);
  const hiddenDay = { ...zero('2026-10-13'), activity: [span('2026-10-13', '10:00', '11:00', 'hidden')] };
  render(React.createElement(StatisticsView, { todayStats: hiddenDay, allStats: [], cvsResult: null }));
  assert(find(node => node.tagName === 'DETAILS'), 'uncertain-only observation still exposes detail');
  assert.deepEqual(all(node => node.tagName === 'DD').map(node => node.textContent), ['Нет данных', 'Нет данных', 'Нет данных', 'Нет данных']);
  assert(host.textContent.includes('Вкладка скрыта'));
  assert(!host.textContent.includes('За этот день пока нет записи активности'));
  results.push('hidden-only browser records preserve timeline but do not assert work or absence totals');

  const markup = renderToStaticMarkup(React.createElement(StatisticsView, { todayStats: recorded, allStats: [], cvsResult: null }));
  assert(markup.includes('aria-labelledby="daily-activity-title"'));
  assert(markup.includes('<caption class="sr-only">Запись активности'));
  assert(markup.includes('scope="col"'));
  assert(!/[\u2014\u2015]/.test(host.textContent));
  results.push('screen-reader labels and table headers accompany visual timeline; user strings contain no prohibited dashes');
} finally {
  ReactDOM.flushSync(() => root.unmount()); doc.body.removeChild(host);
}
console.log(JSON.stringify({ passed: results.length, results, limitation: 'Synthetic DOM interaction and SSR only; no browser layout claim' }, null, 2));
