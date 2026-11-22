// 命令面板（設計 §9.2，第二期）：⌘K / Ctrl+K 打開，一個輸入框找主體、文檔章節、操作、頁面與視圖。
//   輸入為空時顯示最近查看的主體和最近用過的操作；「>」開頭只找操作，「#」開頭只找 ID；Tab 對選中的主體展開操作。
//   與頂欄全局搜索用同一個接口（GET /api/v1/search）。
import { $, esc, icon, level, showError, get, api } from './core.js';
import { t } from './i18n.js';
import { recentIds, local, prefsNow } from './workspace.js';
import { kbd } from './keys.js';

let P = null; // { pages(), actions(), subjectActions(subject) }
let items = [];
let active = 0;
let seq = 0;
let expanded = null;

const norm = s => String(s || '').toLowerCase();
const matches = (q, ...fields) => !q || fields.some(f => norm(f).includes(q));
const idHref = id => (id.startsWith('S-') ? `#subject/${id}` : id.startsWith('O-') ? `#object/${id}` : id.startsWith('DOC-') ? `#doc/${id}` : `#item/${id}`);

function el() {
  let d = $('#palette');
  if (d) return d;
  d = document.createElement('dialog');
  d.id = 'palette';
  d.className = 'palette';
  d.setAttribute('aria-label', t('命令面板'));
  d.innerHTML = `<div class="palette-box"><input id="palette-q" type="search" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" placeholder="${esc(t('找主體、文檔、操作或頁面…　> 只找操作　# 只找 ID'))}"><ul id="palette-list" role="listbox"></ul><div class="palette-foot">${kbd('ArrowUp')} ${kbd('ArrowDown')} ${t('選擇')} · ${kbd('Enter')} ${t('執行')} · ${kbd('Tab')} ${t('主體的操作')} · ${kbd('Escape')} ${t('關閉')}</div></div>`;
  document.body.append(d);
  d.addEventListener('click', e => { if (e.target === d) d.close(); const li = e.target.closest('[data-i]'); if (li) run(Number(li.dataset.i)); });
  const q = $('#palette-q', d);
  q.addEventListener('input', () => { expanded = null; refresh(); });
  q.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
    else if (e.key === 'Tab') {
      const it = items[active];
      if (it?.subject && !expanded) { e.preventDefault(); expanded = it.subject; refresh(); }
      else if (expanded && e.shiftKey) { e.preventDefault(); expanded = null; refresh(); }
    } else if (e.key === 'Backspace' && expanded && !q.value) { e.preventDefault(); expanded = null; refresh(); }
  });
  return d;
}

function move(delta) {
  if (!items.length) return;
  active = (active + delta + items.length) % items.length;
  paint();
}

function paint() {
  const list = $('#palette-list');
  let group = null;
  list.innerHTML = items.map((it, i) => {
    const head = it.group !== group ? `<li class="palette-group" role="presentation">${esc(it.group)}</li>` : '';
    group = it.group;
    return `${head}<li role="option" id="palette-${i}" data-i="${i}" class="palette-item${i === active ? ' active' : ''}" aria-selected="${i === active}"><span class="nav-icon">${icon(it.icon || 'list')}</span><span class="palette-label">${it.html || esc(it.label)}</span>${it.hint ? `<small class="muted">${esc(it.hint)}</small>` : ''}${it.subject && i === active ? `<small class="palette-tab">${kbd('Tab')} ${t('操作')}</small>` : ''}</li>`;
  }).join('') || `<li class="palette-empty muted">${t('沒有找到')}</li>`;
  $('#palette-q').setAttribute('aria-activedescendant', items[active] ? `palette-${active}` : '');
  $(`#palette-${active}`)?.scrollIntoView({ block: 'nearest' });
}

function remember(it) {
  if (!it.actionKey) return;
  const list = local.get('palette.recent', []).filter(x => x !== it.actionKey);
  list.unshift(it.actionKey);
  local.set('palette.recent', list.slice(0, 6));
}

