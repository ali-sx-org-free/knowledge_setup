// 列表工作台（設計 §3–§10、§14）：導航欄（視圖、我的視圖、分組與聯動計數）、篩選條、搜索語法、
// 表格（排序、分組、密度、欄位、自動載入、行內修改）、選擇與批量操作條、預覽欄、網址狀態、我的視圖、快捷鍵。
// 主體、斷言、客體、關係、重驗隊列共用；資料可以來自服務端（主體：分頁與計數由 API 算）或一次載入後在瀏覽器裡篩選。
import { $, $$, esc, icon, toast, modal, showError, copy, get, put, field, input } from './core.js';
import { t } from './i18n.js';
import { setPageKeys, kbd } from './keys.js';

const PAGE = 100;

// ------------------------------------------------------------------ 本地存儲（只放個人便利設定：欄位、密度、收起狀態）
export const local = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 瀏覽器不允許本地存儲時略過 */ } }
};

// ------------------------------------------------------------------ 偏好與我的視圖（服務端，按登入身份分開）
let prefsCache = null;
export async function loadPrefs(force = false) {
  if (!prefsCache || force) prefsCache = await get('/admin/api/prefs').catch(() => ({ prefs: {}, views: {}, ownerName: null }));
  return prefsCache;
}
export const prefsNow = () => prefsCache || { prefs: {}, views: {}, ownerName: null };
export async function savePrefs(patch) {
  const r = await put('/admin/api/prefs', patch);
  await loadPrefs(true);
  return r.data;
}
export const savedViews = scope => prefsNow().views?.[scope] || [];
export async function saveViews(scope, views) {
  const r = await put('/admin/api/views', { scope, views });
  prefsNow().views = r.data;
  return r.data[scope] || [];
}

// ------------------------------------------------------------------ 列表上下文：從列表打開詳情頁時記下，詳情頁顯示「返回列表、第 n / N 個、上一個、下一個」
export function setListContext(c) {
  try { sessionStorage.setItem('ws.context', JSON.stringify({ ...c, at: Date.now() })); } catch { /* 略過 */ }
}
export function listContext(id) {
  let c = null;
  try { c = JSON.parse(sessionStorage.getItem('ws.context') || 'null'); } catch { c = null; }
  if (!c || Date.now() - c.at > 4 * 3600000 || !c.ids?.includes(id)) return null;
  return c;
}

// ------------------------------------------------------------------ 最近查看（瀏覽器本地，30 個）
export function pushRecent(scope, id) {
  const list = local.get(`recent.${scope}`, []).filter(x => x !== id);
  list.unshift(id);
  local.set(`recent.${scope}`, list.slice(0, 30));
}
export const recentIds = scope => local.get(`recent.${scope}`, []);

// ------------------------------------------------------------------ 條件
/** "INV,ORD,!別名" → { in, not }；與服務端 parseMulti 相同。 */
export function parseMulti(value) {
  const out = { in: [], not: [] };
  for (const raw of String(value ?? '').split(',')) {
    const s = raw.trim();
    if (!s || s === '!') continue;
    if (s.startsWith('!')) out.not.push(s.slice(1).trim());
    else out.in.push(s);
  }
  return out.in.length || out.not.length ? out : null;
}
export const multiParam = f => (f ? [...f.in, ...f.not.map(x => `!${x}`)].join(',') : '');

/**
 * 搜索語法：「domain:INV level:L2 -type:別名 is:pending 文字」。語法鍵在三種語言下相同，另接受中文鍵。
 * 輸入中的最後一個詞（游標還在上面）不轉換，除非 all = true（按 Enter）。返回 { tokens: [{ group, value, not }], rest }。
 */
export function parseSyntax(text, syntax, { all = false } = {}) {
  const parts = String(text || '').split(/\s+/);
  const trailing = /\s$/.test(text || '');
  const tokens = [];
  const rest = [];
  parts.forEach((tok, i) => {
    if (!tok) return;
    const last = i === parts.length - 1 && !trailing && !all;
    const m = /^(-?)([^:\s]+):(.+)$/.exec(tok);
    const key = m && syntax.keys[m[2].toLowerCase()];
    if (!m || !key || last) { rest.push(tok); return; }
    let group = key;
    let value = m[3];
    if (key === 'is') {
      const hit = syntax.is[value.toLowerCase()];
      if (!hit) { rest.push(tok); return; }
      [group, value] = hit;
    }
    if (syntax.normalize?.[group]) value = syntax.normalize[group](value);
    tokens.push({ group, value, not: m[1] === '-' });
  });
  return { tokens, rest: rest.join(' ') + (trailing && rest.length ? ' ' : '') };
}

/** 在瀏覽器裡篩選與計數（斷言、客體、關係、重驗隊列：一次載入全部）。 */
export function localSource({ load, text, views = {}, sorts = {}, groups }) {
  let all = null;
  const data = async force => (all && !force ? all : (all = await load()));
  const viewOk = (st, row) => !st.view || !views[st.view] || views[st.view](row);
  const textOk = (st, row) => {
    const terms = st.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const hay = text(row).toLowerCase();
    return terms.every(x => hay.includes(x));
  };
  const groupOk = (st, row, g) => {
    const f = st.filters[g.key];
    if (!f) return true;
    const vals = g.values(row);
    if (f.in.length && !vals.some(v => f.in.includes(v))) return false;
    if (f.not.length && vals.some(v => f.not.includes(v))) return false;
    return true;
  };
  const sortRows = (st, rows) => {
    const raw = st.sort || '';
    const key = raw.replace(/^-/, '');
    const fn = sorts[key];
    if (!fn) return rows;
    const dir = raw.startsWith('-') ? -1 : 1;
    return rows.sort((a, b) => {
      const x = fn(a);
      const y = fn(b);
      const c = typeof x === 'string' || typeof y === 'string' ? String(x ?? '').localeCompare(String(y ?? '')) : (x ?? 0) - (y ?? 0);
      return c * dir || String(a.id).localeCompare(String(b.id));
    });
  };
  return {
    reload: () => data(true),
    async page(st, offset, limit) {
      const rows = sortRows(st, (await data()).filter(r => viewOk(st, r) && textOk(st, r) && groups.every(g => groupOk(st, r, g))));
      return { rows: rows.slice(offset, offset + limit), total: rows.length };
    },
    async facets(st) {
      const out = { total: 0, groups: Object.fromEntries(groups.map(g => [g.key, {}])), views: Object.fromEntries(Object.keys(views).map(k => [k, 0])) };
      for (const row of await data()) {
        for (const [k, fn] of Object.entries(views)) if (fn(row)) out.views[k]++;
        if (!viewOk(st, row) || !textOk(st, row)) continue;
        const fails = groups.filter(g => !groupOk(st, row, g));
        if (fails.length > 1) continue;
        if (!fails.length) out.total++;
        for (const g of groups) {
          if (fails.length && fails[0] !== g) continue;
          for (const v of new Set(g.values(row))) out.groups[g.key][v] = (out.groups[g.key][v] || 0) + 1;
        }
      }
      return out;
    }
  };
}

