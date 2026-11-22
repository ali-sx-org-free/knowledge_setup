// 主體工作台（設計 §3–§10）、新增主體的預填與查重（§12）、批量導入（第二期）、批量整理與撤銷（§8）。
// 主體頁本身仍在 app.js（沿用條目操作與對話框）；列表上下文條與主體頁快捷鍵由這裡提供。
import { $, $$, esc, toast, modal, showError, download, copy, api, get, post, patch, level, pill, fmtTime, ago, field, input, select, formData, LEVEL_TEXT } from './core.js';
import { t, tk, tv } from './i18n.js';
import { mountWorkspace, multiParam, recentIds, pushRecent, prefsNow, listContext, local } from './workspace.js';
import { kbd, setPageKeys } from './keys.js';

let C = null;
const schema = () => C.schema();
const me = () => C.me();
const isOwner = () => C.isOwner();
const isHuman = () => me()?.isAdmin || me()?.kind === 'human';
/** 「我」作為負責人時的名字：設定 › 帳號中填寫的名字，否則是帳號名稱。 */
export const myName = () => prefsNow().ownerName || (me()?.isAdmin ? t('管理員') : me()?.name) || '';

export const STATE_TEXT = { pending: tk('待重驗'), conflict: tk('有衝突'), feedback: tk('有反饋'), expiring: tk('30 天內到期'), no_owner: tk('無負責人'), no_definition: tk('缺定義'), no_assertion: tk('無斷言'), isolated: tk('孤立'), ambiguous: tk('多義別名') };
const STATE_DESC = {
  pending: tk('有斷言、綁定或關係處於待重驗'), conflict: tk('有條目在未裁決的衝突中'), feedback: tk('有指向本主體或其條目的未處理反饋'),
  expiring: tk('有 L0 條目將在 30 天內到期'), no_owner: tk('沒有填寫負責人'), no_definition: tk('沒有填寫定義'), no_assertion: tk('沒有非 E1 的斷言'),
  isolated: tk('除別名外沒有任何非 E1 的關係'), ambiguous: tk('別名指向多個規範主體')
};
export const STATE_TONE = { pending: 'red', conflict: 'red', feedback: 'red', expiring: 'amber', ambiguous: 'amber', no_owner: 'gray', no_definition: 'gray', no_assertion: 'gray', isolated: 'gray' };
const FIELD_LABEL = { owner: tk('負責人'), ownerIds: tk('指定負責人'), errorCost: tk('出錯代價'), expiryDays: tk('有效期'), tags: tk('標籤') };
const DAY = 86400000;

const aliasesIncluded = st => !st.view || !!st.filters.type?.in.includes('別名');
const domainLabel = code => {
  const d = schema().domains.find(x => x.code === code);
  return d ? `${d.code} ${tv(d.name)}` : code;
};
const ownerLabel = v => (v === 'none' ? t('（無負責人）') : v);

// ------------------------------------------------------------------ 資料來源（服務端篩選、計數、分頁）
function params(st, extra = {}) {
  const p = new URLSearchParams();
  if (st.view === 'viewed') { p.set('view', 'all'); p.set('ids', recentIds('subjects').join(',') || '-'); }
  else if (st.view) p.set('view', st.view);
  if (st.q.trim()) p.set('q', st.q.trim());
  for (const [k, f] of Object.entries(st.filters)) { const v = multiParam(f); if (v) p.set(k, v); }
  if (st.extra?.ids) p.set('ids', st.extra.ids);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  return p;
}
const source = {
  async page(st, offset, limit) {
    const r = await api('GET', `/api/v1/subjects?${params(st, { sort: st.sort, offset, limit })}`);
    return { rows: r.data, total: r.page?.total ?? r.data.length };
  },
  facets: st => get(`/api/v1/subjects/facets?${params(st)}`)
};

