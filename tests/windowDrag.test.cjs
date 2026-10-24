const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-window-drag-'));
const config = path.join(output, 'tsconfig.json');
fs.writeFileSync(config, JSON.stringify({ files: [path.join(repo, 'src/utils/windowDrag.ts')], compilerOptions: {
  target: 'ES2022', module: 'commonjs', rootDir: path.join(repo, 'src/utils'), outDir: output, skipLibCheck: true, strict: true
} }));
execFileSync(process.execPath, [path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'), '-p', config], { stdio: 'inherit' });
const { shouldStartWindowDrag, installWindowDrag } = require(path.join(output, 'windowDrag.js'));
after(() => fs.rmSync(output, { recursive: true, force: true }));

// Mock the DOM boundary with element ancestry, text rectangles and scroll metrics.
// The utility itself, its event handler and native callback run unchanged.
function fixture() {
  const listeners = new Map();
  const doc = {
    defaultView: { innerWidth: 200, innerHeight: 200, getComputedStyle: element => ({ userSelect: 'text', cursor: 'auto', overflowX: 'visible', overflowY: 'visible', direction: 'ltr', ...element.style }) },
    getSelection: () => ({ isCollapsed: true }),
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type); },
    createTreeWalker(element) {
      const texts = [];
      const visit = node => { for (const child of node.childNodes) child.nodeType === 3 ? texts.push(child) : visit(child); };
      visit(element); let index = 0;
      return { nextNode: () => texts[index++] ?? null };
    },
    createRange() { let text; return { selectNodeContents(node) { text = node; }, getClientRects: () => text.rects }; },
    dispatch(event) { listeners.get('mousedown')?.(event); }
  };
  function element(tag = 'div', attributes = {}, parent = null) {
    const node = {
      tagName: tag.toUpperCase(), nodeType: 1, ownerDocument: doc, parentElement: parent, childNodes: [], style: {},
      offsetWidth: 200, offsetHeight: 200, clientWidth: 200, clientHeight: 200, clientLeft: 0, clientTop: 0,
      scrollWidth: 200, scrollHeight: 200,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200 }),
      getAttribute: name => attributes[name] ?? null,
      matches(selector) {
        return selector.split(',').some(part => {
          const value = part.trim();
          if (value.startsWith('.')) return (attributes.class ?? '').split(' ').includes(value.slice(1));
          const attribute = value.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
          if (attribute) return attributes[attribute[1]] !== undefined && (attribute[2] === undefined || attributes[attribute[1]] === attribute[2]);
          return value.toUpperCase() === this.tagName;
        });
      },
      closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    };
    parent?.childNodes.push(node);
    return node;
  }
  const html = element('html'); doc.documentElement = html;
  const app = element('div', { class: 'app-container' }, html);
  const main = element('main', { class: 'main-content' }, app);
  const sidebar = element('nav', { class: 'nav-bar' }, app);
  function text(parent, content, rects = [{ left: 20, right: 140, top: 20, bottom: 40 }]) {
    const node = { nodeType: 3, textContent: content, parentElement: parent, rects };
    parent.childNodes.push(node); return node;
  }
  function event(target = main, overrides = {}) {
    return { target, button: 0, clientX: 100, clientY: 100, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...overrides };
  }
  return { doc, element, app, main, sidebar, html, text, event, listeners };
}

test('free main, sidebar and nested card space can drag, outside app cannot', () => {
  const f = fixture();
  for (const target of [f.app, f.main, f.sidebar, f.element('section', {}, f.main)]) assert(shouldStartWindowDrag(f.event(target)));
  assert.equal(shouldStartWindowDrag(f.event(f.element('aside'))), false);
  assert.equal(shouldStartWindowDrag(f.event(null)), false);
  f.doc.defaultView = null;
  assert.equal(shouldStartWindowDrag(f.event(f.main)), false, 'detached documents cannot start native drag');
});

test('only an unmodified, unclaimed primary mouse press can drag', () => {
  const f = fixture();
  for (const overrides of [{ button: 1 }, { button: 2 }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { defaultPrevented: true }]) {
    assert.equal(shouldStartWindowDrag(f.event(f.main, overrides)), false, JSON.stringify(overrides));
  }
});

test('controls, disabled controls, SVG control descendants and explicit exclusions cannot drag', () => {
  const f = fixture();
  for (const tag of ['button', 'input', 'select', 'textarea', 'a', 'label', 'summary', 'audio', 'video', 'iframe']) {
    const control = f.element(tag, { disabled: '' }, f.main);
    assert.equal(shouldStartWindowDrag(f.event(control)), false, tag);
    assert.equal(shouldStartWindowDrag(f.event(f.element('path', {}, f.element('svg', {}, control)))), false, `${tag} SVG child`);
  }
  for (const attributes of [{ role: 'button' }, { role: 'slider' }, { role: 'tab' }, { tabindex: '0' }, { contenteditable: '' },
    { contenteditable: 'true' }, { draggable: 'true' }, { 'aria-disabled': 'true' }, { class: 'no-drag' }, { 'data-no-drag': '' }]) {
    assert.equal(shouldStartWindowDrag(f.event(f.element('div', attributes, f.main))), false, JSON.stringify(attributes));
  }
  const customControl = f.element('div', {}, f.main); customControl.style.cursor = 'pointer';
  assert.equal(shouldStartWindowDrag(f.event(customControl)), false);
});

