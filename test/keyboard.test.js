import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { installKeys, setPageKeys, setSingleKeys, keyLabel } from '../web/assets/keys.js';

const originalDocument = globalThis.document;
let dispatch;
let dialogOpen = false;
globalThis.document = {
  querySelector: () => ({ open: dialogOpen }),
  addEventListener: (name, fn) => { assert.equal(name, 'keydown'); dispatch = fn; }
};
installKeys();
after(() => { globalThis.document = originalDocument; });

const target = (tagName, type) => ({ closest: () => tagName ? { tagName, type } : null });
function press(key, extra = {}) {
  const event = { key, target: target(), defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
  dispatch(event);
  return event;
}

test('空格可綁定且攔截頁面捲動；X 與空格使用同一個選擇操作', () => {
  let count = 0;
  setPageKeys([{ keys: 'x,Space', run: () => count++ }]);
  for (const key of [' ', 'Spacebar', 'x']) assert.equal(press(key).defaultPrevented, true);
  assert.equal(count, 3);
  assert.ok(keyLabel('Space').trim());
});

test('Shift 方向鍵與普通方向鍵分開，連選不會退化成移動', () => {
  const calls = [];
  setPageKeys([
    { keys: 'j,ArrowDown', run: () => calls.push('move') },
    { keys: 'shift+j,shift+ArrowDown', run: () => calls.push('extend') },
    { keys: '?', run: () => calls.push('help') }
  ]);
  press('ArrowDown'); press('ArrowDown', { shiftKey: true }); press('J', { shiftKey: true }); press('?', { shiftKey: true });
  assert.deepEqual(calls, ['move', 'extend', 'extend', 'help']);
});

test('輸入、輸入法組字、對話框及關閉單鍵快捷鍵時不觸發列表選擇', () => {
  let count = 0;
  setPageKeys([{ keys: 'Space', run: () => count++ }]);
  for (const t of [target('INPUT', 'search'), target('TEXTAREA'), target('SELECT'), target('DIV')]) {
    assert.equal(press(' ', { target: t }).defaultPrevented, false);
  }
  assert.equal(press(' ', { isComposing: true }).defaultPrevented, false);
  dialogOpen = true;
  assert.equal(press(' ').defaultPrevented, false);
  dialogOpen = false;
  setSingleKeys(false);
  assert.equal(press(' ').defaultPrevented, false);
  setSingleKeys(true);
  assert.equal(count, 0);
});

test('點過勾選框後仍能使用 J/K，重複按鍵資訊傳給選擇處理器', () => {
  let moves = 0;
  const repeats = [];
  setPageKeys([
    { keys: 'j,k', run: () => moves++ },
    { keys: 'Space', run: e => repeats.push(!!e.repeat) }
  ]);
  press('j', { target: target('INPUT', 'checkbox') });
  press('k', { target: target('INPUT', 'checkbox') });
  press(' '); press(' ', { repeat: true });
  assert.equal(moves, 2);
  assert.deepEqual(repeats, [false, true]);
});
