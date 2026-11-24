// 快捷鍵：全後台與當前頁面的按鍵註冊、分發、`g` 再按字母前往頁面、`?` 說明（設計 §9.1）。
//   單鍵快捷鍵在輸入框和對話框中不生效；「設定 › 帳號」可以關閉單鍵快捷鍵（只保留帶 ⌘ / Ctrl 的）。
//   按鍵寫法：'j'、'shift+j'、'mod+a'（⌘ 或 Ctrl）、'Enter'、'Escape'、'ArrowDown'、'?'、'['。
import { $, esc, modal } from './core.js';
import { t } from './i18n.js';

const GLOBAL = [];
let page = [];
let singleKeys = true;
let pendingG = 0;
const GO = [];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export const modLabel = isMac ? '⌘' : 'Ctrl';
/** 'mod+a' → '⌘A'；顯示在按鈕和說明中。 */
export const keyLabel = k => k.split(' ').map(part => part.split('+').map(x => ({ mod: modLabel, shift: '⇧', alt: isMac ? '⌥' : 'Alt', Space: t('空格'), Enter: 'Enter', Escape: 'Esc', ArrowDown: '↓', ArrowUp: '↑' }[x] || (x.length === 1 ? x.toUpperCase() : x))).join(isMac ? '' : '+')).join(' ');
export const kbd = k => `<kbd>${esc(keyLabel(k))}</kbd>`;

export function setSingleKeys(on) { singleKeys = on !== false; }
export const singleKeysOn = () => singleKeys;

/** 全後台的按鍵（啟動時註冊一次）。 */
export function bindGlobalKeys(list) { GLOBAL.push(...list); }
/** `g` 再按字母前往的頁面：[['s', '#subjects', '主體'], …] */
export function bindGoKeys(list) { GO.push(...list); }
/** 當前頁面的按鍵：每次換頁時重新設定（render 開始時清空）。 */
export function setPageKeys(list = []) { page = list; }
export const pageKeys = () => page;

function comboOf(e) {
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  const key = e.key === ' ' || e.key === 'Spacebar' ? 'Space' : e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.shiftKey && (/^[a-z]$/.test(key) || ['ArrowDown', 'ArrowUp', 'Space'].includes(key))) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

// 勾選框、單選框和按鈕不算輸入框：勾選一行後仍可直接按 a、t 等鍵
const inField = el => {
  const f = el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  return !!f && !(f.tagName === 'INPUT' && /^(checkbox|radio|button|submit|reset)$/.test(f.type));
};

function handle(e) {
  if (e.defaultPrevented || e.isComposing) return;
  const combo = comboOf(e);
  const single = !combo.includes('mod+') && !combo.includes('alt+');
  const dialog = $('#dialog')?.open;
  const typing = inField(e.target);
  if (pendingG && Date.now() - pendingG < 1500 && single && !typing && !dialog) {
    pendingG = 0;
    const go = GO.find(([k]) => k === combo);
    if (go) { e.preventDefault(); location.hash = go[1]; }
    return;
  }
  pendingG = 0;
  for (const b of [...page, ...GLOBAL]) {
    if (!b.keys.split(',').map(x => x.trim()).includes(combo)) continue;
    if (dialog && !b.inDialog) continue;
    if (typing && !b.inInput) continue;
    if (single && combo !== 'Escape' && !singleKeys && !b.always) continue;
    if (b.when && !b.when(e)) continue;
    // run 返回 false 表示這次不處理，交給下一個綁定（例如 Esc 先退出列表的選擇，沒有可退的再收起選單）
    if (b.run(e) === false) continue;
    e.preventDefault();
    return;
  }
  if (combo === 'g' && singleKeys && !typing && !dialog && GO.length) pendingG = Date.now();
}

export function installKeys() {
  document.addEventListener('keydown', handle);
}

/** `?` 快捷鍵說明：全後台、`g` 前往、當前頁面三組。 */
export function showKeyHelp() {
  const row = b => `<tr><td class="keys">${b.keys.split(',').map(k => kbd(k.trim())).join(' ')}</td><td>${esc(b.desc)}</td></tr>`;
  const go = GO.length ? `<tr><td class="keys">${kbd('g')} …</td><td>${GO.map(([k, , name]) => `${kbd(k)} ${esc(name)}`).join(' · ')}</td></tr>` : '';
  const pg = page.filter(b => b.desc);
  modal(t('快捷鍵'), `${singleKeys ? '' : `<p class="notice warn">${esc(t('單鍵快捷鍵已關閉，只有帶 {mod} 的快捷鍵生效。可以在「設定 › 帳號」重新開啟。', { mod: modLabel }))}</p>`}
    <div class="key-help"><section><h3>${t('全後台')}</h3><table>${GLOBAL.filter(b => b.desc).map(row).join('')}${go}</table></section>
    ${pg.length ? `<section><h3>${t('這個頁面')}</h3><table>${pg.map(row).join('')}</table></section>` : ''}</div>
    <p class="muted small" style="margin-top:10px">${esc(t('在輸入框和對話框中單鍵快捷鍵不生效。三種語言的快捷鍵相同。'))}</p>`);
}
