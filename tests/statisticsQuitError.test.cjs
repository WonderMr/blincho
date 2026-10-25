const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderToStaticMarkup } = require('react-dom/server');
const { React, ReactDOMClient, ReactDOM, doc, DOMNode, transformer } = require('./support/syntheticDom.cjs');
const repo = path.resolve(__dirname, '..');

function component(t = value => value) {
  function source(relative, exports) {
    const file = path.join(repo, relative);
    return transformer.transformSync(file, fs.readFileSync(file, 'utf8'), { jsx: { runtime: 'classic' } }).code
      .replace(/^import .*;\r?\n/gm, '').replace(/\bexport function /g, 'function ') +
      `\nmodule.exports={${exports}};`;
  }
  const context = { React, useRef: React.useRef, useState: React.useState, useEffect: React.useEffect,
    useI18n: () => ({ t }), document: doc, HTMLElement: DOMNode, console: { warn() {} }, module: { exports: {} } };
  vm.runInNewContext(source('src/utils/useModalFocus.ts', 'useModalFocus'), context);
  context.useModalFocus = context.module.exports.useModalFocus; context.module = { exports: {} };
  vm.runInNewContext(source('src/components/StatisticsQuitError.tsx', 'StatisticsQuitError'), context);
  return context.module.exports.StatisticsQuitError;
}
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); ReactDOM.flushSync(() => {}); };
function mount(props) {
  const opener = doc.createElement('button'); doc.body.appendChild(opener); opener.focus();
  const host = doc.createElement('div'); doc.body.appendChild(host);
  const root = ReactDOMClient.createRoot(host), Component = component();
  ReactDOM.flushSync(() => root.render(React.createElement(Component, props)));
  return { host, opener, buttons: () => host.querySelectorAll('button'),
    click(index) { const button = this.buttons()[index]; const reactProps = button[Object.keys(button).find(key => key.startsWith('__reactProps'))]; ReactDOM.flushSync(() => reactProps.onClick()); },
    destroy() { ReactDOM.flushSync(() => root.unmount()); doc.body.removeChild(host); doc.body.removeChild(opener); },
  };
}

test('failed-save dialog defaults to Retry, blocks duplicate actions, retains failure and supports cancellation', async () => {
  let rejectSave, saves = 0, discards = 0, cancels = 0;
  const h = mount({ onRetry: () => { saves++; return new Promise((_, reject) => { rejectSave = reject; }); },
    onDiscard: async () => { discards++; }, onCancel: () => { cancels++; } });
  try {
    assert.equal(h.host.querySelector('[role="alertdialog"]').getAttribute('aria-modal'), 'true');
    assert.equal(doc.activeElement, h.buttons()[0]); assert.equal(discards, 0);
    h.click(0); h.click(0); assert.equal(saves, 1); assert(h.buttons().every(button => button.disabled || button.getAttribute('disabled') !== null));
    rejectSave(Error('disk still full')); await settle();
    assert(h.host.textContent.includes('последние несохранённые изменения будут потеряны'));
    assert(h.buttons().every(button => !button.disabled && button.getAttribute('disabled') === null));
    h.click(2); assert.equal(cancels, 1); assert.equal(discards, 0);
  } finally { h.destroy(); }
});

test('discard is invoked only by its explicit button', async () => {
  let saves = 0, discards = 0;
  const h = mount({ onRetry: async () => { saves++; }, onDiscard: async () => { discards++; }, onCancel() {} });
  try { assert.equal(discards, 0); h.click(1); await settle(); assert.equal(discards, 1); assert.equal(saves, 0); }
  finally { h.destroy(); }
});

test('save failure and exit choices render in every supported language', () => {
  for (const name of fs.readdirSync(path.join(repo, 'src/i18n/locales')).filter(name => name.endsWith('.json'))) {
    const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'src/i18n/locales', name), 'utf8'));
    const Component = component(key => { assert.equal(typeof catalog[key], 'string', `${name}: ${key}`); return catalog[key]; });
    const html = renderToStaticMarkup(React.createElement(Component, { onRetry: async () => {}, onDiscard: async () => {}, onCancel() {} }));
    assert(html.includes('role="alertdialog"')); assert(!/[\u2014\u2015]|\s\u2013\s/.test(html));
    if (!['ru.json', 'uk.json'].includes(name)) assert(!/[\u0400-\u04ff]/.test(html), name);
  }
});
