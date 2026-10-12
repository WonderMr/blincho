// Run unmodified TSX with installed React/ReactDOM, deterministic clocks and a
// small DOM boundary. This verifies behavior, not browser rendering or OS APIs.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { React, ReactDOMClient, ReactDOM, doc, DOMNode, transformer } = require('./support/syntheticDom.cjs');
const repo = path.resolve(__dirname, '..');

function harness(strictMode = true, canvasContext = null) {
  let now = 0, wallNow = 0, sequence = 0, chimes = 0;
  const timers = new Map(), frames = new Map(), modules = new Map(), events = new Map(), locks = [];
  const previousContext = DOMNode.prototype.getContext;
  DOMNode.prototype.getContext = () => canvasContext;
  const soundSynth = { enabled: true, playZenBowl() {}, playSoftBeep() {}, playCompletionChime() { chimes++; } };
  window.matchMedia = () => ({ matches: true });
  window.getComputedStyle = () => ({ getPropertyValue: () => '#9bc9ad' });
  window.electronAPI = { setStrictLock: value => locks.push(value), setAlwaysOnTop() {} };
  window.addEventListener = (name, callback) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); };
  window.removeEventListener = (name, callback) => events.get(name)?.delete(callback);
  const FakeDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : [wallNow])); }
    static now() { return wallNow; }
  };
  function load(file) {
    if(file.endsWith('.json'))return JSON.parse(fs.readFileSync(file,'utf8'));
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const transformed = transformer.transformSync(file, fs.readFileSync(file, 'utf8'), { jsx: { runtime: 'classic' } }).code;
    const exports = [...transformed.matchAll(/export\s+(?:const|function)\s+(\w+)/g)].map(match => match[1]);
    const source = transformed.replace(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/g, (_all, binding, name) => {
      const named = binding.match(/\{([\s\S]*?)\}/)?.[1], defaultName = binding.split(',')[0].trim();
      return (!defaultName.startsWith('{') ? `const ${defaultName}=require(${JSON.stringify(name)}).default ?? require(${JSON.stringify(name)});` : '') +
        (named ? `const {${named.replace(/\s+as\s+/g, ':')}}=require(${JSON.stringify(name)});` : '');
    }).replace(/export (const|function) /g, '$1 ') + `\nObject.assign(module.exports,{${exports.join(',')}});`;
    const requireLocal = name => {
      if (name === 'react') return React;
      if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
      if (name === 'canvas-confetti') return () => {};
      if (name.endsWith('/soundSynth')) return { soundSynth };
      const base = path.resolve(path.dirname(file), name);
      return load(path.extname(base) ? base : fs.existsSync(base + '.ts') ? base + '.ts' : base + '.tsx');
    };
    vm.runInNewContext(source, {
      module, require: requireLocal, console, Date: FakeDate, window, document: doc, HTMLElement: DOMNode,
      ResizeObserver: class { observe() {} disconnect() {} }, performance: { now: () => now },
      requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; }, cancelAnimationFrame: id => frames.delete(id),
      setInterval(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay, due: now + delay }); return id; },
      clearInterval: id => timers.delete(id),
    }, { filename: file });
    return module.exports;
  }
  const BreakOverlay = load(path.join(repo, 'src/components/BreakOverlay.tsx')).BreakOverlay;
  const ExercisePlayer = load(path.join(repo, 'src/components/ExercisePlayer.tsx')).ExercisePlayer;
  const TransientNotice = load(path.join(repo, 'src/components/TransientNotice.tsx')).TransientNotice;
  const host = doc.createElement('div'); doc.body.appendChild(host);
  const root = ReactDOMClient.createRoot(host);
  const render = element => ReactDOM.flushSync(() => root.render(strictMode ? React.createElement(React.StrictMode, null, element) : element));
  const all = predicate => { const found = []; const visit = node => { if (predicate(node)) found.push(node); node.childNodes.forEach(visit); }; visit(host); return found; };
  const button = title => all(node => node.tagName === 'BUTTON' && node.getAttribute('title') === title)[0];
  const click = node => { assert(node, 'button exists'); assert.equal(node.getAttribute('disabled'), null, 'button enabled'); const key = Object.keys(node).find(key => key.startsWith('__reactProps')); ReactDOM.flushSync(() => node[key].onClick()); };
  return {
    BreakOverlay, ExercisePlayer, TransientNotice, host, soundSynth, locks, render, button, click, all,
    i18n: load(path.join(repo, 'src/i18n/runtime.ts')), techniques: load(path.join(repo, 'src/data/medicalTechniques.ts')).MEDICAL_TECHNIQUES,
    get now() { return now; }, get wallNow() { return wallNow; }, get chimes() { return chimes; },
    shiftWall(milliseconds) { wallNow += milliseconds; },
    frame(milliseconds) { now += milliseconds; wallNow += milliseconds; const pending = [...frames]; frames.clear(); for (const [, callback] of pending) callback(now); },
    key(event) { ReactDOM.flushSync(() => { for (const callback of events.get('keydown') || []) callback({ target: doc.body, preventDefault() {}, ...event }); }); },
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        let selected;
        for (const [id, timer] of timers) if (timer.due <= target && (!selected || timer.due < selected[1].due)) selected = [id, timer];
        if (!selected) break;
        const [, timer] = selected; wallNow += timer.due - now; now = timer.due; timer.due += timer.delay;
        ReactDOM.flushSync(() => timer.callback());
      }
      wallNow += target - now; now = target;
    },
    jump(milliseconds) {
      now += milliseconds; wallNow += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.due > now || !timers.has(id)) continue;
        timer.due = now + timer.delay;
        ReactDOM.flushSync(() => timer.callback());
      }
    },
    destroy() { ReactDOM.flushSync(() => root.unmount()); doc.body.removeChild(host); DOMNode.prototype.getContext = previousContext; assert.equal(timers.size, 0, 'intervals cleaned up'); assert.equal(frames.size, 0, 'animation frames cleaned up'); },
  };
}
const technique = (id, durations = [2, 3, 4]) => ({
  id, title: id, categoryLabel: 'Test', badgeClass: '', clinicalMechanism: 'Test', scientificReference: 'https://example.test/source',
  steps: durations.map((durationSeconds, index) => ({ durationSeconds, instruction: `${id}-STEP-${index + 1}`, visualMode: 'zen-horizon' })),
});
const results = [];
function test(name, run) { run(); results.push(name); }

