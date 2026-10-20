// UI behavior and semantic SSR; this cannot verify browser visual layout.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { React, ReactDOMClient, ReactDOM, doc, DOMNode, transformer } = require('./support/syntheticDom.cjs');
const { renderToStaticMarkup } = require('react-dom/server');
const repo = path.resolve(__dirname, '..'), cache = new Map(), store = new Map();
const navigatorStub = { mediaDevices: undefined };
let reloads = 0;
window.electronAPI = undefined; window.location = { reload() { reloads++; } };
const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
window.localStorage=localStorage;localStorage.setItem('blincho-language-v1',JSON.stringify({preference:'ru',acknowledged:true}));
function load(relative) {
  const file = path.resolve(repo, relative); if(file.endsWith('.json'))return JSON.parse(fs.readFileSync(file,'utf8')); if (cache.has(file)) return cache.get(file);
  const module = { exports: {} }; cache.set(file, module.exports);
  let source = transformer.transformSync(file, fs.readFileSync(file, 'utf8'), { jsx: { runtime: 'classic' } }).code;
  const names = [...source.matchAll(/export (?:async )?(?:const|function|class)\s+(\w+)/g)].map(match => match[1]);
  source = source.replace(/import (\w+), \{([^}]+)\} from "([^"]+)";/g, 'const $1=require("$3");const {$2}=$1;')
    .replace(/import \{([^}]+)\} from "([^"]+)";/g, 'const {$1}=require("$2");')
    .replace(/import (\w+) from "([^"]+)";/g, 'const $1=require("$2");')
    .replace(/import \{([^}]+)\} from "([^"]+)";/g, 'const {$1}=require("$2");').replace(/export (async )?(const|function|class) /g, '$1$2 ') + `\nObject.assign(module.exports,{${names.join(',')}});`;
  const requireLocal = name => name === 'react' ? React : name === 'lucide-react' ? new Proxy({}, { get: () => () => null }) :
    name.endsWith('/soundSynth') ? { soundSynth: { enabled: false, playZenBowl() {} } } :
      name.endsWith('/notifications') ? { requestNotificationPermission: async () => false, showEyeBreakNotification() {} } :
        name.startsWith('.') ? load(path.relative(repo, path.resolve(path.dirname(file), name) + (path.extname(name) ? '' : fs.existsSync(path.resolve(path.dirname(file), name)+'.ts')?'.ts':'.tsx'))) : require(name);
  vm.runInNewContext(source, { module, require: requireLocal, console, window, navigator: navigatorStub, document: doc, HTMLElement: DOMNode, localStorage, AbortController }, { filename: file });
  return module.exports;
}
const { SettingsModal } = load('src/components/SettingsModal.tsx'), { DEFAULT_SETTINGS } = load('src/utils/storage.ts');
const { ExerciseLibrary } = load('src/components/ExerciseLibrary.tsx'), { MEDICAL_TECHNIQUES } = load('src/data/medicalTechniques.ts');
const { StatisticsView } = load('src/components/StatisticsView.tsx'), { Navbar } = load('src/components/Navbar.tsx');
const { TimerWidget } = load('src/components/TimerWidget.tsx'), { ErrorBoundary } = load('src/components/ErrorBoundary.tsx');
const { ErgonomicsGuide } = load('src/components/ErgonomicsGuide.tsx');
const host = doc.createElement('div'), opener = doc.createElement('button'); doc.body.appendChild(host); doc.body.appendChild(opener); opener.focus();
const root = ReactDOMClient.createRoot(host);
const render = element => ReactDOM.flushSync(() => root.render(element));
const find = (predicate, node = host) => { if (predicate(node)) return node; for (const child of node.childNodes) { const found = find(predicate, child); if (found) return found; } };
const reactProps = node => node[Object.keys(node).find(key => key.startsWith('__reactProps'))];
const invoke = (node, name, event) => { assert(node, 'control exists'); ReactDOM.flushSync(() => reactProps(node)[name](event)); };
const results = [], noop = () => {};
let settings = { ...DEFAULT_SETTINGS }, closed = 0;
const settingsElement = () => React.createElement(SettingsModal, { settings, onUpdateSettings(value) { settings = value; render(settingsElement()); }, onClose() { closed++; } });
render(settingsElement());
assert.equal(doc.activeElement.tagName, 'BUTTON');
const idleThreshold = () => find(node => node.getAttribute('id') === 'idle-threshold');
assert.equal(reactProps(idleThreshold()).value, 1);
assert(idleThreshold().querySelectorAll('option').some(node => node.getAttribute('value') === '1'), 'default one-minute threshold must be displayed');
settings = { ...settings, idleThresholdMinutes: 2 }; render(settingsElement());
assert.equal(reactProps(idleThreshold()).value, 2);
assert(idleThreshold().querySelectorAll('option').some(node => node.getAttribute('value') === '2'), 'saved custom threshold must be displayed');
assert.equal(find(node => node.getAttribute('id') === 'strict-idle'), undefined);
assert(host.textContent.includes('Автопауза действует и в строгом режиме'));
invoke(find(node => node.getAttribute('id') === 'work-minutes'), 'onChange', { target: { value: '30' } }); assert.equal(settings.workMinutes, 30); assert.equal(settings.timerPreset, 'custom');
invoke(find(node => node.getAttribute('id') === 'timer-preset'), 'onChange', { target: { value: 'pomodoro' } }); assert.equal(settings.workMinutes, 25); assert.equal(settings.breakSeconds, 300);
const meeting = find(node => node.getAttribute('id') === 'meeting-detection'); assert.notEqual(meeting.getAttribute('disabled'), null); assert.equal(reactProps(meeting).checked, false);
const modal = host.querySelector('[aria-modal="true"]'), controls = modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]');
let prevented = 0; controls.at(-1).focus(); doc.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: false, preventDefault() { prevented++; } }); assert.equal(doc.activeElement, controls[0]);
doc.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true, preventDefault() { prevented++; } }); assert.equal(doc.activeElement, controls.at(-1)); assert.equal(prevented, 2);
let stopped = false; doc.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true; } }); assert.equal(closed, 1); assert(stopped);
render(null); assert.equal(doc.activeElement, opener); assert.equal(doc._listeners.get('keydown').size, 0);
results.push('settings default/custom idle threshold, strict absence policy, custom duration, atomic 25/300 preset, Tab/Escape, focus restore, listener cleanup and unsupported meeting control');

