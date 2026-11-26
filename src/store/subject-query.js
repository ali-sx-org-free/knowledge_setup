// 主體工作台的查詢與批量整理（設計：docs/design/subject-management.md §4、§5、§7、§8、§15）。
//   查詢：多值篩選（逗號分隔，! 開頭為排除）、狀態標記、內置視圖、聯動計數、矩陣、排序與分頁。
//   批量：先算計畫（將修改 / 跳過與原因），再在事務中套用；撤銷按記錄寫反向提交。
//   派生索引（別名、狀態標記、搜索文字）按 store.gen 快取：每次寫入（t.touch）或重新載入後重算一次。
import { RuleError, hasEvidence } from './validity.js';
import { SUBJECT_TYPES } from './model.js';
import { tr, tk } from '../i18n/index.js';

export const SUBJECT_STATES = {
  pending: tk('待重驗'), conflict: tk('有衝突'), feedback: tk('有反饋'), expiring: tk('30 天內到期'),
  no_owner: tk('無負責人'), no_definition: tk('缺定義'), no_assertion: tk('無斷言'), isolated: tk('孤立'), ambiguous: tk('多義別名')
};
export const SUBJECT_SORTS = ['usage', 'priority', 'updated', 'id', 'name', 'level', 'pending'];
export const SUBJECT_VIEWS = ['all', 'mine', 'hot', 'recent'];
export const FACET_GROUPS = ['domain', 'type', 'level', 'state', 'owner', 'tag'];
export const PIVOTS = ['domain', 'type', 'owner'];
export const MAX_LIMIT = 1000;
export const MAX_BATCH = 500;
export const EXPORT_COLUMNS = {
  id: 'ID', name: tk('名稱'), type: tk('類型'), domain: tk('領域'), level: tk('綜合層級'), flags: tk('狀態'), assertions: tk('斷言數'), bindings: tk('綁定數'),
  relations: tk('關係數'), pending: tk('待重驗數'), usage: tk('使用次數'), errorCost: tk('出錯代價'), owner: tk('負責人'), tags: tk('標籤'),
  aliases: tk('別名'), updatedAt: tk('更新時間'), nextExpiry: tk('最近到期日'), definition: tk('定義')
};
const DEFAULT_EXPORT = ['id', 'name', 'type', 'domain', 'level', 'flags', 'assertions', 'pending', 'usage', 'errorCost', 'owner', 'tags', 'updatedAt'];
const DAY = 86400000;
const EXPIRING_DAYS = 30;
const RECENT_DAYS = 14;
const LEVEL_ORDER = { L0: 0, L1: 1, L2: 2 };
const FLAG_ORDER = Object.keys(SUBJECT_STATES);
const collator = new Intl.Collator('zh-Hant');
const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const bad = (message, code = 'invalid_input') => new RuleError(message, 400, code);
const clean = v => (typeof v === 'string' ? v.trim() : v);
const nowIso = () => new Date().toISOString();
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ------------------------------------------------------------------ 參數解析

/** "INV,ORD,!別名" → { in: ['INV','ORD'], not: ['別名'] }；沒有值時返回 null。 */
export function parseMulti(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : String(value).split(',');
  const out = { in: [], not: [] };
  for (const raw of list) {
    const s = String(raw).trim();
    if (!s || s === '!') continue;
    if (s.startsWith('!')) out.not.push(s.slice(1).trim());
    else out.in.push(s);
  }
  return out.in.length || out.not.length ? out : null;
}

export function parseSubjectQuery(p = {}) {
  const state = parseMulti(p.state);
  for (const s of [...(state?.in || []), ...(state?.not || [])]) {
    if (!SUBJECT_STATES[s]) throw bad(tr('未知狀態 {state}；可用：{list}', { state: s, list: FLAG_ORDER.join(', ') }));
  }
  let sort = null;
  if (p.sort) {
    const raw = String(p.sort);
    const key = raw.replace(/^[-+]/, '');
    if (!SUBJECT_SORTS.includes(key)) throw bad(tr('{field} 必須為 {values}', { field: 'sort', values: SUBJECT_SORTS.join(' / ') }));
    sort = { key, desc: raw.startsWith('-') };
  }
  if (p.view && !SUBJECT_VIEWS.includes(p.view)) throw bad(tr('{field} 必須為 {values}', { field: 'view', values: SUBJECT_VIEWS.join(' / ') }));
  const since = p.updatedSince ? Date.parse(p.updatedSince) : null;
  if (p.updatedSince && Number.isNaN(since)) throw bad(tr('{field} 必須是 ISO 日期', { field: 'updatedSince' }));
  const limit = p.limit === undefined || p.limit === null || p.limit === '' ? 500 : Number(p.limit);
  if (!Number.isInteger(limit) || limit < 0) throw bad(tr('{field} 必須是 0–{max} 的整數', { field: 'limit', max: MAX_LIMIT }));
  const offset = p.offset === undefined || p.offset === '' ? 0 : Number(p.offset);
  if (!Number.isInteger(offset) || offset < 0) throw bad(tr('{field} 必須是非負整數', { field: 'offset' }));
  const ids = Array.isArray(p.ids) ? p.ids : p.ids ? String(p.ids).split(',') : null;
  return {
    terms: String(p.q ?? '').toLowerCase().split(/\s+/).filter(Boolean),
    domain: parseMulti(p.domain), type: parseMulti(p.type), level: parseMulti(p.level), state, owner: parseMulti(p.owner), tag: parseMulti(p.tag),
    ownerId: clean(p.ownerId) || null,
    mine: p.mine === true || p.mine === 1 || p.mine === '1' || p.mine === 'true',
    updatedSince: since,
    view: p.view || null,
    ids: ids ? new Set(ids.map(x => String(x).trim()).filter(Boolean)) : null,
    sort, offset, limit: Math.min(MAX_LIMIT, limit)
  };
}

