// Real React interactions in a synthetic DOM; no browser layout or native keyboard dispatch claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { React, ReactDOMClient, ReactDOM, doc, DOMNode, transformer } = require('./support/syntheticDom.cjs');
const repo = path.resolve(__dirname, '..');
const cache = new Map(), store = new Map(), scrolls = [];
const resultKey = 'myeyes_cvs_result_v1';
let blocked = false;
const localStorage = {
  getItem: key => store.get(key) ?? null,
  setItem(key, value) {
    if (blocked && key === resultKey) throw new Error('Storage is blocked');
    store.set(key, value);
  },
};
window.localStorage = localStorage;
localStorage.setItem('blincho-language-v1', JSON.stringify({ preference: 'ru', acknowledged: true }));
DOMNode.prototype.scrollIntoView = function (options) { scrolls.push({ node: this, options }); };
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
  const requireLocal = name => name === 'react' ? React : name === 'lucide-react' ? new Proxy({}, { get: () => () => null }) :
    name.startsWith('.') ? load(path.relative(repo, path.resolve(path.dirname(file), name) +
      (path.extname(name) ? '' : fs.existsSync(path.resolve(path.dirname(file), name) + '.ts') ? '.ts' : '.tsx'))) : require(name);
  vm.runInNewContext(source, { module, require: requireLocal, console, window, document: doc, HTMLElement: DOMNode, localStorage }, { filename: file });
  return module.exports;
}
const { CVSSurvey, calculateSymptomResult } = load('src/components/CVSSurvey.tsx');
const { CVS_SURVEY_QUESTIONS: questions } = load('src/data/cvsQuestions.ts');
const { saveCVSResult, loadCVSResult, getTodayDateString } = load('src/utils/storage.ts');
const i18n = load('src/i18n/runtime.ts');
const props = node => node?.[Object.keys(node).find(key => key.startsWith('__reactProps'))];
const invoke = (node, name, event) => { assert(node, 'control exists'); ReactDOM.flushSync(() => props(node)[name](event)); };
const plain = value => JSON.parse(JSON.stringify(value));
function mount() {
  const host = doc.createElement('div'); doc.body.appendChild(host);
  const root = ReactDOMClient.createRoot(host), callbacks = [];
  const onResult = result => callbacks.push(result);
  const render = () => ReactDOM.flushSync(() => root.render(React.createElement(CVSSurvey, { onResult })));
  render();
  // The synthetic selector engine handles tags/attributes, so use explicit descendants.
  const button = label => host.querySelectorAll('button').find(node => node.textContent.includes(label));
  const choiceButtons = () => host.querySelectorAll('button').filter(node => props(node).className?.includes('survey-radio-btn'));
  const answer = (index, score) => invoke(choiceButtons()[index * 4 + score], 'onClick');
  const fill = values => values.forEach((score, index) => answer(index, score));
  const submit = () => {
    const form = host.querySelector('form');
    if (form) invoke(form, 'onSubmit', { preventDefault() {} });
    else invoke(button(i18n.t('Сохранить ответы')), 'onClick');
  };
  return { host, callbacks, button, choiceButtons, answer, fill, submit, render,
    close() { ReactDOM.flushSync(() => root.unmount()); doc.body.removeChild(host); } };
}
test.beforeEach(() => {
  store.delete(resultKey); blocked = false; scrolls.length = 0;
  ReactDOM.flushSync(() => i18n.setLanguagePreference('ru'));
});

test('successful save replaces the completed form with a focused visible summary and persists each answer', () => {
  const h = mount();
  try {
    const values = [0, 1, 2, 3, 1, 2];
    h.fill(values); h.submit();
    assert.equal(h.choiceButtons().length, 0, 'completed questions must leave the screen');
    assert.equal(h.button(i18n.t('Сохранить ответы')), undefined);
    const saved = JSON.parse(store.get(resultKey));
    assert.deepEqual(saved.answers, Object.fromEntries(questions.map((q, index) => [q.id, values[index]])));
    assert.equal(saved.score, 9); assert.equal(saved.level, 'self-check');
    assert.equal(saved.date, getTodayDateString());
    assert.equal(h.callbacks.length, 1);
    const summary = h.host.querySelector('[aria-labelledby="survey-result-title"]');
    assert(summary); assert.equal(doc.activeElement, summary); assert.equal(summary.getAttribute('tabindex'), '-1');
    assert.equal(scrolls.at(-1).node, summary);
    assert(summary.textContent.includes(i18n.t('Ответы сохранены')));
    assert(summary.textContent.includes(i18n.formatDate(saved.date)));
    assert.equal(summary.querySelectorAll('dt').length, 6);
    assert.deepEqual(summary.querySelectorAll('dd').map(node => node.textContent), values.map((score, index) => i18n.t(questions[index].options[score].label)));
  } finally { h.close(); }
});