test('StrictMode break emits elapsed once without a return confirmation button', () => {
  const h = harness(), elapsed = []; let closed = 0;
  try {
    h.render(React.createElement(h.BreakOverlay, { initialSeconds: 2, onClose: () => closed++, onPostpone() {}, onOpenExercises() {}, onElapsed: deadline => elapsed.push([deadline, h.now]) }));
    h.advance(1999); assert.deepEqual(elapsed, []);
    h.advance(1); assert.deepEqual(elapsed, [[2000, 2000]]);
    assert.equal(h.all(node => node.tagName === 'BUTTON' && node.textContent.includes('Вернуться к работе')).length, 0,
      'the completed break must not require an extra return confirmation');
    h.advance(2000); assert.deepEqual(elapsed, [[2000, 2000]]); assert.equal(h.chimes, 1);
    assert.equal(closed, 0, 'elapsed owns completion; it must not also issue a cancel callback');
  } finally { h.destroy(); }
});
test('delayed break heartbeat publishes the original deadline rather than its late callback time', () => {
  const h = harness(), elapsed = [];
  h.render(React.createElement(h.BreakOverlay, { initialSeconds: 2, onClose() {}, onPostpone() {}, onOpenExercises() {},
    onElapsed: deadline => elapsed.push({ deadline, observedAt: h.now }) }));
  h.advance(1000); h.jump(5000);
  assert.deepEqual(elapsed, [{ deadline: 2000, observedAt: 6000 }]);
  h.advance(4000); assert.equal(elapsed.length, 1); assert.equal(h.chimes, 1); h.destroy();
});
test('wall-clock jumps neither shorten nor extend a break and its deadline stays monotonic', () => {
  for (const wallJump of [2500, -2500, 3600000, -3600000]) {
    const h = harness(), elapsed = [];
    try {
      h.advance(5000); h.shiftWall(86400000);
      h.render(React.createElement(h.BreakOverlay, { initialSeconds: 3, strictMode: true,
        onClose() {}, onPostpone() {}, onOpenExercises() {},
        onElapsed: deadline => elapsed.push({ deadline, observedAt: h.now }) }));
      h.advance(1000); h.shiftWall(wallJump);
      h.advance(1999); assert.deepEqual(elapsed, [], `wall jump ${wallJump} must not end the break early`);
      h.advance(1); assert.deepEqual(elapsed, [{ deadline: 8000, observedAt: 8000 }],
        `wall jump ${wallJump} must not extend the break or change its monotonic deadline`);
      assert.equal(h.wallNow, 86408000 + wallJump);
      h.advance(10000); assert.equal(elapsed.length, 1); assert.equal(h.chimes, 1);
    } finally { h.destroy(); }
  }
});
test('elapsed callback lets the parent dismiss the strict break automatically', () => {
  const h = harness(), elapsed = [];
  function Parent() {
    const [open, setOpen] = React.useState(true);
    return open ? React.createElement(h.BreakOverlay, { initialSeconds: 2, strictMode: true,
      onClose() {}, onPostpone() {}, onOpenExercises() {},
      onElapsed: deadline => { elapsed.push(deadline); setOpen(false); } }) : null;
  }
  h.render(React.createElement(Parent));
  h.advance(1999); assert.equal(h.host.querySelectorAll('[aria-modal="true"]').length, 1);
  h.advance(1); assert.deepEqual(elapsed, [2000]);
  assert.equal(h.host.querySelectorAll('[aria-modal="true"]').length, 0);
  h.advance(10000); assert.deepEqual(elapsed, [2000]); h.destroy();
});
test('changing strict setting preserves the active break deadline', () => {
  const h = harness(), elapsed = [];
  const render = strictMode => h.render(React.createElement(h.BreakOverlay, { initialSeconds: 3, strictMode, onClose() {}, onPostpone() {}, onOpenExercises() {}, onElapsed: deadline => elapsed.push(deadline) }));
  render(false); h.advance(1000); render(true); h.advance(1999); assert.deepEqual(elapsed, []);
  h.advance(1); assert.deepEqual(elapsed, [3000]); h.destroy();
});
test('strict break offers no close or postpone before its deadline', () => {
  const h = harness(); let closed = 0, postponed = 0;
  h.render(React.createElement(h.BreakOverlay, { initialSeconds: 3, strictMode: true,
    onClose: () => closed++, onPostpone: () => postponed++, onOpenExercises() {} }));
  h.advance(2000);
  assert.equal(h.button('Закрыть'), undefined);
  assert.equal(h.all(node => node.tagName === 'BUTTON' && node.textContent.includes('Отложить')).length, 0);
  assert(h.host.textContent.includes('Строгий режим активен'));
  assert.equal(closed, 0); assert.equal(postponed, 0); h.destroy();
});
test('early non-strict close and postpone cancel the elapsed callback on unmount', () => {
  for (const action of ['close', 'postpone']) {
    const h = harness(), elapsed = [], cancelled = [];
    function Parent() {
      const [open, setOpen] = React.useState(true);
      return open ? React.createElement(h.BreakOverlay, { initialSeconds: 3, strictMode: false,
        onClose: () => { cancelled.push('close'); setOpen(false); },
        onPostpone: minutes => { cancelled.push(minutes); setOpen(false); },
        onOpenExercises() {}, onElapsed: () => elapsed.push(h.now) }) : null;
    }
    h.render(React.createElement(Parent)); h.advance(1000);
    if (action === 'close') h.click(h.button('Закрыть'));
    else h.click(h.all(node => node.tagName === 'BUTTON' && node.textContent.includes('Отложить на 5 мин'))[0]);
    assert.deepEqual(cancelled, [action === 'close' ? 'close' : 5]);
    assert.equal(h.host.querySelectorAll('[aria-modal="true"]').length, 0);
    h.advance(10000); assert.deepEqual(elapsed, []); assert.equal(h.chimes, 0); h.destroy();
  }
});
test('StrictMode exercise executes every 2+3+4 second step and credits once', () => {
  const h = harness(), done = [], item = technique('single');
  h.render(React.createElement(h.ExercisePlayer, { technique: item, onClose() {}, onFinished: id => done.push([id, h.now]) }));
  h.advance(1999); assert(h.host.textContent.includes('single-STEP-1')); assert.deepEqual(done, []);
  h.advance(1); assert(h.host.textContent.includes('single-STEP-2'));
  h.advance(2999); assert(h.host.textContent.includes('single-STEP-2')); h.advance(1); assert(h.host.textContent.includes('single-STEP-3'));
  h.advance(3999); assert.deepEqual(done, []); h.advance(1); assert.deepEqual(done, [['single', 9000]]);
  h.advance(3000); assert.equal(done.length, 1); h.destroy();
});
test('multi-technique routine runs its entire queue and records each once', () => {
  const h = harness(), done = [], routine = [technique('first'), technique('second', [1, 2])];
  h.render(React.createElement(h.ExercisePlayer, { technique: routine[0], routine, onClose() {}, onFinished: id => done.push([id, h.now]) }));
  h.advance(9000); assert.deepEqual(done, [['first', 9000]]); assert(h.host.textContent.includes('second-STEP-1'));
  h.advance(2999); assert.equal(done.length, 1); h.advance(1); assert.deepEqual(done, [['first', 9000], ['second', 12000]]); h.destroy();
});
test('skipped technique earns no credit; next routine technique remains eligible', () => {
  const h = harness(), done = [], routine = [technique('skipped'), technique('valid', [1])];
  h.render(React.createElement(h.ExercisePlayer, { technique: routine[0], routine, onClose() {}, onFinished: id => done.push(id) }));
  h.click(h.button('Перейти к следующему шагу')); h.advance(7000); assert.deepEqual(done, []);
  h.advance(1000); assert.deepEqual(done, ['valid']); h.destroy();
});
test('player pause excludes paused time and local mute preserves global sound', () => {
  const h = harness(), done = [];
  h.render(React.createElement(h.ExercisePlayer, { technique: technique('pause', [2]), onClose() {}, onFinished: id => done.push([id, h.now]) }));
  h.advance(1000); h.click(h.button('Пауза / Продолжить (Пробел)')); h.advance(5000); assert.deepEqual(done, []);
  h.click(h.button('Отключить звук')); assert.equal(h.soundSynth.enabled, true);
  h.click(h.button('Пауза / Продолжить (Пробел)')); h.advance(999); assert.deepEqual(done, []); h.advance(1);
  assert.deepEqual(done, [['pause', 7000]]); assert.equal(h.chimes, 0); h.destroy(); assert.equal(h.soundSynth.enabled, true);
});
test('optional exercise can be aborted immediately without completion credit', () => {
  const h = harness(), credits = []; let closed = 0;
  h.render(React.createElement(h.ExercisePlayer, { technique: technique('abort', [2]), onClose: () => closed++, onFinished: id => credits.push(id) }));
  assert.equal(h.button('Закрыть').getAttribute('disabled'), null);
  h.click(h.button('Закрыть')); assert.equal(closed, 1);
  h.key({ code: 'Escape' }); assert.equal(closed, 2); assert.deepEqual(credits, []); h.destroy();
});
test('Space on focused interactive controls preserves player state', () => {
  const h = harness(), done = [];
  h.render(React.createElement(h.ExercisePlayer, { technique: technique('keyboard', [2]), onClose() {}, onFinished: id => done.push(id) }));
  h.key({ code: 'Space', target: h.button('Пауза / Продолжить (Пробел)') }); h.advance(2000); assert.deepEqual(done, ['keyboard']); h.destroy();
});
test('Canvas figure-eight direction follows each actual step metadata', () => {
  const arcs = [], context = new Proxy({ arc(...args) { arcs.push(args); }, createRadialGradient() { return { addColorStop() {} }; } }, { get(target, key) { return key in target ? target[key] : () => {}; } });
  const h = harness(true, context), item = technique('direction', [1, 1]);
  item.steps = item.steps.map((step, index) => ({ ...step, visualMode: 'dot-figure8', direction: index === 0 ? 1 : -1 }));
  h.render(React.createElement(h.ExercisePlayer, { technique: item, onClose() {} }));
  h.frame(100); const first = arcs.at(-1); assert(first[1] > 150, 'forward particle below center');
  h.advance(900); arcs.length = 0; h.frame(100); const reverse = arcs.at(-1); assert(reverse[1] < 150, 'reverse particle above center');
  assert.equal(Math.round(first[0]), Math.round(reverse[0]), 'same phase with opposite direction'); h.destroy();
});
test('Canvas near/far cues and saccade paths follow distinct step instructions', () => {
  function geometry() { const arcs = []; return { arcs, context: new Proxy({ arc(...args) { arcs.push(args); }, createRadialGradient() { return { addColorStop() {} }; } }, { get(target, key) { return key in target ? target[key] : () => {}; } }) }; }
  const focus = geometry(), h = harness(true, focus.context), item = technique('focus-cue', [1, 1]);
  item.steps = item.steps.map((step, index) => ({ ...step, visualMode: 'near-far', focus: index === 0 ? 'near' : 'far' }));
  h.render(React.createElement(h.ExercisePlayer, { technique: item, onClose() {} }));
  h.frame(100); const nearRadius = focus.arcs.at(-1)[2]; h.advance(900); h.frame(100); const farRadius = focus.arcs.at(-1)[2];
  assert(nearRadius > farRadius, 'near cue larger than far cue'); h.destroy();
  const path = geometry(), s = harness(true, path.context), targets = technique('saccades', [1, 1]);
  targets.steps = targets.steps.map((step, index) => ({ ...step, visualMode: 'dot-saccades', path: index === 0 ? 'horizontal' : 'diagonal' }));
  s.render(React.createElement(s.ExercisePlayer, { technique: targets, onClose() {} }));
  s.frame(100); const horizontal = path.arcs.at(-1); assert.equal(horizontal[1], 150, 'horizontal target remains on center horizontal axis');
  s.advance(900); s.frame(100); const diagonal = path.arcs.at(-1); assert.notEqual(diagonal[0], 200); assert.notEqual(diagonal[1], 150, 'diagonal target moves off both center axes'); s.destroy();
});
test('long visual cues are readable DOM captions and follow the current step', () => {
  const fillTextCalls = [], context = new Proxy({ fillText(...args) { fillTextCalls.push(args); }, createRadialGradient() { return { addColorStop() {} }; } }, { get(target, key) { return key in target ? target[key] : () => {}; } });
  const h = harness(true, context), item = technique('captions', [1, 1, 1, 1]);
  item.steps = [
    { ...item.steps[0], visualMode: 'blink' },
    { ...item.steps[1], visualMode: 'near-far', focus: 'far' },
    { ...item.steps[2], visualMode: 'near-far', focus: 'near' },
    { ...item.steps[3], visualMode: 'zen-horizon' },
  ];
  h.render(React.createElement(h.ExercisePlayer, { technique: item, onClose() {} }));
  const caption = () => h.all(node => node.getAttribute('id') === 'exercise-visual-caption')[0];
  assert.equal(caption().textContent, 'Мягко сомкните веки • Не сжимайте и не давите на глаза');
  assert.equal(h.all(node => node.tagName === 'CANVAS')[0].getAttribute('aria-describedby'), 'exercise-visual-caption');
  h.frame(100); h.advance(900); assert.equal(caption().textContent, 'Отведите взгляд от экрана вдаль');
  h.frame(100); h.advance(900); assert.equal(caption().textContent, 'Посмотрите на предмет рядом');
  h.frame(100); h.advance(900); assert.equal(caption().childNodes.length, 2); assert(caption().textContent.includes('Смотрите вдаль на расстояние 6+ метров'));
  h.frame(100); assert.deepEqual(fillTextCalls, [], 'long text is no longer painted into a fixed Canvas'); h.destroy();
});
test('short canvases keep the circle path and breathing label inside their bounds', () => {
  const previousBounds = DOMNode.prototype.getBoundingClientRect;
  DOMNode.prototype.getBoundingClientRect = function () { return this.tagName === 'CANVAS' ? { width: 400, height: 180, top: 0, left: 0, right: 400, bottom: 180 } : previousBounds.call(this); };
  try {
    const arcs = [], labels = [], context = new Proxy({ arc(...args) { arcs.push(args); }, fillText(...args) { labels.push(args); }, createRadialGradient() { return { addColorStop() {} }; } }, { get(target, key) { return key in target ? target[key] : () => {}; } });
    const h = harness(true, context), item = technique('short-canvas', [1, 1]);
    item.steps[0].visualMode = 'dot-circle'; item.steps[1].visualMode = 'palming';
    h.render(React.createElement(h.ExercisePlayer, { technique: item, onClose() {} }));
    h.frame(100); assert(arcs[0][1] - arcs[0][2] >= 0 && arcs[0][1] + arcs[0][2] <= 180, 'circle path fits the Canvas height');
    h.advance(900); h.frame(100); assert(labels.at(-1)[2] <= 160, 'breathing label has a visible bottom margin'); h.destroy();
  } finally { DOMNode.prototype.getBoundingClientRect = previousBounds; }
});
test('topmost modal traps Tab and restores its opener on close', () => {
  const h = harness(); const opener = doc.createElement('button'); doc.body.appendChild(opener); opener.focus();
  const overlay = React.createElement(h.BreakOverlay, { key: 'break', initialSeconds: 20, onClose() {}, onPostpone() {}, onOpenExercises() {} });
  h.render(overlay); const previous = doc.activeElement;
  h.render(React.createElement(React.Fragment, null, overlay, React.createElement(h.ExercisePlayer, { key: 'player', technique: technique('focus'), onClose() {} })));
  const dialogs = h.host.querySelectorAll('[aria-modal="true"]'), player = dialogs.at(-1);
  const controls = player.querySelectorAll('button:not([disabled])'); assert.equal(doc.activeElement, controls[0]);
  let prevented = 0; ReactDOM.flushSync(() => doc.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true, preventDefault() { prevented++; } }));
  assert.equal(doc.activeElement, controls.at(-1)); assert.equal(prevented, 1);
  h.render(overlay); assert.equal(doc.activeElement, previous); h.destroy(); assert.equal(doc.activeElement, opener); doc.body.removeChild(opener);
});