// ------------------------------------------------------------------ 派生索引

/** 別名索引、每個主體的狀態標記、待重驗數、最近到期日、搜索文字。寫入後（store.gen 變化）重算。 */
export function derived(store) {
  const cached = store._derived;
  if (cached && cached.gen === store.gen) return cached;
  const aliasesOf = new Map();
  const aliasTargets = new Map();
  const relations = new Map();
  const relPending = new Map();
  const relExpiry = new Map();
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const push = (m, k, v) => (m.has(k) ? m.get(k).push(v) : m.set(k, [v]));
  for (const r of store.relations.values()) {
    const v = r.validity;
    if (v.level === 'E1') continue;
    if (v.pending) inc(relPending, r.from);
    if (v.level === 'L0' && v.expiresAt && (!relExpiry.has(r.from) || v.expiresAt < relExpiry.get(r.from))) relExpiry.set(r.from, v.expiresAt);
    if (r.type === '別名') {
      push(aliasTargets, r.from, r.to);
      push(aliasesOf, r.to, { id: r.from, relationId: r.id, level: v.level });
    } else {
      inc(relations, r.from);
      inc(relations, r.to);
    }
  }
  const conflicts = new Set();
  for (const c of store.conflicts.values()) if (c.status === 'open') for (const id of c.subjects || []) conflicts.add(id);
  const feedback = new Set();
  for (const f of store.feedback.values()) if (f.status === 'open' && f.subjectId) feedback.add(f.subjectId);
  const info = new Map();
  for (const s of store.subjects.values()) {
    const alias = s.type === '別名';
    let pending = relPending.get(s.id) || 0;
    let nextExpiry = relExpiry.get(s.id) || null;
    for (const x of [...s.assertions, ...s.bindings]) {
      const v = x.validity;
      if (v.level === 'E1') continue;
      if (v.pending) pending++;
      if (v.level === 'L0' && v.expiresAt && (!nextExpiry || v.expiresAt < nextExpiry)) nextExpiry = v.expiresAt;
    }
    const flags = [];
    if (alias) {
      if ((aliasTargets.get(s.id) || []).length > 1) flags.push('ambiguous');
    } else {
      if (pending) flags.push('pending');
      if (conflicts.has(s.id)) flags.push('conflict');
      if (feedback.has(s.id)) flags.push('feedback');
      if (!s.owner) flags.push('no_owner');
      if (!s.definition) flags.push('no_definition');
      if (!s.assertions.some(a => a.validity.level !== 'E1')) flags.push('no_assertion');
      if (!relations.get(s.id)) flags.push('isolated');
    }
    const aliasNames = (aliasesOf.get(s.id) || []).map(a => store.subjects.get(a.id)?.name).filter(Boolean);
    info.set(s.id, {
      level: alias ? null : store.subjectLevel(s),
      pending, nextExpiry, flags, relations: relations.get(s.id) || 0, aliasNames,
      own: [s.id, s.name, s.definition, s.owner, ...(s.tags || [])].filter(Boolean).join('\n').toLowerCase(),
      hay: [s.id, s.name, s.definition, s.owner, ...(s.tags || []), ...aliasNames].filter(Boolean).join('\n').toLowerCase()
    });
  }
  store._derived = { gen: store.gen, aliasesOf, aliasTargets, info };
  return store._derived;
}