const cameraToggle = () => find(node => node.getAttribute('id') === 'camera-lock-enabled');
render(settingsElement());
assert.equal(reactProps(cameraToggle()).disabled, true, 'browser camera locking is unavailable');
assert.equal(reactProps(cameraToggle()).checked, false, 'an unavailable feature is shown inactive');
assert.equal(settings.cameraLockEnabled, false, 'capability checks preserve the disabled default');
assert(host.textContent.includes('В браузере компьютер не блокируется.'));
window.electronAPI = { lockComputer() { throw new Error('Settings must not lock the computer'); } };
render(settingsElement());
assert.equal(reactProps(cameraToggle()).disabled, true, 'a desktop bridge without camera support is unavailable');
navigatorStub.mediaDevices = { getUserMedia() { throw new Error('Settings must not request camera access'); } };
window.electronAPI = undefined;
render(settingsElement());
assert.equal(reactProps(cameraToggle()).disabled, true, 'camera support alone cannot enable OS locking');
window.electronAPI = { isElectron: true, meetingDetectionSupported: false, lockComputer() { throw new Error('Settings must not lock the computer'); } };
render(settingsElement());
assert.equal(reactProps(cameraToggle()).disabled, true, 'camera locking requires call-detection capability');
assert(host.textContent.includes('Детекция встреч недоступна'));
window.electronAPI.meetingDetectionSupported = true;
render(settingsElement());
assert.equal(reactProps(cameraToggle()).disabled, false);
assert.equal(reactProps(cameraToggle()).checked, false);
assert.equal(cameraToggle().getAttribute('aria-describedby'), 'camera-lock-enabled-description');
assert(host.textContent.includes('кадры не сохраняются и не отправляются'));
assert(host.textContent.includes('Нужно разрешение камеры'));
assert(host.textContent.includes('Если камера или проверка недоступны, блокировка пропускается.'));
settings = { ...settings, cameraLockEnabled: true }; render(settingsElement());
assert.equal(reactProps(cameraToggle()).checked, true, 'an explicit saved opt-in is preserved');
const workMinutesBeforeCameraChange = settings.workMinutes;
invoke(cameraToggle(), 'onChange', { target: { checked: false } });
assert.equal(settings.cameraLockEnabled, false);
assert.equal(settings.workMinutes, workMinutesBeforeCameraChange);
render(null); render(settingsElement());
assert.equal(reactProps(cameraToggle()).checked, false, 'saved camera opt-out survives modal reopening');
window.electronAPI = undefined; navigatorStub.mediaDevices = undefined;
render(null);
results.push('camera locking requires desktop, camera and call-detection capabilities, explains local privacy and permissions, and preserves the opt-out without requesting camera access');