test('settings, exercise, break and notification overlay space keeps normal pointer behavior', () => {
  const f = fixture();
  for (const attributes of [{ class: 'modal-backdrop' }, { class: 'exercise-modal-overlay' }, { class: 'fullscreen-break-takeover' },
    { class: 'app-toast' }, { role: 'dialog' }, { role: 'alertdialog' }, { 'aria-modal': 'true' }]) {
    const overlay = f.element('div', attributes, f.app);
    assert.equal(shouldStartWindowDrag(f.event(f.element('div', {}, overlay))), false, JSON.stringify(attributes));
  }
});

test('text remains selectable while empty padding and gaps remain draggable', () => {
  const f = fixture();
  const paragraph = f.element('p', {}, f.main); f.text(paragraph, 'Selectable label');
  assert.equal(shouldStartWindowDrag(f.event(paragraph, { clientX: 30, clientY: 30 })), false);
  assert.equal(shouldStartWindowDrag(f.event(paragraph.childNodes[0], { clientX: 30, clientY: 30 })), false);
  assert(shouldStartWindowDrag(f.event(paragraph, { clientX: 30, clientY: 70 })));
  // A child with pointer-events:none makes its parent the event target.
  assert.equal(shouldStartWindowDrag(f.event(f.main, { clientX: 30, clientY: 30 })), false);
  paragraph.style.userSelect = 'none';
  assert(shouldStartWindowDrag(f.event(paragraph, { clientX: 30, clientY: 30 })));
  f.doc.getSelection = () => ({ isCollapsed: false });
  assert(shouldStartWindowDrag(f.event(f.main)), 'selected text must not block dragging empty space');
  paragraph.style.userSelect = 'text';
  assert.equal(shouldStartWindowDrag(f.event(paragraph, { clientX: 30, clientY: 30 })), false, 'selected text keeps its normal interaction');
  const titlebar = f.element('div', { class: 'mac-titlebar-drag' }, f.app);
  f.text(titlebar, 'Blincho');
  assert(shouldStartWindowDrag(f.event(titlebar, { clientX: 30, clientY: 30 })), 'selected text must not block the titlebar');
});

test('classic, horizontal, overlay, ancestor and RTL scrollbar gutters cannot drag', () => {
  const f = fixture();
  f.main.style.overflowY = 'auto'; f.main.scrollHeight = 500; f.main.clientWidth = 184;
  assert.equal(shouldStartWindowDrag(f.event(f.main, { clientX: 190 })), false);
  assert(shouldStartWindowDrag(f.event(f.main, { clientX: 170 })));
  f.main.clientWidth = 200; // overlay scrollbar reserves no client width
  assert.equal(shouldStartWindowDrag(f.event(f.main, { clientX: 196 })), false);
  f.main.style.direction = 'rtl';
  assert.equal(shouldStartWindowDrag(f.event(f.main, { clientX: 4 })), false);
  f.main.style.direction = 'ltr'; f.main.style.overflowX = 'scroll'; f.main.scrollWidth = 400;
  assert.equal(shouldStartWindowDrag(f.event(f.element('div', {}, f.main), { clientY: 196 })), false);
  f.html.style.overflowY = 'auto'; f.html.scrollHeight = 600;
  assert.equal(shouldStartWindowDrag(f.event(f.sidebar, { clientX: 196 })), false);
  f.html.style.overflowX = 'auto'; f.html.scrollWidth = 600;
  f.html.getBoundingClientRect = () => ({ left: -100, right: 100, top: -100, bottom: 100, width: 200, height: 200 });
  assert.equal(shouldStartWindowDrag(f.event(f.sidebar, { clientY: 196 })), false, 'document scrollbar stays at viewport edge after page scroll');
});

test('existing titlebar still drags over its title, with controls and modifiers excluded', () => {
  const f = fixture();
  const titlebar = f.element('div', { class: 'mac-titlebar-drag' }, f.app);
  const title = f.element('span', {}, titlebar); f.text(title, 'Blincho');
  assert(shouldStartWindowDrag(f.event(title, { clientX: 30, clientY: 30 })));
  assert.equal(shouldStartWindowDrag(f.event(f.element('button', {}, titlebar))), false);
  assert.equal(shouldStartWindowDrag(f.event(title, { metaKey: true })), false);
});

test('native callback is immediate and unique, controls are untouched, cleanup removes listener', async () => {
  const f = fixture(); let calls = 0;
  const cleanup = installWindowDrag(f.doc, () => { calls++; return Promise.resolve(); });
  const press = f.event(); f.doc.dispatch(press);
  assert.equal(calls, 1); assert(press.defaultPrevented);
  const control = f.event(f.element('button', {}, f.main)); f.doc.dispatch(control);
  assert.equal(calls, 1); assert.equal(control.defaultPrevented, false);
  cleanup(); f.doc.dispatch(f.event()); assert.equal(calls, 1);
});

test('synchronous and asynchronous native failures are reported without escaping the listener', async () => {
  for (const asynchronous of [false, true]) {
    const f = fixture(), failure = new Error('drag unavailable'), errors = [];
    installWindowDrag(f.doc, () => { if (asynchronous) return Promise.reject(failure); throw failure; }, error => errors.push(error));
    assert.doesNotThrow(() => f.doc.dispatch(f.event())); await Promise.resolve();
    assert.deepEqual(errors, [failure]);
  }
});

test('bridge installs free-area drag only inside Tauri initialization', () => {
  const bridge = fs.readFileSync(path.join(repo, 'src/utils/tauriBridge.ts'), 'utf8');
  assert.match(bridge, /if \(!window\.__TAURI__\) return Promise\.resolve\(\);/);
  assert.match(bridge, /installWindowDrag\(document, \(\) => api\.window\.getCurrentWindow\(\)\.startDragging\(\)\)/);
  const css = fs.readFileSync(path.join(repo, 'src/index.css'), 'utf8');
  assert.doesNotMatch(css, /-webkit-app-region/);
});