/** 健康指標「L0 覆蓋率」統計的高頻主體中沒有 L0 知識的那些（內置視圖「高頻未達 L0」）。 */
export function hotWithoutL0(store) {
  const canonical = [...store.subjects.values()].filter(s => s.type !== '別名');
  const used = canonical.map(s => ({ s, count: store.usage.subjects[s.id]?.count || 0 })).filter(x => x.count > 0).sort((a, b) => b.count - a.count);
  const ratio = store.config.highFrequencyRatio || 0.2;
  const hot = used.length ? used.slice(0, Math.max(1, Math.ceil(used.length * ratio))).map(x => x.s) : canonical;
  const hasL0 = s => store.subjectLevel(s) === 'L0' || s.assertions.some(a => a.validity.level === 'L0');
  return new Set(hot.filter(s => !hasL0(s)).map(s => s.id));
}

// ------------------------------------------------------------------ 篩選

function matchMulti(f, values) {
  if (!f) return true;
  if (f.in.length && !values.some(v => f.in.includes(v))) return false;
  if (f.not.length && values.some(v => f.not.includes(v))) return false;
  return true;
}

const lowerMulti = f => (f ? { in: f.in.map(x => x.toLowerCase()), not: f.not.map(x => x.toLowerCase()) } : null);

/**
 * 對每個主體算出：基本條件（搜索、視圖、ownerId 等）是否滿足，以及每個導航分組是否滿足。
 * 帶 view 時（後台總是帶）別名預設不出現，除非類型條件選了「別名」——這條算在「類型」分組裡，
 * 所以類型分組的計數仍能看到別名有多少個。
 */
function evaluate(store, q, { me = null, now = Date.now() } = {}) {
  const d = derived(store);
  const hot = q.view === 'hot' ? hotWithoutL0(store) : null;
  const tagF = lowerMulti(q.tag);
  const aliasAllowed = !q.view || !!q.type?.in.includes('別名');
  const mine = s => !!me && ((s.ownerIds || []).includes(me.id) || (!!me.name && s.owner === me.name));
  const out = [];
  for (const s of store.subjects.values()) {
    const inf = d.info.get(s.id);
    let flags = inf.flags;
    if (s.type !== '別名' && inf.nextExpiry && Date.parse(inf.nextExpiry) - now <= EXPIRING_DAYS * DAY) {
      flags = FLAG_ORDER.filter(k => k === 'expiring' || inf.flags.includes(k));
    }
    const updated = Date.parse(s.updatedAt || 0) || 0;
    const base = (!q.terms.length || q.terms.every(t => inf.hay.includes(t)))
      && (!q.ownerId || (s.ownerIds || []).includes(q.ownerId))
      && (!q.mine || mine(s))
      && (q.updatedSince === null || updated >= q.updatedSince)
      && (!q.ids || q.ids.has(s.id))
      && (q.view !== 'mine' || mine(s))
      && (q.view !== 'hot' || hot.has(s.id))
      && (q.view !== 'recent' || now - updated <= RECENT_DAYS * DAY);
    const g = {
      domain: matchMulti(q.domain, [s.domain]),
      type: (aliasAllowed || s.type !== '別名') && matchMulti(q.type, [s.type]),
      level: matchMulti(q.level, inf.level ? [inf.level] : []),
      state: matchMulti(q.state, flags),
      owner: matchMulti(q.owner, [s.owner || 'none']),
      tag: matchMulti(tagF, (s.tags || []).map(x => x.toLowerCase()))
    };
    out.push({ s, inf, flags, base, g, updated, mine: mine(s) });
  }
  return out;
}

const passes = e => e.base && FACET_GROUPS.every(k => e.g[k]);

function rowOf(store, d, { s, inf, flags }) {
  return {
    id: s.id, name: s.name, type: s.type, domain: s.domain, owner: s.owner || null, ownerIds: s.ownerIds || [], definition: s.definition || null,
    level: inf.level, assertions: s.assertions.length, bindings: s.bindings.length, relations: inf.relations,
    aliasOf: s.type === '別名' ? d.aliasTargets.get(s.id) || [] : undefined,
    aliases: s.type === '別名' ? undefined : inf.aliasNames,
    usage: store.usage.subjects[s.id]?.count || 0, pending: inf.pending,
    errorCost: s.errorCost ?? 3, expiryDays: s.expiryDays || null, tags: s.tags || [],
    flags, nextExpiry: inf.nextExpiry, updatedAt: s.updatedAt
  };
}

const SORT_KEYS = {
  usage: r => r.usage, priority: r => (r.usage + 1) * r.errorCost, updated: r => r.updatedAt || '', id: r => r.id,
  name: r => r.name || '', level: r => LEVEL_ORDER[r.level] ?? 9, pending: r => r.pending
};

function sortRows(rows, sort) {
  if (!sort) return rows.sort((a, b) => cmpId(a.id, b.id));
  const key = SORT_KEYS[sort.key];
  const dir = sort.desc ? -1 : 1;
  const cmp = sort.key === 'name' ? collator.compare : cmpId;
  return rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = typeof x === 'string' ? cmp(x, y) : x - y;
    return c * dir || cmpId(a.id, b.id);
  });
}