test('live language changes do not restart the break or exercise countdown', () => {
  const h = harness(); let elapsed = 0, finished = 0;
  try {
    h.render(React.createElement(h.BreakOverlay, {initialSeconds:3,onClose(){},onPostpone(){},onOpenExercises(){},onElapsed(){elapsed++;}}));
    h.advance(1000); ReactDOM.flushSync(() => h.i18n.setLanguagePreference('en')); h.advance(2000);
    assert.equal(elapsed,1);
    h.render(React.createElement(h.ExercisePlayer, {technique:technique('language-countdown',[3]),onClose(){},onFinished(){finished++;}}));
    h.advance(1000); ReactDOM.flushSync(() => h.i18n.setLanguagePreference('ja')); h.advance(2000);
    assert.equal(finished,1);
  } finally { ReactDOM.flushSync(() => h.i18n.setLanguagePreference('ru')); h.destroy(); }
});

test('all exercise badges and medical explanations follow the selected language', () => {
  const h = harness();
  try {
    for (const language of h.i18n.SUPPORTED_LANGUAGES) {
      ReactDOM.flushSync(() => h.i18n.setLanguagePreference(language.code));
      for (const item of h.techniques) {
        h.render(React.createElement(h.ExercisePlayer, { key: language.code + item.id, technique: item, onClose() {} }));
        const badge = h.all(node => node.getAttribute?.('class')?.includes('technique-badge'))[0];
        assert.equal(badge.textContent, h.i18n.t(item.categoryLabel), language.code + item.id);
        if (!['ru','uk'].includes(language.code)) assert(!/[А-Яа-яЁё]/.test(h.host.textContent), language.code + ': untranslated exercise text');
      }
    }
  } finally { ReactDOM.flushSync(() => h.i18n.setLanguagePreference('ru')); h.destroy(); }
});