// ------------------------------------------------------------------ 導航欄分組
const miniBar = c => {
  const total = (c?.L0 || 0) + (c?.L1 || 0) + (c?.L2 || 0);
  if (!total) return '';
  return `<span class="ws-bar" aria-hidden="true">${['L0', 'L1', 'L2'].map(k => (c[k] ? `<i class="${k}" style="width:${(c[k] / total) * 100}%"></i>` : '')).join('')}</span>`;
};
const typeOrder = () => Object.keys(schema().subjectTypes);
function domainItems(fc, st) {
  const single = st.filters.domain?.in.length === 1 ? st.filters.domain.in[0] : null;
  const codes = schema().domains.map(d => d.code);
  const extra = Object.keys(fc.groups.domain || {}).filter(c => !codes.includes(c));
  return [...schema().domains.map(d => ({ value: d.code, label: `${d.code} ${tv(d.name)}` })), ...extra.map(c => ({ value: c, label: c }))].map(it => {
    const c = fc.domainLevels?.[it.value] || {};
    const out = { ...it, bar: miniBar(c), title: t('{name}：{n} 個主體（L0 {l0} · L1 {l1} · L2 {l2}）', { name: it.label, n: (c.L0 || 0) + (c.L1 || 0) + (c.L2 || 0), l0: c.L0 || 0, l1: c.L1 || 0, l2: c.L2 || 0 }) };
    if (it.value === single) {
      out.children = typeOrder().filter(k => k !== '別名' || aliasesIncluded(st)).map(k => ({ group: 'type', value: k, label: tv(k), count: fc.groups.type?.[k] || 0 })).filter(x => x.count || st.filters.type?.in.includes(x.value));
    }
    return out;
  });
}
const byCount = obj => Object.entries(obj || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const GROUPS = () => [
  { key: 'domain', label: t('領域'), items: domainItems, valueLabel: domainLabel },
  { key: 'level', label: t('層級'), items: () => ['L0', 'L1', 'L2'].map(l => ({ value: l, label: LEVEL_TEXT[l], dot: l })), valueLabel: l => LEVEL_TEXT[l] || l },
  {
    key: 'state', label: t('狀態'), valueLabel: k => (STATE_TEXT[k] ? t(STATE_TEXT[k]) : k),
    items: (fc, st) => Object.keys(STATE_TEXT).filter(k => k !== 'ambiguous' || aliasesIncluded(st)).map(k => ({ value: k, label: t(STATE_TEXT[k]), title: t(STATE_DESC[k]), tone: STATE_TONE[k] }))
  },
  { key: 'type', label: t('類型'), collapsed: true, items: () => typeOrder().map(k => ({ value: k, label: tv(k) })), valueLabel: k => tv(k) },
  {
    key: 'owner', label: t('負責人'), collapsed: true, more: 8, drop: true, valueLabel: ownerLabel,
    items: fc => {
      const mine = myName();
      const list = byCount(fc.groups.owner).filter(([k]) => k !== 'none').map(([k]) => ({ value: k, label: k, pinned: k === mine }));
      if (mine && !list.some(x => x.value === mine)) list.push({ value: mine, label: mine, pinned: true });
      return [{ value: 'none', label: t('（無負責人）'), pinned: true, tone: 'gray' }, ...list];
    }
  },
  { key: 'tag', label: t('標籤'), collapsed: true, more: 10, drop: true, items: fc => byCount(fc.groups.tag).map(([k]) => ({ value: k, label: k })) }
];

// 搜索語法：鍵在三種語言下相同，另接受繁簡中文鍵；值可以寫代碼或顯示名稱。
const SYNTAX = () => ({
  keys: {
    domain: 'domain', 領域: 'domain', 领域: 'domain', level: 'level', 層級: 'level', 层级: 'level', type: 'type', 類型: 'type', 类型: 'type',
    owner: 'owner', 負責人: 'owner', 负责人: 'owner', tag: 'tag', 標籤: 'tag', 标签: 'tag', state: 'state', 狀態: 'state', 状态: 'state', is: 'is'
  },
  is: { ...Object.fromEntries(Object.keys(STATE_TEXT).map(k => [k, ['state', k]])), orphan: ['state', 'isolated'], noowner: ['state', 'no_owner'] },
  normalize: {
    domain: v => schema().domains.find(d => d.code.toLowerCase() === v.toLowerCase() || d.name === v || tv(d.name).toLowerCase() === v.toLowerCase())?.code || v.toUpperCase(),
    level: v => v.toUpperCase(),
    type: v => typeOrder().find(k => k === v || tv(k).toLowerCase() === v.toLowerCase()) || v,
    state: v => Object.keys(STATE_TEXT).find(k => k === v || t(STATE_TEXT[k]) === v) || v
  }
});

// ------------------------------------------------------------------ 表格欄位
const daysLeft = iso => Math.ceil((Date.parse(iso) - Date.now()) / DAY);
/** 狀態標記：有文字，不只靠顏色（「重驗 2」「6 天到期」「無斷言」）。 */
export function flagBadges(r, max = 3) {
  const text = f => (f === 'pending' ? t('重驗 {n}', { n: r.pending || 0 }) : f === 'expiring' && r.nextExpiry ? t('{n} 天到期', { n: Math.max(0, daysLeft(r.nextExpiry)) }) : t(STATE_TEXT[f] || f));
  const flags = r.flags || [];
  const shown = flags.slice(0, max).map(f => `<span class="badge ${STATE_TONE[f] === 'gray' ? '' : STATE_TONE[f]}" title="${esc(t(STATE_DESC[f] || f))}">${esc(text(f))}</span>`).join(' ');
  return shown + (flags.length > max ? ` <small class="muted" title="${esc(flags.slice(max).map(f => t(STATE_TEXT[f] || f)).join(t('、')))}">+${flags.length - max}</small>` : '');
}
const nameCell = r => {
  const alias = r.type === '別名';
  const sub = alias
    ? `<span class="cell-sub">${esc(t('別名 → {targets}', { targets: (r.aliasOf || []).join(t('、')) || '—' }))}</span>`
    : r.aliases?.length ? `<span class="ws-alias" title="${esc(t('別名：{list}', { list: r.aliases.join(t('、')) }))}">${esc(r.aliases.join(' · '))}</span>` : '';
  const hit = r.match?.alias ? ` <span class="badge blue">${esc(t('經別名 {name}', { name: r.match.alias }))}</span>` : '';
  return `<a class="ws-open" href="#subject/${esc(r.id)}" title="${esc(r.definition || '')}"><strong>${esc(r.name)}</strong></a>${sub}${hit}<span class="cell-sub ws-def">${esc(alias ? '' : r.definition || t('（未填寫定義）'))}</span>`;
};
const num = v => `<span class="numeric">${v ?? 0}</span>`;
const COLUMNS = () => [
  { key: 'id', label: 'ID', def: true, sort: 'id', render: r => `<span class="mono">${esc(r.id)}</span>` },
  { key: 'name', label: t('名稱'), always: true, sort: 'name', cls: 'ws-name-cell', render: nameCell },
  { key: 'type', label: t('類型'), render: r => esc(tv(r.type)) },
  { key: 'domain', label: t('領域'), def: true, render: r => `<span title="${esc(domainLabel(r.domain))}">${esc(r.domain)}</span>` },
  { key: 'level', label: t('綜合層級'), def: true, sort: 'level', render: r => (r.type === '別名' ? `<span class="muted">${t('不適用')}</span>` : level(r.level)) },
  { key: 'flags', label: t('狀態'), def: true, render: r => flagBadges(r) },
  { key: 'assertions', label: '#' + t('斷言'), def: true, cls: 'numeric', render: r => num(r.assertions) },
  { key: 'bindings', label: '#' + t('綁定'), cls: 'numeric', render: r => num(r.bindings) },
  { key: 'relations', label: '#' + t('關係'), cls: 'numeric', render: r => num(r.relations) },
  { key: 'pending', label: '#' + t('待重驗'), sort: 'pending', cls: 'numeric', render: r => (r.pending ? pill(r.pending, 'red') : '0') },
  { key: 'usage', label: '#' + t('使用'), def: true, sort: 'usage', cls: 'numeric', render: r => num(r.usage) },
  {
    key: 'errorCost', label: t('出錯代價'), sort: 'priority', cls: 'numeric', render: r => (r.type === '別名' ? '—' : `${r.errorCost ?? 3}`),
    edit: { type: 'number', min: 1, max: 5, when: r => r.type !== '別名', value: r => r.errorCost ?? 3, save: (r, v, ws) => saveField(r, { errorCost: Number(v) }, ws) }
  },
  {
    key: 'owner', label: t('負責人'), def: true, render: r => (r.type === '別名' ? '—' : r.owner ? esc(r.owner) : `<span class="muted">${t('（無）')}</span>`),
    edit: { when: r => r.type !== '別名', value: r => r.owner || '', save: (r, v, ws) => saveField(r, { owner: v }, ws) }
  },
  { key: 'tags', label: t('標籤'), render: r => (r.tags || []).map(x => `<span class="tag-chip">${esc(x)}</span>`).join(' ') || '<span class="muted">—</span>' },
  { key: 'updatedAt', label: t('更新'), def: true, sort: 'updated', render: r => `<span title="${esc(fmtTime(r.updatedAt))}">${ago(r.updatedAt)}</span>` },
  { key: 'nextExpiry', label: t('最近到期'), render: r => (r.nextExpiry ? `<span title="${esc(fmtTime(r.nextExpiry))}">${esc(t('{n} 天後', { n: Math.max(0, daysLeft(r.nextExpiry)) }))}</span>` : '—') }
];
async function saveField(r, body, ws) {
  await patch(`/api/v1/subjects/${r.id}`, body);
  toast(t('已保存 {id}', { id: r.id }));
  await ws.refreshRow();
}

// ------------------------------------------------------------------ 預覽（§6）
function previewHead(r) {
  return `<div class="ws-pv-head"><div class="chip-row"><span class="tag">${esc(r.id)}</span>${r.type === '別名' ? pill(t('別名')) : level(r.level)}<span class="badge">${esc(tv(r.type))} · ${esc(r.domain)}</span></div><h2>${esc(r.name)}</h2><p class="muted small">${esc(r.definition || (r.type === '別名' ? '' : t('（未填寫定義）')))}</p></div>`;
}
let previewSeq = 0;
async function preview(r, el, ws, { from = null } = {}) {
  const my = ++previewSeq;
  el.innerHTML = `${previewHead(r)}<p class="muted small">${t('載入中…')}</p>`;
  const card = await get(`/api/v1/subjects/${encodeURIComponent(r.id)}`);
  if (my !== previewSeq || !el.isConnected) return;
  pushRecent('subjects', r.id);
  const s = card.subject;
  const back = from ? `<button type="button" class="text-btn" data-pv-back="${esc(from)}">‹ ${esc(t('回到 {id}', { id: from }))}</button>` : '';
  if (s.type === '別名') {
    el.innerHTML = `${back}${previewHead({ ...r, ...s })}<div class="ws-pv-sec"><h3>${t('指向')}</h3>${card.alias.targets.map(x => `<button type="button" class="ws-pv-link" data-pv="${esc(x.id)}">${esc(x.id)} ${esc(x.name)}</button>`).join('')}<p class="notice ${card.alias.ambiguous ? 'warn' : ''}">${esc(card.alias.guidance)}</p></div><div class="ws-pv-actions"><a class="button primary" href="#subject/${esc(s.id)}" data-pv-open>${t('打開')} ${kbd('Enter')}</a></div>`;
    return;
  }
  const items = [
    ...card.assertions.map(a => ({ kind: 'assertion', id: a.id, level: a.level, v: a.validity, text: a.content })),
    ...card.bindings.map(b => ({ kind: 'binding', id: b.id, level: b.level, v: b.validity, text: `${b.object.id} ${b.object.name || ''}` })),
    ...card.relations.outgoing.map(x => ({ kind: 'relation', id: x.id, level: x.level, v: x.validity, text: `→ ${tv(x.type, 'rel')} ${x.to.name}` })),
    ...card.relations.incoming.map(x => ({ kind: 'relation', id: x.id, level: x.level, v: x.validity, text: `${x.from.name} ${tv(x.type, 'rel')} →` }))
  ];
  const pending = items.filter(x => x.v?.pending);
  const rels = [...card.relations.outgoing.map(x => ({ x, other: x.to, dir: 'out' })), ...card.relations.incoming.map(x => ({ x, other: x.from, dir: 'in' }))].filter(y => y.x.level !== 'E1');
  const active = card.assertions.filter(a => a.level !== 'E1');
  const sec = (k, label, n) => `<a href="#subject/${esc(s.id)}?sec=${k}" class="ws-pv-count" data-pv-open><strong>${n}</strong><small>${esc(label)}</small></a>`;
  el.innerHTML = `${back}${previewHead({ ...r, ...s })}
    ${pending.length ? `<div class="ws-pv-sec ws-pv-pending"><h3>${esc(t('待處理（{n}）', { n: pending.length }))}</h3>${pending.slice(0, 6).map(p => `<div class="ws-pv-item"><div><a href="#item/${esc(p.id)}" class="mono">${esc(p.id)}</a> ${pill(C.pendingLabel(p.v.pending), 'amber')}<span class="cell-sub">${esc(p.text)}</span></div>${C.rowOps(p.id, p.level)}</div>`).join('')}${pending.length > 6 ? `<a class="text-btn" href="#subject/${esc(s.id)}" data-pv-open>${esc(t('另外 {n} 條…', { n: pending.length - 6 }))}</a>` : ''}</div>` : ''}
    <div class="ws-pv-sec"><dl class="kv">
      <dt>${t('負責人')}</dt><dd><button type="button" class="text-btn ws-pv-edit" data-pv-owner>${esc(s.owner || t('（無）'))} ✎</button></dd>
      <dt>${t('出錯代價')}</dt><dd>${s.errorCost} / 5</dd>
      <dt>${t('別名')}</dt><dd>${card.aliases.map(a => esc(a.name)).join(t('、')) || '—'}</dd>
      <dt>${t('標籤')}</dt><dd>${(s.tags || []).map(x => `<span class="tag-chip">${esc(x)}</span>`).join(' ') || '—'}</dd>
      <dt>${t('使用次數')}</dt><dd>${r.usage ?? 0}</dd>
      <dt>${t('更新')}</dt><dd>${ago(s.updatedAt)}</dd>
    </dl></div>
    <div class="ws-pv-counts">${sec('assertions', t('斷言'), active.length)}${sec('bindings', t('綁定'), card.bindings.length)}${sec('relations', t('關係'), card.relations.outgoing.length + card.relations.incoming.length)}${sec('docs', t('文檔'), (card.documents || []).length)}</div>
    ${rels.length ? `<div class="ws-pv-sec"><h3>${t('關係')}</h3>${rels.slice(0, 3).map(y => `<button type="button" class="ws-pv-link" data-pv="${esc(y.other.id)}" title="${esc(t('在預覽中查看'))}">${y.dir === 'out' ? `${esc(tv(y.x.type, 'rel'))} → ` : ''}<strong>${esc(y.other.name)}</strong>${y.dir === 'in' ? ` → ${esc(tv(y.x.type, 'rel'))}` : ''} ${level(y.x.level)}</button>`).join('')}${rels.length > 3 ? `<a class="text-btn" href="#subject/${esc(s.id)}?sec=relations" data-pv-open>${esc(t('全部 {n} 條', { n: rels.length }))}</a>` : ''}</div>` : ''}
    <div class="ws-pv-actions"><a class="button primary" href="#subject/${esc(s.id)}" data-pv-open>${t('打開')} ${kbd('Enter')}</a><button type="button" class="button" data-pv-assert>${t('新增斷言')}</button><a class="button" href="#graph/${esc(s.id)}">${t('在圖譜中查看')}</a></div>`;
  el.onclick = async e => {
    const link = e.target.closest('[data-pv]');
    if (link) { const id = link.dataset.pv; return preview({ id, name: id, type: '', domain: '', usage: null }, el, ws, { from: s.id }).catch(showError); }
    const backBtn = e.target.closest('[data-pv-back]');
    if (backBtn) return ws.showPreview();
    if (e.target.closest('[data-pv-open]')) ws.rememberContext();
    if (e.target.closest('[data-pv-assert]')) return C.assertionDialog(s, card);
    if (e.target.closest('[data-pv-owner]')) return bulkOwner([s.id], ws);
  };
}

// ------------------------------------------------------------------ 矩陣（§7）
const MATRIX_COLS = [['pending', tk('待重驗'), 'red'], ['expiring', tk('30 天內到期'), 'amber'], ['no_owner', tk('無負責人'), 'amber'], ['no_definition', tk('缺定義'), 'amber'], ['no_assertion', tk('無斷言'), 'amber']];
const PIVOT_GROUP = { domain: 'domain', type: 'type', owner: 'owner' };
async function renderMatrix(el, st, ws) {
  const pivot = PIVOT_GROUP[st.rows] ? st.rows : 'domain';
  el.innerHTML = `<p class="muted small" style="padding:12px">${t('載入中…')}</p>`;
  const fc = await get(`/api/v1/subjects/facets?${params(st, { pivot })}`);
  const m = fc.matrix;
  const label = k => (pivot === 'domain' ? domainLabel(k) : pivot === 'type' ? tv(k) : ownerLabel(k));
  const heat = (n, max, tone) => (n ? ` heat-${tone}-${Math.min(4, Math.ceil((n / Math.max(1, max)) * 4))}` : '');
  const maxOf = k => Math.max(1, ...m.rows.map(r => r[k]));
  const cell = (row, child, col, n, tone) => `<td class="numeric ws-mx-cell${tone ? heat(n, maxOf(col), tone) : ''}">${n ? `<button type="button" class="ws-mx-btn" data-mx-row="${esc(row ?? '')}" data-mx-child="${esc(child ?? '')}" data-mx-col="${esc(col)}">${n}</button>` : '<span class="muted">0</span>'}</td>`;
  const rowHtml = (r, child = null) => {
    const key = child ? null : r.key;
    const rk = child ? child.parent : r.key;
    const ck = child ? r.key : null;
    const b = (r.L0 || 0) + (r.L1 || 0) + (r.L2 || 0);
    return `<tr class="${child ? 'ws-mx-child' : ''}"><th scope="row">${!child && r.children?.length ? `<button type="button" class="ws-caret${local.get('ws.subjects.mxOpen', []).includes(r.key) ? ' open' : ''}" data-mx-open="${esc(r.key)}" aria-expanded="${local.get('ws.subjects.mxOpen', []).includes(r.key)}">${esc(label(r.key))}</button>` : esc(child ? tv(r.key) : key === null ? '' : label(r.key))}</th>
      ${cell(rk, ck, 'total', r.total)}<td class="ws-mx-bar">${miniBar(r)}</td><td class="numeric">${b ? `${Math.round(((r.L0 || 0) / b) * 100)}%` : '—'}</td>
      ${['L0', 'L1', 'L2'].map(l => cell(rk, ck, l, r[l])).join('')}${MATRIX_COLS.map(([k, , tone]) => cell(rk, ck, k, r[k], tone)).join('')}<td class="numeric">${r.usage}</td></tr>`;
  };
  const open = new Set(local.get('ws.subjects.mxOpen', []));
  const body = m.rows.map(r => rowHtml(r) + (open.has(r.key) ? (r.children || []).map(c => rowHtml(c, { parent: r.key })).join('') : '')).join('');
  el.innerHTML = `<div class="ws-mx-tools"><div class="segmented" role="group" aria-label="${esc(t('矩陣的行'))}">${[['domain', t('按領域')], ['type', t('按類型')], ['owner', t('按負責人')]].map(([k, l]) => `<button type="button" data-mx-pivot="${k}" class="${k === pivot ? 'active' : ''}" aria-pressed="${k === pivot}">${esc(l)}</button>`).join('')}</div><span class="muted small">${t('點任何一格回到列表並篩選；{mod}＋點擊是加到當前條件上。', { mod: kbd('mod').replace(/<\/?kbd>/g, '') })}</span><button type="button" class="button" id="mx-csv">${t('導出 CSV')}</button></div>
    <div class="table-scroll"><table class="ws-matrix"><thead><tr><th>${esc(pivot === 'domain' ? t('領域') : pivot === 'type' ? t('類型') : t('負責人'))}</th><th class="numeric">${t('主體數')}</th><th>${t('層級構成')}</th><th class="numeric" title="${esc(t('該行中 L0 主體的比例；與健康指標的「L0 覆蓋率」（只看高頻主體）不同'))}">${t('L0 佔比')}</th><th class="numeric">L0</th><th class="numeric">L1</th><th class="numeric">L2</th>${MATRIX_COLS.map(([, l]) => `<th class="numeric">${esc(t(l))}</th>`).join('')}<th class="numeric">${t('使用次數')}</th></tr></thead>
    <tbody>${body || `<tr><td colspan="13" class="muted">${t('沒有符合條件的主體')}</td></tr>`}</tbody><tfoot>${rowHtml({ ...m.totals, key: null })}</tfoot></table></div>`;
  el.onclick = e => {
    const pv = e.target.closest('[data-mx-pivot]');
    if (pv) { st.rows = pv.dataset.mxPivot; return ws.setMode('matrix'); }
    const op = e.target.closest('[data-mx-open]');
    if (op) { const k = op.dataset.mxOpen; open.has(k) ? open.delete(k) : open.add(k); local.set('ws.subjects.mxOpen', [...open]); return renderMatrix(el, st, ws); }
    if (e.target.closest('#mx-csv')) {
      const head = [label === null ? '' : pivot, 'total', 'L0', 'L1', 'L2', ...MATRIX_COLS.map(([k]) => k), 'usage'];
      const lines = [head, ...m.rows.flatMap(r => [[label(r.key), r.total, r.L0, r.L1, r.L2, ...MATRIX_COLS.map(([k]) => r[k]), r.usage], ...(r.children || []).map(c => [`${label(r.key)} / ${tv(c.key)}`, c.total, c.L0, c.L1, c.L2, ...MATRIX_COLS.map(([k]) => c[k]), c.usage])]), [t('合計'), m.totals.total, m.totals.L0, m.totals.L1, m.totals.L2, ...MATRIX_COLS.map(([k]) => m.totals[k]), m.totals.usage]];
      return download(`subjects-matrix-${pivot}.csv`, '﻿' + lines.map(l => l.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
    }
    const b = e.target.closest('[data-mx-col]');
    if (!b) return;
    const f = {};
    if (b.dataset.mxRow) f[PIVOT_GROUP[pivot]] = { in: [b.dataset.mxRow], not: [] };
    if (b.dataset.mxChild) f.type = { in: [b.dataset.mxChild], not: [] };
    const col = b.dataset.mxCol;
    if (['L0', 'L1', 'L2'].includes(col)) f.level = { in: [col], not: [] };
    else if (col !== 'total') f.state = { in: [col], not: [] };
    if (e.metaKey || e.ctrlKey) return ws.setFilters(f, { add: true });
    ws.setFilters({ ...Object.fromEntries(Object.entries(ws.st.filters).filter(([k]) => !(k in f))), ...f });
  };
}
const csvCell = v => {
  const s = String(v ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

// ------------------------------------------------------------------ 批量整理（§8）：預覽 → 提交 → 撤銷
const fmtValue = (f, v) => (Array.isArray(v) ? v.join(t('、')) || '—' : v === null || v === undefined || v === '' ? (f === 'expiryDays' ? t('預設') : '—') : f === 'expiryDays' ? t('{n} 天', { n: v }) : String(v));
function planHtml(plan) {
  const rows = plan.updated.slice(0, 60).map(u => `<tr><td class="mono">${esc(u.id)}</td><td>${esc(u.name)}</td><td class="wrap">${Object.entries(u.changes).map(([f, c]) => `${esc(t(FIELD_LABEL[f] || f))}${t('：')}<span class="muted">${esc(fmtValue(f, c.from))}</span> → <strong>${esc(fmtValue(f, c.to))}</strong>`).join('<br>')}</td></tr>`).join('');
  const skipped = plan.skipped.length ? `<details class="batch-skip" ${plan.updated.length ? '' : 'open'}><summary>${esc(t('跳過 {n} 個', { n: plan.skipped.length }))}</summary><div class="table-scroll"><table><tbody>${plan.skipped.slice(0, 100).map(s => `<tr><td class="mono">${esc(s.id)}</td><td>${esc(s.name || '')}</td><td class="wrap">${esc(s.reason)}</td></tr>`).join('')}</tbody></table></div></details>` : '';
  return `<p class="batch-sum"><strong>${esc(t('將修改 {n} 個', { n: plan.updated.length }))}</strong>${plan.skipped.length ? ` · ${esc(t('跳過 {n} 個', { n: plan.skipped.length }))}` : ''}</p>
    ${plan.updated.length ? `<div class="table-scroll batch-table"><table><thead><tr><th>ID</th><th>${t('名稱')}</th><th>${t('修改')}</th></tr></thead><tbody>${rows}</tbody></table></div>${plan.updated.length > 60 ? `<p class="muted small">${esc(t('另外 {n} 個…', { n: plan.updated.length - 60 }))}</p>` : ''}` : ''}
    ${skipped}${plan.updated.length ? `<p class="muted small">${t('提交說明')}${t('：')}<code>${esc(plan.message)}</code></p>` : ''}`;
}

/** 最近一次批量：提示條的「撤銷」10 分鐘內有效；同一時間也顯示在列表底部。 */
const LAST_KEY = 'ws.subjects.lastBatch';
function rememberBatch(r) {
  try { sessionStorage.setItem(LAST_KEY, JSON.stringify({ commit: r.commit, message: r.data.message, n: r.data.updated.length, at: Date.now() })); } catch { /* 略過 */ }
}
function lastBatch() {
  try { const x = JSON.parse(sessionStorage.getItem(LAST_KEY) || 'null'); return x && Date.now() - x.at < 600000 ? x : null; } catch { return null; }
}
export async function undoBatch(commit, after) {
  const r = await post('/api/v1/subjects/batch/undo', { commit });
  const d = r.data;
  try { if (lastBatch()?.commit === commit) sessionStorage.removeItem(LAST_KEY); } catch { /* 略過 */ }
  toast(d.skipped.length ? t('已撤銷：還原 {n} 個主體，{m} 個在批量之後又被修改過，未撤銷', { n: d.updated.length, m: d.skipped.length }) : t('已撤銷：還原 {n} 個主體', { n: d.updated.length }), 6000);
  await after?.();
}

async function organizeDialog(ws, ids, { title, form, body }) {
  let timer;
  let seq = 0;
  modal(title, `<div id="batch-form">${form}</div><div id="batch-plan" class="batch-plan" aria-live="polite"></div>`, {
    label: t('提交'),
    run: async () => {
      const b = body();
      if (!b) throw new Error(t('請先填寫要修改的內容'));
      const r = await post('/api/v1/subjects/batch', { ids, ...b });
      if (!r.data.updated.length) { toast(t('沒有需要修改的主體')); return; }
      if (r.undoable) rememberBatch(r);
      toast(t('已修改 {n} 個主體', { n: r.data.updated.length }), 600000, r.undoable ? { label: t('撤銷'), run: () => undoBatch(r.commit, () => ws.reload({ keepRows: true })) } : null);
      ws.clearSelection();
      await ws.reload({ keepRows: true });
    }
  });
  const refresh = async () => {
    const my = ++seq;
    const b = body();
    const box = $('#batch-plan');
    if (!box) return;
    if (!b) { box.innerHTML = ''; return; }
    try {
      const r = await post('/api/v1/subjects/batch', { ids, ...b, dryRun: true });
      if (my === seq && box.isConnected) box.innerHTML = planHtml(r.data);
    } catch (err) { if (my === seq && box.isConnected) box.innerHTML = `<p class="notice warn">${esc(err.message)}</p>`; }
  };
  const formEl = $('#batch-form');
  const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 250); };
  formEl.addEventListener('input', later);
  formEl.addEventListener('change', later);
  refresh();
}
const ownerOptions = ws => `<datalist id="owner-options">${Object.keys(ws?.facets()?.groups?.owner || {}).filter(k => k !== 'none').map(k => `<option value="${esc(k)}">`).join('')}</datalist>`;
const tagOptions = ws => `<datalist id="tag-options">${Object.keys(ws?.facets()?.groups?.tag || {}).map(k => `<option value="${esc(k)}">`).join('')}</datalist>`;
const splitList = v => String(v || '').split(/[,，、;；\n]/).map(x => x.trim()).filter(Boolean);
const val = name => $(`#dialog-content [name="${name}"]`)?.value ?? '';

function bulkOwner(ids, ws) {
  return organizeDialog(ws, ids, {
    title: t('改負責人（{n} 個主體）', { n: ids.length }),
    form: `${ownerOptions(ws)}${field(t('新負責人'), input('owner', myName(), `list="owner-options" placeholder="${esc(t('留空表示清除負責人'))}"`), t('對主體知識有效性負責的人；預設是你自己（「設定 › 帳號」可改名字）'))}
      ${isOwner() ? `<label class="check"><input type="checkbox" name="setOwnerIds"> ${t('同時設定指定負責人（只有他能確認、改有效期）')}</label><div id="owner-ids" hidden>${field(t('指定負責人的金鑰 ID（逗號分隔，留空表示清除）'), input('ownerIds', '', `placeholder="${esc(t('例如 key_xxx'))}"`))}</div>` : ''}`,
    body: () => {
      const box = $('#owner-ids');
      const on = !!$('#dialog-content [name=setOwnerIds]')?.checked;
      if (box) box.hidden = !on;
      return { set: { owner: val('owner').trim() || null, ...(on ? { ownerIds: splitList(val('ownerIds')) } : {}) } };
    }
  });
}
function bulkTags(ids, ws) {
  return organizeDialog(ws, ids, {
    title: t('標籤（{n} 個主體）', { n: ids.length }),
    form: `${tagOptions(ws)}<div class="field-pair">${field(t('加上標籤'), input('addTags', '', `list="tag-options" placeholder="${esc(t('多個用逗號分隔'))}"`))}${field(t('去掉標籤'), input('removeTags', '', `list="tag-options" placeholder="${esc(t('多個用逗號分隔'))}"`))}</div><p class="muted small">${t('主體和文檔共用一份標籤字典；新標籤會自動加入字典。')}</p>`,
    body: () => {
      const addTags = splitList(val('addTags'));
      const removeTags = splitList(val('removeTags'));
      return addTags.length || removeTags.length ? { addTags, removeTags } : null;
    }
  });
}
function bulkErrorCost(ids, ws) {
  return organizeDialog(ws, ids, {
    title: t('出錯代價（{n} 個主體）', { n: ids.length }),
    form: field(t('出錯代價（1–5）'), select('errorCost', ['1', '2', '3', '4', '5'], '3'), t('出錯代價 × 使用次數決定重驗優先級')),
    body: () => ({ set: { errorCost: Number(val('errorCost')) } })
  });
}
function bulkExpiry(ids, ws) {
  return organizeDialog(ws, ids, {
    title: t('有效期（{n} 個主體）', { n: ids.length }),
    form: field(t('有效期覆蓋（天）'), input('expiryDays', '', 'type="number" min="1" max="3650"'), t('留空表示清除覆蓋、恢復規則參數中的預設值')),
    body: () => ({ set: { expiryDays: val('expiryDays') ? Number(val('expiryDays')) : null } })
  });
}

async function bulkValidate(ids, ws) {
  if (ids.length > 500) throw new Error(t('單次批量最多 {n} 個主體', { n: 500 }));
  toast(t('正在校驗 {n} 個主體…', { n: ids.length }), 20000);
  const d = (await post('/api/v1/validate-batch', { subjectIds: ids })).data;
  const parts = [t('校驗 {subjects} 個主體的 {total} 條：通過 {passed}，不符 {mismatched}，客體缺失 {missing}，失敗 {errors}', d)];
  if (d.async) parts.push(t('{n} 條 RPA 校驗在後台執行', { n: d.async }));
  if (d.noAction) parts.push(t('{n} 條沒有可用的校驗 Action', { n: d.noAction }));
  toast(parts.join(t('；')), 9000, d.async ? { label: t('執行記錄'), run: () => { location.hash = 'executions'; } } : null);
  await ws?.reload({ keepRows: true });
}

const KIND_TEXT = { assertion: tk('斷言'), binding: tk('綁定'), relation: tk('關係') };
async function bulkConfirm(ids, ws) {
  const items = (await post('/api/v1/items/confirmable', { subjectIds: ids })).data;
  if (!items.length) return toast(t('所選主體下沒有可以確認的條目：只有附了證據的 L1 條目能確認為 L0'), 6000);
  const ok = items.filter(x => x.canConfirm).length;
  modal(t('確認為 L0（{n} 個主體）', { n: ids.length }), `<p class="notice">${t('列出所選主體下全部附了證據的 L1 條目。逐條核對後勾選，一次確認；確認後晉升為 L0，有效期按規則參數計算。')}</p>
    <label class="check"><input type="checkbox" id="confirm-all" ${ok ? 'checked' : 'disabled'}> ${esc(t('全選可確認的 {n} 條', { n: ok }))}</label>
    <div class="table-scroll batch-table"><table><thead><tr><th></th><th>ID</th><th>${t('種類')}</th><th>${t('主體')}</th><th>${t('內容')}</th><th>${t('證據')}</th></tr></thead><tbody>${items.map(x => `<tr${x.canConfirm ? '' : ' class="muted"'}><td class="check-cell"><input type="checkbox" data-item="${esc(x.id)}" ${x.canConfirm ? 'checked' : 'disabled'} aria-label="${esc(x.id)}"></td><td class="mono">${esc(x.id)}</td><td>${esc(t(KIND_TEXT[x.kind]))}</td><td>${esc(x.subject?.name || '')}</td><td class="wrap">${esc(x.summary)}${x.reason ? `<span class="cell-sub">${esc(x.reason)}</span>` : ''}${x.pending ? ` ${pill(C.pendingLabel(x.pending), 'amber')}` : ''}</td><td class="wrap">${C.evidenceCell({ evidence: x.evidence })}</td></tr>`).join('')}</tbody></table></div>
    ${field(t('確認說明（選填）'), input('note', '', `placeholder="${esc(t('例如：已對照口徑文檔 v3 核實'))}"`))}`, {
    label: t('確認為 L0'),
    run: async () => {
      const chosen = $$('#dialog-content input[data-item]:checked').map(b => items.find(x => x.id === b.dataset.item)).map(x => ({ id: x.id, version: x.version }));
      if (!chosen.length) throw new Error(t('請至少勾選一條'));
      await post('/api/v1/items/confirm-batch', { items: chosen, note: val('note') });
      toast(t('已確認 {n} 條為 L0', { n: chosen.length }));
      await ws?.reload({ keepRows: true });
    }
  });
  $('#confirm-all').onchange = e => $$('#dialog-content input[data-item]:not(:disabled)').forEach(b => (b.checked = e.target.checked));
}

async function bulkHandbook(ids) {
  if (ids.length > 50) throw new Error(t('一次最多為 {n} 個主體生成手冊', { n: 50 }));
  modal(t('生成主體手冊（{n} 個主體）', { n: ids.length }), `<p class="notice">${t('每個主體一篇主體手冊：正文從知識生成、只讀；已有手冊時重新生成，知識沒有變化時不產生新版本。')}</p><div id="handbook-progress" class="muted small"></div>`, {
    label: t('生成'),
    run: async () => {
      const box = $('#handbook-progress');
      const done = { created: 0, changed: 0, same: 0, failed: [] };
      for (const [i, id] of ids.entries()) {
        box.textContent = t('正在生成 {i} / {n}：{id}', { i: i + 1, n: ids.length, id });
        try {
          const r = await post('/api/v1/docs/generate', { subjectId: id });
          if (r.data.created) done.created++;
          else if (r.data.changed) done.changed++;
          else done.same++;
        } catch (err) { done.failed.push(`${id}${t('：')}${err.message}`); }
      }
      toast(t('手冊：新生成 {created}，重新生成 {changed}，沒有變化 {same}，失敗 {failed}', { ...done, failed: done.failed.length }), 8000);
      if (done.failed.length) { box.innerHTML = `<div class="notice warn">${done.failed.map(esc).join('<br>')}</div>`; return true; }
    }
  });
}

async function exportCsv(st, ids, cols) {
  const columns = cols.filter(k => k !== 'state').join(',');
  const fetchCsv = async p => {
    const res = await fetch(`/api/v1/subjects/export?${p}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message || res.statusText);
    return (await res.text()).replace(/^﻿/, '');
  };
  let text;
  if (ids) {
    const parts = [];
    for (let i = 0; i < ids.length; i += 200) {
      const csv = await fetchCsv(new URLSearchParams({ ids: ids.slice(i, i + 200).join(','), columns, sort: st.sort || '-usage' }));
      parts.push(i ? csv.split(/\r?\n/).slice(1).join('\r\n') : csv);
    }
    text = parts.filter(Boolean).join('\r\n');
  } else {
    const p = params(st, { sort: st.sort, columns });
    p.delete('limit');
    text = await fetchCsv(p);
  }
  download(`subjects-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + text, 'text/csv;charset=utf-8');
}

async function bulkRelations(ids, ws) {
  const sc = schema();
  const opts = await C.subjectOptions();
  modal(t('批量新增關係（{n} 個主體）', { n: ids.length }), `${opts}<p class="notice">${t('所選主體逐個與目標主體建立同一種關係；方向必須符合關係類型的定義，不合規的跳過並說明。附證據時最高 L1，否則 L2。')}</p>
    ${field(t('關係類型'), select('type', Object.entries(sc.relationTypes).map(([k, v]) => [k, `${tv(k, 'rel')}${t('：')}${v.direction}`]), '依賴'))}
    <div class="field-pair">${field(t('方向'), select('direction', [['out', t('所選主體 → 目標')], ['in', t('目標 → 所選主體')]], 'out'))}${field(t('目標主體'), input('target', '', 'list="subject-options" required'))}</div>
    ${field(t('明確來源（選填）'), input('sourceRef', '', `placeholder="${esc(t('調用鏈、表血緣、設計文檔…'))}"`))}
    <div id="rel-plan" class="batch-plan"></div>`, {
    label: t('新增'),
    run: async () => {
      const d = formData($('#dialog-content'));
      const body = { subjectIds: ids, type: d.type, direction: d.direction, target: String(d.target || '').trim().split(/\s+/)[0], evidence: d.sourceRef ? { sourceRef: d.sourceRef } : undefined };
      if (!$('#rel-plan').dataset.ready || $('#rel-plan').dataset.ready !== JSON.stringify(body)) {
        const plan = (await post('/api/v1/relations/batch', { ...body, dryRun: true })).data;
        $('#rel-plan').dataset.ready = JSON.stringify(body);
        $('#rel-plan').innerHTML = `<p class="batch-sum"><strong>${esc(t('將新增 {n} 條', { n: plan.ok.length }))}</strong>${plan.skipped.length ? ` · ${esc(t('跳過 {n} 個', { n: plan.skipped.length }))}` : ''}</p>${plan.skipped.length ? `<div class="table-scroll batch-table"><table><tbody>${plan.skipped.map(s => `<tr><td class="mono">${esc(s.id)}</td><td>${esc(s.name || '')}</td><td class="wrap">${esc(s.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}<p class="muted small">${t('再按一次「新增」提交。')}</p>`;
        return true;
      }
      const r = await post('/api/v1/relations/batch', body);
      toast(t('已新增 {n} 條關係', { n: r.data.created.length }));
      await ws?.reload({ keepRows: true });
    }
  });
}

function showInGraph(ids) {
  try { sessionStorage.setItem('graph.ids', JSON.stringify(ids.slice(0, 300))); } catch { /* 略過 */ }
  location.hash = 'graph?selection=1';
}

// ------------------------------------------------------------------ 新增主體（§12）：預填、查重、連續新增；別名
/** existing：編輯；preset：{ type, domain, aliasOf, name }。 */
export async function subjectDialog(existing, preset = {}) {
  const sc = schema();
  const opts = await C.subjectOptions();
  const s = existing || {};
  const editing = !!existing;
  const type = s.type || preset.type || '指標';
  const tags = await get('/api/v1/docs/tags').catch(() => []);
  modal(editing ? t('編輯主體 {id}', { id: s.id }) : t('新增主體'), `${opts}<datalist id="tag-options">${(Array.isArray(tags) ? tags : []).map(x => `<option value="${esc(x.name || x)}">`).join('')}</datalist>
    ${field(t('名稱（規範名）'), input('name', s.name ?? preset.name ?? '', 'required autocomplete="off"'))}
    <div id="similar-box" aria-live="polite"></div>
    <div class="field-pair">${field(t('類型'), select('type', Object.entries(sc.subjectTypes).map(([k, v]) => [k, `${tv(k)} — ${v.desc}`]), type, editing ? 'disabled' : 'id="subject-type"'))}${field(t('領域'), select('domain', sc.domains.map(d => [d.code, C.domainName(d)]), s.domain || preset.domain || sc.domains[0]?.code, editing ? 'disabled' : ''))}</div>
    <div id="alias-box" hidden>${field(t('別名指向的規範主體（多個用逗號分隔，表示一詞多義）'), input('aliasOf', (preset.aliasOf || []).join(', '), `list="subject-options" placeholder="${esc(t('S-INV-0012 可售庫存'))}"`))}</div>
    <div id="canon-box">
    ${field(t('定義'), `<textarea name="definition" rows="3" placeholder="${esc(t('一句話說明它是什麼、不是什麼'))}">${esc(s.definition || '')}</textarea>`)}
    <div class="field-pair">${field(t('負責人'), input('owner', editing ? s.owner : preset.owner ?? myName(), `placeholder="${esc(t('對該主體知識有效性負責的人'))}"`))}${field(t('出錯代價（1–5）'), input('errorCost', s.errorCost ?? 3, 'type="number" min="1" max="5"'), t('用於重驗優先級'))}</div>
    ${field(t('標籤（選填，逗號分隔）'), input('tags', (s.tags || []).join(', '), 'list="tag-options"'))}
    ${editing ? field(t('有效期覆蓋（天，選填）'), input('expiryDays', s.expiryDays || '', 'type="number" min="1"'), t('負責人可按主體調整有效期')) : ''}
    </div>
    ${editing ? '' : `<label class="check"><input type="checkbox" name="continue" ${local.get('subjects.continue', false) ? 'checked' : ''}> ${t('連續新增：保存後保留領域、類型和負責人，清空名稱和定義')}</label>`}`, {
    label: editing ? t('保存') : t('新增'),
    run: async () => {
      const d = formData($('#dialog-content'));
      const tagList = splitList(d.tags);
      if (editing) {
        const body = { name: d.name, definition: d.definition, owner: d.owner, errorCost: Number(d.errorCost), tags: tagList };
        if (String(d.expiryDays || '') !== String(s.expiryDays || '')) body.expiryDays = d.expiryDays ? Number(d.expiryDays) : null;
        await patch(`/api/v1/subjects/${s.id}`, body);
        toast(t('已保存'));
        C.render();
        return;
      }
      const t2 = $('#subject-type').value;
      const body = { name: d.name, type: t2, domain: d.domain };
      if (t2 === '別名') body.aliasOf = d.aliasOf.split(/[,，]/).map(x => x.trim().split(/\s+/)[0]).filter(Boolean);
      else Object.assign(body, { definition: d.definition, owner: d.owner, errorCost: Number(d.errorCost), tags: tagList });
      const r = await post('/api/v1/subjects', body);
      const cont = $('#dialog-content [name=continue]')?.checked;
      local.set('subjects.continue', !!cont);
      if (cont) {
        toast(t('已新增 {id}，繼續下一個', { id: r.data.id }));
        $('#dialog-content [name=name]').value = '';
        $('#dialog-content [name=definition]').value = '';
        $('#similar-box').innerHTML = '';
        $('#dialog-content [name=name]').focus();
        C.onSubjectCreated?.();
        return true;
      }
      toast(t('已新增 {id}', { id: r.data.id }));
      location.hash = `subject/${r.data.id}`;
    }
  });
  const typeSel = $('#subject-type');
  if (typeSel) {
    const sync = () => { $('#alias-box').hidden = typeSel.value !== '別名'; $('#canon-box').hidden = typeSel.value === '別名'; };
    typeSel.onchange = sync;
    sync();
  }
  // 查重：輸入名稱時顯示同名、別名命中與相似名稱；可以一鍵改為新增別名
  const nameBox = $('#dialog-content [name=name]');
  let timer;
  let seq = 0;
  const check = async () => {
    const my = ++seq;
    const name = nameBox.value.trim();
    const box = $('#similar-box');
    if (!box) return;
    if (name.length < 2) { box.innerHTML = ''; return; }
    const hits = (await get(`/api/v1/subjects/similar?name=${encodeURIComponent(name)}`).catch(() => [])).filter(h => h.id !== s.id);
    if (my !== seq || !box.isConnected) return;
    if (!hits.length) { box.innerHTML = ''; return; }
    const line = h => {
      const target = h.aliasOf?.[0];
      const what = h.kind === 'exact' ? t('已有同名主體') : h.kind === 'alias' ? t('是 {target} 的別名', { target: (h.aliasOf || []).map(x => `${x.id} ${x.name}`).join(t('、')) }) : t('名稱相似');
      const canon = h.type === '別名' ? target : h;
      const btn = !editing && canon && h.kind !== 'exact' && h.kind !== 'alias' ? `<button type="button" class="text-btn" data-as-alias="${esc(canon.id)}">${esc(t('改為新增「{name}」的別名', { name: canon.name }))}</button>` : '';
      return `<li><a href="#subject/${esc(h.id)}" target="_blank" rel="noopener">${esc(h.id)} ${esc(h.name)}</a> <small class="muted">${esc(what)}</small> ${btn}</li>`;
    };
    const exact = hits.some(h => h.kind === 'exact' || h.kind === 'alias');
    box.innerHTML = `<div class="notice ${exact ? 'warn' : ''} similar-box"><strong>${exact ? t('這個名稱已經存在') : t('可能重複：')}</strong><ul>${hits.slice(0, 5).map(line).join('')}</ul></div>`;
  };
  nameBox.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(check, 250); });
  if (nameBox.value) check();
  $('#dialog-content').querySelector('#similar-box').onclick = e => {
    const b = e.target.closest('[data-as-alias]');
    if (!b) return;
    typeSel.value = '別名';
    typeSel.onchange();
    $('#dialog-content [name=aliasOf]').value = b.dataset.asAlias;
    const target = schema().domains.find(d => b.dataset.asAlias.startsWith(`S-${d.code}-`));
    if (target) $('#dialog-content [name=domain]').value = target.code;
    toast(t('已改為新增別名'));
  };
}

// ------------------------------------------------------------------ 批量導入（第二期）：貼上表格或 CSV
const IMPORT_HEADERS = {
  name: ['name', '名稱', '名称', '主體', '主体'], type: ['type', '類型', '类型'], domain: ['domain', '領域', '领域'], definition: ['definition', '定義', '定义'],
  owner: ['owner', '負責人', '负责人'], aliases: ['aliases', 'alias', '別名', '别名'], tags: ['tags', 'tag', '標籤', '标签'], errorCost: ['errorcost', 'error cost', '出錯代價', '出错代价']
};
export function parseTable(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] || '';
  const sep = first.includes('\t') ? '\t' : first.split(',').length >= first.split(';').length ? ',' : ';';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const data = rows.filter(r => r.some(c => c.trim()));
  if (!data.length) return { rows: [], unknown: [] };
  const head = data[0].map(h => h.trim().toLowerCase());
  const map = head.map(h => Object.entries(IMPORT_HEADERS).find(([, names]) => names.includes(h))?.[0] || null);
  if (!map.includes('name')) throw new Error(t('第一行必須是表頭，並包含「名稱」欄'));
  return {
    rows: data.slice(1).map(r => Object.fromEntries(map.map((k, i) => [k, (r[i] || '').trim()]).filter(([k]) => k))),
    unknown: data[0].filter((h, i) => !map[i] && h.trim())
  };
}
const IMPORT_STATUS = { create: ['新增', 'green'], skip: ['跳過', 'amber'], error: ['錯誤', 'red'] };
export function importDialog(after) {
  let planned = null;
  modal(t('批量導入主體'), `<p class="notice">${t('從 Excel 複製表格貼上，或選 CSV 檔案。第一行是表頭：名稱、類型、領域（代碼或名稱）、定義、負責人、別名、標籤、出錯代價；多個別名或標籤用逗號或頓號分隔。先預覽每行的查重和校驗結果，再一次提交。')}</p>
    ${field(t('CSV 檔案'), '<input type="file" name="file" accept=".csv,.tsv,.txt,text/csv">')}
    ${field(t('或貼上表格'), `<textarea name="table" rows="8" spellcheck="false" placeholder="${esc(t('名稱\t類型\t領域\t定義\n可用庫存\t指標\tINV\t…'))}"></textarea>`)}
    <div id="import-plan" class="batch-plan" aria-live="polite"></div>`, {
    label: t('預覽'),
    run: async () => {
      const text = val('table');
      const parsed = parseTable(text);
      if (!parsed.rows.length) throw new Error(t('沒有可以導入的行'));
      const key = JSON.stringify(parsed.rows);
      if (!planned || planned.key !== key) {
        const plan = (await post('/api/v1/subjects/import', { rows: parsed.rows, dryRun: true })).data.rows;
        planned = { key, plan };
        const n = plan.filter(x => x.status === 'create').length;
        const aliasN = plan.filter(x => x.status === 'create').reduce((m, x) => m + x.aliasPlan.filter(a => a.status === 'create').length, 0);
        $('#import-plan').innerHTML = `${parsed.unknown.length ? `<p class="notice warn">${esc(t('不認識的欄位會被忽略：{list}', { list: parsed.unknown.join(t('、')) }))}</p>` : ''}<p class="batch-sum"><strong>${esc(t('將新增 {n} 個主體、{m} 個別名', { n, m: aliasN }))}</strong> · ${esc(t('跳過 {n} 行', { n: plan.filter(x => x.status === 'skip').length }))} · ${esc(t('錯誤 {n} 行', { n: plan.filter(x => x.status === 'error').length }))}</p>
          <div class="table-scroll batch-table"><table><thead><tr><th>#</th><th>${t('結果')}</th><th>${t('名稱')}</th><th>${t('類型')}</th><th>${t('領域')}</th><th>${t('別名')}</th><th>${t('說明')}</th></tr></thead><tbody>${plan.map(x => `<tr><td class="numeric">${x.index + 2}</td><td>${pill(t(IMPORT_STATUS[x.status][0]), IMPORT_STATUS[x.status][1])}</td><td>${esc(x.name)}</td><td>${esc(tv(x.type))}</td><td>${esc(x.domain)}</td><td class="wrap">${x.aliasPlan.map(a => `${esc(a.name)}${a.status === 'skip' ? ` <small class="muted" title="${esc(a.reason)}">${t('（跳過）')}</small>` : ''}`).join(t('、')) || '—'}</td><td class="wrap">${esc(x.reason || '')}</td></tr>`).join('')}</tbody></table></div>`;
        $('#dialog-action').textContent = n ? t('導入 {n} 個', { n }) : t('預覽');
        return true;
      }
      if (!planned.plan.some(x => x.status === 'create')) throw new Error(t('沒有可以新增的行'));
      const r = await post('/api/v1/subjects/import', { rows: parsed.rows });
      toast(t('已導入 {n} 個主體', { n: r.data.created.length }));
      await after?.();
    }
  });
  $('#dialog-content [name=file]').onchange = async e => {
    const f = e.target.files?.[0];
    if (f) $('#dialog-content [name=table]').value = await f.text();
  };
  $('#dialog-content [name=table]').addEventListener('input', () => { planned = null; $('#dialog-action').textContent = t('預覽'); });
}

// ------------------------------------------------------------------ 主體頁：列表上下文條與快捷鍵（§11）
/** 從列表進來時：「‹ 返回列表」、篩選標籤、「第 n / N 個」、上一個、下一個；直接打開鏈接時返回空字串。 */
export function subjectContext(id) {
  const c = listContext(id);
  if (!c) return { html: '', prev: null, next: null, back: null };
  const i = c.ids.indexOf(id);
  // 返回列表時把當前行設為這個主體（按 j / k 走過幾個之後，回到列表也停在這裡）
  const [path, q] = c.hash.split('?');
  const p = new URLSearchParams(q || '');
  if (c.page === 'subjects') p.set('focus', id);
  c.hash = `${path}${p.toString() ? `?${p}` : ''}`;
  const prev = i > 0 ? c.ids[i - 1] : null;
  const next = i < c.ids.length - 1 ? c.ids[i + 1] : null;
  const html = `<nav class="ctx-bar" aria-label="${esc(t('列表位置'))}"><a href="${esc(c.hash)}" class="text-btn">‹ ${t('返回列表')} ${kbd('u')}</a><span class="ctx-label" title="${esc(c.label)}">${esc(c.label)}</span><span class="ctx-pos">${esc(t('第 {i} / {n} 個', { i: i + 1, n: c.total || c.ids.length }))}</span><span class="ctx-nav">${prev ? `<a class="button" href="#subject/${esc(prev)}" aria-label="${esc(t('上一個'))}">‹ ${kbd('k')}</a>` : `<button class="button" disabled aria-label="${esc(t('上一個'))}">‹</button>`}${next ? `<a class="button" href="#subject/${esc(next)}" aria-label="${esc(t('下一個'))}">${kbd('j')} ›</a>` : `<button class="button" disabled aria-label="${esc(t('下一個'))}">›</button>`}</span></nav>`;
  return { html, prev, next, back: c.hash };
}

/** 主體頁快捷鍵：j/k 上一個下一個、u 返回列表、1–6 跳到區塊、n 新增選單、y 複製 ID、e 編輯。 */
export function subjectPageKeys({ id, ctx, sections, onNew, onEdit }) {
  setPageKeys([
    { keys: 'j', desc: t('列表中的下一個主體'), run: () => (ctx.next ? (location.hash = `subject/${ctx.next}`) : toast(t('已經是列表中的最後一個'))) },
    { keys: 'k', desc: t('列表中的上一個主體'), run: () => (ctx.prev ? (location.hash = `subject/${ctx.prev}`) : toast(t('已經是列表中的第一個'))) },
    { keys: 'u', desc: t('返回列表（保留篩選和位置）'), run: () => { location.hash = ctx.back || 'subjects'; } },
    ...sections.map((s, i) => ({ keys: String(i + 1), desc: t('跳到「{name}」', { name: s.label }), run: () => { const el = document.getElementById(s.id); el?.scrollIntoView({ behavior: 'smooth', block: 'start' }); el?.querySelector('h2, button, a')?.focus({ preventScroll: true }); } })),
    ...(onNew ? [{ keys: 'n', desc: t('新增（斷言、綁定、關係、文檔）'), run: onNew }] : []),
    ...(onEdit ? [{ keys: 'e', desc: t('編輯主體'), run: onEdit }] : []),
    { keys: 'y', desc: t('複製主體 ID'), run: () => copy(id) }
  ]);
}

// ------------------------------------------------------------------ 工作台頁面
const VIEWS = () => [
  { key: 'all', label: t('全部主體'), icon: 'grid' },
  { key: 'mine', label: t('我負責的'), icon: 'user' },
  { key: 'hot', label: t('高頻未達 L0'), icon: 'fire' },
  { key: 'recent', label: t('最近更新'), icon: 'clock' },
  { key: 'viewed', label: t('最近查看'), icon: 'eye', count: () => recentIds('subjects').length }
];

async function pageSubjects() {
  C.setActions(`<button class="button" id="export-csv">${t('導出 CSV')}</button>${me().role !== 'consumer' || me().isAdmin ? `<button class="button" id="import-subjects">${t('批量導入')}</button><button class="button primary" id="add-subject">${t('新增主體')} ${kbd('n')}</button>` : ''}`);
  const contributor = me().isAdmin || me().role !== 'consumer';
  const newItem = st => subjectDialog(null, {
    domain: st.filters.domain?.in.length === 1 ? st.filters.domain.in[0] : undefined,
    type: st.filters.type?.in.length === 1 ? st.filters.type.in[0] : undefined,
    owner: st.filters.owner?.in.length === 1 && st.filters.owner.in[0] !== 'none' ? st.filters.owner.in[0] : undefined
  });
  const ws = mountWorkspace(C.content(), {
    scope: 'subjects', page: 'subjects', source,
    views: VIEWS(), defaultView: 'all', groups: GROUPS(), syntax: SYNTAX(), columns: COLUMNS(),
    sorts: [['usage', t('使用次數')], ['priority', t('優先級（使用 × 代價）')], ['updated', t('最近更新')], ['pending', t('待重驗數')], ['level', t('綜合層級')], ['name', t('名稱')], ['id', 'ID']],
    defaultSort: '-usage',
    groupBy: [
      ['domain', t('領域'), r => [r.domain, domainLabel(r.domain)]],
      ['type', t('類型'), r => [r.type, tv(r.type)]],
      ['owner', t('負責人'), r => [r.owner || 'none', ownerLabel(r.owner || 'none')]],
      ['level', t('綜合層級'), r => [r.level || '—', r.level ? LEVEL_TEXT[r.level] : t('別名')]]
    ],
    preview: (r, el, w) => preview(r, el, w),
    rowActions: contributor ? [
      { key: 'validate', label: t('校驗'), when: r => r.type !== '別名', run: (r, w) => bulkValidate([r.id], w) },
      ...(isOwner() ? [{ key: 'confirm', label: t('確認'), when: r => r.type !== '別名', run: (r, w) => bulkConfirm([r.id], w) }] : []),
      { key: 'edit', label: t('編輯'), run: r => subjectDialog({ ...r }) }
    ] : [],
    bulk: contributor ? [
      { key: 'owner', label: t('改負責人'), keys: 'a', run: (ids, w) => bulkOwner(ids, w) },
      { key: 'tags', label: t('標籤'), keys: 't', run: (ids, w) => bulkTags(ids, w) },
      { key: 'validate', label: t('校驗'), keys: 'v', run: (ids, w) => bulkValidate(ids, w) },
      ...(isOwner() ? [{ key: 'confirm', label: t('確認為 L0'), keys: 'c', run: (ids, w) => bulkConfirm(ids, w) }] : []),
      { key: 'edit', label: t('編輯'), keys: 'e', hidden: true, run: (ids, w) => { const r = w.rows().find(x => x.id === (w.st.focus || ids[0])) || w.rows().find(x => x.id === ids[0]); if (r) subjectDialog({ ...r }); } },
      { key: 'errorCost', label: t('出錯代價'), more: true, run: (ids, w) => bulkErrorCost(ids, w) },
      ...(isOwner() ? [{ key: 'expiry', label: t('有效期'), more: true, run: (ids, w) => bulkExpiry(ids, w) }] : []),
      { key: 'relations', label: t('批量新增關係'), more: true, run: (ids, w) => bulkRelations(ids, w) },
      ...(isHuman() ? [
        { key: 'handbook', label: t('生成手冊'), more: true, run: ids => bulkHandbook(ids) },
        { key: 'draft', label: t('AI 起草'), more: true, run: ids => { if (ids.length > 10) throw new Error(t('AI 起草最多選 10 個主體')); return C.aiDraftDialog({ subjects: ids }); } }
      ] : []),
      { key: 'graph', label: t('在圖譜中顯示'), more: true, run: ids => showInGraph(ids) },
      { key: 'export', label: t('導出 CSV'), more: true, run: (ids, w) => exportCsv(w.st, ids, w.cols()) }
    ] : [
      { key: 'graph', label: t('在圖譜中顯示'), more: true, run: ids => showInGraph(ids) },
      { key: 'export', label: t('導出 CSV'), more: true, run: (ids, w) => exportCsv(w.st, ids, w.cols()) }
    ],
    open: r => `subject/${r.id}`,
    drop: contributor ? async (group, value, ids, w) => {
      if (group === 'owner') return organizeDialog(w, ids, { title: t('改負責人（{n} 個主體）', { n: ids.length }), form: `<p>${esc(t('把負責人改為「{name}」', { name: ownerLabel(value) }))}</p>`, body: () => ({ set: { owner: value === 'none' ? null : value } }) });
      if (group === 'tag') return organizeDialog(w, ids, { title: t('標籤（{n} 個主體）', { n: ids.length }), form: `<p>${esc(t('加上標籤「{name}」', { name: value }))}</p>`, body: () => ({ addTags: [value] }) });
    } : null,
    matrix: { label: t('矩陣'), render: renderMatrix },
    newItem: contributor ? { label: t('新增主體（預填當前篩選的領域和類型）'), run: newItem } : null,
    footExtra: () => {
      const b = lastBatch();
      return b ? `<span class="ws-last">${esc(t('最近一次批量：已修改 {n} 個', { n: b.n }))} <button type="button" class="text-btn" data-undo-last="${esc(b.commit)}">${t('撤銷')}</button></span>` : '';
    },
    noun: n => t('{n} 個主體', { n }), nounName: t('主體'),
    searchPlaceholder: t('名稱、ID、別名、定義、標籤、負責人；可寫 domain:INV is:pending'),
    extraParams: ['ids'], extraLabel: { ids: v => t('指定的 {n} 個主體', { n: v.split(',').length }) },
    emptyHint: esc(t('搜索語法：domain:INV、level:L2、type:指標、owner:none、tag:口徑、is:pending、-type:別名'))
  });
  C.content().addEventListener('click', e => {
    const u = e.target.closest('[data-undo-last]');
    if (u) undoBatch(u.dataset.undoLast, () => ws.reload({ keepRows: true })).catch(showError);
  });
  C.onSubjectCreated = () => ws.reload({ keepRows: true });
  $('#add-subject')?.addEventListener('click', () => newItem(ws.st));
  $('#import-subjects')?.addEventListener('click', () => importDialog(() => ws.reload()));
  $('#export-csv').onclick = () => exportCsv(ws.st, null, ws.cols()).catch(showError);
}

export function registerSubjectPages(PAGES, ctx) {
  C = ctx;
  PAGES.subjects = pageSubjects;
}

export { organizeDialog, bulkValidate, bulkConfirm };