/** 列表：返回當前頁的行與總數。opts.all 時忽略分頁（批量「全部符合條件的」用）。 */
export function querySubjects(store, params = {}, opts = {}) {
  const q = parseSubjectQuery(params);
  const d = derived(store);
  const rows = evaluate(store, q, opts).filter(passes).map(e => rowOf(store, d, e));
  sortRows(rows, q.sort);
  const page = opts.all ? rows : rows.slice(q.offset, q.offset + q.limit);
  if (q.terms.length) {
    for (const r of page) {
      const inf = d.info.get(r.id);
      const miss = q.terms.find(t => !inf.own.includes(t));
      if (miss) {
        const alias = inf.aliasNames.find(n => n.toLowerCase().includes(miss));
        if (alias) r.match = { alias };
      }
    }
  }
  return { rows: page, total: rows.length, offset: opts.all ? 0 : q.offset, limit: opts.all ? rows.length : q.limit };
}

/**
 * 聯動計數：每個值 =「保持其他分組條件不變，點下去會剩幾個」。一次遍歷：
 * 主體只有一個分組不滿足時，只計入那一組；全部滿足時計入每一組與總數。
 * views 是內置視圖本身的數量（不受篩選影響）；domainLevels 是各領域全部主體的層級構成（不隨篩選變化）。
 */
export function subjectFacets(store, params = {}, opts = {}) {
  const q = parseSubjectQuery({ ...params, limit: 0, offset: 0 });
  const evals = evaluate(store, q, opts);
  const groups = Object.fromEntries(FACET_GROUPS.map(k => [k, {}]));
  const add = (k, v) => (groups[k][v] = (groups[k][v] || 0) + 1);
  let total = 0;
  const views = { all: 0, mine: 0, hot: 0, recent: 0 };
  const domainLevels = {};
  const hot = hotWithoutL0(store);
  const now = opts.now ?? Date.now();
  for (const e of evals) {
    if (e.s.type !== '別名') {
      views.all++;
      if (e.mine) views.mine++;
      if (hot.has(e.s.id)) views.hot++;
      if (now - e.updated <= RECENT_DAYS * DAY) views.recent++;
      const dl = (domainLevels[e.s.domain] ||= { L0: 0, L1: 0, L2: 0 });
      dl[e.inf.level]++;
    }
    if (!e.base) continue;
    const fails = FACET_GROUPS.filter(k => !e.g[k]);
    if (fails.length > 1) continue;
    if (!fails.length) total++;
    const on = k => !fails.length || fails[0] === k;
    if (on('domain')) add('domain', e.s.domain);
    if (on('type')) add('type', e.s.type);
    if (on('level') && e.inf.level) add('level', e.inf.level);
    if (on('state')) for (const f of e.flags) add('state', f);
    if (on('owner')) add('owner', e.s.owner || 'none');
    if (on('tag')) for (const tg of e.s.tags || []) add('tag', tg);
  }
  const out = { total, groups, views, domainLevels };
  if (params.pivot) out.matrix = pivotOf(store, evals, params.pivot);
  return out;
}

const MATRIX_COLUMNS = ['pending', 'expiring', 'no_owner', 'no_definition', 'no_assertion'];

/** 矩陣：行為領域（展開到類型）、類型或負責人；列為主體數、層級構成與問題數。別名不計。 */
function pivotOf(store, evals, pivot) {
  if (!PIVOTS.includes(pivot)) throw bad(tr('{field} 必須為 {values}', { field: 'pivot', values: PIVOTS.join(' / ') }));
  const blank = key => ({ key, total: 0, L0: 0, L1: 0, L2: 0, pending: 0, expiring: 0, no_owner: 0, no_definition: 0, no_assertion: 0, usage: 0 });
  const acc = (r, e) => {
    r.total++;
    r[e.inf.level]++;
    for (const f of MATRIX_COLUMNS) if (e.flags.includes(f)) r[f]++;
    r.usage += store.usage.subjects[e.s.id]?.count || 0;
  };
  const rows = new Map();
  const totals = blank('total');
  for (const e of evals) {
    if (!passes(e) || e.s.type === '別名') continue;
    const key = pivot === 'owner' ? e.s.owner || 'none' : e.s[pivot];
    if (!rows.has(key)) rows.set(key, { ...blank(key), children: pivot === 'domain' ? new Map() : undefined });
    const r = rows.get(key);
    acc(r, e);
    acc(totals, e);
    if (r.children) {
      if (!r.children.has(e.s.type)) r.children.set(e.s.type, blank(e.s.type));
      acc(r.children.get(e.s.type), e);
    }
  }
  const typeOrder = Object.keys(SUBJECT_TYPES);
  const domainOrder = store.config.domains.map(x => x.code);
  const rank = (order, k) => (order.includes(k) ? order.indexOf(k) : order.length);
  let list = [...rows.values()];
  if (pivot === 'domain') {
    for (const code of domainOrder) if (!rows.has(code)) list.push({ ...blank(code), children: new Map() });
    list.sort((a, b) => rank(domainOrder, a.key) - rank(domainOrder, b.key) || cmpId(a.key, b.key));
  } else if (pivot === 'type') list.sort((a, b) => rank(typeOrder, a.key) - rank(typeOrder, b.key));
  else list.sort((a, b) => (a.key === 'none') - (b.key === 'none') || b.total - a.total || collator.compare(a.key, b.key));
  list = list.map(r => (r.children ? { ...r, children: [...r.children.values()].sort((a, b) => rank(typeOrder, a.key) - rank(typeOrder, b.key)) } : r));
  return { pivot, rows: list, totals };
}