const toastEvent = (h, name, event = {}) => {
  const node = h.all(node => node.getAttribute?.('class') === 'app-toast')[0];
  const props = node[Object.keys(node).find(key => key.startsWith('__reactProps'))];
  ReactDOM.flushSync(() => props[name]({currentTarget: node, ...event}));
};

test('notice counts down and disappears once after six visible seconds despite parent renders', () => {
  const h = harness(); let dismissed = 0;
  function Parent({revision}) {
    const [open, setOpen] = React.useState(true);
    return open ? React.createElement(h.TransientNotice, {message:'Активность возобновилась. Отсчёт продолжен.', durationMs:6000,
      onDismiss:() => { dismissed += revision; setOpen(false); }}) : null;
  }
  h.render(React.createElement(Parent, {revision:1}));
  assert(h.host.textContent.includes('Исчезнет через 6 с'));
  h.advance(3000); assert(h.host.textContent.includes('Исчезнет через 3 с'));
  h.render(React.createElement(Parent, {revision:2}));
  h.shiftWall(3600000); h.advance(2999); assert.equal(dismissed,0);
  h.advance(1); assert.equal(dismissed,2); assert.equal(h.host.textContent,'');
  h.advance(6000); assert.equal(dismissed,2); h.destroy();
});

test('hover and keyboard focus pause expiry until both leave the notice', () => {
  const h = harness(); let dismissed = 0;
  h.render(React.createElement(h.TransientNotice, {message:'Test',durationMs:6000,onDismiss:()=>dismissed++}));
  h.advance(2000); toastEvent(h,'onMouseEnter'); h.advance(10000);
  assert(h.host.textContent.includes('Исчезновение приостановлено')); assert.equal(dismissed,0);
  toastEvent(h,'onFocusCapture'); toastEvent(h,'onMouseLeave'); h.advance(10000); assert.equal(dismissed,0);
  const close=h.all(n=>n.tagName==='BUTTON')[0];
  toastEvent(h,'onBlurCapture',{relatedTarget:close}); h.advance(10000); assert.equal(dismissed,0);
  toastEvent(h,'onBlurCapture',{relatedTarget:null}); h.advance(3999); assert.equal(dismissed,0);
  h.advance(1); assert.equal(dismissed,1); h.destroy();
});

