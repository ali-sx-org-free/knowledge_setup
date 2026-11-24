import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copy } from '../web/assets/core.js';

for (const inDialog of [false, true]) {
  test(`HTTP 頁面沒有 Clipboard API 時仍可複製完整來源${inDialog ? '（對話框內）' : ''}`, async t => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    t.after(() => {
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else delete globalThis.document;
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
    });
    t.mock.method(globalThis, 'setTimeout', () => 0);
    const text = 'http://example.test/runs/ddl?version=1&table=order_sku#output';
    let area, removed = false, restored = false, parent;
    const toast = {};
    const body = { append: el => { parent = body; area = el; } };
    const dialog = { append: el => { parent = dialog; area = el; } };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      body,
      activeElement: { focus: opts => { assert.equal(opts.preventScroll, true); restored = true; } },
      getSelection: () => null,
      querySelector: s => s === '#toast' ? toast : inDialog ? dialog : null,
      createElement: tag => {
        assert.equal(tag, 'textarea');
        return { style: {}, select() { this.selected = true; }, remove() { removed = true; } };
      },
      execCommand: command => {
        assert.equal(command, 'copy');
        assert.equal(parent, inDialog ? dialog : body);
        assert.equal(area.value, text);
        assert.equal(area.selected, true);
        return true;
      }
    } });
    assert.equal(await copy(text), true);
    assert.equal(removed, true);
    assert.equal(restored, true);
    assert.equal(toast.hidden, false);
  });
}