let selected;
render(React.createElement(ExerciseLibrary, { onSelectTechnique: item => { selected = item; }, onStartFullRoutine: noop }));
invoke(find(node => node.getAttribute('id') === 'technique-search'), 'onChange', { target: { value: '  НЕСУЩЕСТВУЮЩЕЕ УПРАЖНЕНИЕ  ' } }); assert(host.textContent.includes('Ничего не найдено')); assert.equal(host.querySelectorAll('article').length, 0);
invoke(find(node => node.tagName === 'BUTTON' && node.textContent === 'Сбросить фильтры'), 'onClick');
const startButtons = host.querySelectorAll('button').filter(node => node.getAttribute('aria-label')?.startsWith('Начать:'));
assert.equal(startButtons.length, MEDICAL_TECHNIQUES.length); invoke(startButtons[0], 'onClick'); assert.equal(selected.id, MEDICAL_TECHNIQUES[0].id);
results.push('library search empty state, reset filters, semantic start buttons and selection callback');

render(React.createElement(ErgonomicsGuide));
const checklistButtons = host.querySelectorAll('button');
assert.equal(checklistButtons.length, 6); for (const button of checklistButtons) { assert.equal(button.getAttribute('type'), 'button'); assert.equal(button.getAttribute('aria-pressed'), 'false'); }
invoke(checklistButtons[0], 'onClick'); assert.equal(checklistButtons[0].getAttribute('aria-pressed'), 'true'); assert(host.textContent.includes('Выполнено: 1 из 6'));
assert.equal(JSON.parse(store.get('myeyes_ergonomics_checklist_v1')).distance, true);
render(null); render(React.createElement(ErgonomicsGuide)); assert.equal(host.querySelectorAll('button')[0].getAttribute('aria-pressed'), 'true', 'checklist choice survives remount');
results.push('ergonomics checklist has native buttons, exposes toggle state and preserves the existing saved checklist');