test('hidden document and app overlays preserve remaining notice reading time', () => {
  const h=harness(); let dismissed=0;
  const render=suspended=>h.render(React.createElement(h.TransientNotice,{message:'Test',durationMs:6000,suspended,onDismiss:()=>dismissed++}));
  try {
    render(false); h.advance(1000);
    doc.visibilityState='hidden'; ReactDOM.flushSync(()=>doc.dispatchEvent({type:'visibilitychange'}));
    h.advance(10000); assert.equal(dismissed,0);
    doc.visibilityState='visible'; ReactDOM.flushSync(()=>doc.dispatchEvent({type:'visibilitychange'}));
    h.advance(1000); render(true); h.advance(10000); assert.equal(dismissed,0);
    assert.equal(h.all(n=>n.getAttribute?.('class')==='app-toast')[0].getAttribute('hidden'),'');
    render(false); h.advance(3999); assert.equal(dismissed,0); h.advance(1); assert.equal(dismissed,1);
  } finally { doc.visibilityState='visible'; h.destroy(); }
});

test('repeated notification text receives a fresh deadline and an old timer cannot dismiss it', () => {
  const h=harness(), dismissed=[];
  const render=id=>h.render(React.createElement(h.TransientNotice,{key:id,message:'Same message',durationMs:6000,onDismiss:()=>dismissed.push(id)}));
  render(1); h.advance(5000); render(2); h.advance(1000); assert.deepEqual(dismissed,[]);
  assert(h.host.textContent.includes('Исчезнет через 5 с'));
  h.advance(5000); assert.deepEqual(dismissed,[2]); h.destroy();
});

test('undo notice lasts fifteen seconds and close remains immediately available', () => {
  const h=harness(); let dismissed=0,undone=0;
  function Parent(){const[open,setOpen]=React.useState(true);return open?React.createElement(h.TransientNotice,{message:'Reset',durationMs:15000,onUndo:()=>undone++,onDismiss:()=>{dismissed++;setOpen(false);}}):null;}
  h.render(React.createElement(Parent)); h.advance(6000); assert.equal(dismissed,0);
  h.click(h.button('Восстановить прежний отсчет времени')); assert.equal(undone,1);
  h.advance(8999); assert.equal(dismissed,0); h.advance(1); assert.equal(dismissed,1);
  h.render(React.createElement(Parent,{key:'fresh'}));
  h.click(h.all(n=>n.tagName==='BUTTON'&&n.getAttribute('aria-label')==='Закрыть сообщение')[0]);
  assert.equal(h.host.textContent,''); h.advance(20000); assert.equal(dismissed,2); h.destroy();
});

console.log(JSON.stringify({ passed: results.length, results, limitation: 'Real React/ReactDOM and synthetic DOM; no browser layout, Canvas visual QA or Electron E2E' }, null, 2));
