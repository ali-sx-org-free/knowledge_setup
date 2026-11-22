// 斷言、客體、關係、重驗隊列也用同一個列表工作台（設計 §14，第二期）：資料一次載入，在瀏覽器裡篩選與計數。
import { $$, esc, toast, modal, showError, download, get, post, level, pill, vpill, tag, fmtTime, field, input, structuredValueText } from './core.js';
import { t, tk, tv } from './i18n.js';
import { mountWorkspace, localSource, setListContext } from './workspace.js';

let C = null;
const schema = () => C.schema();
const me = () => C.me();
const isOwner = () => C.isOwner();
const contributor = () => me()?.isAdmin || me()?.role !== 'consumer';
const DAY = 86400000;
const PENDING_REASONS = { expired: tk('有效期到期'), mismatch: tk('校驗不符'), conflict: tk('知識衝突'), feedback: tk('使用反饋指出錯誤'), object_offline: tk('證據客體已下線'), object_changed: tk('客體已變化') };
const KIND = { assertion: tk('斷言'), binding: tk('客體綁定'), relation: tk('關係') };
const LEVELS = ['L0', 'L1', 'L2', 'E1'];
const levelItems = () => LEVELS.map(l => ({ value: l, label: l, dot: l }));
const domainItems = () => schema().domains.map(d => ({ value: d.code, label: `${d.code} ${tv(d.name)}` }));
const domainLabel = code => { const d = schema().domains.find(x => x.code === code); return d ? `${d.code} ${tv(d.name)}` : code; };
const evidenceKind = v => (v?.evidence?.objectIds?.length ? 'objects' : v?.evidence?.sourceRef || v?.evidence?.actionId ? 'source' : 'none');
const EVIDENCE = { objects: tk('有客體證據'), source: tk('只有來源'), none: tk('無證據') };
const expiringSoon = v => v?.level === 'L0' && v.expiresAt && Date.parse(v.expiresAt) - Date.now() <= 30 * DAY;
const subjectLink = s => (s ? `<a href="#subject/${esc(s.id)}" data-subject-link="${esc(s.id)}">${esc(s.name)}</a><span class="cell-sub mono">${esc(s.id)}</span>` : '—');
const csvCell = v => {
  const s = String(v ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
function exportRows(name, cols, rows) {
  const text = [cols.map(c => c[0]), ...rows.map(r => cols.map(c => c[1](r)))].map(l => l.map(csvCell).join(',')).join('\r\n');
  download(`${name}-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + text, 'text/csv;charset=utf-8');
}
const pickRows = (ws, ids) => { const set = new Set(ids); return ws.rows().filter(r => set.has(String(r.id))); };

/** 批量校驗條目：逐條調用現有的單條校驗（RPA 異步執行，進度在「執行記錄」）。 */
async function validateItems(ids, ws) {
  if (ids.length > 200) throw new Error(t('一次最多校驗 {n} 條', { n: 200 }));
  const out = { pass: 0, mismatch: 0, missing: 0, error: 0, async: 0 };
  for (const [i, id] of ids.entries()) {
    toast(t('正在校驗 {i} / {n}：{id}', { i: i + 1, n: ids.length, id }), 20000);
    try {
      const d = (await post(`/api/v1/validate/${id}`, {})).data;
      out[d.executionId ? 'async' : d.outcome in out ? d.outcome : 'error']++;
    } catch { out.error++; }
  }
  toast(t('校驗 {total} 條：通過 {pass}，不符 {mismatch}，客體缺失 {missing}，失敗 {error}，RPA 異步 {async}', { total: ids.length, ...out }), 8000, out.async ? { label: t('執行記錄'), run: () => { location.hash = 'executions'; } } : null);
  await ws.reload({ keepRows: true });
}

/** 批量確認為 L0：只收有證據的 L1，逐條核對後一次提交（審閱版本防止確認到別人剛改過的內容）。 */
function confirmItems(rows, ws, describe) {
  const ok = rows.filter(r => r.validity.level === 'L1' && evidenceKind(r.validity) !== 'none');
  if (!ok.length) return toast(t('所選條目中沒有可以確認的：只有附了證據的 L1 條目能確認為 L0'), 6000);
  modal(t('確認為 L0（{n} 條）', { n: ok.length }), `${ok.length < rows.length ? `<p class="notice warn">${esc(t('{n} 條不是附了證據的 L1，已略過', { n: rows.length - ok.length }))}</p>` : ''}<div class="table-scroll batch-table"><table><thead><tr><th></th><th>ID</th><th>${t('內容')}</th><th>${t('證據')}</th></tr></thead><tbody>${ok.map(r => `<tr><td class="check-cell"><input type="checkbox" data-item="${esc(r.id)}" checked aria-label="${esc(r.id)}"></td><td class="mono">${esc(r.id)}</td><td class="wrap">${describe(r)}</td><td class="wrap">${C.evidenceCell(r.validity)}</td></tr>`).join('')}</tbody></table></div>${field(t('確認說明（選填）'), input('note', '', `placeholder="${esc(t('例如：已對照口徑文檔 v3 核實'))}"`))}`, {
    label: t('確認為 L0'),
    run: async () => {
      const items = $$('#dialog-content input[data-item]:checked').map(b => ok.find(r => r.id === b.dataset.item)).map(r => ({ id: r.id, version: r.reviewVersion }));
      if (!items.length) throw new Error(t('請至少勾選一條'));
      await post('/api/v1/items/confirm-batch', { items, note: $$('#dialog-content [name=note]')[0]?.value || '' });
      toast(t('已確認 {n} 條為 L0', { n: items.length }));
      ws.clearSelection();
      await ws.reload({ keepRows: true });
    }
  });
}

function itemPreview(r, el, text) {
  const v = r.validity;
  el.innerHTML = `<div class="ws-pv-head"><div class="chip-row"><span class="tag">${esc(r.id)}</span>${level(v.level)}${v.pending ? pill(C.pendingLabel(v.pending), 'amber') : ''}</div><h2 class="wrap">${text}</h2></div>
    <div class="ws-pv-sec"><dl class="kv"><dt>${t('證據')}</dt><dd>${C.evidenceCell(v)}</dd><dt>${t('驗證人與時間')}</dt><dd>${esc(v.verifiedBy || '—')} · ${fmtTime(v.verifiedAt)}</dd><dt>${t('有效期至')}</dt><dd>${fmtTime(v.expiresAt)}</dd>${v.lastCheck ? `<dt>${t('最近校驗')}</dt><dd>${esc(v.lastCheck.actionId || '')} · ${esc(v.lastCheck.outcome || '')}</dd>` : ''}</dl></div>
    <div class="ws-pv-actions">${C.rowOps(r.id, v.level, { full: true })}</div>`;
}

// ------------------------------------------------------------------ 斷言
async function pageAssertions() {
  C.setActions('');
  const sc = schema();
  mountWorkspace(C.content(), {
    scope: 'assertions', page: 'assertions', nounName: t('斷言'), noun: n => t('{n} 條斷言', { n }),
    source: localSource({
      load: () => get('/api/v1/assertions'),
      text: r => `${r.id} ${r.content} ${r.subject?.name || ''} ${r.subject?.id || ''} ${r.structured?.key || ''}`,
      views: { all: () => true, active: r => r.validity.level !== 'E1', pending: r => !!r.validity.pending, review: r => r.validity.level === 'L1' && evidenceKind(r.validity) !== 'none' },
      sorts: { id: r => r.id, subject: r => r.subject?.name || '', level: r => LEVELS.indexOf(r.validity.level), expires: r => (r.validity.expiresAt ? Date.parse(r.validity.expiresAt) : Infinity) },
      groups: [
        { key: 'level', values: r => [r.validity.level] },
        { key: 'type', values: r => [r.type] },
        { key: 'reason', values: r => [r.validity.pending?.reason || 'none'] },
        { key: 'evidence', values: r => [evidenceKind(r.validity)] },
        { key: 'domain', values: r => [r.subject?.domain] },
        { key: 'expiring', values: r => [expiringSoon(r.validity) ? 'yes' : 'no'] }
      ]
    }),
    views: [{ key: 'active', label: t('有效斷言'), icon: 'list' }, { key: 'pending', label: t('待重驗'), icon: 'clock' }, ...(isOwner() ? [{ key: 'review', label: t('待確認（有證據的 L1）'), icon: 'shield' }] : []), { key: 'all', label: t('全部（含 E1）'), icon: 'grid' }],
    defaultView: 'active',
    groups: [
      { key: 'level', label: t('層級'), items: levelItems },
      { key: 'type', label: t('類型'), items: () => Object.keys(sc.assertionTypes).map(k => ({ value: k, label: tv(k) })), valueLabel: tv },
      { key: 'reason', label: t('待重驗原因'), items: () => Object.keys(PENDING_REASONS).map(k => ({ value: k, label: t(PENDING_REASONS[k]), tone: 'amber' })), valueLabel: k => (PENDING_REASONS[k] ? t(PENDING_REASONS[k]) : k) },
      { key: 'evidence', label: t('證據'), items: () => Object.keys(EVIDENCE).map(k => ({ value: k, label: t(EVIDENCE[k]) })), valueLabel: k => t(EVIDENCE[k] || k) },
      { key: 'domain', label: t('主體領域'), collapsed: true, items: domainItems, valueLabel: domainLabel },
      { key: 'expiring', label: t('30 天內到期'), collapsed: true, items: () => [{ value: 'yes', label: t('是'), tone: 'amber' }, { value: 'no', label: t('否') }], valueLabel: v => (v === 'yes' ? t('是') : t('否')) }
    ],
    syntax: { keys: { level: 'level', 層級: 'level', type: 'type', 類型: 'type', domain: 'domain', 領域: 'domain', reason: 'reason', is: 'is' }, is: { pending: ['reason', 'expired'], expiring: ['expiring', 'yes'] }, normalize: { level: v => v.toUpperCase(), domain: v => v.toUpperCase() } },
    columns: [
      { key: 'id', label: 'ID', def: true, sort: 'id', render: r => `<a class="ws-open mono" href="#item/${esc(r.id)}">${esc(r.id)}</a>` },
      { key: 'subject', label: t('主體'), def: true, sort: 'subject', render: r => subjectLink(r.subject) },
      { key: 'type', label: t('類型'), def: true, render: r => esc(tv(r.type)) },
      { key: 'content', label: t('內容'), always: true, cls: 'wrap', render: r => `${esc(r.content)}${r.structured ? `<span class="cell-sub mono">${esc(r.structured.key)} = ${esc(structuredValueText(r.structured.value))}</span>` : ''}` },
      { key: 'level', label: t('層級'), def: true, sort: 'level', render: r => `${level(r.validity.level)} ${C.pendingCell(r.validity)}` },
      { key: 'evidence', label: t('證據'), def: true, cls: 'wrap', render: r => C.evidenceCell(r.validity) },
      { key: 'expires', label: t('有效期至'), sort: 'expires', render: r => fmtTime(r.validity.expiresAt) },
      { key: 'ops', label: t('操作'), def: true, render: r => C.rowOps(r.id, r.validity.level) }
    ],
    sorts: [['id', 'ID'], ['subject', t('主體')], ['level', t('層級')], ['expires', t('有效期至')]], defaultSort: 'id',
    groupBy: [['subject', t('主體'), r => [r.subject?.id, r.subject?.name || '—']], ['type', t('類型'), r => [r.type, tv(r.type)]], ['level', t('層級'), r => [r.validity.level, r.validity.level]]],
    preview: (r, el) => itemPreview(r, el, esc(r.content)),
    bulk: [
      ...(contributor() ? [{ key: 'validate', label: t('校驗'), keys: 'v', run: (ids, ws) => validateItems(ids, ws) }] : []),
      ...(isOwner() ? [{ key: 'confirm', label: t('確認為 L0'), keys: 'c', run: (ids, ws) => confirmItems(pickRows(ws, ids), ws, r => esc(r.content)) }] : []),
      { key: 'export', label: t('導出 CSV'), more: true, run: (ids, ws) => exportRows('assertions', [['ID', r => r.id], [t('主體'), r => r.subject?.name], [t('類型'), r => r.type], [t('內容'), r => r.content], [t('層級'), r => r.validity.level], [t('有效期至'), r => r.validity.expiresAt || '']], pickRows(ws, ids)) }
    ],
    open: r => `item/${r.id}`,
    searchPlaceholder: t('內容、ID、主體名；可寫 level:L1 type:約束 is:expiring'),
    emptyHint: ''
  });
}

// ------------------------------------------------------------------ 客體
async function pageObjects() {
  const sc = schema();
  C.setActions(contributor() ? `<button class="button primary" id="add-object">${t('登記客體')}</button>` : '');
  document.getElementById('add-object')?.addEventListener('click', () => C.objectDialog());
  mountWorkspace(C.content(), {
    scope: 'objects', page: 'objects', nounName: t('客體'), noun: n => t('{n} 個客體', { n }),
    source: localSource({
      load: () => get('/api/v1/objects'),
      text: r => `${r.id} ${r.name} ${r.locator || ''} ${r.kind || ''}`,
      views: { all: () => true, active: r => r.status !== '下線' },
      sorts: { id: r => r.id, name: r => r.name, bound: r => r.boundSubjects.length },
      groups: [
        { key: 'category', values: r => [r.category] },
        { key: 'kind', values: r => [r.kind || '—'] },
        { key: 'status', values: r => [r.status || '在用'] },
        { key: 'action', values: r => [(r.actionIds || []).length ? 'yes' : 'no'] },
        { key: 'bound', values: r => [r.boundSubjects.length ? 'yes' : 'no'] }
      ]
    }),
    views: [{ key: 'active', label: t('在用'), icon: 'list' }, { key: 'all', label: t('全部（含下線）'), icon: 'grid' }], defaultView: 'active',
    groups: [
      { key: 'category', label: t('類別'), items: () => Object.keys(sc.objectCategories).map(k => ({ value: k, label: tv(k) })), valueLabel: tv },
      { key: 'kind', label: t('種類'), more: 8, items: fc => Object.entries(fc.groups.kind || {}).sort((a, b) => b[1] - a[1]).map(([k]) => ({ value: k, label: tv(k) })), valueLabel: tv },
      { key: 'status', label: t('狀態'), items: () => [{ value: '在用', label: tv('在用') }, { value: '下線', label: tv('下線'), tone: 'red' }], valueLabel: tv },
      { key: 'action', label: t('可用 Action'), items: () => [{ value: 'yes', label: t('有') }, { value: 'no', label: t('沒有'), tone: 'gray' }], valueLabel: v => (v === 'yes' ? t('有') : t('沒有')) },
      { key: 'bound', label: t('被綁定'), items: () => [{ value: 'yes', label: t('1 個以上') }, { value: 'no', label: t('0（未綁定）'), tone: 'gray' }], valueLabel: v => (v === 'yes' ? t('1 個以上') : t('0（未綁定）')) }
    ],
    syntax: { keys: { category: 'category', 類別: 'category', kind: 'kind', 種類: 'kind', status: 'status', 狀態: 'status', is: 'is' }, is: { unbound: ['bound', 'no'], offline: ['status', '下線'] } },
    columns: [
      { key: 'id', label: 'ID', def: true, sort: 'id', render: r => `<span class="mono">${esc(r.id)}</span>` },
      { key: 'name', label: t('名稱'), always: true, sort: 'name', cls: 'wrap', render: r => `<a class="ws-open" href="#object/${esc(r.id)}"><strong>${esc(r.name)}</strong></a>` },
      { key: 'category', label: t('類別 / 種類'), def: true, render: r => `${esc(tv(r.category))}<span class="cell-sub">${esc(tv(r.kind) || '')}</span>` },
      { key: 'locator', label: t('定位'), def: true, cls: 'mono wrap', render: r => esc(r.locator || '—') },
      { key: 'actions', label: t('可用 Action'), def: true, render: r => (r.actionIds || []).map(tag).join(' ') || '—' },
      { key: 'status', label: t('狀態'), def: true, render: r => C.statusPill(r.status) },
      { key: 'bound', label: t('綁定主體'), def: true, sort: 'bound', cls: 'wrap', render: r => r.boundSubjects.map(s => C.idLink(s.id, s.name)).join(' ') || '—' },
      { key: 'ops', label: t('操作'), def: true, render: r => (r.docId ? `<a class="text-btn" href="#doc/${esc(r.docId)}">${t('由文檔庫管理')}</a>` : r.status !== '下線' && contributor() ? `<button class="text-btn" data-op="offline" data-id="${esc(r.id)}">${t('標記下線')}</button>` : '') }
    ],
    sorts: [['id', 'ID'], ['name', t('名稱')], ['bound', t('綁定主體數')]], defaultSort: 'id',
    groupBy: [['category', t('類別'), r => [r.category, tv(r.category)]], ['kind', t('種類'), r => [r.kind || '—', tv(r.kind) || '—']]],
    preview: (r, el) => {
      el.innerHTML = `<div class="ws-pv-head"><div class="chip-row"><span class="tag">${esc(r.id)}</span>${C.statusPill(r.status)}<span class="badge">${esc(tv(r.category))} · ${esc(tv(r.kind) || '')}</span></div><h2>${esc(r.name)}</h2><p class="muted small mono">${esc(r.locator || '')}</p></div>
        <div class="ws-pv-sec"><dl class="kv"><dt>${t('說明')}</dt><dd>${esc(r.description || '—')}</dd><dt>${t('可用 Action')}</dt><dd>${(r.actionIds || []).map(tag).join(' ') || '—'}</dd><dt>${t('綁定主體')}</dt><dd>${r.boundSubjects.map(s => `${C.idLink(s.id, s.name)} ${level(s.bindingLevel)}`).join('<br>') || '—'}</dd></dl></div>
        <div class="ws-pv-actions"><a class="button primary" href="#object/${esc(r.id)}">${t('打開')}</a></div>`;
    },
    bulk: [{ key: 'export', label: t('導出 CSV'), run: (ids, ws) => exportRows('objects', [['ID', r => r.id], [t('名稱'), r => r.name], [t('類別'), r => r.category], [t('種類'), r => r.kind], [t('定位'), r => r.locator], [t('狀態'), r => r.status], [t('綁定主體'), r => r.boundSubjects.map(s => s.id).join(' ')]], pickRows(ws, ids)) }],
    open: r => `object/${r.id}`,
    newItem: contributor() ? { label: t('登記客體'), run: () => C.objectDialog() } : null,
    searchPlaceholder: t('名稱、ID、定位；可寫 category:數字 is:unbound')
  });
}

// ------------------------------------------------------------------ 關係
async function pageRelations() {
  const sc = schema();
  C.setActions(contributor() ? `<button class="button primary" id="add-relation">${t('新增關係')}</button>` : '');
  document.getElementById('add-relation')?.addEventListener('click', () => C.relationDialog());
  const text = r => `${esc(r.fromSubject?.name)} –${esc(tv(r.type, 'rel'))}→ ${esc(r.toSubject?.name)}`;
  mountWorkspace(C.content(), {
    scope: 'relations', page: 'relations', nounName: t('關係'), noun: n => t('{n} 條關係', { n }),
    source: localSource({
      load: () => get('/api/v1/relations'),
      text: r => `${r.id} ${r.from} ${r.to} ${r.fromSubject?.name || ''} ${r.toSubject?.name || ''} ${r.type}`,
      views: { active: r => r.validity.level !== 'E1' && r.type !== '別名', all: () => true },
      sorts: { id: r => r.id, from: r => r.fromSubject?.name || '', level: r => LEVELS.indexOf(r.validity.level) },
      groups: [
        { key: 'type', values: r => [r.type] },
        { key: 'level', values: r => [r.validity.level] },
        { key: 'fromDomain', values: r => [r.fromSubject?.domain] },
        { key: 'toDomain', values: r => [r.toSubject?.domain] },
        { key: 'pending', values: r => [r.validity.pending ? 'yes' : 'no'] }
      ]
    }),
    views: [{ key: 'active', label: t('有效關係（不含別名）'), icon: 'node' }, { key: 'all', label: t('全部（含別名、E1）'), icon: 'grid' }], defaultView: 'active',
    groups: [
      { key: 'type', label: t('類型'), items: () => Object.keys(sc.relationTypes).map(k => ({ value: k, label: tv(k, 'rel') })), valueLabel: k => tv(k, 'rel') },
      { key: 'level', label: t('層級'), items: levelItems },
      { key: 'fromDomain', label: t('起點領域'), collapsed: true, items: domainItems, valueLabel: domainLabel },
      { key: 'toDomain', label: t('終點領域'), collapsed: true, items: domainItems, valueLabel: domainLabel },
      { key: 'pending', label: t('待重驗'), items: () => [{ value: 'yes', label: t('是'), tone: 'red' }, { value: 'no', label: t('否') }], valueLabel: v => (v === 'yes' ? t('是') : t('否')) }
    ],
    syntax: { keys: { type: 'type', 類型: 'type', level: 'level', 層級: 'level', from: 'fromDomain', to: 'toDomain', is: 'is' }, is: { pending: ['pending', 'yes'] }, normalize: { level: v => v.toUpperCase(), fromDomain: v => v.toUpperCase(), toDomain: v => v.toUpperCase() } },
    columns: [
      { key: 'id', label: 'ID', def: true, sort: 'id', render: r => `<a class="ws-open mono" href="#item/${esc(r.id)}">${esc(r.id)}</a>` },
      { key: 'from', label: t('起點'), always: true, sort: 'from', render: r => subjectLink(r.fromSubject) },
      { key: 'type', label: t('關係'), def: true, render: r => vpill(r.type, 'blue', 'rel') },
      { key: 'to', label: t('終點'), def: true, render: r => subjectLink(r.toSubject) },
      { key: 'level', label: t('層級'), def: true, sort: 'level', render: r => `${level(r.validity.level)} ${C.pendingCell(r.validity)}` },
      { key: 'evidence', label: t('證據'), def: true, cls: 'wrap', render: r => C.evidenceCell(r.validity) },
      { key: 'ops', label: t('操作'), def: true, render: r => C.rowOps(r.id, r.validity.level) }
    ],
    sorts: [['id', 'ID'], ['from', t('起點')], ['level', t('層級')]], defaultSort: 'id',
    groupBy: [['type', t('類型'), r => [r.type, tv(r.type, 'rel')]], ['from', t('起點'), r => [r.from, r.fromSubject?.name || r.from]]],
    preview: (r, el) => itemPreview(r, el, text(r)),
    bulk: [
      ...(contributor() ? [{ key: 'validate', label: t('校驗'), keys: 'v', run: (ids, ws) => validateItems(ids, ws) }] : []),
      ...(isOwner() ? [{ key: 'confirm', label: t('確認為 L0'), keys: 'c', run: (ids, ws) => confirmItems(pickRows(ws, ids), ws, text) }] : []),
      { key: 'export', label: t('導出 CSV'), more: true, run: (ids, ws) => exportRows('relations', [['ID', r => r.id], [t('起點'), r => r.from], [t('關係'), r => r.type], [t('終點'), r => r.to], [t('層級'), r => r.validity.level]], pickRows(ws, ids)) }
    ],
    open: r => `item/${r.id}`,
    newItem: contributor() ? { label: t('新增關係'), run: () => C.relationDialog() } : null,
    searchPlaceholder: t('起點、終點、ID；可寫 type:依賴 level:L1 from:INV')
  });
}

// ------------------------------------------------------------------ 重驗隊列
async function pageQueue() {
  C.setActions(`${isOwner() ? `<button class="button" id="validate-pending">${t('對隊列執行校驗')}</button>` : ''}${me().isAdmin ? `<button class="button" id="run-expiry">${t('執行到期檢查')}</button>` : ''}`);
  document.getElementById('validate-pending')?.addEventListener('click', async () => { try { const r = await post('/api/v1/validate-all', { onlyPending: true }); toast(t('校驗 {total} 條：通過 {passed}，不符 {mismatched}，客體缺失 {missing}，失敗 {errors}', r.data), 6000); C.render(); } catch (err) { showError(err); } });
  document.getElementById('run-expiry')?.addEventListener('click', async () => { try { const r = await post('/admin/api/maintenance/expiry'); toast(t('到期檢查完成：{n} 條降為 L1', { n: r.data.expired.length })); C.render(); } catch (err) { showError(err); } });
  const ws = mountWorkspace(C.content(), {
    scope: 'queue', page: 'queue', nounName: t('條目'), noun: n => t('{n} 條待重驗', { n }),
    source: localSource({
      load: () => get('/api/v1/queue'),
      text: r => `${r.id} ${r.summary} ${r.subject?.name || ''} ${r.subject?.id || ''} ${r.owner || ''}`,
      views: { all: () => true, mine: r => !!r.owner && r.owner === C.myName?.() },
      sorts: { priority: r => r.priority, id: r => r.id, at: r => Date.parse(r.pending?.at || 0) },
      groups: [
        { key: 'reason', values: r => [r.pending?.reason || 'other'] },
        { key: 'domain', values: r => [r.subject?.domain] },
        { key: 'owner', values: r => [r.owner || 'none'] },
        { key: 'kind', values: r => [r.kind] }
      ]
    }),
    views: [{ key: 'all', label: t('全部待重驗'), icon: 'list' }, { key: 'mine', label: t('我負責的'), icon: 'user' }], defaultView: 'all',
    groups: [
      { key: 'reason', label: t('原因'), items: () => Object.keys(PENDING_REASONS).map(k => ({ value: k, label: t(PENDING_REASONS[k]), tone: 'amber' })), valueLabel: k => (PENDING_REASONS[k] ? t(PENDING_REASONS[k]) : k) },
      { key: 'domain', label: t('領域'), items: domainItems, valueLabel: domainLabel },
      { key: 'owner', label: t('負責人'), more: 8, items: fc => Object.entries(fc.groups.owner || {}).sort((a, b) => b[1] - a[1]).map(([k]) => ({ value: k, label: k === 'none' ? t('（無負責人）') : k })), valueLabel: k => (k === 'none' ? t('（無負責人）') : k) },
      { key: 'kind', label: t('條目種類'), items: () => Object.keys(KIND).map(k => ({ value: k, label: t(KIND[k]) })), valueLabel: k => t(KIND[k] || k) }
    ],
    syntax: { keys: { reason: 'reason', 原因: 'reason', domain: 'domain', 領域: 'domain', owner: 'owner', 負責人: 'owner', kind: 'kind', is: 'is' }, is: {}, normalize: { domain: v => v.toUpperCase() } },
    columns: [
      { key: 'priority', label: '#' + t('優先級'), def: true, sort: 'priority', cls: 'numeric', render: r => `${r.priority}` },
      { key: 'id', label: t('條目'), def: true, sort: 'id', render: r => `<a class="mono" href="#item/${esc(r.id)}">${esc(r.id)}</a><span class="cell-sub">${esc(t(KIND[r.kind] || r.kind))}</span>` },
      { key: 'subject', label: t('主體'), always: true, render: r => (r.subject ? `<a class="ws-open" href="#subject/${esc(r.subject.id)}">${esc(r.subject.name)}</a><span class="cell-sub mono">${esc(r.subject.id)}</span>` : '—') },
      { key: 'summary', label: t('內容'), def: true, cls: 'wrap', render: r => esc(r.summary) },
      { key: 'reason', label: t('原因'), def: true, sort: 'at', render: r => `${pill(C.pendingLabel(r.pending), 'amber')}<span class="cell-sub">${C.docNoteHtml(r.pending.note)} ${C.ago(r.pending.at)}</span>` },
      { key: 'level', label: t('層級'), def: true, render: r => level(r.level) },
      { key: 'owner', label: t('負責人'), def: true, render: r => esc(r.owner || '—') },
      { key: 'usage', label: '#' + t('使用 × 代價'), def: true, cls: 'numeric', render: r => `${r.usage} × ${r.errorCost}` },
      { key: 'ops', label: t('操作'), def: true, render: r => C.rowOps(r.id, r.level) }
    ],
    sorts: [['priority', t('優先級')], ['at', t('進入隊列時間')], ['id', 'ID']], defaultSort: '-priority',
    groupBy: [['subject', t('主體'), r => [r.subject?.id || '—', r.subject?.name || '—']], ['reason', t('原因'), r => [r.pending?.reason, C.pendingLabel(r.pending)]], ['owner', t('負責人'), r => [r.owner || 'none', r.owner || t('（無負責人）')]]],
    preview: (r, el) => {
      el.innerHTML = `<div class="ws-pv-head"><div class="chip-row"><span class="tag">${esc(r.id)}</span>${level(r.level)}${pill(C.pendingLabel(r.pending), 'amber')}</div><h2 class="wrap">${esc(r.summary)}</h2><p class="muted small">${r.subject ? `${esc(r.subject.name)} · ${esc(r.subject.id)}` : ''}</p></div>
        <div class="ws-pv-sec"><dl class="kv"><dt>${t('原因')}</dt><dd>${esc(C.pendingLabel(r.pending))}<span class="cell-sub">${C.docNoteHtml(r.pending.note)}</span></dd><dt>${t('進入隊列')}</dt><dd>${fmtTime(r.pending.at)}</dd><dt>${t('負責人')}</dt><dd>${esc(r.owner || '—')}</dd><dt>${t('使用 × 代價')}</dt><dd>${r.usage} × ${r.errorCost}</dd><dt>${t('可自動校驗')}</dt><dd>${r.hasValidateAction ? t('是') : t('否')}</dd></dl></div>
        <div class="ws-pv-actions">${C.rowOps(r.id, r.level, { full: true })}${r.subject ? `<a class="button" href="#subject/${esc(r.subject.id)}" data-subject-link="${esc(r.subject.id)}">${t('打開主體')}</a>` : ''}</div>`;
    },
    bulk: [
      ...(contributor() ? [{ key: 'validate', label: t('校驗'), keys: 'v', run: (ids, w) => validateItems(ids, w) }] : []),
      { key: 'export', label: t('導出 CSV'), more: true, run: (ids, w) => exportRows('queue', [[t('優先級'), r => r.priority], [t('條目'), r => r.id], [t('主體'), r => r.subject?.id], [t('內容'), r => r.summary], [t('原因'), r => r.pending?.reason], [t('負責人'), r => r.owner]], pickRows(w, ids)) }
    ],
    // 打開主體時帶上「待重驗」的列表上下文：主體頁按 j 到隊列中的下一個主體
    open: r => (r.subject ? `subject/${r.subject.id}` : `item/${r.id}`),
    contextId: r => r.subject?.id || r.id,
    searchPlaceholder: t('條目、主體、內容、負責人；可寫 reason:expired domain:INV'),
    emptyHint: esc(t('沒有待重驗的知識'))
  });
  C.content().addEventListener('click', e => {
    const a = e.target.closest('[data-subject-link]');
    if (!a) return;
    setListContext({ hash: location.hash, ids: [...new Set(ws.rows().map(r => r.subject?.id).filter(Boolean))], total: null, label: t('待重驗'), page: 'queue' });
  });
}

export function registerListPages(PAGES, ctx) {
  C = ctx;
  PAGES.assertions = pageAssertions;
  PAGES.objects = pageObjects;
  PAGES.relations = pageRelations;
  PAGES.queue = pageQueue;
}
