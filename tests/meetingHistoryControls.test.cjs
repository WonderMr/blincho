// Exercise the real controls at their React boundary. Native persistence is
// covered separately in meetings.test.cjs and the desktop smoke check.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { React, ReactDOMClient, ReactDOM, doc, DOMNode, transformer } = require('./support/syntheticDom.cjs');
const { renderToStaticMarkup } = require('react-dom/server');
const originalFocus = DOMNode.prototype.focus;
DOMNode.prototype.focus = function () {
  if (!this.disabled && this.getAttribute('disabled') === null) originalFocus.call(this);
};
const repo = path.resolve(__dirname, '..'), cache = new Map();
function load(relative) {
  const file = path.resolve(repo, relative);
  if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8'));
  if (cache.has(file)) return cache.get(file);
  const module = { exports: {} }; cache.set(file, module.exports);
  let source = transformer.transformSync(file, fs.readFileSync(file, 'utf8'), { jsx: { runtime: 'classic' } }).code;
  const names = [...source.matchAll(/export (?:async )?(?:const|function|class)\s+(\w+)/g)].map(match => match[1]);
  source = source.replace(/import (\w+), \{([^}]+)\} from "([^"]+)";/g, 'const $1=require("$3");const {$2}=$1;')
    .replace(/import \{([^}]+)\} from "([^"]+)";/g, 'const {$1}=require("$2");')
    .replace(/import (\w+) from "([^"]+)";/g, 'const $1=require("$2");')
    .replace(/export (async )?(const|function|class) /g, '$1$2 ') + `\nObject.assign(module.exports,{${names.join(',')}});`;
  const requireLocal = name => {
    if (name === 'react') return React;
    if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
    if (name.endsWith('/soundSynth')) return { soundSynth: { enabled: false, playZenBowl() {} } };
    if (name.endsWith('/notifications')) return { requestNotificationPermission: async () => false, showEyeBreakNotification() {} };
    const base = path.resolve(path.dirname(file), name);
    return load(path.relative(repo, path.extname(base) ? base : fs.existsSync(base + '.ts') ? base + '.ts' : base + '.tsx'));
  };
  vm.runInNewContext(source, { module, require: requireLocal, console, Date, Intl, window, document: doc,
    HTMLElement: DOMNode, localStorage: window.localStorage }, { filename: file });
  return module.exports;
}
const { MeetingHistoryControls } = load('src/components/MeetingHistoryControls.tsx');
const { SettingsModal } = load('src/components/SettingsModal.tsx');
const { StatisticsView } = load('src/components/StatisticsView.tsx');
const { DEFAULT_SETTINGS } = load('src/utils/storage.ts');
const i18n = load('src/i18n/runtime.ts');
const host = doc.createElement('div'); doc.body.appendChild(host);
const root = ReactDOMClient.createRoot(host);
const render = element => ReactDOM.flushSync(() => root.render(element));
const find = predicate => {
  function visit(node) { if (predicate(node)) return node; for (const child of node.childNodes) { const found = visit(child); if (found) return found; } }
  return visit(host);
};
const byId = id => find(node => node.getAttribute?.('id') === id);
const propsOf = node => node[Object.keys(node).find(key => key.startsWith('__reactProps'))];
const invoke = (node, event = 'onClick', value) => {
  assert(node, 'control exists'); assert.equal(propsOf(node).disabled, false, 'control is enabled');
  ReactDOM.flushSync(() => propsOf(node)[event](value));
};
// Settings installs a document capture listener before React's bubbling handler.
const pressCapturedKey = (target, key) => {
  let stopped = false;
  const event = { type: 'keydown', target, key, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { stopped = true; } };
  ReactDOM.flushSync(() => {
    doc.dispatchEvent(event);
    for (let node = target; node && !stopped; node = node.parentNode) propsOf(node)?.onKeyDown?.(event);
  });
  return { prevented: event.defaultPrevented, stopped };
};
const settle = async () => {
  for (let i = 0; i < 6; i++) { await Promise.resolve(); ReactDOM.flushSync(() => {}); }
  for (let i = 0; i < 3; i++) { await new Promise(resolve => setImmediate(resolve)); ReactDOM.flushSync(() => {}); }
};
const results = [];
(async () => {
  const common = { enabled: false, supported: true, hasHistory: true, pending: false, feedback: null,
    onEnabledChange() {}, onDelete: async () => {} };
  try {
    i18n.setLanguagePreference('ru');
    let settingsCloses = 0;
    render(React.createElement(SettingsModal, { settings: DEFAULT_SETTINGS, onUpdateSettings() {}, onClose() { settingsCloses++; },
      meetingHistoryControls: common }));
    assert.equal(propsOf(byId('meeting-detection')).checked, false, 'unsupported postponement remains disabled');
    assert.equal(propsOf(byId('settings-meeting-history-enabled')).checked, false);
    assert.equal(propsOf(byId('settings-meeting-history-enabled')).disabled, false);
    invoke(byId('settings-meeting-history-delete'));
    const settingsEscape = pressCapturedKey(doc.activeElement, 'Escape');
    assert.equal(settingsCloses, 0, 'Escape inside the confirmation does not close Settings');
    assert(settingsEscape.prevented && settingsEscape.stopped, 'confirmation consumes Escape after the document capture listener');
    assert(!byId('settings-meeting-history-confirm-delete'), 'Escape cancels the inline confirmation');
    assert(doc.activeElement === byId('settings-meeting-history-delete'), 'cancellation restores focus to the enabled delete action');
    pressCapturedKey(doc.activeElement, 'Escape');
    assert.equal(settingsCloses, 1, 'ordinary Escape still closes Settings after confirmation cancellation');
    results.push('Settings document capture Escape defers to confirmation cancellation and ordinary Escape still closes Settings');
    render(React.createElement(StatisticsView, { todayStats: { date: '2026-10-14', focusMinutes: 0,
      breaksCompleted: 0, exercisesCompleted: 0 }, allStats: [], cvsResult: null, meetingHistoryControls: common }));
    assert(byId('statistics-meeting-history-enabled'));
    assert(host.textContent.includes('Выключено по умолчанию'));
    assert(host.textContent.includes('Статистика никуда не отправляется'));
    results.push('settings and statistics expose separate default-off recording control and local-data explanation');

    let changed, deletions = 0, resolveDelete, deleted = false;
    function Parent() {
      const [enabled, setEnabled] = React.useState(false), [pending, setPending] = React.useState(false);
      const [feedback, setFeedback] = React.useState(null);
      return React.createElement(MeetingHistoryControls, { ...common, id: 'privacy', enabled, pending, feedback,
        hasHistory: !deleted, onEnabledChange: value => { changed = value; setEnabled(value); },
        onDelete: async () => {
          deletions++; setPending(true);
          await new Promise(resolve => { resolveDelete = resolve; });
          deleted = true; setPending(false); setFeedback('deleted');
        } });
    }
    render(React.createElement(Parent));
    invoke(byId('privacy-enabled'), 'onChange', { target: { checked: true } });
    assert.equal(changed, true); assert.equal(deletions, 0, 'opt-in does not delete history');
    invoke(byId('privacy-enabled'), 'onChange', { target: { checked: false } });
    assert.equal(deletions, 0, 'opt-out does not delete saved history');
    invoke(byId('privacy-delete'));
    assert.equal(deletions, 0, 'initial delete action requires confirmation');
    assert.equal(doc.activeElement.textContent, 'Отмена', 'confirmation initially focuses the safe action');
    const confirmation = find(node => node.getAttribute?.('role') === 'group');
    assert(confirmation.getAttribute('aria-labelledby'));
    let prevented = false, stopped = false;
    ReactDOM.flushSync(() => propsOf(confirmation).onKeyDown({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } }));
    assert(prevented && stopped); assert(byId('privacy-delete')); assert.equal(doc.activeElement, byId('privacy-delete'));
    invoke(byId('privacy-delete')); invoke(byId('privacy-confirm-delete'));
    assert.equal(deletions, 1);
    assert.equal(propsOf(byId('privacy-confirm-delete')).disabled, true);
    assert.equal(propsOf(byId('privacy-enabled')).disabled, true);
    const pendingEscape = pressCapturedKey(doc.activeElement, 'Escape');
    assert(pendingEscape.prevented && pendingEscape.stopped);
    assert(byId('privacy-confirm-delete'), 'Escape cannot dismiss a deletion while it is pending');
    resolveDelete(); await settle();
    assert.equal(byId('privacy-feedback').getAttribute('role'), 'status');
    assert.equal(byId('privacy-feedback').textContent, 'История созвонов удалена.');
    assert.equal(propsOf(byId('privacy-delete')).disabled, true);
    assert(doc.activeElement === byId('privacy-feedback'), 'successful deletion focuses its visible status, not the disabled delete action');
    assert.equal(byId('privacy-feedback').getAttribute('tabindex'), '-1', 'feedback supports programmatic focus without entering the tab order');
    results.push('opt-out keeps history, accessible confirmation supports Escape and focus restore, deletion waits and announces success');

    function FailureParent() {
      const [pending, setPending] = React.useState(false), [feedback, setFeedback] = React.useState(null);
      return React.createElement(MeetingHistoryControls, { ...common, id: 'retry', pending, feedback,
        onDelete: async () => { setPending(true); await Promise.resolve(); setPending(false); setFeedback('failed'); } });
    }
    render(React.createElement(FailureParent));
    invoke(byId('retry-delete')); invoke(byId('retry-confirm-delete')); await settle();
    assert.equal(byId('retry-feedback').getAttribute('role'), 'alert');
    assert.equal(propsOf(byId('retry-delete')).disabled, false, 'failed deletion keeps records available to retry');
    assert(doc.activeElement === byId('retry-delete'), 'failed deletion restores focus to the enabled delete action');
    results.push('failed deletion announces the error and restores focus to the enabled retry action');

    render(React.createElement(MeetingHistoryControls, { ...common, id: 'unavailable', supported: false,
      enabled: true, feedback: 'failed' }));
    assert.equal(propsOf(byId('unavailable-enabled')).checked, false);
    assert.equal(propsOf(byId('unavailable-enabled')).disabled, true);
    assert.equal(propsOf(byId('unavailable-delete')).disabled, false, 'saved records can be deleted on unsupported platforms');
    assert.equal(byId('unavailable-feedback').getAttribute('role'), 'alert');
    assert(host.textContent.includes('Попробуйте ещё раз'));
    assert(host.textContent.includes('только в настольном приложении Blincho'));
    results.push('unsupported recording is disabled truthfully, saved history remains deletable and failure is visible');

    for (const language of i18n.SUPPORTED_LANGUAGES) {
      i18n.setLanguagePreference(language.code);
      const markup = renderToStaticMarkup(React.createElement(MeetingHistoryControls, { ...common, id: 'locale', feedback: 'failed' }));
      assert(!/[\u2014\u2015]|\s\u2013\s/.test(markup));
      if (!['ru', 'uk'].includes(language.code)) assert(!/[А-Яа-яЁё]/.test(markup), `${language.code} has translated privacy text`);
    }
    results.push('privacy controls render in all thirty languages without Russian fallback or prohibited dashes');
  } finally {
    i18n.setLanguagePreference('ru'); ReactDOM.flushSync(() => root.unmount()); doc.body.removeChild(host);
    DOMNode.prototype.focus = originalFocus;
  }
  console.log(JSON.stringify({ passed: results.length, results, limitation: 'React synthetic DOM and SSR only; native smoke is separate' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