const noun = (cfg, n) => cfg.noun(n);

// ------------------------------------------------------------------ 工作台
/**
 * cfg:
 *   scope / page            我的視圖的範圍、網址的頁面名（#subjects）
 *   source                  { page(st, offset, limit) → { rows, total }, facets(st) → { total, groups, views } }
 *   views                   內置視圖 [{ key, label, icon }]；defaultView
 *   groups                  導航分組 [{ key, label, collapsed, items(facets, st) → [{ value, label, title, dot, tone, bar }], more, hidden(st) }]
 *   syntax                  搜索語法 { keys: { domain: 'domain', 領域: 'domain', is: 'is' }, is: { pending: ['state','pending'] }, normalize }
 *   columns                 [{ key, label, def, sort, cls, render(row, ws), edit: { type, min, max, save(row, value) } }]
 *   sorts / defaultSort     [[key, label]]
 *   groupBy                 [[key, label, row → [groupKey, groupLabel]]]
 *   preview(row, el, ws)    預覽欄
 *   rowActions              懸停時行尾的小按鈕 [{ key, label, run(row, ws), when(row) }]
 *   bulk                    批量操作 [{ key, label, keys, when(), run(ids, ws) }]
 *   open(row)               打開詳情的網址（不含 #）
 *   drop(group, value, ids) 拖曳行到導航項（負責人、標籤）
 *   matrix                  { label, render(el, st, ws) } 切換到矩陣
 *   newItem(st)             `n` 新增
 *   noun(n)                 「486 個主體」
 */