async function run(i) {
  const it = items[i];
  if (!it) return;
  remember(it);
  $('#palette').close();
  try {
    if (it.href) location.hash = it.href.replace(/^#/, '');
    else await it.run?.();
  } catch (err) { showError(err); }
}

const subjectItem = (s, group) => ({
  group, icon: 'node', subject: s, href: `#subject/${s.id}`,
  html: `<strong>${esc(s.name)}</strong> <span class="mono muted">${esc(s.id)}</span> ${s.level ? level(s.level) : ''}${s.match?.field === 'alias' && s.match.text ? ` <small class="muted">${esc(t('經別名 {name}', { name: s.match.text }))}</small>` : ''}`,
  label: `${s.name} ${s.id}`
});

function staticItems(q) {
  const acts = P.actions().filter(a => matches(q, a.label, a.keywords)).map(a => ({ group: t('操作'), icon: a.icon || 'bolt', label: a.label, hint: a.hint, run: a.run, actionKey: a.key }));
  const pages = P.pages().filter(p => matches(q, p.name, p.id, p.group)).map(p => ({ group: t('頁面'), icon: p.icon || 'grid', label: p.name, hint: p.group, href: `#${p.id}` }));
  const views = [];
  for (const [scope, list] of Object.entries(prefsNow().views || {})) {
    for (const v of list || []) if (matches(q, v.name)) views.push({ group: t('我的視圖'), icon: 'star', label: v.name, hint: P.scopeName(scope), href: `#${scope === 'docs' ? 'docs' : scope}${v.query ? `?${v.query}` : ''}` });
  }
  for (const v of P.builtinViews()) if (matches(q, v.label)) views.push({ group: t('視圖'), icon: v.icon, label: v.label, hint: t('主體工作台'), href: `#subjects?view=${v.key}` });
  return { acts, pages, views };
}

async function refresh() {
  const my = ++seq;
  const raw = $('#palette-q').value;
  const q = norm(raw.trim());
  active = 0;
  if (expanded) {
    items = P.subjectActions(expanded).map(a => ({ group: t('{name} 的操作', { name: expanded.name }), icon: a.icon || 'bolt', label: a.label, run: a.run, href: a.href }));
    return paint();
  }
  if (q.startsWith('>')) {
    const { acts, pages, views } = staticItems(q.slice(1).trim());
    items = [...acts, ...pages, ...views];
    return paint();
  }
  if (q.startsWith('#')) {
    const id = raw.trim().slice(1).trim();
    items = id ? [{ group: t('ID'), icon: 'search', label: t('打開 {id}', { id: id.toUpperCase() }), href: idHref(id.toUpperCase()) }] : [];
    paint();
    if (!id) return;
    const r = await api('GET', `/api/v1/subjects?${new URLSearchParams({ q: id, limit: 8, sort: 'id' })}`).catch(() => ({ data: [] }));
    if (my !== seq) return;
    items = [...items, ...r.data.filter(s => norm(s.id).includes(norm(id))).map(s => subjectItem(s, t('主體')))];
    return paint();
  }
  if (!q) {
    const rec = recentIds('subjects').slice(0, 6);
    const recentActs = local.get('palette.recent', []).map(k => P.actions().find(a => a.key === k)).filter(Boolean).map(a => ({ group: t('最近用過的操作'), icon: a.icon || 'bolt', label: a.label, run: a.run, actionKey: a.key }));
    items = recentActs;
    paint();
    if (rec.length) {
      const r = await api('GET', `/api/v1/subjects?${new URLSearchParams({ ids: rec.join(','), limit: 6 })}`).catch(() => ({ data: [] }));
      if (my !== seq) return;
      const byId = new Map(r.data.map(s => [s.id, s]));
      items = [...rec.map(id => byId.get(id)).filter(Boolean).map(s => subjectItem(s, t('最近查看的主體'))), ...recentActs];
      if (!items.length) items = staticItems('').acts;
      paint();
    } else if (!items.length) { items = staticItems('').acts; paint(); }
    return;
  }
  const { acts, pages, views } = staticItems(q);
  items = [...acts.slice(0, 4), ...pages.slice(0, 4), ...views.slice(0, 4)];
  paint();
  await new Promise(r => setTimeout(r, 120));
  if (my !== seq) return;
  const r = await get(`/api/v1/search?${new URLSearchParams({ q: raw.trim(), limit: 8 })}`).catch(() => null);
  if (my !== seq || !r) return;
  const subj = r.subjects.map(s => subjectItem(s, t('主體')));
  const docs = r.documents.slice(0, 6).map(d => ({ group: t('文檔'), icon: 'doc', label: d.title, hint: d.match?.heading ? `§${d.match.heading}` : d.id, href: `#doc/${d.id}${d.match?.anchor ? `/${encodeURIComponent(d.match.anchor)}` : ''}` }));
  const more = r.subjectTotal > r.subjects.length ? [{ group: t('主體'), icon: 'search', label: t('在主體工作台中查看全部 {n} 個', { n: r.subjectTotal }), href: `#subjects?q=${encodeURIComponent(raw.trim())}` }] : [];
  items = [...subj, ...more, ...docs, ...acts.slice(0, 4), ...pages.slice(0, 4), ...views.slice(0, 4)];
  paint();
}

export function setupPalette(provider) { P = provider; }

export function openPalette(prefix = '') {
  if (!P) return;
  const d = el();
  if (d.open) return;
  expanded = null;
  d.showModal();
  const q = $('#palette-q');
  q.value = prefix;
  q.focus();
  refresh();
}