test('saved answer summary survives remount; retake starts a fresh keyboard-submittable form', () => {
  let h = mount();
  try {
    h.fill([3, 2, 1, 0, 3, 2]); h.submit();
    const saved = store.get(resultKey);
    h.close(); h = mount();
    assert.equal(h.choiceButtons().length, 0);
    assert.equal(h.host.querySelectorAll('dd').length, 6);
    assert.equal(h.host.querySelectorAll('dd')[0].textContent, i18n.t(questions[0].options[3].label));
    assert.equal(h.host.querySelector('[id="survey-result-title"]').textContent, i18n.t('Самопроверка симптомов'), 'reopened result does not claim a new save');
    invoke(h.button(i18n.t('Пройти повторно')), 'onClick', { detail: 0 });
    assert.equal(h.host.querySelector('[aria-labelledby="survey-result-title"]'), null);
    assert.equal(h.choiceButtons().length, 24);
    assert(h.choiceButtons().every(node => node.getAttribute('aria-pressed') === 'false'));
    assert.equal(scrolls.at(-1).node, doc.activeElement);
    assert.equal(doc.activeElement.getAttribute('id'), `survey-question-${questions[0].id}`);
    for (const question of questions) {
      const group = h.host.querySelector(`[aria-describedby="survey-explanation-${question.id}"]`);
      assert.equal(group.getAttribute('role'), 'group');
      assert.equal(group.getAttribute('aria-labelledby'), `survey-question-${question.id}`);
      assert(h.host.querySelector(`[id="survey-explanation-${question.id}"]`));
    }
    assert.equal(store.get(resultKey), saved, 'retake must preserve the prior persisted result until a replacement saves');
    h.fill([0, 0, 0, 0, 0, 0]);
    const submit = h.button(i18n.t('Сохранить ответы'));
    assert.equal(submit.tagName, 'BUTTON'); assert.equal(submit.getAttribute('type'), 'submit');
    assert(h.choiceButtons().every(node => node.getAttribute('type') === 'button'));
    submit.focus(); h.submit(); // Native form submit is shared by Enter/Space and pointer activation.
    assert.equal(doc.activeElement, h.host.querySelector('[aria-labelledby="survey-result-title"]'));
    assert.equal(JSON.parse(store.get(resultKey)).score, 0);
  } finally { h.close(); }
});

test('blocked storage reports failure, retains editable selections and never calls onResult until retry succeeds', () => {
  const h = mount();
  try {
    h.fill([1, 1, 1, 1, 1, 1]); blocked = true; h.submit();
    assert.equal(h.callbacks.length, 0); assert.equal(store.has(resultKey), false);
    assert.equal(h.host.querySelector('[aria-labelledby="survey-result-title"]'), null);
    assert.equal(h.choiceButtons().filter(node => node.getAttribute('aria-pressed') === 'true').length, 6);
    assert(h.host.querySelector('[role="alert"]').textContent.includes(i18n.t('Не удалось сохранить ответы. Они остались в форме. Попробуйте ещё раз.')));
    h.answer(0, 3); blocked = false; h.submit();
    assert.equal(h.callbacks.length, 1); assert.equal(JSON.parse(store.get(resultKey)).answers[questions[0].id], 3);
  } finally { h.close(); }
});

test('legacy results remain available with neutral wording and no fabricated detailed answers', () => {
  store.set(resultKey, JSON.stringify({ score: 12, maxScore: 18, level: 'high', title: 'Old diagnosis', recommendations: ['Old treatment'], date: '2026-01-02' }));
  const h = mount();
  try {
    assert.equal(h.choiceButtons().length, 0); assert.equal(h.host.querySelectorAll('dd').length, 0);
    assert(h.host.textContent.includes(i18n.t('Подробные ответы для этого результата не сохранены. Пройдите опрос повторно, чтобы сохранить их.')));
    assert(!h.host.textContent.includes('Old diagnosis')); assert(!h.host.textContent.includes('Old treatment'));
    assert.equal(h.callbacks[0].level, 'self-check'); assert.equal(h.callbacks[0].score, 12);
    assert(h.host.textContent.includes(i18n.formatDate('2026-01-02')));
  } finally { h.close(); }
});

test('locale changes preserve in-progress and saved answers while translating current questions and frequencies', () => {
  const h = mount();
  try {
    h.fill([2, 1, 0, 3, 2, 1]);
    ReactDOM.flushSync(() => i18n.setLanguagePreference('en'));
    assert.equal(h.choiceButtons().filter(node => node.getAttribute('aria-pressed') === 'true').length, 6);
    assert(h.host.textContent.includes(i18n.t(questions[0].question)));
    h.submit();
    const saved = store.get(resultKey);
    ReactDOM.flushSync(() => i18n.setLanguagePreference('ar'));
    assert.equal(store.get(resultKey), saved);
    assert.equal(h.host.querySelectorAll('dd')[0].textContent, i18n.t(questions[0].options[2].label));
    assert.equal(doc.documentElement.dir, 'rtl'); assert.equal(h.choiceButtons().length, 0);
    invoke(h.button(i18n.t('Пройти повторно')), 'onClick'); h.answer(0, 1);
    ReactDOM.flushSync(() => i18n.setLanguagePreference('ru'));
    assert.equal(h.choiceButtons()[1].getAttribute('aria-pressed'), 'true', 'locale change during retake must not restore the prior result');
  } finally { h.close(); }
});

test('storage returns an explicit success flag, filters malformed optional answers and accepts old records', () => {
  const values = Object.fromEntries(questions.map(q => [q.id, 2]));
  const result = calculateSymptomResult({ ...values, foreign: 1000 }, '2026-01-02');
  assert.deepEqual(plain(result.answers), values, 'foreign answer keys are not persisted');
  assert.equal(saveCVSResult(result), true); assert.deepEqual(plain(loadCVSResult().answers), values);
  blocked = true; assert.equal(saveCVSResult({ ...result, score: 0 }), false);
  assert.equal(loadCVSResult().score, 12, 'failed write preserves previous result');
  blocked = false;
  for (const invalid of [null, [], 7, 'invalid', { dryness: 2 }, { ...values, dryness: -1 }, { ...values, dryness: '2' }]) {
    store.set(resultKey, JSON.stringify({ ...result, answers: invalid }));
    const loaded = loadCVSResult();
    assert(loaded); assert.equal(loaded.score, 12); assert.equal(loaded.answers, undefined);
  }
});