export function mountWorkspace(root, cfg) {
  const hashQuery = (location.hash.split('?')[1] || '');
  const st = readState(hashQuery);
  const sel = new Set();
  let rows = [];
  let total = 0;
  let facets = null;
  let seq = 0;
  let loading = false;
  let anchor = null;
  let selectAllPending = false;
  const collapsed = new Set(local.get(`ws.${cfg.scope}.collapsed`, cfg.groups.filter(g => g.collapsed).map(g => g.key)));
  const layout = local.get('ws.layout', { nav: true, preview: true });
  let density = local.get(`ws.${cfg.scope}.density`, 'compact');
  let cols = local.get(`ws.${cfg.scope}.cols`, null) || cfg.columns.filter(c => c.def).map(c => c.key);
  const groupCollapsed = new Set();
  let showMore = new Set();

  function readState(query) {
    const p = new URLSearchParams(query);
    const filters = {};
    for (const g of cfg.groups) {
      const m = parseMulti(p.get(g.key));
      if (m) filters[g.key] = m;
    }
    const empty = ![...p.keys()].length;
    const def = empty ? savedViews(cfg.scope).find(v => v.default) : null;
    if (def) {
      const lp = new URLSearchParams(def.layout || '');
      if (lp.get('cols')) local.set(`ws.${cfg.scope}.cols`, lp.get('cols').split(','));
      if (lp.get('density')) local.set(`ws.${cfg.scope}.density`, lp.get('density'));
      return readState(def.query || 'view=' + (cfg.defaultView || ''));
    }
    return {
      view: p.get('view') || (empty ? cfg.defaultView || null : p.get('view')), q: p.get('q') || '', filters,
      sort: p.get('sort') || cfg.defaultSort || '', group: p.get('group') || '', mode: p.get('mode') || 'list', rows: p.get('rows') || 'domain',
      focus: p.get('focus') || '', extra: Object.fromEntries((cfg.extraParams || []).map(k => [k, p.get(k) || '']))
    };
  }

  /** 網址與「我的視圖」中的條件（ui=false 時只含篩選條件）。 */
  function query({ ui = true, focus = true } = {}) {
    const p = new URLSearchParams();
    if (st.view) p.set('view', st.view);
    if (st.q.trim()) p.set('q', st.q.trim());
    for (const g of cfg.groups) if (st.filters[g.key]) p.set(g.key, multiParam(st.filters[g.key]));
    for (const [k, v] of Object.entries(st.extra)) if (v) p.set(k, v);
    if (ui) {
      if (st.sort && st.sort !== cfg.defaultSort) p.set('sort', st.sort);
      if (st.group) p.set('group', st.group);
      if (st.mode !== 'list') { p.set('mode', st.mode); p.set('rows', st.rows); }
      if (focus && st.focus) p.set('focus', st.focus);
    }
    return p.toString();
  }
  const syncUrl = () => history.replaceState(null, '', `#${cfg.page}${query() ? `?${query()}` : ''}`);

  // ---- 骨架
  root.innerHTML = `<div class="ws ${layout.nav ? '' : 'nav-off'} ${layout.preview ? '' : 'preview-off'}" id="ws">
    <nav class="panel ws-nav" id="ws-nav" aria-label="${esc(t('篩選'))}"></nav>
    <section class="panel ws-main">
      <div class="ws-top">
        <button type="button" class="button ws-filter-btn" id="ws-filter-btn" aria-controls="ws-nav">${icon('filter')} ${t('篩選')}</button>
        <label class="grow ws-search"><input id="ws-q" type="search" autocomplete="off" value="${esc(st.q)}" placeholder="${esc(cfg.searchPlaceholder)}" aria-label="${esc(t('搜索'))}"></label>
        <div class="ws-tools">
          ${cfg.sorts?.length ? `<label class="ws-tool">${t('排序')} <select id="ws-sort">${cfg.sorts.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('')}</select><button type="button" class="ws-dir" id="ws-dir" title="${esc(t('升序 / 降序'))}" aria-label="${esc(t('升序 / 降序'))}"></button></label>` : ''}
          ${cfg.groupBy?.length ? `<label class="ws-tool">${t('分組')} <select id="ws-group"><option value="">${t('無')}</option>${cfg.groupBy.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('')}</select></label>` : ''}
          <div class="segmented ws-density" role="group" aria-label="${esc(t('密度'))}"><button type="button" data-density="compact">${t('緊湊')}</button><button type="button" data-density="standard">${t('標準')}</button></div>
          <details class="menu ws-cols"><summary class="button">${t('欄位')}</summary><div class="menu-list" id="ws-cols"></div></details>
          ${cfg.matrix ? `<div class="segmented" role="group" aria-label="${esc(t('顯示方式'))}"><button type="button" data-mode="list">${t('列表')}</button><button type="button" data-mode="matrix">${esc(cfg.matrix.label)}</button></div>` : ''}
        </div>
      </div>
      <div class="ws-chips" id="ws-chips"></div>
      <div class="ws-banner" id="ws-banner" hidden></div>
      <div class="ws-body" id="ws-body"></div>
      <div class="ws-foot" id="ws-foot"></div>
      <div class="ws-bulk" id="ws-bulk" hidden></div>
    </section>
    <aside class="panel ws-preview" id="ws-preview" aria-live="polite" aria-label="${esc(t('預覽'))}"></aside>
  </div>`;
  const wsEl = $('#ws', root);

  // ---- 導航欄
  const countOf = (g, v) => facets?.groups?.[g]?.[v] || 0;
  function navItem(g, it) {
    const f = st.filters[g.key];
    const on = !!f?.in.includes(it.value);
    const not = !!f?.not.includes(it.value);
    const n = it.count ?? countOf(g.key, it.value);
    const tone = n && it.tone ? ` ${it.tone}` : '';
    const label = `${it.label}${not ? ` (${t('排除')})` : ''}`;
    return `<button type="button" class="ws-item${on ? ' on' : ''}${not ? ' not' : ''}${n ? '' : ' zero'}" data-g="${esc(g.key)}" data-v="${esc(it.value)}" aria-pressed="${on || not}" aria-label="${esc(t('{name}，{n} 個', { name: label, n }))}${on ? esc(t('，已選')) : ''}" title="${esc(it.title || it.label)}"${g.drop ? ' data-drop="1"' : ''}>
      <span class="ws-box" data-box aria-hidden="true"></span>${it.dot ? `<i class="ws-dot ${esc(it.dot)}"></i>` : ''}<span class="ws-name">${esc(it.label)}</span>${it.bar || ''}<small class="ws-n${tone}">${n}</small></button>${it.children && on ? `<div class="ws-sub">${it.children.map(c => `<button type="button" class="ws-item ws-child${st.filters[c.group]?.in.includes(c.value) ? ' on' : ''}${c.count ? '' : ' zero'}" data-g="${esc(c.group)}" data-v="${esc(c.value)}" aria-pressed="${!!st.filters[c.group]?.in.includes(c.value)}"><span class="ws-name">${esc(c.label)}</span><small class="ws-n">${c.count}</small></button>`).join('')}</div>` : ''}`;
  }
  function renderNav() {
    const views = (cfg.views || []).map(v => `<button type="button" class="ws-item ws-view${st.view === v.key && !activeSaved() ? ' on' : ''}" data-view="${esc(v.key)}" aria-pressed="${st.view === v.key}"><span class="nav-icon">${icon(v.icon || 'list')}</span><span class="ws-name">${esc(v.label)}</span><small class="ws-n">${v.count ? v.count(facets) : facets?.views?.[v.key] ?? ''}</small></button>`).join('');
    const saved = savedViews(cfg.scope);
    const act = activeSaved();
    const savedHtml = saved.map(v => `<div class="ws-saved"><button type="button" class="ws-item ws-view${act?.id === v.id ? ' on' : ''}" data-saved="${esc(v.id)}"><span class="nav-icon">${icon('star')}</span><span class="ws-name">${esc(v.name)}</span>${v.default ? `<small class="ws-n">${t('預設')}</small>` : ''}</button><details class="menu ws-saved-menu"><summary aria-label="${esc(t('管理視圖 {name}', { name: v.name }))}">⋯</summary><div class="menu-list"><button type="button" data-saved-op="rename" data-id="${esc(v.id)}">${t('重命名')}</button><button type="button" data-saved-op="up" data-id="${esc(v.id)}">${t('上移')}</button><button type="button" data-saved-op="default" data-id="${esc(v.id)}">${v.default ? t('取消預設') : t('設為預設視圖')}</button><button type="button" data-saved-op="update" data-id="${esc(v.id)}">${t('用當前條件覆蓋')}</button><button type="button" data-saved-op="delete" data-id="${esc(v.id)}" style="color:var(--danger)">${t('刪除')}</button></div></details></div>`).join('');
    const groups = cfg.groups.filter(g => !g.hidden?.(st, facets)).map(g => {
      const f = st.filters[g.key];
      const n = (f?.in.length || 0) + (f?.not.length || 0);
      const open = !collapsed.has(g.key);
      let items = facets ? g.items(facets, st) : [];
      let more = '';
      if (g.more && items.length > g.more && !showMore.has(g.key)) {
        const keep = items.filter((it, i) => i < g.more || it.pinned || f?.in.includes(it.value) || f?.not.includes(it.value));
        more = `<button type="button" class="text-btn ws-more" data-more="${esc(g.key)}">${esc(t('另外 {n} 個…', { n: items.length - keep.length }))}</button>`;
        items = keep;
      } else if (g.more && items.length > g.more) {
        more = `<input type="search" class="ws-find" data-find="${esc(g.key)}" placeholder="${esc(t('篩選{name}', { name: g.label }))}" aria-label="${esc(t('篩選{name}', { name: g.label }))}">`;
      }
      return `<section class="ws-sec" data-sec="${esc(g.key)}"><div class="ws-sec-head"><button type="button" class="ws-caret${open ? ' open' : ''}" data-toggle="${esc(g.key)}" aria-expanded="${open}">${esc(g.label)}</button>${n ? `<button type="button" class="ws-clear" data-clear="${esc(g.key)}" title="${esc(t('清除這一組'))}">${esc(t('已選 {n}', { n }))} ×</button>` : ''}</div>${open ? `<div class="ws-items">${more.startsWith('<input') ? more : ''}${items.map(it => navItem(g, it)).join('') || `<p class="muted small ws-none">${t('無')}</p>`}${more.startsWith('<button') ? more : ''}</div>` : ''}</section>`;
    }).join('');
    $('#ws-nav', root).innerHTML = `<section class="ws-sec"><div class="ws-sec-head"><span class="ws-title">${t('視圖')}</span></div><div class="ws-items">${views}</div></section>
      <section class="ws-sec"><div class="ws-sec-head"><span class="ws-title">${t('我的視圖')}</span></div><div class="ws-items">${savedHtml}<button type="button" class="text-btn ws-more" id="ws-save-current">${t('+ 保存當前')}</button></div></section>
      ${groups}
      <p class="ws-hint">${t('單擊只看這一項；{mod}＋單擊加選；{alt}＋單擊排除。', { mod: kbd('mod').replace(/<\/?kbd>/g, ''), alt: navigator.platform?.includes('Mac') ? '⌥' : 'Alt' })} ${kbd('[')} ${t('收起')}</p>`;
  }
  const activeSaved = () => {
    const q = query({ focus: false });
    return savedViews(cfg.scope).find(v => v.query === q) || null;
  };

  // ---- 篩選條
  function chipsHtml() {
    const chips = [];
    const viewDef = cfg.views?.find(v => v.key === st.view);
    if (viewDef && st.view !== cfg.defaultView) chips.push(`<span class="chip ws-chip">${esc(t('視圖：{name}', { name: viewDef.label }))}<button type="button" class="chip-x" data-chip-view aria-label="${esc(t('移除 {name}', { name: viewDef.label }))}">×</button></span>`);
    for (const g of cfg.groups) {
      const f = st.filters[g.key];
      if (!f) continue;
      const name = v => (facets ? g.items(facets, st).find(it => it.value === v)?.label : null) || g.valueLabel?.(v) || v;
      if (f.in.length) chips.push(`<span class="chip ws-chip">${esc(g.label)} ${esc(f.in.map(name).join(t('、')))}<button type="button" class="chip-x" data-chip="${esc(g.key)}" data-chip-kind="in" aria-label="${esc(t('移除 {name}', { name: g.label }))}">×</button></span>`);
      if (f.not.length) chips.push(`<span class="chip ws-chip not">${esc(g.label)} ≠ ${esc(f.not.map(name).join(t('、')))}<button type="button" class="chip-x" data-chip="${esc(g.key)}" data-chip-kind="not" aria-label="${esc(t('移除 {name}', { name: g.label }))}">×</button></span>`);
    }
    for (const [k, v] of Object.entries(st.extra)) if (v && cfg.extraLabel?.[k]) chips.push(`<span class="chip ws-chip">${esc(cfg.extraLabel[k](v))}<button type="button" class="chip-x" data-chip-extra="${esc(k)}" aria-label="${esc(t('移除'))}">×</button></span>`);
    const any = chips.length || st.q.trim();
    return `<div class="ws-chip-list">${chips.join('')}${any ? `<button type="button" class="text-btn" id="ws-clear-all">${t('清除全部')}</button>` : ''}</div>
      <div class="ws-chip-end"><strong class="ws-count" role="status">${esc(noun(cfg, total))}</strong><button type="button" class="text-btn" id="ws-save-view">${t('保存為視圖')}</button><button type="button" class="text-btn" id="ws-copy-link">${t('複製鏈接')}</button></div>`;
  }
  const renderChips = () => ($('#ws-chips', root).innerHTML = chipsHtml());

  // ---- 表格
  const visibleCols = () => cfg.columns.filter(c => cols.includes(c.key) || c.always);
  function headHtml() {
    const sortKey = st.sort.replace(/^-/, '');
    const desc = st.sort.startsWith('-');
    return `<thead><tr><th class="check-cell"><input type="checkbox" id="ws-all" aria-label="${esc(t('全選已載入的行'))}"></th>${visibleCols().map(c => {
      const sorted = c.sort && c.sort === sortKey;
      return `<th class="${c.cls || ''}"${sorted ? ` aria-sort="${desc ? 'descending' : 'ascending'}"` : ''}>${c.sort ? `<button type="button" class="ws-th" data-sort="${esc(c.sort)}">${esc(c.label)}${sorted ? (desc ? ' ↓' : ' ↑') : ''}</button>` : esc(c.label)}</th>`;
    }).join('')}${cfg.rowActions?.length ? '<th class="ws-acts-head"></th>' : ''}</tr></thead>`;
  }
  function rowHtml(r) {
    const id = String(r.id);
    const s = sel.has(id);
    const focus = st.focus === id;
    return `<tr class="ws-row${focus ? ' focused' : ''}${s ? ' selected' : ''}" data-id="${esc(id)}" aria-selected="${s}"${cfg.drop ? ' draggable="true"' : ''}><td class="check-cell"><input type="checkbox" data-sel ${s ? 'checked' : ''} aria-label="${esc(t('選擇 {name}', { name: r.name || id }))}" tabindex="-1"></td>${visibleCols().map(c => `<td class="${c.cls || ''}${c.edit ? ' ws-editable' : ''}"${c.edit ? ` data-edit="${esc(c.key)}" title="${esc(t('點擊修改'))}"` : ''}>${c.render(r, api)}</td>`).join('')}${cfg.rowActions?.length ? `<td class="ws-acts">${cfg.rowActions.filter(a => !a.when || a.when(r)).map(a => `<button type="button" class="text-btn" data-act="${esc(a.key)}">${esc(a.label)}</button>`).join('')}</td>` : ''}</tr>`;
  }
  function bodyRows() {
    if (!st.group) return rows.map(rowHtml).join('');
    const by = cfg.groupBy.find(g => g[0] === st.group);
    if (!by) return rows.map(rowHtml).join('');
    const buckets = new Map();
    for (const r of rows) {
      const [k, label] = by[2](r);
      if (!buckets.has(k)) buckets.set(k, { label, rows: [] });
      buckets.get(k).rows.push(r);
    }
    const span = visibleCols().length + 1 + (cfg.rowActions?.length ? 1 : 0);
    return [...buckets.entries()].map(([k, b]) => `<tr class="ws-group-row"><td colspan="${span}"><button type="button" class="ws-caret${groupCollapsed.has(k) ? '' : ' open'}" data-collapse="${esc(k)}" aria-expanded="${!groupCollapsed.has(k)}">${esc(b.label)} <small>${b.rows.length}</small></button></td></tr>${groupCollapsed.has(k) ? '' : b.rows.map(rowHtml).join('')}`).join('');
  }
  async function emptyHtml() {
    const relax = [];
    const tryRelax = async (label, change) => {
      const copyState = structuredClone({ ...st, filters: st.filters });
      change(copyState);
      try {
        const r = await cfg.source.page(copyState, 0, 0);
        if (r.total) relax.push({ label, n: r.total, change });
      } catch { /* 略過 */ }
    };
    const jobs = [];
    for (const g of cfg.groups) if (st.filters[g.key]) jobs.push(tryRelax(t('去掉「{name}」', { name: g.label }), s => delete s.filters[g.key]));
    if (st.q.trim()) jobs.push(tryRelax(t('去掉搜索詞'), s => (s.q = '')));
    if (st.view && st.view !== cfg.defaultView) jobs.push(tryRelax(t('換成「{name}」', { name: cfg.views.find(v => v.key === cfg.defaultView)?.label || '' }), s => (s.view = cfg.defaultView)));
    await Promise.all(jobs);
    relaxers = relax;
    return `<div class="ws-empty"><p>${esc(t('沒有符合全部條件的{noun}。', { noun: cfg.nounName }))}</p>${relax.length ? `<div class="chip-row">${relax.map((x, i) => `<button type="button" class="button" data-relax="${i}">${esc(t('{label}後有 {n} 個', { label: x.label, n: x.n }))}</button>`).join('')}</div>` : ''}${cfg.emptyHint ? `<p class="muted small">${cfg.emptyHint}</p>` : ''}</div>`;
  }
  let relaxers = [];
  async function renderBody() {
    const body = $('#ws-body', root);
    if (st.mode === 'matrix' && cfg.matrix) {
      $('#ws-foot', root).innerHTML = '';
      await cfg.matrix.render(body, st, api);
      return;
    }
    if (!rows.length) {
      body.innerHTML = total || loading ? '' : await emptyHtml();
    } else {
      body.innerHTML = `<div class="table-scroll ws-scroll"><table class="ws-grid ${density}" role="grid" aria-rowcount="${total}" aria-multiselectable="true">${headHtml()}<tbody>${bodyRows()}</tbody></table><div class="ws-sentinel" id="ws-sentinel"></div></div>`;
      observe();
    }
    renderFoot();
    syncAllBox();
  }
  function renderFoot() {
    $('#ws-foot', root).innerHTML = `<span>${esc(t('已顯示 {n} / {total}', { n: rows.length, total }))}</span>${cfg.footExtra?.() || ''}<span class="ws-keys">${kbd('j')} ${kbd('k')} ${t('移動')} · ${kbd('x')} ${t('選中')} · ${kbd('Enter')} ${t('打開')} · ${kbd('?')} ${t('全部快捷鍵')}</span>`;
  }
  let observer = null;
  function observe() {
    observer?.disconnect();
    const s = $('#ws-sentinel', root);
    if (!s || rows.length >= total) return;
    const sc = s.closest('.ws-scroll');
    const scrollRoot = sc && getComputedStyle(sc).maxHeight !== 'none' ? sc : null;
    observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) loadMore(); }, { root: scrollRoot, rootMargin: '400px' });
    observer.observe(s);
  }

  // ---- 載入
  async function reload({ keepRows = false } = {}) {
    const my = ++seq;
    loading = true;
    try {
      const limit = st.group ? 1000 : Math.max(PAGE, keepRows ? rows.length : 0);
      const [page, fc] = await Promise.all([st.mode === 'matrix' ? { rows: [], total: null } : cfg.source.page(st, 0, limit), cfg.source.facets(st)]);
      if (my !== seq || !root.isConnected) return;
      facets = fc;
      rows = page.rows;
      total = page.total ?? fc.total;
      loading = false;
      renderNav();
      renderChips();
      renderBanner();
      await renderBody();
      renderBulk();
      if (st.focus && !rows.some(r => String(r.id) === st.focus) && st.mode !== 'matrix') st.focus = '';
      if (!st.focus && rows.length && st.mode !== 'matrix' && window.innerWidth >= 1000) setFocus(String(rows[0].id), { scroll: false });
      else showPreview();
      if (st.focus) $(`tr[data-id="${CSS.escape(st.focus)}"]`, root)?.scrollIntoView({ block: 'nearest' });
      syncUrl();
    } catch (err) {
      loading = false;
      if (my === seq) $('#ws-body', root).innerHTML = `<div class="notice warn">${esc(err.message)}</div>`;
    }
  }
  async function loadMore() {
    if (loading || rows.length >= total) return;
    loading = true;
    const my = seq;
    try {
      const page = await cfg.source.page(st, rows.length, PAGE);
      if (my !== seq) return;
      rows = rows.concat(page.rows);
      const tbody = $('#ws-body tbody', root);
      if (tbody && !st.group) tbody.insertAdjacentHTML('beforeend', page.rows.map(rowHtml).join(''));
      renderFoot();
      renderBanner();
    } finally {
      loading = false;
      observe();
    }
  }
  const change = (fn, opts) => { fn(); st.focus = ''; reload(opts); };

  // ---- 焦點與預覽
  let previewTimer;
  function setFocus(id, { scroll = true } = {}) {
    st.focus = id;
    $$('tr.ws-row.focused', root).forEach(tr => tr.classList.remove('focused'));
    const tr = id ? $(`tr[data-id="${CSS.escape(id)}"]`, root) : null;
    tr?.classList.add('focused');
    if (scroll) tr?.scrollIntoView({ block: 'nearest' });
    syncUrl();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(showPreview, 90);
  }
  const focusedRow = () => rows.find(r => String(r.id) === st.focus) || null;
  async function showPreview() {
    const el = $('#ws-preview', root);
    const r = focusedRow();
    if (!r || !cfg.preview) { el.innerHTML = `<div class="ws-preview-empty"><span class="nav-icon">${icon('eye')}</span><p class="muted small">${t('選一行查看要點')}</p></div>`; return; }
    try { await cfg.preview(r, el, api); } catch (err) { el.innerHTML = `<div class="notice warn">${esc(err.message)}</div>`; }
  }
  function move(delta, extend = false) {
    if (!rows.length) return;
    let i = rows.findIndex(r => String(r.id) === st.focus);
    i = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + delta));
    const id = String(rows[i].id);
    if (extend) { sel.add(id); if (st.focus) sel.add(st.focus); syncSelection(); }
    setFocus(id);
    if (i >= rows.length - 5) loadMore();
  }
  function rememberContext() {
    const ids = [...new Set(rows.map(x => String(cfg.contextId ? cfg.contextId(x) : x.id)))];
    setListContext({ hash: `#${cfg.page}${query() ? `?${query()}` : ''}`, ids, total: cfg.contextId ? ids.length : total, label: chipText() || t('全部'), page: cfg.page });
  }
  function openRow(r, newTab = false) {
    if (!r || !cfg.open) return;
    rememberContext();
    if (newTab) window.open(`#${cfg.open(r)}`, '_blank', 'noopener');
    else location.hash = cfg.open(r);
  }
  const chipText = () => [...$$('.ws-chip', root)].map(c => c.firstChild?.textContent?.trim()).filter(Boolean).join(' · ');

  // ---- 選擇與批量
  function syncSelection() {
    for (const tr of $$('tr.ws-row', root)) {
      const on = sel.has(tr.dataset.id);
      tr.classList.toggle('selected', on);
      tr.setAttribute('aria-selected', String(on));
      const box = $('input[data-sel]', tr);
      if (box) box.checked = on;
    }
    syncAllBox();
    renderBanner();
    renderBulk();
  }
  function syncAllBox() {
    const box = $('#ws-all', root);
    if (!box) return;
    const loaded = rows.filter(r => sel.has(String(r.id))).length;
    box.checked = !!rows.length && loaded === rows.length;
    box.indeterminate = loaded > 0 && loaded < rows.length;
  }
  function renderBanner() {
    const b = $('#ws-banner', root);
    const loaded = rows.filter(r => sel.has(String(r.id))).length;
    if (selectAllPending && loaded === rows.length && total > rows.length) {
      b.hidden = false;
      b.innerHTML = `${esc(t('已選已載入的 {n} 個。', { n: rows.length }))} <button type="button" class="text-btn" id="ws-select-all">${esc(t('選擇全部 {n} 個符合條件的{noun}', { n: total, noun: cfg.nounName }))}</button>`;
    } else b.hidden = true;
  }
  function renderBulk() {
    const bar = $('#ws-bulk', root);
    if (!sel.size) { bar.hidden = true; return; }
    const shown = new Set(rows.map(r => String(r.id)));
    const outside = rows.length >= total ? [...sel].filter(id => !shown.has(id)).length : 0;
    const ops = (cfg.bulk || []).filter(b => !b.hidden && (!b.when || b.when()));
    bar.hidden = false;
    bar.innerHTML = `<strong>${esc(t('已選 {n} 個', { n: sel.size }))}</strong>${outside ? `<small>${esc(t('其中 {n} 個不在當前結果中', { n: outside }))}</small>` : ''}<div class="ws-bulk-ops">${ops.filter(b => !b.more).map(b => `<button type="button" class="button" data-bulk="${esc(b.key)}">${esc(b.label)}${b.keys ? ` ${kbd(b.keys)}` : ''}</button>`).join('')}${ops.some(b => b.more) ? `<details class="menu ws-bulk-more"><summary class="button">${t('更多')}</summary><div class="menu-list">${ops.filter(b => b.more).map(b => `<button type="button" data-bulk="${esc(b.key)}">${esc(b.label)}</button>`).join('')}</div></details>` : ''}</div><button type="button" class="text-btn" id="ws-unselect">${t('取消選擇')} ${kbd('Escape')}</button>`;
  }
  const targetIds = () => (sel.size ? [...sel] : st.focus ? [st.focus] : []);
  async function runBulk(key) {
    const op = (cfg.bulk || []).find(b => b.key === key);
    if (!op || (op.when && !op.when())) return;
    const ids = targetIds();
    if (!ids.length) return toast(t('請先選擇或移到一行'));
    try { await op.run(ids, api); } catch (err) { showError(err); }
  }

  // ---- 我的視圖
  async function saveCurrent(existing) {
    const q = query({ focus: false });
    const layoutQ = new URLSearchParams({ cols: cols.join(','), density }).toString();
    if (existing) {
      const list = savedViews(cfg.scope).map(v => (v.id === existing.id ? { ...v, query: q, layout: layoutQ } : v));
      await saveViews(cfg.scope, list);
      toast(t('已更新視圖「{name}」', { name: existing.name }));
      renderNav();
      return;
    }
    modal(t('保存為視圖'), `${field(t('名稱'), input('name', '', 'required maxlength="40"'))}<p class="muted small">${esc(t('記下目前的篩選、搜索、排序與分組；只有你看得到，換瀏覽器也在。'))}</p><label class="check"><input type="checkbox" name="default"> ${t('進入這個列表時預設打開')}</label>`, {
      label: t('保存'),
      run: async () => {
        const name = $('#dialog-content [name=name]').value.trim();
        if (!name) throw new Error(t('請填寫名稱'));
        const def = $('#dialog-content [name=default]').checked;
        const list = savedViews(cfg.scope).map(v => (def ? { ...v, default: false } : v));
        await saveViews(cfg.scope, [...list, { name, query: q, layout: layoutQ, ...(def ? { default: true } : {}) }]);
        toast(t('已保存視圖「{name}」', { name }));
        renderNav();
      }
    });
  }
  async function savedOp(op, id) {
    const list = savedViews(cfg.scope);
    const v = list.find(x => x.id === id);
    if (!v) return;
    if (op === 'delete') await saveViews(cfg.scope, list.filter(x => x.id !== id));
    else if (op === 'up') { const i = list.indexOf(v); if (i > 0) { const next = [...list]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; await saveViews(cfg.scope, next); } }
    else if (op === 'default') await saveViews(cfg.scope, list.map(x => ({ ...x, default: x.id === id ? !v.default : false })));
    else if (op === 'update') return saveCurrent(v);
    else if (op === 'rename') {
      return modal(t('重命名視圖'), field(t('名稱'), input('name', v.name, 'required maxlength="40"')), {
        label: t('保存'),
        run: async () => { await saveViews(cfg.scope, list.map(x => (x.id === id ? { ...x, name: $('#dialog-content [name=name]').value.trim() } : x))); renderNav(); }
      });
    }
    renderNav();
  }
  function applyQuery(q, layoutQ = '') {
    const p = new URLSearchParams(layoutQ);
    if (p.get('cols')) { cols = p.get('cols').split(','); local.set(`ws.${cfg.scope}.cols`, cols); }
    if (p.get('density')) { density = p.get('density') === 'standard' ? 'standard' : 'compact'; local.set(`ws.${cfg.scope}.density`, density); }
    Object.assign(st, readState(q || 'view=' + (cfg.defaultView || '')), { focus: '' });
    $('#ws-q', root).value = st.q;
    syncTools();
    reload();
  }

  // ---- 工具列
  function syncTools() {
    const sortSel = $('#ws-sort', root);
    if (sortSel) {
      sortSel.value = st.sort.replace(/^-/, '');
      $('#ws-dir', root).textContent = st.sort.startsWith('-') ? '↓' : '↑';
    }
    if ($('#ws-group', root)) $('#ws-group', root).value = st.group;
    $$('[data-density]', root).forEach(b => { b.classList.toggle('active', b.dataset.density === density); b.setAttribute('aria-pressed', String(b.dataset.density === density)); });
    $$('[data-mode]', root).forEach(b => { b.classList.toggle('active', b.dataset.mode === st.mode); b.setAttribute('aria-pressed', String(b.dataset.mode === st.mode)); });
    $('#ws-cols', root).innerHTML = cfg.columns.filter(c => !c.always).map(c => `<label class="check"><input type="checkbox" data-col="${esc(c.key)}" ${cols.includes(c.key) ? 'checked' : ''}> ${esc(c.label)}</label>`).join('');
    wsEl.classList.toggle('matrix-mode', st.mode === 'matrix');
  }
  function setLayout(k, on) {
    layout[k] = on;
    local.set('ws.layout', layout);
    wsEl.classList.toggle(`${k}-off`, !on);
    wsEl.classList.toggle(`${k}-open`, on);
  }

  // ---- 搜索
  let searchTimer;
  function onSearch(all = false) {
    const box = $('#ws-q', root);
    const { tokens, rest } = parseSyntax(box.value, cfg.syntax || { keys: {}, is: {} }, { all });
    if (tokens.length) {
      for (const tk of tokens) {
        const f = (st.filters[tk.group] ||= { in: [], not: [] });
        const list = tk.not ? f.not : f.in;
        if (!list.includes(tk.value)) list.push(tk.value);
        const other = tk.not ? f.in : f.not;
        if (other.includes(tk.value)) other.splice(other.indexOf(tk.value), 1);
      }
      box.value = rest;
    }
    st.q = box.value.trim();
    st.focus = '';
    reload();
  }

  // ---- 事件
  root.addEventListener('click', async e => {
    const el = e.target;
    // 窄屏抽屜：點遮罩（抽屜外）收起
    if (el === wsEl && wsEl.matches('.nav-open, .preview-open')) { wsEl.classList.remove('nav-open', 'preview-open'); return; }
    // 導航欄
    const item = el.closest('.ws-item[data-g]');
    if (item) {
      const g = item.dataset.g;
      const v = item.dataset.v;
      const f = st.filters[g] || { in: [], not: [] };
      if (e.altKey) {
        f.in = f.in.filter(x => x !== v);
        f.not = f.not.includes(v) ? f.not.filter(x => x !== v) : [...f.not, v];
      } else if (e.metaKey || e.ctrlKey || el.closest('[data-box]')) {
        f.not = f.not.filter(x => x !== v);
        f.in = f.in.includes(v) ? f.in.filter(x => x !== v) : [...f.in, v];
      } else {
        const only = f.in.length === 1 && f.in[0] === v && !f.not.length;
        f.in = only ? [] : [v];
        f.not = [];
      }
      if (item.classList.contains('ws-child') && cfg.childParent) cfg.childParent(st, item);
      if (f.in.length || f.not.length) st.filters[g] = f;
      else delete st.filters[g];
      return change(() => {});
    }
    const view = el.closest('[data-view]');
    if (view) return change(() => { st.view = view.dataset.view; st.filters = {}; st.q = ''; st.extra = Object.fromEntries(Object.keys(st.extra).map(k => [k, ''])); $('#ws-q', root).value = ''; });
    const saved = el.closest('[data-saved]');
    if (saved) { const v = savedViews(cfg.scope).find(x => x.id === saved.dataset.saved); if (v) applyQuery(v.query, v.layout); return; }
    const sop = el.closest('[data-saved-op]');
    if (sop) { sop.closest('details')?.removeAttribute('open'); return savedOp(sop.dataset.savedOp, sop.dataset.id).catch(showError); }
    if (el.closest('#ws-save-current') || el.closest('#ws-save-view')) return saveCurrent().catch(showError);
    if (el.closest('#ws-copy-link')) return copy(`${location.origin}${location.pathname}#${cfg.page}${query({ focus: false }) ? `?${query({ focus: false })}` : ''}`);
    const tog = el.closest('[data-toggle]');
    if (tog) { const k = tog.dataset.toggle; collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k); local.set(`ws.${cfg.scope}.collapsed`, [...collapsed]); return renderNav(); }
    const clr = el.closest('[data-clear]');
    if (clr) return change(() => delete st.filters[clr.dataset.clear]);
    const more = el.closest('[data-more]');
    if (more) { showMore.add(more.dataset.more); return renderNav(); }
    // 篩選條
    const chip = el.closest('[data-chip]');
    if (chip) return change(() => { const f = st.filters[chip.dataset.chip]; f[chip.dataset.chipKind] = []; if (!f.in.length && !f.not.length) delete st.filters[chip.dataset.chip]; });
    if (el.closest('[data-chip-view]')) return change(() => (st.view = cfg.defaultView || null));
    const ex = el.closest('[data-chip-extra]');
    if (ex) return change(() => (st.extra[ex.dataset.chipExtra] = ''));
    if (el.closest('#ws-clear-all')) return change(() => { st.filters = {}; st.q = ''; st.view = cfg.defaultView || null; st.extra = Object.fromEntries(Object.keys(st.extra).map(k => [k, ''])); $('#ws-q', root).value = ''; });
    const relax = el.closest('[data-relax]');
    if (relax) return change(() => relaxers[Number(relax.dataset.relax)]?.change(st));
    // 工具列
    if (el.closest('#ws-dir')) return change(() => (st.sort = st.sort.startsWith('-') ? st.sort.slice(1) : `-${st.sort}`), { keepRows: true });
    const th = el.closest('[data-sort]');
    if (th) return change(() => (st.sort = st.sort === `-${th.dataset.sort}` ? th.dataset.sort : `-${th.dataset.sort}`), { keepRows: true });
    const dens = el.closest('[data-density]');
    if (dens) { density = dens.dataset.density; local.set(`ws.${cfg.scope}.density`, density); syncTools(); return renderBody(); }
    const mode = el.closest('[data-mode]');
    if (mode) { st.mode = mode.dataset.mode; syncTools(); return reload(); }
    if (el.closest('#ws-filter-btn')) return wsEl.classList.toggle('nav-open');
    if (el.closest('#ws-select-all')) {
      const all = await cfg.source.page(st, 0, 1000);
      all.rows.forEach(r => sel.add(String(r.id)));
      selectAllPending = false;
      if (all.total > 1000) toast(t('最多一次選 {n} 個', { n: 1000 }));
      return syncSelection();
    }
    if (el.closest('#ws-unselect')) { sel.clear(); return syncSelection(); }
    const bulk = el.closest('[data-bulk]');
    if (bulk) { bulk.closest('details')?.removeAttribute('open'); return runBulk(bulk.dataset.bulk); }
    const gc = el.closest('[data-collapse]');
    if (gc) { const k = gc.dataset.collapse; groupCollapsed.has(k) ? groupCollapsed.delete(k) : groupCollapsed.add(k); return renderBody(); }
    // 行
    const tr = el.closest('tr.ws-row');
    if (!tr) return;
    const id = tr.dataset.id;
    const r = rows.find(x => String(x.id) === id);
    const act = el.closest('[data-act]');
    if (act) { const a = cfg.rowActions.find(x => x.key === act.dataset.act); try { await a?.run(r, api); } catch (err) { showError(err); } return; }
    if (el.closest('a')) { if (el.closest('a.ws-open')) { e.preventDefault(); openRow(r, e.metaKey || e.ctrlKey); } return; }
    if (el.closest('input[data-sel]') || e.shiftKey) {
      if (e.shiftKey && anchor) {
        const ids = rows.map(x => String(x.id));
        const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
        if (a >= 0) ids.slice(a, b + 1).forEach(x => sel.add(x));
      } else sel.has(id) ? sel.delete(id) : sel.add(id);
      anchor = id;
      selectAllPending = false;
      syncSelection();
      if (el.closest('input[data-sel]')) return;
    }
    const cell = el.closest('td[data-edit]');
    if (cell && !cell.querySelector('input')) return startEdit(cell, r);
    anchor = id;
    if (window.innerWidth < 700) return openRow(r);
    setFocus(id, { scroll: false });
  });
  root.addEventListener('dblclick', e => {
    const tr = e.target.closest('tr.ws-row');
    if (tr && !e.target.closest('input, button, td[data-edit]')) openRow(rows.find(x => String(x.id) === tr.dataset.id));
  });
  root.addEventListener('change', e => {
    if (e.target.id === 'ws-all') {
      rows.forEach(r => (e.target.checked ? sel.add(String(r.id)) : sel.delete(String(r.id))));
      selectAllPending = e.target.checked;
      return syncSelection();
    }
    if (e.target.id === 'ws-sort') return change(() => (st.sort = `${st.sort.startsWith('-') ? '-' : ''}${e.target.value}`), { keepRows: true });
    if (e.target.id === 'ws-group') return change(() => (st.group = e.target.value));
    const col = e.target.closest('[data-col]');
    if (col) {
      cols = cfg.columns.filter(c => (c.key === col.dataset.col ? col.checked : cols.includes(c.key))).map(c => c.key);
      local.set(`ws.${cfg.scope}.cols`, cols);
      return renderBody();
    }
  });
  root.addEventListener('input', e => {
    if (e.target.id === 'ws-q') { clearTimeout(searchTimer); searchTimer = setTimeout(() => onSearch(), 200); }
    const find = e.target.closest('[data-find]');
    if (find) {
      const q = find.value.trim().toLowerCase();
      $$(`[data-sec="${CSS.escape(find.dataset.find)}"] .ws-item`, root).forEach(b => (b.hidden = !!q && !b.textContent.toLowerCase().includes(q)));
    }
  });
  $('#ws-q', root).addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); onSearch(true); }
    if (e.key === 'Escape' && e.target.value) { e.preventDefault(); e.stopPropagation(); e.target.value = ''; onSearch(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); e.target.blur(); move(0); }
  });

  // 拖曳行到導航項（負責人、標籤）
  if (cfg.drop) {
    root.addEventListener('dragstart', e => {
      const tr = e.target.closest?.('tr.ws-row');
      if (!tr) return;
      const ids = sel.has(tr.dataset.id) ? [...sel] : [tr.dataset.id];
      e.dataTransfer.setData('text/x-ws-ids', JSON.stringify(ids));
      e.dataTransfer.setData('text/plain', ids.join(' '));
      e.dataTransfer.effectAllowed = 'copy';
      wsEl.classList.add('dragging');
    });
    root.addEventListener('dragend', () => { wsEl.classList.remove('dragging'); $$('.ws-item.drop-on', root).forEach(x => x.classList.remove('drop-on')); });
    root.addEventListener('dragover', e => {
      const it = e.target.closest?.('.ws-item[data-drop]');
      if (!it || !e.dataTransfer.types.includes('text/x-ws-ids')) return;
      e.preventDefault();
      $$('.ws-item.drop-on', root).forEach(x => x !== it && x.classList.remove('drop-on'));
      it.classList.add('drop-on');
    });
    root.addEventListener('drop', async e => {
      const it = e.target.closest?.('.ws-item[data-drop]');
      if (!it) return;
      e.preventDefault();
      it.classList.remove('drop-on');
      const ids = JSON.parse(e.dataTransfer.getData('text/x-ws-ids') || '[]');
      if (ids.length) { try { await cfg.drop(it.dataset.g, it.dataset.v, ids, api); } catch (err) { showError(err); } }
    });
  }

  // ---- 行內修改
  function startEdit(cell, r) {
    const col = cfg.columns.find(c => c.key === cell.dataset.edit);
    if (!col?.edit || (col.edit.when && !col.edit.when(r))) return;
    const old = col.edit.value(r);
    cell.innerHTML = `<input class="ws-inline" value="${esc(old ?? '')}" ${col.edit.type === 'number' ? `type="number" min="${col.edit.min}" max="${col.edit.max}"` : ''} aria-label="${esc(col.label)}">`;
    const box = $('input', cell);
    box.focus();
    box.select();
    let done = false;
    const finish = async save => {
      if (done) return;
      done = true;
      const v = box.value.trim();
      if (save && v !== String(old ?? '')) {
        try { await col.edit.save(r, v, api); return; } catch (err) { showError(err); }
      }
      cell.innerHTML = col.render(r, api);
    };
    box.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } });
    box.addEventListener('blur', () => finish(false));
  }

  // ---- 快捷鍵
  const inList = () => st.mode !== 'matrix';
  setPageKeys([
    { keys: '/', desc: t('聚焦列表搜索'), run: () => { $('#ws-q', root).focus(); $('#ws-q', root).select(); } },
    { keys: 'j,ArrowDown', desc: t('下一個（預覽跟著換）'), run: () => move(1), when: inList },
    { keys: 'k,ArrowUp', desc: t('上一個'), run: () => move(-1), when: inList },
    { keys: 'shift+j', desc: t('往下連續選擇'), run: () => move(1, true), when: inList },
    { keys: 'shift+k', desc: t('往上連續選擇'), run: () => move(-1, true), when: inList },
    { keys: 'Enter', desc: t('打開'), run: () => openRow(focusedRow()), when: () => inList() && !!st.focus },
    { keys: 'x', desc: t('選中 / 取消選中當前行'), run: () => { if (st.focus) { sel.has(st.focus) ? sel.delete(st.focus) : sel.add(st.focus); anchor = st.focus; syncSelection(); } }, when: inList },
    { keys: 'mod+a', desc: t('全選'), run: () => { rows.forEach(r => sel.add(String(r.id))); selectAllPending = true; syncSelection(); }, when: inList },
    { keys: '[', desc: t('收起或展開導航欄'), run: () => setLayout('nav', !layout.nav) },
    { keys: ']', desc: t('收起或展開預覽'), run: () => (window.innerWidth < 1280 ? wsEl.classList.toggle('preview-open') : setLayout('preview', !layout.preview)) },
    ...(cfg.newItem ? [{ keys: 'n', desc: cfg.newItem.label, run: () => cfg.newItem.run(st, api) }] : []),
    ...(cfg.bulk || []).filter(b => b.keys).map(b => ({ keys: b.keys, desc: t('{name}（已選或當前行）', { name: b.label }), run: () => runBulk(b.key), when: () => !b.when || b.when() })),
    { keys: 'Escape', desc: t('逐層退出：收起選單 → 取消選擇 → 關閉預覽 → 清空搜索'), run: () => {
      const menus = [...document.querySelectorAll('details.menu[open]')];
      if (menus.length) return menus.forEach(d => { d.open = false; });
      if (wsEl.classList.contains('nav-open')) return wsEl.classList.remove('nav-open');
      if (sel.size) { sel.clear(); selectAllPending = false; return syncSelection(); }
      if (window.innerWidth < 1280 && wsEl.classList.contains('preview-open')) return wsEl.classList.remove('preview-open');
      if (st.q) { $('#ws-q', root).value = ''; return onSearch(); }
      return false;
    } }
  ]);

  const api = {
    st, reload, sel, rows: () => rows, total: () => total, facets: () => facets, cols: () => visibleCols().map(c => c.key), rememberContext, setFocus, query, openRow, applyQuery,
    refreshRow: async () => reload({ keepRows: true }), clearSelection: () => { sel.clear(); syncSelection(); },
    showPreview, setMode: m => { st.mode = m; syncTools(); reload(); },
    setFilters: (filters, { add = false } = {}) => change(() => {
      if (!add) st.filters = {};
      for (const [k, f] of Object.entries(filters)) {
        if (!add || !st.filters[k]) st.filters[k] = { in: [...f.in], not: [...(f.not || [])] };
        else for (const v of f.in) if (!st.filters[k].in.includes(v)) st.filters[k].in.push(v);
      }
      st.mode = 'list';
      syncTools();
    })
  };
  syncTools();
  reload();
  return api;
}