// ------------------------------------------------------------------ CSV

const csvCell = v => {
  let s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // 避免表格軟體把內容當公式
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function subjectsCsv(rows, columns) {
  const cols = (columns?.length ? columns : DEFAULT_EXPORT).filter(c => EXPORT_COLUMNS[c]);
  if (!cols.length) throw bad(tr('{field} 必須為 {values}', { field: 'columns', values: Object.keys(EXPORT_COLUMNS).join(' / ') }));
  const value = (r, c) => {
    if (c === 'flags') return (r.flags || []).map(f => tr(SUBJECT_STATES[f]));
    if (c === 'type') return tr(r.type);
    if (c === 'aliases') return r.aliases || r.aliasOf || [];
    return r[c];
  };
  const lines = [cols.map(c => csvCell(tr(EXPORT_COLUMNS[c]))).join(',')];
  for (const r of rows) lines.push(cols.map(c => csvCell(value(r, c))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ------------------------------------------------------------------ 查重

const norm = s => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** 新增主體時查重：同名、別名命中、包含關係與相近名稱。 */
export function similarSubjects(store, name, { limit = 8 } = {}) {
  const n = norm(name);
  if (!n) return [];
  const d = derived(store);
  const chars = [...n];
  const out = [];
  for (const s of store.subjects.values()) {
    const sn = norm(s.name);
    if (!sn) continue;
    let kind = null;
    let score = 0;
    if (sn === n) { kind = 'exact'; score = 100; }
    else if (chars.length >= 2 && [...sn].length >= 2 && (sn.includes(n) || n.includes(sn))) { kind = 'similar'; score = 50; }
    else {
      const max = chars.length <= 3 ? 0 : chars.length <= 8 ? 1 : 2;
      if (max && editDistance([...sn], chars, max) <= max) { kind = 'similar'; score = 40; }
    }
    if (!kind) continue;
    const alias = s.type === '別名';
    out.push({
      ...store.subjectSummary(s), kind: alias && kind === 'exact' ? 'alias' : kind, score: score + (alias ? -1 : 0),
      aliasOf: alias ? (d.aliasTargets.get(s.id) || []).map(id => store.subjectSummary(store.subjects.get(id))) : undefined
    });
  }
  return out.sort((a, b) => b.score - a.score || cmpId(a.id, b.id)).slice(0, limit).map(({ score, ...x }) => x);
}

// ------------------------------------------------------------------ 批量整理：計畫、套用、撤銷

const FIELD_LABEL = { owner: '負責人', ownerIds: '指定負責人', errorCost: '出錯代價', expiryDays: '有效期', tags: '標籤' };
const OWNER_ONLY = new Set(['ownerIds', 'expiryDays']);
const current = (s, field) => (field === 'errorCost' ? s.errorCost ?? 3 : field === 'tags' ? s.tags || [] : field === 'ownerIds' ? s.ownerIds || [] : s[field] ?? null);

function normalizeSet(store, input) {
  const set = {};
  const src = input.set || {};
  if (src.owner !== undefined) set.owner = clean(src.owner) || null;
  if (src.ownerIds !== undefined) {
    if (src.ownerIds !== null && !Array.isArray(src.ownerIds)) throw bad(tr('{field} 必須為陣列', { field: 'ownerIds' }));
    set.ownerIds = [...new Set((src.ownerIds || []).map(x => String(x).trim()).filter(Boolean))];
  }
  if (src.errorCost !== undefined) {
    const n = Number(src.errorCost);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw bad(tr('出錯代價必須是 1–5 的整數'));
    set.errorCost = n;
  }
  if (src.expiryDays !== undefined) {
    const n = src.expiryDays === null || src.expiryDays === '' ? null : Number(src.expiryDays);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 3650)) throw bad(tr('有效期必須是 1–3650 天，或留空恢復預設'));
    set.expiryDays = n;
  }
  const addTags = store.docs.normalizeTags(input.addTags || []);
  const removeTags = store.docs.normalizeTags(input.removeTags || []);
  if (!Object.keys(set).length && !addTags.length && !removeTags.length) throw bad(tr('沒有要修改的內容：請提供 set、addTags 或 removeTags'));
  return { set, addTags, removeTags };
}

function batchMessage({ set, addTags, removeTags }, n) {
  const parts = [];
  if ('owner' in set) parts.push(`負責人 → ${set.owner || '（清空）'}`);
  if ('ownerIds' in set) parts.push(`指定負責人 → ${set.ownerIds.join('、') || '（清空）'}`);
  if ('errorCost' in set) parts.push(`出錯代價 → ${set.errorCost}`);
  if ('expiryDays' in set) parts.push(`有效期 → ${set.expiryDays ? `${set.expiryDays} 天` : '預設'}`);
  if (addTags.length || removeTags.length) parts.push(`標籤 ${[...addTags.map(x => `+${x}`), ...removeTags.map(x => `−${x}`)].join(' ')}`);
  return `[批量] ${parts.join('，')}（${n} 個主體）`;
}

/** 解析 ids 或 query（與 GET /subjects 相同的條件），去重，最多 MAX_BATCH 個。 */
export function resolveBatchIds(store, input, opts) {
  let ids;
  if (Array.isArray(input.ids)) ids = input.ids.map(String);
  else if (input.query && typeof input.query === 'object') ids = querySubjects(store, input.query, { ...opts, all: true }).rows.map(r => r.id);
  else throw bad(tr('請提供 ids（主體 ID 陣列）或 query（篩選條件）'));
  ids = [...new Set(ids)];
  if (!ids.length) throw bad(tr('沒有選中任何主體'));
  if (ids.length > MAX_BATCH) throw bad(tr('單次批量最多 {n} 個主體', { n: MAX_BATCH }));
  return ids;
}

/** 批量整理的計畫：每個主體將修改什麼（目前值 → 修改後），或為什麼跳過。不修改任何數據。 */
export function planSubjectBatch(store, input, principal, opts = {}) {
  store.assertCanContribute(principal);
  const ops = normalizeSet(store, input);
  const ids = resolveBatchIds(store, input, opts);
  const updated = [];
  const skipped = [];
  const ownerOnly = Object.keys(ops.set).some(k => OWNER_ONLY.has(k));
  for (const id of ids) {
    const s = store.subjects.get(id);
    if (!s) { skipped.push({ id, name: null, reason: tr('找不到主體 {id}', { id }) }); continue; }
    const skip = reason => skipped.push({ id, name: s.name, reason });
    const alias = s.type === '別名';
    if (ownerOnly && !alias) {
      try { store.assertOwner(principal, s); } catch (err) { skip(err.message); continue; }
    }
    const changes = {};
    if (!alias) {
      for (const [field, to] of Object.entries(ops.set)) if (!same(current(s, field), to)) changes[field] = { from: current(s, field), to };
    }
    if (ops.addTags.length || ops.removeTags.length) {
      const rm = new Set(ops.removeTags.map(x => x.toLowerCase()));
      const next = (s.tags || []).filter(x => !rm.has(x.toLowerCase()));
      for (const tg of ops.addTags) if (!next.some(x => x.toLowerCase() === tg.toLowerCase())) next.push(tg);
      if (!same(next, s.tags || [])) changes.tags = { from: s.tags || [], to: next };
    }
    if (Object.keys(changes).length) { updated.push({ id, name: s.name, changes }); continue; }
    if (alias && Object.keys(ops.set).length) skip(tr('別名不設負責人、出錯代價和有效期'));
    else if ('owner' in ops.set && Object.keys(ops.set).length === 1 && !ops.addTags.length && !ops.removeTags.length) skip(ops.set.owner ? tr('已經是 {value}', { value: ops.set.owner }) : tr('本來就沒有負責人'));
    else skip(tr('已經是目標值，無需修改'));
  }
  return { updated, skipped, message: batchMessage(ops, updated.length), ops };
}

/** 在事務中套用計畫（只套用 updated）。 */
export function applySubjectBatch(store, t, plan) {
  const at = nowIso();
  const tags = new Set();
  for (const u of plan.updated) {
    const s = store.getSubject(u.id);
    for (const [field, { to }] of Object.entries(u.changes)) {
      s[field] = Array.isArray(to) ? [...to] : to;
      if (field === 'tags') to.forEach(x => tags.add(x));
    }
    s.updatedAt = at;
    t.touch('subject', s.id);
  }
  if (tags.size) store.docs.ensureTags(t, [...tags]);
  return { updated: plan.updated, skipped: plan.skipped };
}

/** 撤銷計畫：把記錄中的欄位改回原值；批量之後又被改過的主體跳過。 */
export function planSubjectUndo(store, record, principal) {
  store.assertCanContribute(principal);
  const updated = [];
  const skipped = [];
  for (const item of record.items || []) {
    const s = store.subjects.get(item.id);
    if (!s) { skipped.push({ id: item.id, name: item.name || null, reason: tr('找不到主體 {id}', { id: item.id }) }); continue; }
    const fields = Object.keys(item.changes || {});
    if (fields.some(f => !same(current(s, f), item.changes[f].to))) { skipped.push({ id: s.id, name: s.name, reason: tr('{id} 在批量之後又被修改過，未撤銷', { id: s.id }) }); continue; }
    if (fields.some(f => OWNER_ONLY.has(f))) {
      try { store.assertOwner(principal, s); } catch (err) { skipped.push({ id: s.id, name: s.name, reason: err.message }); continue; }
    }
    updated.push({ id: s.id, name: s.name, changes: Object.fromEntries(fields.map(f => [f, { from: item.changes[f].to, to: item.changes[f].from }])) });
  }
  return { updated, skipped, message: `[撤銷] ${record.message}` };
}

export const batchFieldLabel = f => FIELD_LABEL[f] || f;

// ------------------------------------------------------------------ 批量確認為 L0（斷言、綁定、關係）

/** 所選主體下全部「有證據的 L1」條目（含以這些主體為起點的關係），附審閱版本與能否確認。 */
export function confirmableItems(store, subjectIds, principal) {
  if (!Array.isArray(subjectIds) || !subjectIds.length) throw bad(tr('請提供 subjectIds'));
  if (subjectIds.length > MAX_BATCH) throw bad(tr('單次批量最多 {n} 個主體', { n: MAX_BATCH }));
  const ids = new Set(subjectIds.map(String));
  const out = [];
  const push = (kind, item, subject, summary) => {
    const v = item.validity;
    if (v.level !== 'L1' || !hasEvidence(v)) return;
    let reason = null;
    try { store.confirmMode(principal, { kind, item, subject }); } catch (err) { reason = err.message; }
    if (!reason && kind === 'binding' && store.objects.get(item.objectId)?.status === '下線') reason = tr('客體已下線，綁定不能晉升');
    out.push({ id: item.id, kind, subject: store.subjectSummary(subject), summary, evidence: v.evidence, pending: v.pending || null, version: store.reviewVersion(item), canConfirm: !reason, reason });
  };
  for (const id of ids) {
    const s = store.subjects.get(id);
    if (!s) continue;
    for (const a of s.assertions) push('assertion', a, s, a.content);
    for (const b of s.bindings) push('binding', b, s, tr('綁定客體 {id}（{name}）', { id: b.objectId, name: store.objects.get(b.objectId)?.name || '?' }));
  }
  for (const r of store.relations.values()) {
    if (!ids.has(r.from)) continue;
    push('relation', r, store.subjects.get(r.from), `${store.subjects.get(r.from)?.name} –${r.type}→ ${store.subjects.get(r.to)?.name}`);
  }
  return out;
}

export function confirmItemsMessage(store, items) {
  const kinds = { assertion: 0, binding: 0, relation: 0 };
  const subjects = new Set();
  for (const { id } of items) {
    const ref = store.getItem(id);
    kinds[ref.kind]++;
    if (ref.subject) subjects.add(ref.subject.id);
  }
  const parts = [['斷言', kinds.assertion], ['綁定', kinds.binding], ['關係', kinds.relation]].filter(([, n]) => n).map(([k, n]) => `${k} ${n}`);
  return `[批量] 確認為 L0：${items.length} 條（${parts.join('、')}，涉及 ${subjects.size} 個主體）`;
}

// ------------------------------------------------------------------ 批量導入、批量新增關係

const listOf = v => (Array.isArray(v) ? v : String(v ?? '').split(/[;；,，、\n]/)).map(x => String(x).trim()).filter(Boolean);

/** 導入計畫：每行新增、跳過（已存在）或錯誤；別名逐個判斷。不修改任何數據。 */
export function planSubjectImport(store, rows, principal) {
  store.assertCanContribute(principal);
  if (!Array.isArray(rows) || !rows.length) throw bad(tr('rows 必須為非空陣列'));
  if (rows.length > MAX_BATCH) throw bad(tr('單次最多導入 {n} 行', { n: MAX_BATCH }));
  const d = derived(store);
  const byName = new Map([...store.subjects.values()].map(s => [s.name.toLowerCase(), s]));
  const seen = new Map();
  const domains = store.config.domains;
  // 行號：調用方可以傳 line（表格中的行號，表頭是第 1 行）；沒有時按 rows 的順序從 1 數起
  const lineOf = i => (Number.isInteger(rows[i]?.line) && rows[i].line > 0 ? rows[i].line : i + 1);
  return rows.map((raw, index) => {
    const row = {
      index, line: lineOf(index), name: clean(String(raw?.name ?? '')), type: clean(String(raw?.type ?? '')), domain: clean(String(raw?.domain ?? '')),
      definition: clean(String(raw?.definition ?? '')) || null, owner: clean(String(raw?.owner ?? '')) || null,
      aliases: listOf(raw?.aliases), tags: listOf(raw?.tags), errorCost: raw?.errorCost ? Number(raw.errorCost) : null
    };
    const out = { ...row, status: 'create', reason: null, existing: null, aliasPlan: [] };
    const fail = reason => Object.assign(out, { status: 'error', reason });
    if (!row.name) return fail(tr('主體名稱必填'));
    if (!SUBJECT_TYPES[row.type] || row.type === '別名') return fail(tr('類型必須為：{list}', { list: Object.keys(SUBJECT_TYPES).filter(k => k !== '別名').join(tr('、')) }));
    const dom = domains.find(x => x.code === row.domain.toUpperCase() || x.name === row.domain);
    if (!dom) return fail(tr('未知領域 {domain}；可用：{list}', { domain: row.domain || '—', list: domains.map(x => x.code).join(', ') }));
    out.domain = dom.code;
    if (row.errorCost !== null && !(Number.isInteger(row.errorCost) && row.errorCost >= 1 && row.errorCost <= 5)) return fail(tr('出錯代價必須是 1–5 的整數'));
    try { out.tags = store.docs.normalizeTags(row.tags); } catch (err) { return fail(err.message); }
    const key = row.name.toLowerCase();
    const dup = byName.get(key);
    if (dup) {
      const targets = dup.type === '別名' ? (d.aliasTargets.get(dup.id) || []).join('、') : null;
      return Object.assign(out, { status: 'skip', existing: store.subjectSummary(dup), reason: targets ? tr('「{name}」已是 {targets} 的別名', { name: row.name, targets }) : tr('已有同名主體 {id}', { id: dup.id }) });
    }
    if (seen.has(key)) return fail(tr('與第 {n} 行重名', { n: lineOf(seen.get(key)) }));
    seen.set(key, index);
    for (const a of row.aliases) {
      const ak = a.toLowerCase();
      if (ak === key) continue;
      const hit = byName.get(ak);
      if (hit) out.aliasPlan.push({ name: a, status: 'skip', reason: hit.type === '別名' ? tr('「{name}」已是別名', { name: a }) : tr('已有同名主體 {id}', { id: hit.id }) });
      else if (seen.has(ak)) out.aliasPlan.push({ name: a, status: 'skip', reason: tr('與第 {n} 行重名', { n: lineOf(seen.get(ak)) }) });
      else { seen.set(ak, index); out.aliasPlan.push({ name: a, status: 'create', reason: null }); }
    }
    return out;
  });
}

export function applySubjectImport(store, t, plan, principal) {
  const created = [];
  for (const row of plan) {
    if (row.status !== 'create') continue;
    const s = store.createSubject(t, { name: row.name, type: row.type, domain: row.domain, definition: row.definition, owner: row.owner, tags: row.tags, errorCost: row.errorCost || undefined }, principal);
    const aliases = [];
    for (const a of row.aliasPlan) {
      if (a.status !== 'create') continue;
      aliases.push(store.createSubject(t, { name: a.name, type: '別名', domain: row.domain, aliasOf: [s.id] }, principal).id);
    }
    created.push({ index: row.index, id: s.id, name: s.name, aliases });
  }
  return created;
}

/** 批量新增關係的計畫：所選主體逐個與目標主體建立同一種關係（方向可選），不合規的跳過並說明。 */
export function planRelationBatch(store, input, principal) {
  store.assertCanContribute(principal);
  const ids = [...new Set((input.subjectIds || []).map(String))];
  if (!ids.length) throw bad(tr('請提供 subjectIds'));
  if (ids.length > MAX_BATCH) throw bad(tr('單次批量最多 {n} 個主體', { n: MAX_BATCH }));
  const target = clean(input.target);
  if (!target) throw bad(tr('{field} 必填', { field: 'target' }));
  store.getSubject(target);
  const direction = input.direction === 'in' ? 'in' : 'out';
  const ok = [];
  const skipped = [];
  for (const id of ids) {
    const rel = direction === 'out' ? { from: id, to: target, type: input.type } : { from: target, to: id, type: input.type };
    try {
      store.checkRelation(rel);
      ok.push({ ...rel, name: store.subjects.get(id)?.name });
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      if (err.code === 'invalid_relation_type') throw err;
      skipped.push({ id, name: store.subjects.get(id)?.name || null, reason: err.message });
    }
  }
  return { ok, skipped, direction, target, type: input.type, message: `[批量] 新增關係「${input.type}」：${ok.length} 條（${direction === 'out' ? `→ ${target}` : `${target} →`}）` };
}