const zero = { date: '2026-10-11', breaksCompleted: 0, exercisesCompleted: 0, focusMinutes: 0 }, ssr = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const empty = ssr(StatisticsView, { todayStats: zero, allStats: [], cvsResult: null }); assert.equal((empty.match(/Ещё впереди/g) || []).length, 3); assert.equal((empty.match(/Получено/g) || []).length, 0);
const active = { ...zero, breaksCompleted: 5, exercisesCompleted: 2, techniqueCounts: { 'donald-korb-blinking': 1, 'palming-relaxation': 1 } };
const history = Array.from({ length: 35 }, (_, index) => { const date = new Date('2026-10-11T12:00:00'); date.setDate(date.getDate() - index); return { ...active, date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }; });
const earned = ssr(StatisticsView, { todayStats: active, allStats: history, cvsResult: null }); assert.equal((earned.match(/Получено/g) || []).length, 3); assert(earned.includes('35 дн.'));
results.push('empty achievements remain pending; actual technique history earns badges and a streak longer than 30 days');
const timerProps = { totalSeconds: 1200, secondsRemaining: 897, isRunning: false, preset: '20-20-20', phase: 'idle', onTogglePlay: noop, onReset: noop, onTriggerInstantBreak: noop, onSelectPreset: noop };
const idle = ssr(TimerWidget, timerProps); assert(idle.includes('Пауза: нет активности')); assert(idle.includes('Продолжить')); assert(idle.includes('aria-pressed="true"'));
const nav = ssr(Navbar, { activeTab: 'stats', onSelectTab: noop, onOpenSettings: noop, onTriggerInstantBreak: noop, soundEnabled: true, onToggleSound: noop }); assert.equal((nav.match(/aria-current="page"/g) || []).length, 1); assert(nav.includes('aria-label="Главная навигация"'));
results.push('timer absence state and active preset; navbar exposes current section and labelled controls');

for (const key of ['myeyes_settings_v1', 'myeyes_stats_v1', 'myeyes_cvs_result_v1', 'another_app']) store.set(key, 'preserved');
const boundary = new ErrorBoundary({ children: null }); boundary.state = { hasError: true, error: new Error('regression fixture') };
render(boundary.render()); invoke(find(node => node.tagName === 'BUTTON' && node.textContent.includes('Сбросить только настройки')), 'onClick');
assert.equal(store.has('myeyes_settings_v1'), false); for (const key of ['myeyes_stats_v1', 'myeyes_cvs_result_v1', 'another_app']) assert.equal(store.get(key), 'preserved'); assert.equal(reloads, 1);
results.push('error recovery resets settings while preserving statistics, self-check and unrelated storage');

const i18n = load('src/i18n/runtime.ts');
render(settingsElement());
const languageControl = () => find(node => node.tagName === 'SELECT' && reactProps(node).className?.includes('language-select'));
assert.equal(languageControl().querySelectorAll('option').length, 31);
const originalDialog = host.querySelector('[aria-modal="true"]');
const savedSettings = JSON.stringify(settings);
invoke(languageControl(), 'onChange', { target: { value: 'ar' } });
assert.equal(doc.documentElement.dir, 'rtl');
assert.equal(host.querySelector('[aria-modal="true"]'), originalDialog, 'language change must not remount the open dialog');
assert.equal(JSON.stringify(settings), savedSettings, 'language choice must not update timer settings');
assert.equal(JSON.parse(store.get('blincho-language-v1')).preference, 'ar');
assert(host.textContent.includes(i18n.t('Язык и регион')));
invoke(languageControl(), 'onChange', { target: { value: 'en' } });
assert.equal(doc.documentElement.dir, 'ltr');
assert(host.textContent.includes('Language'));
render(React.createElement(ExerciseLibrary, { onSelectTechnique: noop, onStartFullRoutine: noop }));
const translatedTitle = i18n.t(MEDICAL_TECHNIQUES[0].title);
invoke(find(node => node.getAttribute('id') === 'technique-search'), 'onChange', { target: { value: translatedTitle } });
assert(host.querySelectorAll('article').length > 0);
assert(host.textContent.includes(translatedTitle));
assert(!/[А-Яа-яЁё]/.test(host.textContent), 'English library has no Russian display text');
results.push('thirty languages plus automatic selection, live RTL/LTR without dialog remount or timer changes, persisted choice and translated exercise search');
ReactDOM.flushSync(() => i18n.setLanguagePreference('ru'));
ReactDOM.flushSync(() => root.unmount()); doc.body.removeChild(host); doc.body.removeChild(opener);
console.log(JSON.stringify({ passed: results.length, results, limitation: 'Real React interactions and SSR with synthetic DOM; no browser visual/E2E claim' }, null, 2));
