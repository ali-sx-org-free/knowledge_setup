// 管理後台：知識管理與可視化。頁面只填內容區，Portal 外殼與樣式沿用視覺樣式包。
// 介面文字一律經 t() 取譯文（繁體原文即字典鍵，見 i18n.js）；枚舉值經 tv()，服務端寫入倉庫的固定措辭經 td()。
import {
  $, $$, esc, structuredValueText, icon, shell, setHeading, toast, modal, closeModal, showError, download, copy, api, get, post, put, patch, del,
  setUnauthorizedHandler, level, pill, vpill, tag, idLink, fmtTime, ago, pct, panel, table, formData, field, input, select, textarea, markdown, LEVEL_TEXT
} from './core.js';
import { renderGraph, legend } from './graph.js';
import { registerDocPages, subjectDocsPanel, objectDocsHtml, docsDashboardPanel, docNoteHtml } from './docs.js';
import { t, tk, tv, td, locale, initI18n, setLocale, localeSelect } from './i18n.js';

await initI18n();

const NAV = {
  title: t('供應鏈知識體系'),
  subtitle: 'KNOWLEDGE PORTAL',
  groups: [
    { id: 'overview', name: t('總覽'), en: 'OVERVIEW', icon: 'chart', pages: [
      { id: 'dashboard', name: t('健康指標'), desc: t('試點期每週查看：L0 覆蓋率、待重驗數、未收錄查詢數、L0 錯誤反饋數。') },
      { id: 'search', name: t('全局搜索'), icon: 'search', desc: t('主體和文檔一起搜：名稱、別名、ID、定義，以及文檔的標題、摘要、標籤和正文。') },
      { id: 'changes', name: t('變更記錄'), icon: 'list', desc: t('每次知識寫入都是知識 Git 倉庫中的一次提交。') }
    ] },
    { id: 'knowledge', name: t('知識庫'), en: 'KNOWLEDGE', icon: 'grid', pages: [
      { id: 'subjects', name: t('nav|主體'), aliases: ['subject'], desc: t('圖譜的節點；綜合層級由客體綁定計算得出，只讀。') },
      { id: 'assertions', name: t('nav|斷言'), aliases: ['item'], icon: 'list', desc: t('關於主體的具體陳述；一條只說一件事，單獨驗證、單獨失效。') },
      { id: 'objects', name: t('nav|客體'), aliases: ['object'], desc: t('主體在真實世界中的對應物，也是有效性的證據來源。') },
      { id: 'relations', name: t('nav|關係'), icon: 'node', desc: t('10 種關係類型的閉集；邊直接帶有效性。') }
    ] },
    { id: 'documents', name: t('文檔庫'), en: 'DOCUMENTS', icon: 'doc', pages: [
      { id: 'docs', name: t('文檔'), aliases: ['doc', 'doc-edit'], desc: t('知識倉庫中的 Markdown 文檔。文件夾就是 Git 目錄；內容走版本，整理即時生效。') },
      { id: 'doc-templates', name: t('nav|模板'), icon: 'grid', desc: t('知識文檔與管理文檔的模板：欄位、章節、誰能發布、多久複審。') },
      { id: 'doc-tags', name: t('標籤'), icon: 'tag', desc: t('標籤字典：分組、顏色、使用數；重命名與合併會改寫所有用到它的文檔。') }
    ] },
    { id: 'graph', name: t('圖譜'), en: 'GRAPH', icon: 'node', pages: [
      { id: 'graph', name: t('知識圖譜'), desc: t('拖曳節點、滾輪縮放、拖曳空白處平移；點選節點查看主體。') },
      { id: 'levels', name: t('層級分佈'), icon: 'chart', desc: t('有效性層級的分佈與遷移規則：只有校驗或確認能升到 L0，任何異常先降回 L1。') }
    ] },
    { id: 'governance', name: t('治理'), en: 'GOVERNANCE', icon: 'shield', pages: [
      { id: 'queue', name: t('重驗隊列'), desc: t('按「被使用頻率 × 出錯代價」排序，先處理被問得最多、錯了代價最大的知識。') },
      { id: 'conflicts', name: t('衝突裁決'), desc: t('兩條知識互相矛盾時雙方降為 L1；裁決後一方回到 L0，另一方轉為 E1。') },
      { id: 'feedback', name: t('使用反饋'), desc: t('用戶或智能體指出知識有誤，觸發降級與重驗。') },
      { id: 'gaps', name: t('知識缺口'), desc: t('智能體回答「未收錄」的問題，用於決定下一批要建設的內容。') }
    ] },
    { id: 'runtime', name: t('動力層'), en: 'RUNTIME', icon: 'bolt', pages: [
      { id: 'actions', name: 'Action', desc: t('對某類客體的一次只讀管道交互：校驗（結果寫回有效性）與取值（實時讀取動態值）。') },
      { id: 'pipelines', name: t('nav|管道'), icon: 'plug', aliases: ['scenes'], desc: t('到數據源的連接；憑證以 ${env:變數} 引用，不寫入知識倉庫。') },
      { id: 'executions', name: t('執行記錄'), icon: 'list', desc: t('RPA 校驗的異步執行：受理、排隊、執行、判定與寫回。記錄存在服務本地，不進知識倉庫。') }
    ] },
    { id: 'integration', name: t('接入'), en: 'INTEGRATION', icon: 'plug', pages: [
      { id: 'playground', name: t('問答測試'), desc: t('模擬智能體調用消費型 API：結構化知識 + 自然語言答案。') },
      { id: 'prompt', name: t('智能體教程'), icon: 'list', desc: t('三方智能體拉取此教程即可學會如何生產與消費知識。') },
      { id: 'keys', name: t('API 金鑰'), adminOnly: true, icon: 'shield', desc: t('為三方智能體、人和管道發放金鑰；角色決定可用的 API。') },
      { id: 'apidoc', name: t('API 參考'), icon: 'list', desc: t('生產型與消費型 API 端點一覽（OpenAPI 3.1）。') }
    ] },
    { id: 'settings', name: t('設定'), en: 'SETTINGS', icon: 'gear', adminOnly: true, pages: [
      { id: 'repo', name: t('知識倉庫'), desc: t('使用你指定的 Git 倉庫作為私有領域知識的持久化存儲。') },
      { id: 'llm', name: t('自然語言'), desc: t('消費型 API 經 OpenRouter 組織自然語言答案；未配置時使用規則模板。') },
      { id: 'rules', name: t('規則參數'), desc: t('領域代碼、有效期初值等，保存在知識倉庫的 config.yaml。') },
      { id: 'account', name: t('帳號'), desc: t('目前身份與管理員密碼。') }
    ] }
  ]
};

// 代碼 → 顯示文字（取用時再經 t() 翻譯）
const PENDING_TEXT = { expired: tk('有效期到期'), mismatch: tk('校驗不符'), conflict: tk('知識衝突'), feedback: tk('使用反饋指出錯誤'), object_offline: tk('證據客體已下線'), object_changed: tk('客體已變化') };
const PENDING_SHORT = { expired: tk('到期'), mismatch: tk('校驗不符'), conflict: tk('衝突'), feedback: tk('反饋'), object_offline: tk('客體下線'), object_changed: tk('內容修改') };
const OUTCOME_TEXT = { pass: tk('通過'), mismatch: tk('不符'), missing: tk('客體不存在'), error: tk('無法完成') };
const SOURCE_KIND = { human: tk('人'), agent: tk('智能體'), pipeline: tk('管道'), system: tk('系統') };
const ROLE_TEXT = { consumer: tk('消費者'), contributor: tk('貢獻者'), owner: tk('負責人') };
const ITEM_KIND = { assertion: tk('斷言'), binding: tk('客體綁定'), relation: tk('關係') };
const ITEM_KIND_SHORT = { assertion: tk('斷言'), binding: tk('綁定'), relation: tk('關係') };
const mapText = (map, k) => (map[k] ? t(map[k]) : k);
const pendingLabel = p => (PENDING_TEXT[p.reason] ? t(PENDING_TEXT[p.reason]) : td(p.label || p.reason));
const domainName = d => `${d.code} ${tv(d.name)}`;

let me = null;
let schema = null;
let subjectsCache = null;
const isOwner = () => me && (me.isAdmin || me.role === 'owner');

function navFor() {
  return { ...NAV, groups: NAV.groups.map(g => ({ ...g, hidden: g.adminOnly && !me?.isAdmin, pages: g.pages.filter(p => !p.adminOnly || me?.isAdmin) })) };
}

function route() {
  const [page, ...rest] = decodeURIComponent(location.hash.slice(1)).split('/');
  return { page: page || 'dashboard', param: rest.join('/') || null };
}

const content = () => $('#content');
const setActions = html => ($('#page-actions').innerHTML = html);
const qs = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

async function subjectOptions(force = false) {
  if (!subjectsCache || force) subjectsCache = await get('/api/v1/subjects');
  return `<datalist id="subject-options">${subjectsCache.map(s => `<option value="${esc(s.id)} ${esc(s.name)}">`).join('')}</datalist>`;
}
const parseId = v => String(v || '').trim().split(/\s+/)[0];

function levelBar(counts, keys = ['L0', 'L1', 'L2', 'E1']) {
  const total = keys.reduce((n, k) => n + (counts[k] || 0), 0);
  const seg = keys.map(k => (counts[k] ? `<i class="${k}" style="width:${(counts[k] / Math.max(1, total)) * 100}%" title="${k} ${counts[k]}"></i>` : '')).join('');
  return { bar: `<div class="bar" role="img" aria-label="${keys.map(k => `${k} ${counts[k] || 0}`).join(t('，'))}">${seg}</div>`, text: keys.map(k => `${k} ${counts[k] || 0}`).join(' · '), total };
}

function evidenceCell(v) {
  const e = v?.evidence || {};
  const parts = (e.objectIds || []).map(id => idLink(id));
  if (e.sourceRef) parts.push(`<span class="cell-sub" title="${esc(e.sourceRef)}">${esc(t('來源：{ref}', { ref: e.sourceRef }))}</span>`);
  if (e.actionId) parts.push(`<span class="cell-sub">${esc(t('校驗：{id}', { id: e.actionId }))}</span>`);
  return parts.join(' ') || `<span class="muted">${t('無證據')}</span>`;
}
const pendingCell = v => (v?.pending ? pill(pendingLabel(v.pending), 'amber') : '');

function rowOps(id, lvl, { full = false } = {}) {
  const ops = [`<a class="text-btn" href="#item/${esc(id)}">${t('詳情')}</a>`];
  if (lvl !== 'E1') ops.push(`<button class="text-btn" data-op="validate" data-id="${esc(id)}">${t('校驗')}</button>`);
  if (isOwner() && (lvl === 'L1' || lvl === 'L0')) ops.push(`<button class="text-btn" data-op="confirm" data-id="${esc(id)}">${lvl === 'L0' ? t('續期') : t('確認')}</button>`);
  if (full) {
    if (lvl === 'L2' || lvl === 'L1') ops.push(`<button class="text-btn" data-op="evidence" data-id="${esc(id)}">${t('補證據')}</button>`);
    if (lvl !== 'E1') ops.push(`<button class="text-btn" data-op="feedback" data-id="${esc(id)}">${t('反饋有誤')}</button>`, `<button class="text-btn" data-op="conflict" data-id="${esc(id)}">${t('登記衝突')}</button>`);
    if (isOwner() && lvl !== 'E1') ops.push(`<button class="text-btn" data-op="invalidate" data-id="${esc(id)}" style="color:var(--danger)">${t('判定失效')}</button>`);
  }
  return `<div class="cell-actions">${ops.join('')}</div>`;
}

// ------------------------------------------------------------------ 條目操作（事件委派）
const OPS = {
  async validate(id, data = {}) {
    const r = await post(`/api/v1/validate/${id}`, data.action ? { actionId: data.action } : {});
    const d = r.data;
    if (d.executionId) return watchExecution(d.executionId, d.deduped ? t('{id} 已有進行中的校驗', { id }) : t('校驗 {id}（RPA）', { id }));
    const outcome = { pass: t('通過 → L0'), mismatch: t('不符 → L1'), missing: t('客體不存在 → 下線'), error: t('無法完成') }[d.outcome] || d.outcome;
    toast(t('{id} 校驗結果：{outcome}。{detail}', { id, outcome, detail: td(d.detail) || '' }), 6000);
    render();
  },
  confirm(id) {
    modal(t('負責人確認 {id}', { id }), `<p class="notice">${t('確認後晉升為 L0（人工驗證），有效期按規則參數計算；到期自動降為 L1 並排入重驗。')}</p>${field(t('確認說明（選填）'), textarea('note', '', `placeholder="${esc(t('例如：已對照口徑文檔 v3 核實'))}"`))}${field(t('有效期（天，選填）'), input('expiryDays', '', `type="number" min="1" placeholder="${esc(t('留空使用預設'))}"`))}`, {
      label: t('確認為 L0'),
      run: async () => { await post(`/api/v1/items/${id}/confirm`, formData($('#dialog-content'))); toast(t('{id} 已確認為 L0', { id })); render(); }
    });
  },
  invalidate(id) {
    modal(t('判定失效 {id}', { id }), `<p class="notice warn">${t('E1 不刪除：保留失效知識和替代者，智能體才能回答「以前是怎樣、現在改成了什麼」。')}</p>${field(t('失效原因'), textarea('reason', '', 'required'))}${field(t('替代者 ID（選填）'), input('replacedBy', '', `placeholder="${esc(t('例如 A-0001'))}"`))}`, {
      label: t('轉為 E1'),
      run: async () => { await post(`/api/v1/items/${id}/invalidate`, formData($('#dialog-content'))); toast(t('{id} 已轉為 E1', { id })); render(); }
    });
  },
  async evidence(id) {
    const objects = await get('/api/v1/objects');
    modal(t('補充證據 {id}', { id }), `<p class="notice">${t('補充客體證據或明確來源後，L2 升為 L1。')}</p>${field(t('證據客體（可多選）'), `<select name="objectIds" multiple size="6">${objects.map(o => `<option value="${esc(o.id)}">${esc(o.id)} ${esc(o.name)}${o.status === '下線' ? esc(t('（下線）')) : ''}</option>`).join('')}</select>`)}${field(t('明確來源（選填）'), input('sourceRef', '', `placeholder="${esc(t('文檔鏈接、評審記錄編號等'))}"`))}`, {
      label: t('提交證據'),
      run: async () => { await post(`/api/v1/items/${id}/evidence`, formData($('#dialog-content'))); toast(t('證據已補充')); render(); }
    });
  },
  feedback(id) {
    modal(t('反饋知識有誤 {id}', { id }), `<p class="notice warn">${t('提交後，若該知識為 L0 將降為 L1 並排入重驗。')}</p>${field(t('哪裡有誤'), textarea('comment', '', 'required'))}${field(t('相關問題（選填）'), input('question'))}`, {
      label: t('提交反饋'),
      run: async () => { await post('/api/v1/feedback', { targetId: id, ...formData($('#dialog-content')) }); toast(t('反饋已提交')); render(); }
    });
  },
  conflict(id) {
    modal(t('登記衝突 {id}', { id }), `<p class="notice warn">${t('雙方都降為 L1，並通知負責人裁決。')}</p>${field(t('與哪條知識矛盾（ID）'), input('b', '', `placeholder="${esc(t('例如 A-0003 或 R-0002'))}" required`))}${field(t('說明'), textarea('note'))}`, {
      label: t('登記衝突'),
      run: async () => { const d = formData($('#dialog-content')); await post('/api/v1/conflicts', { a: id, b: d.b.trim(), note: d.note }); toast(t('衝突已登記')); render(); }
    });
  },
  offline(id) {
    modal(t('標記客體下線 {id}', { id }), `<p class="notice warn">${t('客體下線後，相關綁定轉為 E1；以它為證據的斷言和關係降為 L1，等待負責人處理。')}</p>${field(t('下線原因'), input('reason', '', `required placeholder="${esc(t('表刪除、接口廢棄、文檔作廢…'))}"`))}`, {
      label: t('確認下線'),
      run: async () => { await patch(`/api/v1/objects/${id}`, { status: '下線', reason: formData($('#dialog-content')).reason }); toast(t('{id} 已下線，相關知識已級聯處理', { id })); render(); }
    });
  },
  async invoke(id) {
    const a = (await get('/api/v1/actions')).find(x => x.id === id);
    const objects = await get('/api/v1/objects?category=物理');
    const inputs = (a.inputs || []).map(d => field(`${tv(d.label || d.name)}${d.required ? '' : t('（選填）')}`, d.fromObjects ? select(d.name, [['', t('請選擇')], ...objects.map(o => [o.locator || o.name, o.name])]) : input(d.name, '', `placeholder="${esc(d.pattern || '')}"`))).join('');
    modal(t('調用取值 Action {id}', { id }), `<p class="notice">${esc(t('{name}：實時讀取，不使用任何存儲值。', { name: a.name }))}</p>${inputs || `<p class="muted">${t('此 Action 沒有輸入參數。')}</p>`}<div id="invoke-result"></div>`, {
      label: t('調用'),
      run: async () => {
        const r = await post(`/api/v1/actions/${id}/invoke`, { inputs: formData($('#dialog-content')) });
        $('#invoke-result').innerHTML = `<pre class="mono-block">${esc(JSON.stringify(r.data, null, 2))}</pre>`;
        return true;
      }
    });
  },
  async closeFeedback(id) {
    modal(t('關閉反饋 {id}', { id }), field(t('處理結果'), textarea('resolution', '', 'required')), { label: t('關閉'), run: async () => { await post(`/api/v1/feedback/${id}/close`, formData($('#dialog-content'))); render(); } });
  },
  async closeGap(id) {
    modal(t('標記缺口已處理 {id}', { id }), field(t('處理結果'), textarea('resolution', '', `placeholder="${esc(t('已補充主體 / 斷言 …'))}"`)), { label: t('標記已處理'), run: async () => { await post(`/api/v1/gaps/${id}/close`, formData($('#dialog-content'))); render(); } });
  },
  async resolveConflict(id) {
    const c = (await get('/api/v1/conflicts')).find(x => x.id === id);
    const [a, b] = await Promise.all([get(`/api/v1/items/${c.a}`), get(`/api/v1/items/${c.b}`)]);
    const desc = x => esc(x.content || (x.kind === 'relation' ? `${x.fromSubject?.name} –${tv(x.type, 'rel')}→ ${x.toSubject?.name}` : x.objectId));
    modal(t('裁決衝突 {id}', { id }), `<p class="notice">${t('勝出方回到 L0（負責人確認），另一方轉為 E1 並指向勝出方。')}</p><label class="check"><input type="radio" name="winner" value="${esc(c.a)}" checked> ${esc(c.a)}${t('：')}${desc(a)}</label><label class="check"><input type="radio" name="winner" value="${esc(c.b)}"> ${esc(c.b)}${t('：')}${desc(b)}</label>${field(t('裁決理由'), textarea('reason'))}`, {
      label: t('提交裁決'),
      run: async () => { const winner = $('#dialog-content input[name=winner]:checked').value; await post(`/api/v1/conflicts/${id}/resolve`, { winner, reason: $('#dialog-content textarea').value }); toast(t('已裁決')); render(); }
    });
  }
};

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-op]');
  if (!b || !OPS[b.dataset.op]) return;
  e.preventDefault();
  b.disabled = true;
  try { await OPS[b.dataset.op](b.dataset.id, b.dataset); } catch (err) { showError(err); } finally { b.disabled = false; }
});

// ------------------------------------------------------------------ 頁面
const PAGES = {};
registerDocPages(PAGES, { me: () => me, render: () => render(), title: NAV.title, schema: () => schema, subjectOptions: () => subjectOptions(true) });

PAGES.dashboard = async () => {
  const o = await get('/admin/api/overview');
  const h = o.health;
  setActions(`<a class="button" href="#playground">${t('問答測試')}</a>${me.isAdmin ? `<button class="button" id="run-expiry">${t('執行到期檢查')}</button>` : ''}<a class="button primary" href="#subjects">${t('管理知識')}</a>`);
  const empty = !h.totals.subjects;
  const stat = (label, value, sub, hint) => `<section class="panel stat"><small>${label}</small><div class="value">${value}${sub ? `<small>${sub}</small>` : ''}</div><p>${hint}</p></section>`;
  const lv = h.levels;
  const bars = [[t('nav|主體'), lv.subject, ['L0', 'L1', 'L2']], [t('nav|客體綁定'), lv.binding], [t('nav|斷言'), lv.assertion], [t('nav|關係'), lv.relation]].map(([n, c, keys]) => {
    const b = levelBar(c, keys);
    return `<div class="bar-row"><span>${n}</span>${b.bar}<small class="muted">${b.text}</small></div>`;
  }).join('');
  const git = o.git;
  const emptyHint = me.isAdmin
    ? t('知識庫目前為空。可在 <a href="#repo">設定 › 知識倉庫</a> 配置 Git 倉庫並載入庫存域示例資料，或讓三方智能體按 <a href="#prompt">智能體教程</a> 提交知識。')
    : t('知識庫目前為空。可讓三方智能體按 <a href="#prompt">智能體教程</a> 提交知識。');
  content().innerHTML = `${empty ? `<div class="notice warn" style="margin-bottom:12px">${emptyHint}</div>` : ''}
  <div class="four-col">
    ${stat(t('L0 覆蓋率'), pct(h.l0Coverage.value), h.l0Coverage.total ? `${h.l0Coverage.covered}/${h.l0Coverage.total}` : '', esc(h.l0Coverage.basis))}
    ${stat(t('待重驗數'), h.pendingRevalidation.value, t('條'), Object.entries(h.pendingRevalidation.byReason).map(([k, v]) => `${mapText(PENDING_SHORT, k)} ${v}`).join(' · ') || t('已到期降級、尚未重驗的條目'))}
    ${stat(t('未收錄查詢數'), h.uncoveredQueries.value, t('近 {n} 天', { n: h.windowDays }), t('累計 {total} 次 · 未處理缺口 {gaps} 個', { total: h.uncoveredQueries.total, gaps: h.uncoveredQueries.openGaps }))}
    ${stat(t('L0 錯誤反饋數'), h.l0ErrorFeedback.value, t('近 {n} 天', { n: h.windowDays }), t('累計 {total} 次 · 應趨近於 0', { total: h.l0ErrorFeedback.total }))}
  </div>
  <div class="two-col" style="margin-top:12px">
    <div class="stack">
      ${panel(t('有效性層級分佈'), `<div class="panel-body">${bars}</div>`, `<a class="text-btn" href="#levels">${t('層級說明')}</a>`)}
      ${panel(t('高頻主體'), table([t('主體'), t('類型'), '#' + t('使用次數'), t('綜合層級'), t('有 L0 知識')], h.topSubjects.map(s => `<tr><td>${idLink(s.id)} ${esc(s.name)}</td><td>${esc(tv(s.type))}</td><td class="numeric">${s.usage}</td><td>${level(s.level)}</td><td>${s.hasL0 ? pill(t('是'), 'green') : pill(t('否'), 'amber')}</td></tr>`), t('尚無使用記錄：智能體通過消費型 API 提問後會累計')), `<a class="text-btn" href="#queue">${t('重驗隊列')}</a>`)}
    </div>
    <div class="stack">
      ${panel(t('知識倉庫'), `<div class="panel-body"><dl class="kv">
        <dt>${t('遠端')}</dt><dd>${esc(git.remote || t('未配置（本地倉庫）'))}</dd>
        <dt>${t('分支 / HEAD')}</dt><dd>${esc(git.branch)} · <span class="mono">${esc(git.head || '—')}</span></dd>
        <dt>${t('認證')}</dt><dd>${esc(authText(git.auth) || '—')}</dd>
        <dt>${t('最近拉取')}</dt><dd>${ago(git.lastPullAt)}</dd><dt>${t('最近推送')}</dt><dd>${ago(git.lastPushAt)}</dd>
        <dt>${t('狀態')}</dt><dd>${git.lastError ? `<span class="badge red">${t('同步異常')}</span> <span class="cell-sub">${esc(git.lastError)}</span>` : `<span class="badge green">${t('正常')}</span>`}${git.loadErrors?.length ? ` <span class="badge amber">${esc(t('{n} 個檔案無法解析', { n: git.loadErrors.length }))}</span>` : ''}</dd>
        <dt>${t('自然語言')}</dt><dd>${o.llm.enabled ? `OpenRouter · ${esc(o.llm.model)}` : t('未配置（使用規則模板）')}</dd>
      </dl></div>`, me.isAdmin ? `<a class="text-btn" href="#repo">${t('設定')}</a>` : '')}
      ${docsDashboardPanel(h.documents)}
      ${panel(t('知識規模'), `<div class="panel-body"><dl class="kv">${[[t('規範主體'), h.totals.subjects], [t('nav|別名'), h.totals.aliases], [t('nav|斷言'), h.totals.assertions], [t('nav|客體'), h.totals.objects], [t('nav|關係'), h.totals.relations], [t('Action / 管道'), `${h.totals.actions} / ${h.totals.pipelines}`], [t('未裁決衝突'), h.totals.openConflicts], [t('未處理反饋'), h.totals.openFeedback]].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>`)}
      ${panel(t('最近提交'), `<div class="panel-body"><ul class="timeline">${o.log.map(l => `<li><strong>${esc(l.subject)}</strong><span class="cell-sub">${esc(td(l.author))} · ${ago(l.date)} · <span class="mono">${esc(l.hash)}</span></span></li>`).join('') || `<li>${t('尚無提交')}</li>`}</ul></div>`, `<a class="text-btn" href="#changes">${t('全部')}</a>`)}
    </div>
  </div>`;
  $('#run-expiry')?.addEventListener('click', async () => { const r = await post('/admin/api/maintenance/expiry'); toast(t('到期檢查完成：{n} 條降為 L1', { n: r.data.expired.length })); render(); });
};

PAGES.changes = async () => {
  const log = await get('/admin/api/log?limit=150');
  const isDoc = l => /^\[文檔\]/.test(l.subject || '');
  const rows = filter => log.filter(l => (filter === 'docs' ? isDoc(l) : filter === 'knowledge' ? !isDoc(l) : true)).map(l => `<tr><td class="mono">${esc(l.hash)}</td><td>${esc(td(l.author))}<span class="cell-sub">${esc(l.email)}</span></td><td>${fmtTime(l.date)}</td><td class="wrap">${esc(l.subject)}</td></tr>`);
  content().innerHTML = panel(t('提交記錄（{n}）', { n: log.length }), `<div class="toolbar"><label>${t('顯示')} ${select('filter', [['', t('全部')], ['docs', t('只看文檔')], ['knowledge', t('不含文檔')]], '', 'id="f-commits"')}</label></div><div id="commit-table">${table([t('commit|提交'), t('作者'), t('時間'), t('說明')], rows(''), t('尚無提交'))}</div>`);
  $('#f-commits').onchange = e => ($('#commit-table').innerHTML = table([t('commit|提交'), t('作者'), t('時間'), t('說明')], rows(e.target.value), t('尚無提交')));
};

PAGES.subjects = async () => {
  const sc = schema;
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  setActions(`<button class="button primary" id="add-subject">${t('新增主體')}</button>`);
  content().innerHTML = panel(t('主體一覽'), `<div class="toolbar"><label class="grow">${t('搜索')} <input id="f-q" placeholder="${esc(t('名稱、ID、定義、別名'))}" value="${esc(params.get('q') || '')}"></label><label>${t('類型')} ${select('type', [['', t('全部類型')], ...Object.keys(sc.subjectTypes).map(k => [k, tv(k)])], '', 'id="f-type"')}</label><label>${t('領域')} ${select('domain', [['', t('全部領域')], ...sc.domains.map(d => [d.code, domainName(d)])], '', 'id="f-domain"')}</label><label>${t('綜合層級')} ${select('level', [['', t('全部')], 'L0', 'L1', 'L2'], '', 'id="f-level"')}</label><small id="f-count" class="muted"></small></div><div id="subject-table"></div>`);
  const load = async () => {
    const list = await get('/api/v1/subjects?' + qs({ q: $('#f-q').value, type: $('#f-type').value, domain: $('#f-domain').value, level: $('#f-level').value }));
    $('#f-count').textContent = t('{n} 個主體', { n: list.length });
    $('#subject-table').innerHTML = table(['ID', t('名稱 / 定義'), t('類型'), t('領域'), t('綜合層級'), '#' + t('斷言'), '#' + t('待重驗'), '#' + t('使用'), t('負責人')], list.map(s => `<tr><td>${idLink(s.id)}</td><td class="wrap"><a href="#subject/${esc(s.id)}"><strong>${esc(s.name)}</strong></a><span class="cell-sub">${s.type === '別名' ? `${t('別名')} → ${(s.aliasOf || []).map(id => esc(id)).join(t('、'))}` : esc(s.definition || t('（未填寫定義）'))}</span></td><td>${esc(tv(s.type))}</td><td>${esc(s.domain)}</td><td>${s.type === '別名' ? `<span class="muted">${t('不適用')}</span>` : level(s.level)}</td><td class="numeric">${s.assertions}</td><td class="numeric">${s.pending ? pill(s.pending, 'amber') : 0}</td><td class="numeric">${s.usage}</td><td>${esc(s.owner || '—')}</td></tr>`), t('沒有相符的主體'));
  };
  let timer;
  $('#f-q').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 200); };
  ['#f-type', '#f-domain', '#f-level'].forEach(s => ($(s).onchange = load));
  await load();
  $('#add-subject').onclick = () => subjectDialog();
};

async function subjectDialog(existing) {
  const sc = schema;
  const opts = await subjectOptions(true);
  const s = existing || {};
  modal(existing ? t('編輯主體 {id}', { id: s.id }) : t('新增主體'), `${opts}
    ${field(t('名稱（規範名）'), input('name', s.name, 'required'))}
    <div class="field-pair">${field(t('類型'), select('type', Object.entries(sc.subjectTypes).map(([k, v]) => [k, `${tv(k)} — ${v.desc}`]), s.type || '指標', existing ? 'disabled' : 'id="subject-type"'))}${field(t('領域'), select('domain', sc.domains.map(d => [d.code, domainName(d)]), s.domain, existing ? 'disabled' : ''))}</div>
    ${field(t('定義'), textarea('definition', s.definition, `placeholder="${esc(t('一句話說明它是什麼、不是什麼'))}"`))}
    <div class="field-pair">${field(t('負責人'), input('owner', s.owner, `placeholder="${esc(t('對該主體知識有效性負責的人'))}"`))}${field(t('出錯代價（1–5）'), input('errorCost', s.errorCost ?? 3, 'type="number" min="1" max="5"'), t('用於重驗優先級'))}</div>
    ${existing ? field(t('有效期覆蓋（天，選填）'), input('expiryDays', s.expiryDays || '', 'type="number" min="1"'), t('負責人可按主體調整有效期')) : `<div id="alias-box" hidden>${field(t('別名指向的規範主體（多個用逗號分隔，表示一詞多義）'), input('aliasOf', '', `list="subject-options" placeholder="${esc(t('S-INV-0012 可售庫存'))}"`))}</div>`}`, {
    label: existing ? t('保存') : t('新增'),
    run: async () => {
      const d = formData($('#dialog-content'));
      if (existing) {
        await patch(`/api/v1/subjects/${s.id}`, { name: d.name, definition: d.definition, owner: d.owner, errorCost: Number(d.errorCost), expiryDays: d.expiryDays ? Number(d.expiryDays) : null });
        toast(t('已保存'));
      } else {
        const body = { name: d.name, type: d.type, domain: d.domain, definition: d.definition, owner: d.owner, errorCost: Number(d.errorCost) };
        if (d.type === '別名') body.aliasOf = d.aliasOf.split(/[,，]/).map(parseId).filter(Boolean);
        const r = await post('/api/v1/subjects', body);
        toast(t('已新增 {id}', { id: r.data.id }));
        location.hash = `subject/${r.data.id}`;
        return;
      }
      render();
    }
  });
  const typeSel = $('#subject-type');
  if (typeSel) { const sync = () => ($('#alias-box').hidden = typeSel.value !== '別名'); typeSel.onchange = sync; sync(); }
}

const actionLibrary = actions => actions.map(a => `<div class="library-item"><div><strong>${esc(a.name)}</strong><span class="cell-sub">${esc(a.id)} · ${esc(tv(a.kind, 'act'))}</span></div>${a.kind === '取值' ? `<button class="button" data-op="invoke" data-id="${esc(a.id)}">${t('實時取值')}</button>` : pill(tv('校驗', 'act'), 'blue')}</div>`).join('');
const statusPill = status => (status === '下線' ? vpill('下線', 'red') : vpill('在用', 'green'));

PAGES.subject = async ({ param: id }) => {
  const [card, history, graph] = await Promise.all([get(`/api/v1/subjects/${id}`), get(`/api/v1/subjects/${id}/history`), get(`/api/v1/graph?focus=${encodeURIComponent(id)}&depth=1`)]);
  const s = card.subject;
  setHeading(s.name, s.definition || '', `${t('知識庫')} › ${t('主體')} › ${s.id}`);
  document.title = `${s.name} · ${NAV.title}`;
  if (s.type === '別名') {
    setActions(me.isAdmin ? `<button class="button danger" id="del-subject">${t('刪除')}</button>` : '');
    content().innerHTML = `<div class="two-col"><div class="stack">${panel(t('別名'), `<div class="panel-body"><dl class="kv"><dt>ID</dt><dd>${tag(s.id)}</dd><dt>${t('類型')}</dt><dd>${t('別名')}</dd><dt>${t('指向')}</dt><dd>${card.alias.targets.map(x => `${idLink(x.id)} ${esc(x.name)}`).join('<br>') || '—'}</dd></dl><p class="notice ${card.alias.ambiguous ? 'warn' : ''}" style="margin-top:10px">${esc(card.alias.guidance)}</p></div>`)}</div><div>${panel(t('版本歷史'), historyHtml(history))}</div></div>`;
  } else {
    setActions(`<a class="button" href="#graph/${esc(s.id)}">${t('在圖譜中查看')}</a><button class="button" id="edit-subject">${t('編輯')}</button><button class="button" id="add-binding">${t('綁定客體')}</button><button class="button" id="add-relation">${t('新增關係')}</button><button class="button primary" id="add-assertion">${t('新增斷言')}</button>${me.isAdmin ? `<button class="button danger" id="del-subject">${t('刪除')}</button>` : ''}`);
    const assertionRow = a => `<tr><td>${idLink(a.id)}</td><td>${esc(tv(a.type))}</td><td class="wrap">${esc(a.content)}${a.structured ? `<span class="cell-sub mono">${esc(a.structured.key)} = ${esc(structuredValueText(a.structured.value))}</span>` : ''}${a.level === 'E1' ? `<span class="cell-sub">${esc(t('失效原因：{reason}', { reason: td(a.invalidReason) || '—' }))}${a.replacedBy ? `${t('；替代者 ')}${idLink(a.replacedBy)}` : ''}</span>` : ''}</td><td>${level(a.level)} ${pendingCell(a.validity)}</td><td class="wrap">${evidenceCell(a.validity)}</td><td>${rowOps(a.id, a.level)}</td></tr>`;
    const verifyText = v => (v.method === 'auto' ? t('Action 校驗（{by}）', { by: v.verifiedBy || '' }) : v.method === 'manual' ? t('負責人確認（{by}）', { by: v.verifiedBy || '' }) : t('未驗證'));
    const bindingRows = card.bindings.map(b => `<tr><td>${idLink(b.id)}</td><td class="wrap">${idLink(b.object.id)} ${esc(b.object.name)}<span class="cell-sub">${esc(tv(b.object.category))} · ${esc(tv(b.object.kind) || '')} ${b.object.locator ? '· ' + esc(b.object.locator) : ''}</span></td><td>${statusPill(b.object.status)}</td><td>${level(b.level)} ${pendingCell(b.validity)}</td><td>${esc(verifyText(b.validity))}<span class="cell-sub">${b.validity.expiresAt ? esc(t('有效期至 {date}', { date: fmtTime(b.validity.expiresAt) })) : ''}</span></td><td>${rowOps(b.id, b.level)}</td></tr>`);
    const relRow = (r, dir) => `<tr><td>${idLink(r.id)}</td><td>${dir === 'out' ? `<strong>${esc(s.name)}</strong>` : `${idLink(r.from.id)} ${esc(r.from.name)}`}</td><td>${vpill(r.type, 'blue', 'rel')}</td><td>${dir === 'out' ? `${idLink(r.to.id)} ${esc(r.to.name)}` : `<strong>${esc(s.name)}</strong>`}</td><td>${level(r.level)} ${pendingCell(r.validity)}</td><td>${rowOps(r.id, r.level)}</td></tr>`;
    content().innerHTML = `<div class="stack"><div class="two-col subject-overview"><div class="stack">
      ${panel(t('客體綁定（{n}）', { n: card.bindings.length }), table(['ID', t('客體'), t('狀態'), t('層級'), t('驗證'), t('操作')], bindingRows, t('尚無客體綁定：綜合層級為 L2')), `<span class="muted" style="font-size:11px">${t('綜合層級 = 有效綁定中的最高層級')}</span>`)}
      ${panel(t('關係（{n}）', { n: card.relations.outgoing.length + card.relations.incoming.length }), table(['ID', t('起點'), t('關係'), t('終點'), t('層級'), t('操作')], [...card.relations.outgoing.map(r => relRow(r, 'out')), ...card.relations.incoming.map(r => relRow(r, 'in'))], t('尚無關係')))}
      ${subjectDocsPanel(s, card.documents || [])}
    </div><div class="stack">
      ${panel(t('主體資訊'), `<div class="panel-body"><dl class="kv"><dt>ID</dt><dd>${tag(s.id)}</dd><dt>${t('類型 / 領域')}</dt><dd>${esc(tv(s.type))} · ${esc(s.domain)}</dd><dt>${t('綜合層級')}</dt><dd>${level(s.level)}<span class="cell-sub">${esc(s.levelNote)}</span></dd><dt>${t('負責人')}</dt><dd>${esc(s.owner || '—')}</dd><dt>${t('出錯代價')}</dt><dd>${s.errorCost} / 5</dd><dt>${t('別名')}</dt><dd>${card.aliases.map(a => `${idLink(a.id, a.name)}${a.ambiguous ? ` <span class="badge amber">${t('多義')}</span>` : ''}`).join(' ') || '—'}</dd><dt>${t('更新')}</dt><dd>${fmtTime(s.updatedAt)}</dd></dl></div>`)}
      ${panel(t('可用 Action'), `<div class="panel-body stack-sm">${actionLibrary(card.actions) || `<p class="muted">${t('綁定的客體沒有配置 Action。')}</p>`}${card.dynamicValueNote ? `<p class="notice">${esc(card.dynamicValueNote)}</p>` : ''}</div>`)}
      ${panel(t('一跳鄰域'), `<div id="mini-graph" class="graph-canvas"></div>`)}
      ${panel(t('版本歷史'), historyHtml(history))}
    </div></div>
      <div id="subject-assertions">${panel(t('斷言（{n}）', { n: card.assertions.length }), `
        <div class="toolbar assertion-pagination">
          <span id="assertion-range" class="muted" role="status" aria-live="polite"></span>
          <div class="actions">
            <label>${t('層級')}${select('assertion-level', [['active', t('有效斷言')], ['all', t('全部斷言')], 'L0', 'L1', 'L2', 'E1'], 'active', 'id="assertion-level" aria-controls="subject-assertion-table"')}</label>
            <label>${t('每頁條數')}${select('assertion-page-size', [10, 20, 50], 10, 'id="assertion-page-size" aria-controls="subject-assertion-table"')}</label>
          </div>
        </div>
        <div id="subject-assertion-table"></div>
        <nav class="toolbar assertion-pagination" aria-label="${esc(t('斷言分頁'))}">
          <span id="assertion-page-info" class="muted"></span>
          <div class="actions">
            <button class="button" id="assertion-first" aria-controls="subject-assertion-table">${t('首頁')}</button>
            <button class="button" id="assertion-prev" aria-controls="subject-assertion-table">${t('上一頁')}</button>
            <button class="button" id="assertion-next" aria-controls="subject-assertion-table">${t('下一頁')}</button>
            <button class="button" id="assertion-last" aria-controls="subject-assertion-table">${t('末頁')}</button>
          </div>
        </nav>`)}</div>
    </div>`;
    let assertionPage = 1;
    let assertionPageSize = 10;
    let assertionLevel = 'active';
    const filteredAssertions = () => card.assertions.filter(a => assertionLevel === 'all' || (assertionLevel === 'active' ? a.level !== 'E1' : a.level === assertionLevel));
    const assertionPageCount = () => Math.max(1, Math.ceil(filteredAssertions().length / assertionPageSize));
    const renderAssertions = () => {
      const assertions = filteredAssertions();
      const total = assertions.length;
      const pages = assertionPageCount();
      assertionPage = Math.max(1, Math.min(assertionPage, pages));
      const start = (assertionPage - 1) * assertionPageSize;
      const rows = assertions.slice(start, start + assertionPageSize).map(assertionRow);
      $('#subject-assertions h2').textContent = t('斷言（{n}）', { n: total });
      $('#subject-assertion-table').innerHTML = table(['ID', t('類型'), t('內容'), t('層級'), t('證據'), t('操作')], rows, t('尚無斷言。約束類斷言（否定性知識、邊界情況）最容易被智能體用常識補錯，建議優先收集。'));
      $('#assertion-range').textContent = t('顯示 {start}–{end} 條，共 {total} 條', { start: total ? start + 1 : 0, end: Math.min(start + assertionPageSize, total), total });
      $('#assertion-page-info').textContent = t('第 {page} / {pages} 頁', { page: assertionPage, pages });
      $('#assertion-first').disabled = $('#assertion-prev').disabled = assertionPage === 1;
      $('#assertion-next').disabled = $('#assertion-last').disabled = assertionPage === pages;
    };
    $('#assertion-page-size').onchange = e => {
      assertionPageSize = Number(e.target.value);
      assertionPage = 1;
      renderAssertions();
    };
    $('#assertion-level').onchange = e => {
      assertionLevel = e.target.value;
      assertionPage = 1;
      renderAssertions();
    };
    $('#assertion-first').onclick = () => { assertionPage = 1; renderAssertions(); };
    $('#assertion-prev').onclick = () => { assertionPage--; renderAssertions(); };
    $('#assertion-next').onclick = () => { assertionPage++; renderAssertions(); };
    $('#assertion-last').onclick = () => { assertionPage = assertionPageCount(); renderAssertions(); };
    renderAssertions();
    renderGraph($('#mini-graph'), graph, { focus: s.id, height: 300, onSelect: n => { if (n.id !== s.id) location.hash = `subject/${n.id}`; } });
    $('#edit-subject').onclick = () => subjectDialog({ ...s });
    $('#add-assertion').onclick = () => assertionDialog(s, card);
    $('#add-binding').onclick = () => bindingDialog(s);
    $('#add-relation').onclick = () => relationDialog({ from: `${s.id} ${s.name}` });
  }
  $('#del-subject')?.addEventListener('click', () => modal(t('刪除主體 {id}', { id: s.id }), `<p class="notice warn">${t('刪除會同時移除相關關係，僅用於清理錯誤錄入。正常情況請把知識轉為 E1（E1 不刪除）。')}</p>`, { label: t('確認刪除'), run: async () => { await del(`/api/v1/subjects/${s.id}`); location.hash = 'subjects'; } }));
};

function historyHtml(history) {
  return `<div class="panel-body"><ul class="timeline">${history.map(l => `<li><strong>${esc(l.subject)}</strong><span class="cell-sub">${esc(td(l.author))} · ${fmtTime(l.date)} · <span class="mono">${esc(l.hash)}</span></span></li>`).join('') || `<li>${t('尚無提交')}</li>`}</ul></div>`;
}

async function assertionDialog(s, card) {
  const sc = schema;
  const bound = card.bindings.filter(b => b.level !== 'E1');
  modal(t('新增斷言 · {name}', { name: s.name }), `<p class="notice">${t('你的提交：附客體證據最高 L1，無證據只能 L2。L0 只能通過 Action 校驗或負責人確認晉升。')}</p>
    ${field(t('類型'), select('type', Object.entries(sc.assertionTypes).map(([k, v]) => [k, `${tv(k)} — ${v}`]), '定義'))}
    ${field(t('內容（一條只說一件事）'), textarea('content', '', 'required'))}
    <div class="field-pair">${field(t('結構化鍵（選填）'), input('key', '', 'placeholder="reserve.ttl"'))}${field(t('結構化值（選填）'), input('value', '', 'placeholder="30m"'))}</div>
    ${field(t('證據客體（主體已綁定的客體，可多選）'), `<select name="objectIds" multiple size="${Math.min(6, Math.max(2, bound.length))}">${bound.map(b => `<option value="${esc(b.object.id)}">${esc(b.object.id)} ${esc(b.object.name)}</option>`).join('')}</select>`)}
    ${field(t('明確來源（選填）'), input('sourceRef', '', `placeholder="${esc(t('文檔鏈接、評審記錄等'))}"`))}`, {
    label: t('提交'),
    run: async () => {
      const d = formData($('#dialog-content'));
      const r = await post(`/api/v1/subjects/${s.id}/assertions`, { type: d.type, content: d.content, structured: d.key ? { key: d.key, value: d.value } : undefined, evidence: { objectIds: d.objectIds, sourceRef: d.sourceRef } });
      toast(t('已新增 {id}（{level}）', { id: r.data.id, level: r.data.validity.level }));
      render();
    }
  });
}

async function bindingDialog(s) {
  const objects = (await get('/api/v1/objects?status=在用'));
  modal(t('綁定客體 · {name}', { name: s.name }), `<p class="notice">${t('綁定提交後為 L1；通過校驗 Action 或負責人確認後成為 L0，主體綜合層級隨之更新。')}</p>${field(t('客體'), select('objectId', objects.map(o => [o.id, `${o.id} ${o.name}（${tv(o.category)}）`])))}${field(t('說明（選填）'), input('note'))}<p class="muted" style="margin-top:8px">${t('找不到客體？先到 <a href="#objects">客體</a> 頁登記。')}</p>`, {
    label: t('綁定'),
    run: async () => { const r = await post(`/api/v1/subjects/${s.id}/bindings`, formData($('#dialog-content'))); toast(t('已綁定 {id}', { id: r.data.id })); render(); }
  });
}

async function relationDialog(preset = {}) {
  const sc = schema;
  const opts = await subjectOptions(true);
  const objects = await get('/api/v1/objects?status=在用');
  modal(t('新增關係'), `${opts}<p class="notice">${t('關係類型是閉集，方向必須符合定義；新增類型須經負責人評審。')}</p>
    ${field(t('起點主體'), input('from', preset.from || '', 'list="subject-options" required'))}
    ${field(t('關係類型'), select('type', Object.entries(sc.relationTypes).map(([k, v]) => [k, `${tv(k, 'rel')}${t('：')}${v.direction}`]), preset.type || '依賴'))}
    ${field(t('終點主體'), input('to', preset.to || '', 'list="subject-options" required'))}
    ${field(t('證據客體（選填，可多選）'), `<select name="objectIds" multiple size="4">${objects.map(o => `<option value="${esc(o.id)}">${esc(o.id)} ${esc(o.name)}</option>`).join('')}</select>`)}
    ${field(t('明確來源（選填）'), input('sourceRef', '', `placeholder="${esc(t('調用鏈、表血緣、設計文檔…'))}"`))}`, {
    label: t('新增'),
    run: async () => {
      const d = formData($('#dialog-content'));
      const r = await post('/api/v1/relations', { from: parseId(d.from), type: d.type, to: parseId(d.to), evidence: { objectIds: d.objectIds, sourceRef: d.sourceRef } });
      toast(t('已新增 {id}（{level}）', { id: r.data.id, level: r.data.validity.level }));
      render();
    }
  });
}

PAGES.item = async ({ param: id }) => {
  const it = await get(`/api/v1/items/${id}`);
  const v = it.validity;
  const kindName = mapText(ITEM_KIND, it.kind);
  const text = it.kind === 'assertion' ? it.content : it.kind === 'relation' ? `${it.fromSubject?.name} –${tv(it.type, 'rel')}→ ${it.toSubject?.name}` : t('綁定客體 {id}', { id: it.objectId });
  setHeading(`${kindName} ${id}`, text, `${t('知識庫')} › ${kindName} › ${id}`);
  setActions(it.subject ? `<a class="button" href="#subject/${esc(it.subject.id)}">${t('返回主體')}</a>` : '');
  const method = { auto: t('自動（Action 校驗）'), manual: t('人工（負責人確認）'), pipeline: t('已註冊管道同步') }[v.method] || t('未驗證');
  content().innerHTML = `<div class="two-col"><div class="stack">
    ${panel(t('有效性'), `<div class="panel-body"><dl class="kv">
      <dt>${t('層級')}</dt><dd>${level(v.level)} ${pendingCell(v)}</dd>
      <dt>${t('所屬主體')}</dt><dd>${it.subject ? `${idLink(it.subject.id)} ${esc(it.subject.name)}` : '—'}</dd>
      ${it.kind === 'assertion' ? `<dt>${t('類型')}</dt><dd>${esc(tv(it.type))}</dd><dt>${t('內容')}</dt><dd>${esc(it.content)}</dd>${it.structured ? `<dt>${t('結構化值')}</dt><dd class="mono">${esc(it.structured.key)} = ${esc(structuredValueText(it.structured.value))}</dd>` : ''}` : ''}
      ${it.kind === 'relation' ? `<dt>${t('關係')}</dt><dd>${idLink(it.from)} ${esc(it.fromSubject?.name)} –${esc(tv(it.type, 'rel'))}→ ${idLink(it.to)} ${esc(it.toSubject?.name)}</dd>` : ''}
      ${it.kind === 'binding' ? `<dt>${t('客體')}</dt><dd>${idLink(it.objectId)}</dd>` : ''}
      <dt>${t('證據')}</dt><dd>${evidenceCell(v)}</dd>
      <dt>${t('驗證方式')}</dt><dd>${esc(method)}</dd>
      <dt>${t('驗證人與時間')}</dt><dd>${esc(v.verifiedBy || '—')} · ${fmtTime(v.verifiedAt)}</dd>
      <dt>${t('有效期至')}</dt><dd>${fmtTime(v.expiresAt)}</dd>
      <dt>${t('來源')}</dt><dd>${esc(v.source ? `${v.source.name || v.source.id}（${mapText(SOURCE_KIND, v.source.kind)}）` : '—')}</dd>
      ${v.lastCheck ? `<dt>${t('最近校驗')}</dt><dd>${esc(v.lastCheck.actionId)} · ${esc(mapText(OUTCOME_TEXT, v.lastCheck.outcome))} · ${fmtTime(v.lastCheck.at)}<span class="cell-sub">${esc(td(v.lastCheck.detail) || '')}</span></dd>` : ''}
      ${v.lastCheck?.rpa ? `<dt>${t('RPA 證據')}</dt><dd>${runLink(v.lastCheck.rpa)} · ${esc(v.lastCheck.rpa.sceneId)} v${esc(v.lastCheck.rpa.revision)}${v.lastCheck.rpa.workerId ? ` · Worker ${esc(v.lastCheck.rpa.workerId)}` : ''}<span class="cell-sub">${evidenceSummary(v.lastCheck.rpa)}</span><span class="cell-sub">${esc(t('執行 {id}', { id: v.lastCheck.executionId || '' }))}</span></dd>` : ''}
      ${v.level === 'E1' ? `<dt>${t('失效原因')}</dt><dd>${esc(td(v.invalidReason) || '—')}</dd><dt>${t('替代者')}</dt><dd>${v.replacedBy ? idLink(v.replacedBy) : '—'}</dd>` : ''}
    </dl></div>`)}
    ${panel(t('操作'), `<div class="panel-body">${rowOps(id, v.level, { full: true })}<p class="muted" style="margin-top:8px;font-size:12px">${t('上行只有兩條路：補充證據（L2 → L1），以及校驗或確認（L1 → L0）。智能體不能晉升知識。')}</p></div>`)}
  </div><div class="stack">${panel(t('層級歷史'), `<div class="panel-body"><ul class="timeline">${[...(v.history || [])].reverse().map(h => `<li><strong>${esc(h.from || t('新建'))} → ${esc(h.to)}</strong> ${esc(td(h.reason) || '')}<span class="cell-sub">${esc(h.by || '')} · ${fmtTime(h.at)}${h.note ? ' · ' + docNoteHtml(h.note) : ''}</span></li>`).join('') || `<li>${t('無')}</li>`}</ul></div>`)}<div id="item-execs"></div></div></div>`;
  get(`/api/v1/action-executions?${qs({ itemId: id, limit: 10 })}`).then(list => {
    if (list.length) $('#item-execs').innerHTML = panel(t('RPA 執行記錄'), executionTable(list, { item: false }));
  }).catch(() => {});
};

PAGES.assertions = async () => {
  const sc = schema;
  const owner = isOwner();
  const controls = owner ? `<div class="toolbar"><label class="check"><input type="checkbox" id="approve-all" disabled> ${t('全選當前結果中的 L1 斷言')}</label><button class="button primary" id="approve-selected" disabled></button></div>` : '';
  content().innerHTML = panel(t('斷言一覽'), `<div class="toolbar"><label class="grow">${t('搜索')} <input id="f-q" placeholder="${esc(t('內容、ID、主體名'))}"></label><label>${t('類型')} ${select('type', [['', t('全部類型')], ...Object.keys(sc.assertionTypes).map(k => [k, tv(k)])], '', 'id="f-type"')}</label><label>${t('層級')} ${select('level', [['', t('全部')], 'L0', 'L1', 'L2', 'E1'], '', 'id="f-level"')}</label><label class="check"><input type="checkbox" id="f-pending"> ${t('只看待重驗')}</label><small id="f-count" class="muted"></small></div>${controls}<div id="a-table"></div>`);
  const target = $('#a-table');
  const selected = new Set();
  let visible = [];
  let generation = 0;
  const all = $('#approve-all');
  const approve = $('#approve-selected');
  const sync = () => {
    if (!owner) return;
    const count = visible.filter(a => a.validity.level === 'L1').length;
    all.disabled = count === 0;
    all.checked = count > 0 && selected.size === count;
    all.indeterminate = selected.size > 0 && selected.size < count;
    approve.disabled = selected.size === 0;
    approve.textContent = t('批量審批（{n}）', { n: selected.size });
  };
  const reset = () => {
    generation++;
    visible = [];
    selected.clear();
    target.replaceChildren();
    sync();
  };
  if (owner) {
    target.onchange = e => {
      const box = e.target.closest('input[data-assertion]');
      if (!box) return;
      if (box.checked) selected.add(box.dataset.assertion);
      else selected.delete(box.dataset.assertion);
      sync();
    };
    all.onchange = () => {
      selected.clear();
      for (const box of $$('input[data-assertion]', target)) {
        box.checked = all.checked;
        if (box.checked) selected.add(box.dataset.assertion);
      }
      sync();
    };
    approve.onclick = () => {
      const rows = visible.filter(a => selected.has(a.id));
      const items = rows.map(a => ({ id: a.id, version: a.reviewVersion }));
      const review = table(['ID', t('主體'), t('內容'), t('證據')], rows.map(a => `<tr><td>${esc(a.id)}</td><td>${esc(a.subject.name)}</td><td class="wrap">${esc(a.content)}</td><td>${evidenceCell(a.validity)}</td></tr>`));
      modal(t('批量審批（{n}）', { n: rows.length }), review + field(t('確認說明（選填）'), textarea('note', '')), {
        label: t('確認為 L0'),
        run: async () => {
          await post('/api/v1/assertions/confirm-batch', { items, ...formData($('#dialog-content')) });
          toast(t('已確認 {n} 條斷言', { n: items.length }));
          await load();
        }
      });
    };
  }
  const load = async () => {
    if (!target.isConnected) return;
    reset();
    const request = generation;
    const list = await get('/api/v1/assertions?' + qs({ q: $('#f-q').value, type: $('#f-type').value, level: $('#f-level').value, pending: $('#f-pending').checked ? '1' : '' }));
    if (!target.isConnected || request !== generation) return;
    visible = list;
    sync();
    $('#f-count').textContent = t('{n} 條', { n: list.length });
    $('#a-table').innerHTML = table(['ID', t('主體'), t('類型'), t('內容'), t('層級'), t('證據'), t('操作')], list.map(a => `<tr><td>${owner && a.validity.level === 'L1' ? `<input type="checkbox" data-assertion="${esc(a.id)}" aria-label="${esc(a.id)}"> ` : ''}${idLink(a.id)}</td><td>${idLink(a.subject.id)} ${esc(a.subject.name)}</td><td>${esc(tv(a.type))}</td><td class="wrap">${esc(a.content)}${a.structured ? `<span class="cell-sub mono">${esc(a.structured.key)} = ${esc(structuredValueText(a.structured.value))}</span>` : ''}</td><td>${level(a.validity.level)} ${pendingCell(a.validity)}</td><td class="wrap">${evidenceCell(a.validity)}</td><td>${rowOps(a.id, a.validity.level)}</td></tr>`));
  };
  let timer;
  $('#f-q').oninput = () => { clearTimeout(timer); reset(); timer = setTimeout(load, 200); };
  ['#f-type', '#f-level', '#f-pending'].forEach(s => ($(s).onchange = load));
  await load();
};

PAGES.objects = async () => {
  const sc = schema;
  setActions(`<button class="button primary" id="add-object">${t('登記客體')}</button>`);
  content().innerHTML = panel(t('客體一覽'), `<div class="toolbar"><label class="grow">${t('搜索')} <input id="f-q" placeholder="${esc(t('名稱、ID、定位'))}"></label><label>${t('類別')} ${select('category', [['', t('全部類別')], ...Object.keys(sc.objectCategories).map(k => [k, tv(k)])], '', 'id="f-cat"')}</label><label>${t('狀態')} ${select('status', [['', t('全部')], ['在用', tv('在用')], ['下線', tv('下線')]], '', 'id="f-status"')}</label><small id="f-count" class="muted"></small></div><div id="o-table"></div>`);
  const load = async () => {
    const list = await get('/api/v1/objects?' + qs({ q: $('#f-q').value, category: $('#f-cat').value, status: $('#f-status').value }));
    $('#f-count').textContent = t('{n} 個客體', { n: list.length });
    $('#o-table').innerHTML = table(['ID', t('名稱'), t('類別 / 種類'), t('定位'), t('可用 Action'), t('狀態'), t('綁定主體'), t('操作')], list.map(o => `<tr><td>${idLink(o.id)}</td><td class="wrap"><a href="#object/${esc(o.id)}">${esc(o.name)}</a></td><td>${esc(tv(o.category))}<span class="cell-sub">${esc(tv(o.kind) || '')}</span></td><td class="mono wrap">${esc(o.locator || '—')}</td><td>${(o.actionIds || []).map(tag).join(' ') || '—'}</td><td>${statusPill(o.status)}</td><td class="wrap">${o.boundSubjects.map(s => `${idLink(s.id, s.name)}`).join(' ') || '—'}</td><td>${o.docId ? `<a class="text-btn" href="#doc/${esc(o.docId)}">${t('由文檔庫管理')}</a>` : o.status !== '下線' ? `<button class="text-btn" data-op="offline" data-id="${esc(o.id)}">${t('標記下線')}</button>` : ''}</td></tr>`));
  };
  let timer;
  $('#f-q').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 200); };
  ['#f-cat', '#f-status'].forEach(s => ($(s).onchange = load));
  await load();
  $('#add-object').onclick = async () => {
    const actions = await get('/api/v1/actions');
    modal(t('登記客體'), `${field(t('名稱'), input('name', '', `required placeholder="${esc(t('表字段 inventory.sku_stock.available_qty'))}"`))}<div class="field-pair">${field(t('類別'), select('category', Object.entries(sc.objectCategories).map(([k, v]) => [k, `${tv(k)} — ${v.desc}`]), '數字', 'id="obj-cat"'))}${field(t('種類'), input('kind', '', `list="kind-options" placeholder="${esc(t('表字段 / API / 配置項 / 口徑定義 / 倉庫'))}"`))}</div><datalist id="kind-options">${Object.values(sc.objectCategories).flatMap(c => c.kinds).map(k => `<option value="${esc(k)}">${esc(tv(k) === k ? '' : tv(k))}</option>`).join('')}</datalist>${field(t('定位'), input('locator', '', `placeholder="${esc(t('URI、庫表路徑、文檔鏈接等'))}"`))}${field(t('說明（選填）'), textarea('description'))}${field(t('可用 Action（可多選）'), `<select name="actionIds" multiple size="4">${actions.map(a => `<option value="${esc(a.id)}">${esc(a.id)} ${esc(a.name)}（${esc(tv(a.kind, 'act'))}）</option>`).join('')}</select>`, t('物理客體在 MVP 只登記，不接管道'))}`, {
      label: t('登記'),
      run: async () => { const r = await post('/api/v1/objects', formData($('#dialog-content'))); toast(t('已登記 {id}', { id: r.data.id })); render(); }
    });
  };
};

PAGES.object = async ({ param: id }) => {
  const o = await get(`/api/v1/objects/${id}`);
  setHeading(o.name, `${tv(o.category)} · ${tv(o.kind) || ''}`, `${t('知識庫')} › ${t('客體')} › ${o.id}`);
  setActions(`${o.status !== '下線' && !o.managedBy ? `<button class="button danger" data-op="offline" data-id="${esc(o.id)}">${t('標記下線')}</button>` : ''}${o.managedBy ? `<a class="button" href="#doc/${esc(o.managedBy.id)}">${t('打開文檔')}</a>` : ''}<button class="button" id="edit-actions">${t('設定可用 Action')}</button>`);
  const od = objectDocsHtml(o);
  content().innerHTML = `${od.managed}<div class="two-col"><div class="stack">${panel(t('客體資訊'), `<div class="panel-body"><dl class="kv"><dt>ID</dt><dd>${tag(o.id)}</dd><dt>${t('類別 / 種類')}</dt><dd>${esc(tv(o.category))} · ${esc(tv(o.kind) || '—')}</dd><dt>${t('定位')}</dt><dd class="mono">${esc(o.locator || '—')}</dd><dt>${t('狀態')}</dt><dd>${o.status === '下線' ? `${statusPill('下線')} ${esc(td(o.offlineReason) || '')} ${fmtTime(o.offlineAt)}` : statusPill('在用')}</dd><dt>${t('說明')}</dt><dd>${esc(o.description || '—')}</dd><dt>${t('登記者')}</dt><dd>${esc(o.createdBy?.name || '—')} · ${fmtTime(o.createdAt)}</dd></dl></div>`)}
    ${panel(t('綁定的主體'), table([t('主體'), t('綁定'), t('層級')], o.boundSubjects.map(s => `<tr><td>${idLink(s.id)} ${esc(s.name)}</td><td>${idLink(s.bindingId)}</td><td>${level(s.bindingLevel)}</td></tr>`), t('尚未綁定')))}${od.docs}</div>
    <div>${panel(t('可用 Action'), `<div class="panel-body stack-sm">${actionLibrary(o.actions) || `<p class="muted">${t('未配置')}</p>`}</div>`)}</div></div>`;
  $('#edit-actions').onclick = async () => {
    const actions = await get('/api/v1/actions');
    modal(t('可用 Action · {id}', { id: o.id }), field(t('Action（可多選）'), `<select name="actionIds" multiple size="8">${actions.map(a => `<option value="${esc(a.id)}" ${o.actionIds.includes(a.id) ? 'selected' : ''}>${esc(a.id)} ${esc(a.name)}（${esc(tv(a.kind, 'act'))}）</option>`).join('')}</select>`), { label: t('保存'), run: async () => { await patch(`/api/v1/objects/${o.id}`, formData($('#dialog-content'))); render(); } });
  };
};

PAGES.relations = async () => {
  const sc = schema;
  setActions(`<button class="button primary" id="add-relation">${t('新增關係')}</button>`);
  content().innerHTML = panel(t('關係一覽'), `<div class="toolbar"><label>${t('類型')} ${select('type', [['', t('全部類型')], ...Object.keys(sc.relationTypes).map(k => [k, tv(k, 'rel')])], '', 'id="f-type"')}</label><label>${t('層級')} ${select('level', [['', t('全部')], 'L0', 'L1', 'L2', 'E1'], '', 'id="f-level"')}</label><small id="f-count" class="muted"></small></div><div id="r-table"></div>`);
  const load = async () => {
    const list = await get('/api/v1/relations?' + qs({ type: $('#f-type').value, level: $('#f-level').value }));
    $('#f-count').textContent = t('{n} 條', { n: list.length });
    $('#r-table').innerHTML = table(['ID', t('起點'), t('關係'), t('終點'), t('層級'), t('證據'), t('操作')], list.map(r => `<tr><td>${idLink(r.id)}</td><td>${idLink(r.from)} ${esc(r.fromSubject?.name)}</td><td>${vpill(r.type, 'blue', 'rel')}</td><td>${idLink(r.to)} ${esc(r.toSubject?.name)}</td><td>${level(r.validity.level)} ${pendingCell(r.validity)}</td><td class="wrap">${evidenceCell(r.validity)}</td><td>${rowOps(r.id, r.validity.level)}</td></tr>`));
  };
  ['#f-type', '#f-level'].forEach(s => ($(s).onchange = load));
  await load();
  $('#add-relation').onclick = () => relationDialog();
};

PAGES.graph = async ({ param }) => {
  const sc = schema;
  const opts = await subjectOptions();
  const focus = param || '';
  content().innerHTML = `${opts}<section class="panel"><div class="toolbar"><label class="grow">${t('聚焦主體')} <input id="g-focus" list="subject-options" placeholder="${esc(t('留空顯示全圖'))}" value="${esc(focus ? `${focus}` : '')}"></label><label>${t('深度')} ${select('depth', [1, 2, 3], 2, 'id="g-depth"')}</label><label>${t('領域')} ${select('domain', [['', t('全部')], ...sc.domains.map(d => [d.code, domainName(d)])], '', 'id="g-domain"')}</label><label>${t('關係')} ${select('rel', [['', t('全部')], ...Object.keys(sc.relationTypes).map(k => [k, tv(k, 'rel')])], '', 'id="g-rel"')}</label><label class="check"><input type="checkbox" id="g-alias" checked> ${t('nav|別名')}</label><label class="check"><input type="checkbox" id="g-e1"> ${t('含 E1')}</label><button class="button" id="g-reset">${t('重置視圖')}</button></div>
    <div class="graph-wrap" style="border-top:1px solid var(--line)"><div id="graph" class="graph-canvas"></div><aside class="panel-body side-panel" id="g-side"><h3>${t('主體詳情')}</h3><p class="muted" style="font-size:12px">${t('點選圖中節點查看。')}</p></aside></div>${legend()}</section>`;
  let view;
  const draw = async () => {
    const f = parseId($('#g-focus').value);
    const data = await get('/api/v1/graph?' + qs({ focus: f, depth: $('#g-depth').value, domain: $('#g-domain').value, relationTypes: $('#g-rel').value, aliases: $('#g-alias').checked ? '1' : '0', e1: $('#g-e1').checked ? '1' : '' }));
    const height = window.innerWidth < 700 ? 420 : Math.max(480, Math.min(720, window.innerHeight - 260));
    view = renderGraph($('#graph'), data, { focus: f, height, onSelect: showNode });
  };
  async function showNode(n) {
    const card = await get(`/api/v1/subjects/${n.id}`);
    const s = card.subject;
    $('#g-side').innerHTML = `<h3>${esc(s.name)}</h3><div class="chip-row">${tag(s.id)} ${vpill(s.type)} ${s.level ? level(s.level) : ''}</div><p style="font-size:12px;margin:8px 0">${esc(s.definition || card.alias?.guidance || '')}</p>${card.assertions ? `<dl class="kv"><dt>${t('nav|斷言')}</dt><dd>${card.assertions.length}（L0 ${card.assertions.filter(a => a.level === 'L0').length}）</dd><dt>${t('nav|綁定')}</dt><dd>${card.bindings.length}</dd><dt>${t('nav|關係')}</dt><dd>${card.relations.outgoing.length + card.relations.incoming.length}</dd></dl>` : ''}<div class="actions" style="margin-top:10px"><a class="button" href="#subject/${esc(s.id)}">${t('打開主體')}</a><button class="button" id="g-focus-btn">${t('以此為中心')}</button></div>`;
    $('#g-focus-btn').onclick = () => { $('#g-focus').value = `${s.id} ${s.name}`; draw(); };
  }
  ['#g-depth', '#g-domain', '#g-rel', '#g-alias', '#g-e1'].forEach(s => ($(s).onchange = draw));
  $('#g-focus').onchange = draw;
  $('#g-reset').onclick = () => view?.reset();
  await draw();
};

PAGES.levels = async () => {
  const [h, subjects] = await Promise.all([get('/api/v1/metrics'), get('/api/v1/subjects')]);
  const domains = schema.domains;
  const byDomain = domains.map(d => {
    const list = subjects.filter(s => s.domain === d.code && s.type !== '別名');
    const c = { L0: 0, L1: 0, L2: 0 };
    list.forEach(s => (c[s.level] += 1));
    return { d, c, total: list.length };
  });
  const note = (x, y, key, anchor = 'middle') => `<text x="${x}" y="${y}"${anchor ? ` text-anchor="${anchor}"` : ''} class="note">${esc(t(key))}</text>`;
  const box = (x, y, stroke, fill, title, sub, width = 1) => `<rect x="${x}" y="${y}" width="130" height="64" rx="8" fill="${fill}" stroke="${stroke}"${width !== 1 ? ` stroke-width="${width}"` : ''}/><text x="${x + 65}" y="${y + 28}" text-anchor="middle" font-weight="650">${esc(title)}</text><text x="${x + 65}" y="${y + 48}" text-anchor="middle" class="note">${esc(t(sub))}</text>`;
  const diagram = `<svg class="migration" viewBox="0 0 760 320" role="img" aria-label="${esc(t('層級遷移：三個入口、五條遷移'))}">
    <defs><marker id="mg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#7a8aa0"/></marker></defs>
    <g fill="none" stroke="#7a8aa0" stroke-width="1.3" marker-end="url(#mg)"><path d="M85 42v56"/><path d="M315 42v56"/><path d="M655 42v56"/><path d="M150 132h98"/><path d="M380 120h208"/><path d="M590 146h-208"/><path d="M315 164v108h103"/><path d="M655 164v108h-103"/></g>
    <g class="note">${note(85, 32, tk('人或智能體提交，無證據'))}${note(315, 32, tk('人或智能體提交，附證據'))}${note(655, 32, tk('註冊管道自動同步'))}${note(199, 124, tk('補充客體證據'))}${note(484, 112, tk('Action 校驗或負責人確認'))}${note(484, 162, tk('到期、校驗不符、衝突、反饋錯誤'))}${note(323, 222, tk('確認不成立或過時'), '')}${note(647, 222, tk('客體下線或被證偽'), 'end')}</g>
    <g>${box(20, 100, '#d9a441', '#fff', LEVEL_TEXT.L2, tk('無客體證據'))}
    ${box(250, 100, '#147fe6', '#fff', LEVEL_TEXT.L1, tk('有證據，未驗證'))}
    ${box(590, 100, '#248569', '#edf9f3', LEVEL_TEXT.L0, tk('已驗證，在有效期內'), 1.6)}
    ${box(420, 240, '#c9605d', '#fff0ef', LEVEL_TEXT.E1, tk('保留並指向替代者'))}</g></svg>`;
  const lv = h.levels;
  content().innerHTML = `<div class="two-col"><div class="stack">${panel(t('層級遷移 · 三個入口、五條遷移'), `<div class="panel-body">${diagram}<p class="notice" style="margin-top:10px">${t('人或智能體都不能直接寫入 L0；智能體不能晉升自己或其他智能體提交的知識。衝突不設獨立狀態：雙方降為 L1，裁決後一方回到 L0、另一方轉為 E1。')}</p></div>`)}
    ${panel(t('按領域的主體綜合層級'), table([t('領域'), '#' + t('主體'), t('分佈'), 'L0', 'L1', 'L2'], byDomain.map(({ d, c, total }) => `<tr><td>${esc(domainName(d))}</td><td class="numeric">${total}</td><td style="min-width:160px">${levelBar(c, ['L0', 'L1', 'L2']).bar}</td><td class="numeric">${c.L0}</td><td class="numeric">${c.L1}</td><td class="numeric">${c.L2}</td></tr>`)))}</div>
    <div class="stack">${panel(t('按條目類型'), `<div class="panel-body">${[[t('nav|客體綁定'), lv.binding], [t('nav|斷言'), lv.assertion], [t('nav|關係'), lv.relation]].map(([n, c]) => { const b = levelBar(c); return `<div class="bar-row"><span>${n}</span>${b.bar}<small class="muted">${b.text}</small></div>`; }).join('')}</div>`)}
    ${panel(t('層級用法'), table([t('層級'), t('條件'), t('智能體用法')], Object.entries(schema.levels).map(([k, v]) => `<tr><td>${level(k)}</td><td class="wrap-sm">${esc(v.condition)}</td><td class="wrap-sm">${esc(v.usage)}</td></tr>`)))}
    ${panel(t('有效期初值（天）'), table([t('條目'), t('類型'), '#' + t('天數')], [...Object.entries(schema.expiryDays.assertion).map(([k, v]) => `<tr><td>${t('斷言')}</td><td>${esc(tv(k))}</td><td class="numeric">${v}</td></tr>`), ...Object.entries(schema.expiryDays.relation).map(([k, v]) => `<tr><td>${t('關係')}</td><td>${esc(tv(k, 'rel'))}</td><td class="numeric">${v}</td></tr>`), ...Object.entries(schema.expiryDays.binding).map(([k, v]) => `<tr><td>${t('綁定')}</td><td>${esc(t('{category}客體', { category: tv(k) }))}</td><td class="numeric">${v}</td></tr>`)]))}</div></div>`;
};

PAGES.queue = async () => {
  const q = await get('/api/v1/queue');
  setActions(`${isOwner() ? `<button class="button" id="validate-pending">${t('對隊列執行校驗')}</button>` : ''}${me.isAdmin ? `<button class="button" id="run-expiry">${t('執行到期檢查')}</button>` : ''}`);
  content().innerHTML = panel(t('待重驗（{n}）', { n: q.length }), table(['#' + t('優先級'), t('條目'), t('主體'), t('內容'), t('原因'), t('層級'), '#' + t('使用 × 代價'), t('操作')], q.map(x => `<tr><td class="numeric">${x.priority}</td><td>${idLink(x.id)}<span class="cell-sub">${esc(mapText(ITEM_KIND_SHORT, x.kind))}</span></td><td>${x.subject ? `${idLink(x.subject.id)} ${esc(x.subject.name)}` : '—'}</td><td class="wrap">${esc(x.summary)}</td><td>${pill(pendingLabel(x.pending), 'amber')}<span class="cell-sub">${docNoteHtml(x.pending.note)} ${ago(x.pending.at)}</span></td><td>${level(x.level)}</td><td class="numeric">${x.usage} × ${x.errorCost}</td><td>${rowOps(x.id, x.level)}</td></tr>`), t('沒有待重驗的知識')));
  $('#validate-pending')?.addEventListener('click', async () => { const r = await post('/api/v1/validate-all', { onlyPending: true }); toast(t('校驗 {total} 條：通過 {passed}，不符 {mismatched}，客體缺失 {missing}，失敗 {errors}', r.data), 6000); render(); });
  $('#run-expiry')?.addEventListener('click', async () => { const r = await post('/admin/api/maintenance/expiry'); toast(t('到期檢查完成：{n} 條降為 L1', { n: r.data.expired.length })); render(); });
};

PAGES.conflicts = async () => {
  const list = await get('/api/v1/conflicts');
  setActions(`<button class="button primary" id="add-conflict">${t('登記衝突')}</button>`);
  content().innerHTML = panel(t('衝突（{n}）', { n: list.length }), table(['ID', t('知識 A'), t('知識 B'), t('說明'), t('狀態'), t('col|登記'), t('操作')], list.map(c => `<tr><td>${tag(c.id)}</td><td>${idLink(c.a)}${c.winner === c.a ? ' ' + pill(t('勝出'), 'green') : ''}</td><td>${idLink(c.b)}${c.winner === c.b ? ' ' + pill(t('勝出'), 'green') : ''}</td><td class="wrap">${esc(c.note || '—')}${c.reason ? `<span class="cell-sub">${esc(t('裁決：{reason}', { reason: td(c.reason) }))}</span>` : ''}</td><td>${c.status === 'open' ? pill(t('待裁決'), 'amber') : pill(t('已裁決'), 'green')}</td><td>${esc(c.reportedBy?.name || '')}<span class="cell-sub">${fmtTime(c.createdAt)}</span></td><td>${c.status === 'open' && isOwner() ? `<button class="text-btn" data-op="resolveConflict" data-id="${esc(c.id)}">${t('裁決')}</button>` : ''}</td></tr>`), t('沒有衝突')));
  $('#add-conflict').onclick = () => modal(t('登記衝突'), `<p class="notice warn">${t('兩條知識互相矛盾時，雙方都降為 L1，並通知負責人裁決。')}</p><div class="field-pair">${field(t('知識 A（ID）'), input('a', '', 'required placeholder="A-0001"'))}${field(t('知識 B（ID）'), input('b', '', 'required placeholder="A-0007"'))}</div>${field(t('說明'), textarea('note'))}`, { label: t('登記'), run: async () => { await post('/api/v1/conflicts', formData($('#dialog-content'))); render(); } });
};

PAGES.feedback = async () => {
  const list = await get('/api/v1/feedback');
  content().innerHTML = panel(t('反饋（{n}）', { n: list.length }), table(['ID', t('目標'), t('原層級'), t('反饋'), t('來源'), t('狀態'), t('操作')], list.map(f => `<tr><td>${tag(f.id)}</td><td>${idLink(f.targetId)}</td><td>${level(f.wasLevel)}</td><td class="wrap">${esc(f.comment)}${f.question ? `<span class="cell-sub">${esc(t('問題：{text}', { text: f.question }))}</span>` : ''}${f.resolution ? `<span class="cell-sub">${esc(t('處理：{text}', { text: td(f.resolution) }))}</span>` : ''}</td><td>${esc(f.source?.name || '')}<span class="cell-sub">${fmtTime(f.createdAt)}</span></td><td>${f.status === 'open' ? pill(t('待處理'), 'amber') : pill(t('已處理'), 'green')}</td><td>${f.status === 'open' && isOwner() ? `<button class="text-btn" data-op="closeFeedback" data-id="${esc(f.id)}">${t('關閉')}</button>` : ''}</td></tr>`), t('沒有反饋')));
};

PAGES.gaps = async () => {
  const list = await get('/api/v1/gaps');
  content().innerHTML = `<p class="notice" style="margin-bottom:12px">${t('「未收錄就說未收錄」：智能體不會用行業通用知識補全，而是把問題記為知識缺口。按次數決定下一批要建設的內容。')}</p>${panel(t('知識缺口（{n}）', { n: list.length }), table(['ID', t('問題'), '#' + t('次數'), t('相關主體'), t('最近'), t('狀態'), t('操作')], list.map(g => `<tr><td>${tag(g.id)}</td><td class="wrap">${esc(g.question)}<span class="cell-sub">${esc(td(g.reason) || '')}</span></td><td class="numeric">${g.count}</td><td>${(g.subjectIds || []).map(id => idLink(id)).join(' ') || '—'}</td><td>${ago(g.lastAt)}</td><td>${g.status === 'open' ? pill(t('待補充'), 'amber') : pill(t('已處理'), 'green')}</td><td>${g.status === 'open' && isOwner() ? `<button class="text-btn" data-op="closeGap" data-id="${esc(g.id)}">${t('標記已處理')}</button>` : ''}</td></tr>`), t('暫無知識缺口')))}`;
};

// 模板中的 kind、fromObjects 是 API 枚舉值，保持原文；名稱、標籤等可自由填寫的內容按介面語言給示例。
const actionTemplate = () => ({ name: t('查詢可售庫存（SKU，倉庫）'), kind: '取值', pipelineId: 'P-0001', objectKinds: ['API'], request: { method: 'GET', path: '/inventory/v1/availability', query: { sku: '{input.sku}', warehouse: '{input.warehouse}' } }, inputs: [{ name: 'sku', label: 'SKU', required: true, pattern: 'SKU-\\d+' }, { name: 'warehouse', label: t('倉庫'), required: true, fromObjects: '物理' }], output: { path: 'available_qty', unit: t('件'), label: t('可售庫存') }, permission: 'consumer', description: '' });
const pipelineTemplate = () => ({ name: t('API 網關'), type: 'http', baseUrl: 'https://gateway.internal.example', headers: { Authorization: 'Bearer ${env:GATEWAY_TOKEN}' }, timeoutMs: 8000, description: '' });

function jsonDialog(title, value, save) {
  modal(title, `${field(t('定義（JSON）'), textarea('json', JSON.stringify(value, null, 2), 'class="code" spellcheck="false"'))}<p class="muted" style="font-size:12px;margin-top:6px">${t('模板變量：{input.x}、{object.locator}、{item.structured.value}；管道憑證用 ${env:變數名}。MVP 只讀不寫。')}</p>`, {
    label: t('保存'),
    run: async () => {
      let body;
      try { body = JSON.parse($('#dialog-content textarea').value); } catch (e) { throw new Error(t('JSON 格式錯誤：{message}', { message: e.message })); }
      await save(body);
      toast(t('已保存'));
      render();
    }
  });
}

PAGES.actions = async () => {
  const [list, pipelines] = await Promise.all([get('/api/v1/actions'), get('/api/v1/pipelines')]);
  setActions(isOwner() ? `<button class="button primary" id="add-action">${t('新增 Action')}</button>` : '');
  const req = a => (a.rpa ? `RPA ${esc(a.rpa.sceneId)} v${esc(a.rpa.revision)}<span class="cell-sub">${a.enabled === false ? pill(t('未啟用'), 'amber') : a.review?.readOnly ? esc(t('已審閱只讀 · {by}', { by: a.review.by || '' })) : pill(t('未審閱'), 'amber')}</span>` : `${esc(a.request.method)} ${esc(a.request.path)}`);
  const io = a => (a.rpa ? `${Object.keys(a.rpa.inputs || {}).map(tag).join(' ')}<span class="cell-sub">${esc(t('守衛 {outputs}', { outputs: (a.check?.expect || []).map(e => e.output).join(t('、')) }))}</span>` : `${(a.inputs || []).map(i => tag(i.name)).join(' ') || '—'}${a.output?.path ? `<span class="cell-sub">${esc(t('輸出 {path}', { path: a.output.path }))}</span>` : ''}`);
  const ops = a => [
    a.kind === '取值' && !a.rpa ? `<button class="text-btn" data-op="invoke" data-id="${esc(a.id)}">${t('調用')}</button>` : '',
    a.rpa && isOwner() ? `<button class="text-btn" data-op="previewAction" data-id="${esc(a.id)}">${t('預覽')}</button><button class="text-btn" data-op="reviewAction" data-id="${esc(a.id)}">${t('審閱')}</button>` : '',
    a.rpa ? `<a class="text-btn" href="#executions/${esc(a.id)}">${t('記錄')}</a>` : '',
    isOwner() && !a.builtin ? `<button class="text-btn edit-action" data-id="${esc(a.id)}">${t('編輯')}</button>` : ''
  ].join('');
  content().innerHTML = panel(t('Action（{n}）', { n: list.length }), table(['ID', t('名稱'), t('種類'), t('管道'), t('請求 / 場景'), t('輸入 / 輸出'), t('調用權限'), t('操作')], list.map(a => `<tr><td>${tag(a.id)}</td><td class="wrap">${esc(a.name)}<span class="cell-sub">${esc(a.description || '')}</span></td><td>${vpill(a.kind, a.kind === '校驗' ? 'blue' : 'green', 'act')}${a.check ? `<span class="cell-sub">${esc(a.check.mode)}</span>` : ''}</td><td>${esc(pipelines.find(p => p.id === a.pipelineId)?.name || a.pipelineId)}</td><td class="mono wrap">${req(a)}</td><td class="wrap">${io(a)}</td><td>${esc(a.permission)}</td><td><div class="cell-actions">${ops(a)}</div></td></tr>`), t('尚無 Action')));
  $('#add-action')?.addEventListener('click', () => jsonDialog(t('新增 Action'), { ...actionTemplate(), pipelineId: pipelines[0]?.id || 'P-0001' }, body => post('/api/v1/actions', body)));
  $$('.edit-action').forEach(b => (b.onclick = () => { const a = list.find(x => x.id === b.dataset.id); const { id, updatedAt, inputs, ...rest } = a; jsonDialog(t('編輯 {id}', { id }), a.rpa ? rest : { ...rest, inputs }, body => put(`/api/v1/actions/${id}`, body)); }));
};

PAGES.pipelines = async () => {
  const list = await get('/api/v1/pipelines');
  setActions(isOwner() ? `<button class="button" id="add-rpa-pipeline">${t('新增 RPA 管道')}</button><button class="button primary" id="add-pipeline">${t('新增管道')}</button>` : '');
  const typeName = { mock: [t('示意'), 'amber'], http: ['HTTP', 'blue'], rpa: ['RPA', 'green'], docs: [t('內置'), 'gray'] };
  content().innerHTML = `<p class="notice" style="margin-bottom:12px">${t('管道屬於基礎設施，使用者通常只看到 Action。示意（mock）管道按路由返回模板結果；接入真實系統時改為 http 類型。')} ${t('RPA 管道對應瀏覽器 RPA 上的一個 API 用戶端，場景範圍與權限由 RPA 管。')}</p>${panel(t('管道（{n}）', { n: list.length }), table(['ID', t('名稱'), t('類型'), t('地址 / 路由'), t('說明'), t('操作')], list.map(p => `<tr><td>${tag(p.id)}</td><td>${esc(p.name)}</td><td>${pill(...(typeName[p.type] || [p.type]))}</td><td class="mono wrap">${esc(p.type === 'mock' ? (p.routes || []).map(r => `${r.method || 'GET'} ${r.path}`).join('\n') : p.type === 'docs' ? t('本系統文檔庫') : p.baseUrl)}${p.rpa ? `<span class="cell-sub">${esc(t('並發 {n} · 排隊上限 {sec} 秒', { n: p.rpa.maxConcurrent, sec: p.rpa.queueTimeoutSec }))}${p.rpa.target ? ` · ${esc(p.rpa.target)}` : ''}</span>` : ''}</td><td class="wrap">${esc(p.description || '')}</td><td><div class="cell-actions">${isOwner() ? `${p.type === 'rpa' ? `<a class="text-btn" href="#scenes/${esc(p.id)}">${t('場景目錄')}</a>` : ''}<button class="text-btn test-pipe" data-id="${esc(p.id)}">${t('測試')}</button>${p.builtin ? '' : `<button class="text-btn edit-pipe" data-id="${esc(p.id)}">${t('編輯')}</button>`}` : ''}</div></td></tr>`), t('尚無管道')))}`;
  $('#add-pipeline')?.addEventListener('click', () => jsonDialog(t('新增管道'), pipelineTemplate(), body => post('/api/v1/pipelines', body)));
  $('#add-rpa-pipeline')?.addEventListener('click', () => jsonDialog(t('新增 RPA 管道'), rpaPipelineTemplate(), body => post('/api/v1/pipelines', body)));
  $$('.edit-pipe').forEach(b => (b.onclick = () => { const p = list.find(x => x.id === b.dataset.id); const { id, updatedAt, ...rest } = p; jsonDialog(t('編輯 {id}', { id }), rest, body => put(`/api/v1/pipelines/${id}`, body)); }));
  $$('.test-pipe').forEach(b => (b.onclick = async () => {
    const r = await post(`/api/v1/pipelines/${b.dataset.id}/test`);
    if (!r.data.checks) return toast(t('{id}：{state}（{detail}）', { id: b.dataset.id, state: r.data.ok ? t('可用') : t('不可用'), detail: r.data.detail }), 5000);
    const m = r.data.meta;
    modal(t('測試 {id}', { id: b.dataset.id }), `<p class="notice ${r.data.ok ? '' : 'warn'}">${esc(r.data.detail)}</p>${checkList(r.data.checks)}${m ? `<dl class="kv" style="margin-top:12px"><dt>${t('API 用戶端')}</dt><dd>${esc(m.client?.name || m.client?.id || '—')}</dd><dt>${t('可用領域')}</dt><dd>${esc(m.domains ? m.domains.join(t('、')) : t('全部'))}</dd><dt>${t('排隊上限')}</dt><dd>${esc(m.limits?.queuedRuns ?? '—')}</dd><dt>${t('執行位置')}</dt><dd>${esc(m.target || '—')}</dd><dt>Worker</dt><dd>${(r.data.workers || []).map(w => `${esc(w.name || w.id)}（${esc(w.status)}）`).join(t('、')) || '—'}</dd></dl>` : ''}`);
  }));
};

// ------------------------------------------------------------------ RPA：場景目錄、草稿、審閱、執行記錄
const rpaPipelineTemplate = () => ({ name: t('RPA（生產）'), type: 'rpa', baseUrl: 'http://rpa.internal:8081/agent-api/v1', headers: { Authorization: 'Bearer ${env:RPA_KB_TOKEN}' }, timeoutMs: 10000, rpa: { portalUrl: 'http://rpa.internal:8080', target: null, workerId: null, pollIntervalMs: 3000, maxPollIntervalMs: 15000, queueTimeoutSec: 300, deadlineSec: null, maxConcurrent: 2 }, description: t('知識庫專用的 API 用戶端：scenes:read、runs:execute、runs:read') });
const CHECK_COLOR = { ok: 'green', warn: 'amber', error: 'red' };
const CHECK_TEXT = { ok: tk('通過'), warn: tk('注意'), error: tk('不符') };
const checkList = checks => `<ul class="timeline">${checks.map(c => `<li>${pill(c.rule ? `${c.rule} ${t(CHECK_TEXT[c.level])}` : t(CHECK_TEXT[c.level]), CHECK_COLOR[c.level])} ${esc(c.text)}</li>`).join('')}</ul>`;
const runLink = r => (r?.runId ? (r.portalUrl ? `<a href="${esc(r.portalUrl)}" target="_blank" rel="noopener" class="mono">${esc(r.runId)}</a>` : `<span class="mono">${esc(r.runId)}</span>`) : '—');
const evidenceSummary = r => [...Object.entries(r.outputs || {}).map(([k, v]) => `${esc(k)} = ${esc(typeof v === 'string' ? v : JSON.stringify(v))}`), ...Object.entries(r.digests || {}).map(([k, d]) => esc(t('{name}：{n} 字元，sha256 {hash}…', { name: k, n: d.length, hash: String(d.sha256).slice(0, 12) })))].join(t('；'));
const EXEC_STATE = { accepted: [tk('已受理'), 'blue'], submitted: [tk('排隊中'), 'blue'], running: [tk('執行中'), 'blue'], needs_login: [tk('需要登入'), 'amber'], rejected: [tk('已拒絕'), 'red'], expired: [tk('已逾時'), 'amber'], done: [tk('已完成'), 'green'] };
const VERDICT = { pass: [tk('通過'), 'green'], inconclusive: [tk('無法判定'), 'amber'], mismatch: [tk('不符'), 'red'], absent: [tk('疑似不存在'), 'red'] };
const EFFECT = { promoted_L0: tk('L1 → L0'), renewed_L0: tk('L0 續期'), stale: tk('目標已變，未寫回'), dry_run: tk('試運行，不寫回'), skipped_e1: tk('E1 不晉升'), none: tk('未寫回') };
const statePill = (map, k) => (map[k] ? pill(t(map[k][0]), map[k][1]) : pill(k));
const execState = e => `${statePill(EXEC_STATE, e.state)}${e.verdict ? ` ${statePill(VERDICT, e.verdict)}` : ''}`;
const effectText = e => (e.effect ? mapText(EFFECT, e.effect) : '—');
// 執行說明：有原因碼時用介面語言的原因說明，細節（RPA 原文、實際值）保持原樣
// detailText 是服務端按請求語言給出的說明（舊記錄只有繁體原文 detail）
const detailOf = e => e.detailText ?? e.detail ?? null;
const execDetail = e => [e.reasonText, e.verdict === 'pass' || !e.reasonText ? detailOf(e) : null].filter(Boolean).join(t('；'));

function executionTable(list, { item = true } = {}) {
  const short = s => (s && s.length > 90 ? `${s.slice(0, 90)}…` : s || '');
  if (!item) return table([t('執行'), t('狀態'), t('寫回')], list.map(e => `<tr><td><button class="text-btn mono" data-op="showExecution" data-id="${esc(e.id)}">${esc(e.id)}</button><span class="cell-sub">${ago(e.createdAt)} · ${esc(e.actionId)}</span></td><td>${execState(e)}</td><td>${esc(effectText(e))}</td></tr>`), t('沒有執行記錄'));
  return table([t('執行'), t('條目 / Action'), t('狀態'), t('RPA 運行'), t('寫回'), t('操作')], list.map(e => `<tr><td><button class="text-btn mono" data-op="showExecution" data-id="${esc(e.id)}">${esc(e.id)}</button><span class="cell-sub">${ago(e.createdAt)} · ${esc(e.requestedBy?.name || e.requestedBy?.id || '')}</span></td><td>${e.target.itemId ? idLink(e.target.itemId) : pill(t('試運行'))} ${tag(e.actionId)}<span class="cell-sub mono">${esc(e.target.locator || '')}</span></td><td class="wrap">${execState(e)}<span class="cell-sub">${esc(short(execDetail(e)))}</span></td><td>${runLink(e.rpa)}${e.rpa?.revision ? `<span class="cell-sub">v${esc(e.rpa.revision)}</span>` : ''}</td><td>${esc(effectText(e))}</td><td><div class="cell-actions">${execOps(e)}</div></td></tr>`), t('沒有執行記錄'));
}

function execOps(e) {
  const ops = [];
  if (e.state === 'expired' && e.rpa?.runId) ops.push(`<button class="text-btn" data-op="refreshExecution" data-id="${esc(e.id)}">${t('重新讀取原運行')}</button>`);
  if ((e.state === 'needs_login' || e.state === 'expired' || e.state === 'rejected' || e.verdict === 'inconclusive') && e.target.itemId) ops.push(`<button class="text-btn" data-op="validate" data-id="${esc(e.target.itemId)}" data-action="${esc(e.actionId)}">${e.state === 'needs_login' ? t('登入後重試') : t('重新校驗')}</button>`);
  return ops.join('');
}

function executionHtml(e) {
  const rows = [
    [t('狀態'), `${execState(e)}${e.terminal ? '' : ` <span class="muted">${t('（後台執行中，關閉此窗口不影響）')}</span>`}`],
    [t('說明'), esc(execDetail(e) || (e.terminal ? '—' : t('等待 RPA…')))],
    [t('條目'), e.target.itemId ? t('{item}（客體 {object}）', { item: idLink(e.target.itemId), object: idLink(e.target.objectId) }) : t('試運行：客體 {object}', { object: idLink(e.target.objectId) })],
    [t('定位'), `<span class="mono">${esc(e.target.locator || '—')}</span>`],
    ['Action', `${tag(e.actionId)} ${esc(e.actionName || '')}`],
    [t('RPA 運行'), `${runLink(e.rpa)}${e.rpa.status ? ` · ${esc(e.rpa.status)}` : ''}${e.rpa.stage ? ` · ${esc(e.rpa.stage)}` : ''}${e.rpa.workerId ? ` · Worker ${esc(e.rpa.workerId)}` : ''}`],
    [t('場景版本'), esc(e.rpa.revision ? t('{scene} 審閱 v{expected}，實際 v{actual}', { scene: e.rpa.sceneId, expected: e.rpa.expectedRevision, actual: e.rpa.revision }) : t('{scene} 審閱 v{expected}', { scene: e.rpa.sceneId, expected: e.rpa.expectedRevision }))],
    [t('入參'), `<pre class="mono-block">${esc(JSON.stringify(e.inputs, null, 2))}</pre>`]
  ];
  if (e.reasonText && detailOf(e) && detailOf(e) !== e.reasonText && e.verdict !== 'pass') rows.push([t('細節'), esc(detailOf(e))]);
  if (e.problems?.length) rows.push([t('入參問題'), e.problems.map(p => `${esc(p.name || p.field)}：${esc(p.message)}`).join('<br>')]);
  if (e.failures?.length) rows.push([t('守衛不符'), table([t('出參'), t('規則'), t('期望'), t('實際')], e.failures.map(f => `<tr><td class="mono">${esc(f.output)}</td><td>${esc(f.rule)}</td><td class="mono">${esc(JSON.stringify(f.expected))}</td><td class="mono">${esc(JSON.stringify(f.actual))}</td></tr>`))]);
  if (e.evidence) rows.push([t('證據'), evidenceSummary(e.evidence) || '—']);
  if (e.effect) rows.push([t('寫回'), `${esc(effectText(e))}${e.commit ? ` · ${t('commit|提交')} <span class="mono">${esc(String(e.commit).slice(0, 8))}</span>` : ''}`]);
  if (e.lastError && !e.terminal) rows.push([t('最近錯誤'), esc(e.lastError)]);
  rows.push([t('時間'), [`${t('受理')} ${fmtTime(e.createdAt)}`, e.submittedAt ? `${t('time|提交')} ${fmtTime(e.submittedAt)}` : '', e.finishedAt ? `${t('結束')} ${fmtTime(e.finishedAt)}` : ''].filter(Boolean).join(' · ')]);
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl><div class="cell-actions" style="margin-top:12px">${execOps(e)}</div>`;
}

/** 打開執行詳情並輪詢到終態；關閉窗口不影響後台執行。 */
async function watchExecution(id, title = t('執行 {id}', { id })) {
  let e = await get(`/api/v1/action-executions/${id}`);
  modal(title, `<div id="exec-box">${executionHtml(e)}</div>`);
  while (!e.terminal) {
    await new Promise(r => setTimeout(r, 1500));
    if (!$('#dialog').open || !$('#exec-box')) return;
    e = await get(`/api/v1/action-executions/${id}`);
    $('#exec-box').innerHTML = executionHtml(e);
  }
  render();
}

function contractHtml(c) {
  if (!c) return '';
  const ins = Object.entries(c.inputs || {}).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td>${esc(v.type)}</td><td class="wrap">${esc(v.description || '')}${v.enum ? `<span class="cell-sub">${esc(t('可選 {values}', { values: v.enum.join(' / ') }))}</span>` : ''}${v.pattern ? `<span class="cell-sub mono">${esc(v.pattern)}</span>` : ''}${v.default !== undefined ? `<span class="cell-sub">${esc(t('預設 {value}', { value: v.default }))}</span>` : ''}</td></tr>`);
  const outs = Object.entries(c.outputs || {}).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td>${esc(v.type)}</td><td class="wrap">${esc(v.description || '')}</td></tr>`);
  return `<dl class="kv" style="margin-top:12px"><dt>${t('場景')}</dt><dd>${esc(c.name || c.id || '')}<span class="cell-sub">${esc(c.description || '')}</span></dd><dt>${t('登入角色')}</dt><dd>${esc(c.loginRole || t('不需要'))}</dd><dt>${t('期限')}</dt><dd>${c.deadlineMs ? esc(t('{n} 秒', { n: Math.round(c.deadlineMs / 1000) })) : t('未宣告')}</dd><dt>${t('獨立斷言')}</dt><dd>${esc(t('{n} 條', { n: c.verifyCount }))}</dd></dl><h4 style="margin:12px 0 6px">${t('入參')}</h4>${table([t('名稱'), t('型別'), t('說明')], ins, t('沒有入參'))}<h4 style="margin:12px 0 6px">${t('出參')}</h4>${table([t('名稱'), t('型別'), t('說明')], outs, t('沒有出參'))}`;
}

const readOnlyBox = n => `<label class="check" style="margin-top:12px"><input type="checkbox" name="readOnly" value="1"> ${esc(t('我已審閱 v{n}：只讀，沒有下單、審批、修改數據等業務副作用', { n }))}</label>`;

Object.assign(OPS, {
  showExecution: id => watchExecution(id),
  async refreshExecution(id) {
    await post(`/api/v1/action-executions/${id}/refresh`);
    return watchExecution(id, t('重新讀取 {id}', { id }));
  },
  async previewAction(id) {
    const objects = (await get('/api/v1/objects?status=在用')).filter(o => (o.actionIds || []).includes(id));
    modal(t('預覽 {id}', { id }), `<p class="notice">${t('選一個掛了這個 Action 的客體，看解析出的定位分組、提交給 RPA 的入參與守衛期望值。預覽不派發運行；「試運行」走完整流程，但不寫回有效性。')}</p>${field(t('客體'), select('objectId', objects.length ? objects.map(o => [o.id, `${o.id} ${o.name}（${o.locator || t('無定位')}）`]) : [['', t('還沒有客體掛上這個 Action')]]))}${field(t('或直接輸入定位'), input('locator', '', `placeholder="${esc(t('例如 {example}', { example: 'adb_wdk_scm_dpartner.replenish_order' }))}"`))}<div id="preview-box"></div><div class="cell-actions" style="margin-top:8px"><button class="text-btn" id="trial-run" type="button">${t('試運行（不寫回）')}</button></div>`, {
      label: t('預覽'),
      run: async () => {
        const d = formData($('#dialog-content'));
        const r = (await post(`/api/v1/actions/${id}/preview`, d.locator ? { locator: d.locator } : { objectId: d.objectId })).data;
        $('#preview-box').innerHTML = `${r.warnings.map(w => `<p class="notice warn">${esc(w)}</p>`).join('')}${r.problems.map(p => `<p class="notice warn">${esc(p.name)}：${esc(p.message)}</p>`).join('')}<dl class="kv"><dt>${t('定位分組')}</dt><dd class="mono">${esc(JSON.stringify(r.groups))}</dd><dt>${t('RPA 入參')}</dt><dd><pre class="mono-block">${esc(JSON.stringify(r.inputs, null, 2))}</pre></dd><dt>${t('守衛')}</dt><dd>${(r.expect || []).map(e => `${esc(e.output)} ${e.nonEmpty ? t('非空') : `= ${esc(JSON.stringify(e.equals))}`}`).join('<br>') || '—'}</dd></dl>`;
        return true;
      }
    });
    $('#trial-run').onclick = async () => {
      const d = formData($('#dialog-content'));
      if (!d.objectId) return showError(new Error(t('試運行需要選一個客體')), $('#dialog-content'));
      try {
        const r = await post(`/api/v1/actions/${id}/trial`, { objectId: d.objectId });
        await watchExecution(r.data.executionId, t('試運行 {id}', { id }));
      } catch (err) { showError(err, $('#dialog-content')); }
    };
  },
  async reviewAction(id) {
    const a = (await get('/api/v1/actions')).find(x => x.id === id);
    const sc = await get(`/api/v1/pipelines/${a.pipelineId}/scenes/${encodeURIComponent(a.rpa.sceneId)}`);
    const same = sc.revision?.number === a.rpa.revision && sc.revision?.contentHash === a.rpa.contentHash;
    const next = sc.revision?.number ?? '?';
    const note = same ? t('場景 {scene} 的發布版本仍是審閱過的 v{n}，不需要重新審閱。', { scene: a.rpa.sceneId, n: a.rpa.revision }) : t('場景 {scene} 已發布 v{next}，Action 審閱的是 v{n}。確認新版本只讀後，Action 會鎖到新版本。', { scene: a.rpa.sceneId, next, n: a.rpa.revision });
    modal(t('審閱 {id}', { id }), `<p class="notice ${same ? '' : 'warn'}">${esc(note)}</p>${checkList(sc.conformance)}${contractHtml(sc.contract)}${same ? '' : readOnlyBox(next)}`, same ? null : {
      label: t('鎖到新版本'),
      run: async () => {
        if (!$('#dialog-content [name=readOnly]').checked) throw new Error(t('請先勾選已審閱、確認只讀'));
        await post(`/api/v1/actions/${id}/review`, { readOnly: true });
        toast(t('{id} 已鎖到 v{n}', { id, n: next }));
        render();
      }
    });
  },
  async sceneDetail(sceneId, data) {
    const kinds = schema?.objectCategories?.數字?.kinds || ['數據表'];
    const kind = kinds.includes('數據表') ? '數據表' : kinds[0];
    const sc = await get(`/api/v1/pipelines/${data.pipeline}/scenes/${encodeURIComponent(sceneId)}?${qs({ objectKind: kind })}`);
    if (!sc.draft) return modal(t('場景 {id}', { id: sceneId }), checkList(sc.conformance));
    const blocked = sc.conformance.some(c => c.level === 'error');
    modal(t('場景 {id} v{n}', { id: sceneId, n: sc.revision.number }), `${checkList(sc.conformance)}${contractHtml(sc.contract)}${sc.actions.length ? `<p class="notice">${esc(t('已登記：{list}', { list: sc.actions.map(x => `${x.id} ${x.name}（v${x.rpa.revision}）`).join(t('、')) }))}</p>` : ''}
      <h4 style="margin:16px 0 8px">${t('從場景生成校驗 Action')}</h4>
      <div class="field-pair">${field(t('適用的客體種類'), select('objectKind', kinds.map(k => [k, tv(k)]), kind))}${field(t('定位示例'), input('example', '', `placeholder="${esc(t('例如 {example}', { example: 'adb_wdk_scm_dpartner.replenish_order' }))}"`))}</div>
      ${field(t('Action 定義（可修改：rpa.inputs 是入參映射，check.expect 是守衛）'), textarea('json', JSON.stringify(sc.draft, null, 2), 'class="code" spellcheck="false" rows="14"'))}
      ${readOnlyBox(sc.revision.number)}`, blocked ? null : {
      label: t('保存 Action'),
      run: async () => {
        const d = formData($('#dialog-content'));
        let body;
        try { body = JSON.parse(d.json); } catch (e) { throw new Error(t('JSON 格式錯誤：{message}', { message: e.message })); }
        body.objectKinds = [d.objectKind];
        if (body.locator) body.locator.example = d.example || null;
        body.review = { readOnly: $('#dialog-content [name=readOnly]').checked };
        if (!body.review.readOnly) throw new Error(t('啟用前請勾選已審閱、確認只讀；若只想先保存，請把 enabled 改為 false'));
        const r = await post('/api/v1/actions', body);
        toast(t('已保存 {id}：到客體頁把它掛到「可用 Action」，就能在綁定上發起校驗', { id: r.data.id }), 6000);
        render();
      }
    });
  }
});

const ROLE_STATUS = { logged_in: tk('已登入'), needs_login: tk('需要登入'), none: tk('從未登入'), unknown: tk('狀態未知') };

PAGES.scenes = async ({ param }) => {
  const pipe = (await get('/api/v1/pipelines')).find(p => p.id === param);
  if (!pipe) throw new Error(t('找不到管道 {id}', { id: param }));
  setHeading(t('場景目錄 · {name}', { name: pipe.name }), t('已發布、未歸檔的 RPA 場景。打開場景查看契約、按可註冊規範檢查，並生成校驗 Action 草稿。'), `${t('動力層')} › ${t('nav|管道')} › ${pipe.id} › ${t('場景目錄')}`);
  setActions(`<a class="button" href="#pipelines">${t('返回管道')}</a>`);
  const r = await api('GET', `/api/v1/pipelines/${encodeURIComponent(param)}/scenes`);
  const roles = r.roles;
  const roleLine = roles ? `<p class="notice" style="margin-bottom:12px">${t('登入角色：')}${roles.map(x => `${esc(x.name || x.id)} ${pill(mapText(ROLE_STATUS, x.status), x.status === 'logged_in' ? 'green' : 'amber')}`).join(' ') || t('這個 API 用戶端沒有綁定任何登入角色')}</p>` : '';
  content().innerHTML = `${roleLine}${panel(t('場景（{n}）', { n: r.data.length }), table([t('場景'), t('名稱'), t('領域'), t('發布版本'), t('已登記的 Action'), t('操作')], r.data.map(sc => `<tr><td class="mono">${esc(sc.id)}</td><td class="wrap">${esc(sc.name)}<span class="cell-sub">${esc(sc.description || '')}</span></td><td>${esc(sc.domainId || '—')}</td><td>v${esc(sc.publishedRevision)}</td><td>${sc.actions.map(a => `${tag(a.id)}${a.needsReview ? ` ${pill(t('版本待審（v{n}）', { n: a.revision }), 'amber')}` : ''}`).join(' ') || '—'}</td><td><button class="text-btn" data-op="sceneDetail" data-id="${esc(sc.id)}" data-pipeline="${esc(pipe.id)}">${t('查看與註冊')}</button></td></tr>`), t('沒有可註冊的場景（需要已發布、未歸檔）')))}`;
};

PAGES.executions = async ({ param }) => {
  setActions('');
  content().innerHTML = panel(t('執行記錄'), `<div class="toolbar"><label>${t('狀態')} ${select('state', [['', t('全部')], ['accepted,submitted,running', t('進行中')], ['done', t('已完成')], ['needs_login', t('需要登入')], ['rejected', t('已拒絕')], ['expired', t('已逾時')]], '', 'id="f-state"')}</label><label class="grow">${t('條目或 Action')} ${input('q', param || '', `id="f-q" placeholder="${esc(t('例如 {example}', { example: 'B-0001 / ACT-0007' }))}"`)}</label><small id="f-count" class="muted"></small></div><div id="e-table"></div>`);
  const load = async () => {
    const q = $('#f-q').value.trim();
    const list = await get('/api/v1/action-executions?' + qs({ state: $('#f-state').value, limit: 200, ...(q.startsWith('ACT-') ? { actionId: q } : q ? { itemId: q } : {}) }));
    $('#f-count').textContent = t('{n} 條', { n: list.length });
    $('#e-table').innerHTML = executionTable(list);
  };
  $('#f-state').onchange = load;
  let timer;
  $('#f-q').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 300); };
  await load();
};

PAGES.playground = async () => {
  // 示例問題針對庫存域示例資料（知識內容為繁體中文），各語言介面都保持原文。
  const examples = ['可售庫存怎麼算？', '可售庫存以前是不是不扣安全庫存？', 'SKU-123 在上海一號倉還有多少可售？', '可售庫存會出現負數嗎？', '「可用庫存」指什麼？', '可售庫存多久同步到搜索系統？'];
  const rules = [tk('解析術語：別名解析為規範主體；多義別名先消歧。'), tk('動態值調用取值 Action，不使用存儲值。'), tk('按層級作答：L0 直接依據；L1 標註未驗證；L2 只作思路；E1 不得作依據並給出替代者。'), tk('引用主體 ID、斷言 ID 和層級。'), tk('未收錄就說未收錄，記為知識缺口。'), tk('用戶指出有誤時提交反饋，觸發降級和重驗。')];
  content().innerHTML = `<div class="two-col"><div class="stack">${panel(t('提問'), `<div class="panel-body"><form id="ask-form">${field(t('問題'), textarea('question', examples[0], 'required style="min-height:80px;font-family:inherit"'))}<div class="field-pair">${field(t('限定主體 ID（選填，用於消歧）'), input('subjectIds', '', 'placeholder="S-INV-0012"'))}${field(t('自然語言組織'), select('compose', [['auto', t('自動（已配置 OpenRouter 則使用）')], ['llm', t('強制 OpenRouter')], ['template', t('規則模板')]], 'auto'))}</div><div class="actions" style="margin-top:12px"><button class="button primary" type="submit">${t('提問')}</button><span class="muted" style="font-size:11px">${t('以目前登入身份調用 POST /api/v1/ask')}</span></div></form><div class="chip-row" style="margin-top:12px">${examples.map(q => `<button class="button example" type="button">${esc(q)}</button>`).join('')}</div></div>`)}<div id="ask-result" class="stack"></div></div>
    <div>${panel(t('智能體使用規約'), `<div class="panel-body prose"><ol>${rules.map(r => `<li>${t(r)}</li>`).join('')}</ol></div>`)}</div></div>`;
  $$('.example').forEach(b => (b.onclick = () => { $('#ask-form textarea').value = b.textContent; $('#ask-form').requestSubmit(); }));
  $('#ask-form').onsubmit = async e => {
    e.preventDefault();
    const d = formData($('#ask-form'));
    $('#ask-result').innerHTML = `<div class="panel panel-body muted">${t('查詢中…')}</div>`;
    try {
      const r = (await post('/api/v1/ask', { question: d.question, compose: d.compose, subjectIds: d.subjectIds ? d.subjectIds.split(/[,，\s]+/).filter(Boolean) : [] })).data;
      const askStatus = { answered: pill(t('已回答'), 'green'), ambiguous: pill(t('需要消歧'), 'amber'), uncovered: pill(t('知識庫未收錄'), 'red'), need_inputs: pill(t('需要參數'), 'amber') }[r.status];
      const composer = r.composer.type === 'openrouter' ? `OpenRouter · ${r.composer.model}` : r.composer.type === 'template' ? t('規則模板') : t('規則');
      $('#ask-result').innerHTML = `${panel(`${t('答案')} ${askStatus}`, `<div class="panel-body"><div class="answer">${esc(r.answer)}</div><p class="muted" style="font-size:11px;margin-top:10px">${esc(t('組織方式：{composer}', { composer }))}${r.composer.fallbackReason ? esc(t('（OpenRouter 失敗，已回退：{reason}）', { reason: r.composer.fallbackReason })) : ''}${r.gap ? esc(t(' · 已記為知識缺口 {id}', { id: r.gap.id })) : ''}</p>${r.next?.candidates ? `<div class="chip-row" style="margin-top:8px">${r.next.candidates.map(c => `<button class="button disambig" data-id="${esc(c.id)}">${esc(t('指 {name}', { name: c.name }))}</button>`).join('')}</div>` : ''}</div>`)}
        ${r.documents?.length ? panel(t('文檔原文（補充）'), `<div class="panel-body"><p class="muted small" style="margin-bottom:8px">${esc(t('與知識的引用分開標註：文檔原文沒有層級，只作補充，不能覆蓋 L0 知識。'))}</p>${r.documents.map(x => `<div class="search-doc"><div><a href="#doc/${esc(x.docId)}${x.anchor ? `/${encodeURIComponent(x.anchor)}` : ''}"><strong>${esc(x.title)}</strong>${x.heading ? ` <span class="muted">§${esc(x.heading)}</span>` : ''}</a> <span class="mono small">${esc(x.cite)}</span>${x.linked ? ` ${pill(t('關聯了命中的主體'), 'blue')}` : ''}${x.cited ? ` ${pill(t('答案引用了'), 'green')}` : ''}</div><p class="search-snippet">${esc(x.snippet)}</p></div>`).join('')}</div>`) : ''}
        ${r.citations?.length ? panel(t('引用'), table(['ID', t('層級'), t('內容'), ''], r.citations.map(c => `<tr><td>${idLink(c.id)}</td><td>${level(c.level)}</td><td class="wrap">${esc(c.content || '')}</td><td>${c.kind !== 'action' ? `<button class="text-btn" data-op="feedback" data-id="${esc(c.id)}">${t('反饋有誤')}</button>` : ''}</td></tr>`))) : ''}
        ${r.realtime?.length ? panel(t('實時取值'), `<pre class="mono-block">${esc(JSON.stringify(r.realtime, null, 2))}</pre>`) : ''}
        ${panel(t('完整回應（結構化知識）'), `<details style="padding:0 12px"><summary>${t('展開 JSON')}</summary><pre class="mono-block">${esc(JSON.stringify(r, null, 2))}</pre></details>`)}`;
      $$('.disambig').forEach(b => (b.onclick = () => { $('#ask-form [name=subjectIds]').value = b.dataset.id; $('#ask-form').requestSubmit(); }));
    } catch (err) {
      $('#ask-result').innerHTML = `<div class="notice warn">${esc(err.message)}</div>`;
    }
  };
};

PAGES.prompt = async () => {
  const role = new URLSearchParams(location.hash.split('?')[1] || '').get('role') === 'consumer' ? 'consumer' : 'producer';
  const query = new URLSearchParams({ ...(role === 'consumer' ? { role } : {}), lang: locale() }).toString();
  const res = await fetch(`/api/v1/prompt?${query}`);
  const md = await res.text();
  const url = `${location.origin}/api/v1/prompt?${query}`;
  setActions(`<div class="segmented" role="tablist"><button class="${role === 'producer' ? 'active' : ''}" id="r-prod">${t('生產教程')}</button><button class="${role === 'consumer' ? 'active' : ''}" id="r-cons">${t('消費教程')}</button></div><button class="button" id="dl-md">${t('下載 Markdown')}</button>`);
  content().innerHTML = `<div class="stack">${panel(t('拉取地址（無需金鑰）'), `<div class="panel-body stack-sm"><div class="copy-row"><code>${esc(url)}</code><button class="button" id="copy-url">${t('複製')}</button></div><div class="copy-row"><code>curl -s '${esc(url)}'</code><button class="button" id="copy-curl">${t('複製')}</button></div><p class="muted" style="font-size:12px">${t('把這個地址交給三方智能體：先讀教程，再用你在「API 金鑰」頁發放的金鑰調用 API。教程內容會隨知識庫規模、領域代碼和有效期參數即時生成。')} ${t('網址中的 lang 參數決定教程語言（zh-TW / zh-CN / en）。')}</p></div>`)}
    ${panel(t('教程內容'), `<div class="panel-body prose">${markdown(md)}</div>`)}</div>`;
  $('#r-prod').onclick = () => (location.hash = 'prompt');
  $('#r-cons').onclick = () => (location.hash = 'prompt?role=consumer');
  $('#copy-url').onclick = () => copy(url);
  $('#copy-curl').onclick = () => copy(`curl -s '${url}'`);
  $('#dl-md').onclick = () => download(`knowledge-${role}-prompt${locale() === 'zh-TW' ? '' : `.${locale()}`}.md`, md, 'text/markdown');
};

PAGES.keys = async () => {
  const list = await get('/admin/api/keys');
  setActions(`<button class="button primary" id="add-key">${t('發放金鑰')}</button>`);
  const kindName = k => mapText(SOURCE_KIND, k);
  content().innerHTML = `<p class="notice" style="margin-bottom:12px">${t('角色：消費者只能讀取與問答；貢獻者可提交知識（最高 L1）；負責人（只能是人）可確認晉升、裁決衝突、判定失效。管道金鑰提交的知識按管道校驗結果直接定級。')}</p>${panel(t('API 金鑰（{n}）', { n: list.length }), table([t('名稱'), 'ID', t('類型'), t('角色'), t('前綴'), t('建立'), t('最近使用'), t('狀態'), t('操作')], list.map(k => `<tr><td>${esc(k.name)}</td><td class="mono">${esc(k.id)}</td><td>${esc(kindName(k.kind))}</td><td>${esc(mapText(ROLE_TEXT, k.role))}</td><td class="mono">${esc(k.prefix)}…</td><td>${fmtTime(k.createdAt)}</td><td>${ago(k.lastUsedAt)}</td><td>${k.disabled ? pill(t('已停用'), 'red') : pill(t('啟用'), 'green')}</td><td><div class="cell-actions"><button class="text-btn toggle-key" data-id="${esc(k.id)}" data-disabled="${k.disabled ? '0' : '1'}">${k.disabled ? t('啟用') : t('停用')}</button><button class="text-btn del-key" data-id="${esc(k.id)}" style="color:var(--danger)">${t('刪除')}</button></div></td></tr>`), t('尚未發放金鑰')))}`;
  $('#add-key').onclick = () => modal(t('發放 API 金鑰'), `${field(t('名稱'), input('name', '', `required placeholder="${esc(t('例如：庫存域冷啟動智能體'))}"`))}<div class="field-pair">${field(t('類型'), select('kind', [['agent', t('智能體')], ['human', t('人')], ['pipeline', t('管道（自動同步）')]], 'agent'))}${field(t('角色'), select('role', [['contributor', t('貢獻者：生產 + 消費')], ['consumer', t('消費者：只讀與問答')], ['owner', t('負責人（僅限人）')]], 'contributor'))}</div>`, {
    label: t('發放'),
    run: async () => {
      const r = await post('/admin/api/keys', formData($('#dialog-content')));
      modal(t('金鑰已發放'), `<p class="notice warn">${t('金鑰只顯示這一次，請立即保存。')}</p><div class="copy-row" style="margin-top:10px"><code id="new-secret">${esc(r.data.secret)}</code><button class="button" id="copy-secret">${t('複製')}</button></div><p class="muted" style="font-size:12px;margin-top:10px">${t('使用方式：{usage}；教程地址：{url}', { usage: `<code>Authorization: Bearer ${esc(r.data.prefix)}…</code>`, url: `<code>${esc(location.origin)}/api/v1/prompt</code>` })}</p>`);
      $('#copy-secret').onclick = () => copy(r.data.secret);
      PAGES.keys();
      return true;
    }
  });
  $$('.toggle-key').forEach(b => (b.onclick = async () => { await patch(`/admin/api/keys/${b.dataset.id}`, { disabled: b.dataset.disabled === '1' }); render(); }));
  $$('.del-key').forEach(b => (b.onclick = () => modal(t('刪除金鑰'), `<p>${esc(t('確定刪除 {id}？使用此金鑰的智能體將無法訪問。', { id: b.dataset.id }))}</p>`, { label: t('刪除'), run: async () => { await del(`/admin/api/keys/${b.dataset.id}`); render(); } })));
};

PAGES.apidoc = async () => {
  const spec = await (await fetch('/api/v1/openapi.json', { headers: { 'accept-language': locale() } })).json();
  const rows = [];
  for (const [p, methods] of Object.entries(spec.paths)) for (const [m, op] of Object.entries(methods)) rows.push({ tag: op.tags[0], m: m.toUpperCase(), p, op });
  const tags = [...new Set(rows.map(r => r.tag))];
  setActions('<a class="button" href="/api/v1/openapi.json" target="_blank" rel="noopener">openapi.json</a>');
  content().innerHTML = `<div class="stack">${panel(t('基本資訊'), `<div class="panel-body"><dl class="kv"><dt>${t('根地址')}</dt><dd class="mono">${esc(spec.servers[0].url)}</dd><dt>${t('認證')}</dt><dd>${t('<code>Authorization: Bearer &lt;API 金鑰&gt;</code>（教程、Schema、OpenAPI 公開）')}</dd><dt>${t('回應')}</dt><dd>${t('<code>{ data, commit?, warnings? }</code>；錯誤 <code>{ error: { code, message } }</code>')}</dd><dt>${t('語言')}</dt><dd>${t('錯誤訊息、提示與教程按 <code>Accept-Language</code> 或 <code>?lang=</code> 返回（zh-TW / zh-CN / en）；枚舉值（主體類型、關係類型等）在所有語言中保持原文。')}</dd></dl></div>`)}${tags.map(tg => panel(esc(tg), table([t('方法'), t('路徑'), t('說明'), t('角色')], rows.filter(r => r.tag === tg).map(r => `<tr><td>${pill(r.m, r.m === 'GET' ? '' : 'blue')}</td><td class="mono">${esc(r.p)}</td><td class="wrap">${esc(r.op.summary)}</td><td>${esc(r.op['x-role'] || r.op.description)}</td></tr>`)))).join('')}</div>`;
};

const AUTH_TEXT = { local: tk('本地倉庫（無遠端）'), https: tk('HTTPS（無權杖，僅公開倉庫可讀）'), 'https-token': tk('HTTPS 存取權杖'), 'ssh-deploy-key': tk('SSH 部署金鑰'), 'ssh-system': tk('SSH（未產生部署金鑰，使用本機 ssh 設定）') };
const authText = k => (AUTH_TEXT[k] ? t(AUTH_TEXT[k]) : k);
const isSshUrl = u => /^(?:git\+)?ssh:\/\//i.test(u) || (!u.includes('://') && /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\S/.test(u));
const githubDeployKeyUrl = u => {
  const m = u.match(/^(?:git@github\.com:|(?:git\+)?ssh:\/\/git@(?:ssh\.)?github\.com(?::\d+)?\/|https:\/\/github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}/settings/keys/new` : null;
};
const urlAuth = (u, token, hasKey) => (!u ? 'local' : isSshUrl(u) ? (hasKey ? 'ssh-deploy-key' : 'ssh-system') : token ? 'https-token' : 'https');

function sshPanel(ssh) {
  if (!ssh.available) return panel(t('SSH 部署金鑰'), `<div class="panel-body"><p class="notice warn">${t('這台伺服器沒有安裝 OpenSSH 客戶端（ssh、ssh-keygen），無法使用 SSH 部署金鑰。容器映像已內置；本機運行請先安裝 OpenSSH。')}</p></div>`);
  const source = { generated: t('後台產生（ed25519）'), imported: t('後台貼上的私鑰'), env: t('環境變數 KNOWLEDGE_GIT_SSH_KEY_FILE（{file}）', { file: ssh.keyFile }) }[ssh.source] || '—';
  const key = ssh.hasKey
    ? `<div class="copy-row"><code id="ssh-pub">${esc(ssh.publicKey)}</code><button class="button" type="button" id="copy-pub">${t('複製公鑰')}</button></div>
      <dl class="kv" style="margin-top:8px"><dt>${t('指紋')}</dt><dd class="mono">${esc(ssh.fingerprint || '—')}</dd><dt>${t('來源')}</dt><dd>${esc(source)}</dd>${ssh.createdAt ? `<dt>${t('建立時間')}</dt><dd>${fmtTime(ssh.createdAt)}</dd>` : ''}</dl>`
    : `<p class="notice">${t('尚未產生部署金鑰。倉庫地址使用 SSH 形式時，需要先產生（或貼上）部署金鑰，並把公鑰添加到倉庫。')}</p>`;
  const buttons = ssh.source === 'env' ? '' : ssh.hasKey
    ? `<button class="button" type="button" id="ssh-generate">${t('重新產生')}</button><button class="button" type="button" id="ssh-import">${t('貼上私鑰替換')}</button><button class="button danger" type="button" id="ssh-remove">${t('刪除金鑰')}</button>`
    : `<button class="button primary" type="button" id="ssh-generate">${t('產生部署金鑰')}</button><button class="button" type="button" id="ssh-import">${t('貼上已有私鑰')}</button>`;
  const hosts = ssh.hostKeys.length
    ? `<details style="margin-top:10px"><summary>${t('已記下的主機指紋（{n}）', { n: ssh.hostKeys.length })}</summary><ul class="mono" style="font-size:11px;margin:8px 0;padding-left:18px">${ssh.hostKeys.map(h => `<li>${esc(h)}</li>`).join('')}</ul><p class="muted" style="font-size:12px">${t('首次連接時記下，之後主機指紋不符會拒絕連接。GitHub 的官方指紋見 <a href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints" target="_blank" rel="noopener">GitHub 文檔</a>。')}</p><button class="button" type="button" id="ssh-clear-hosts">${t('清除主機指紋')}</button></details>`
    : `<p class="muted" style="font-size:12px;margin-top:10px">${t('首次連接時會記下遠端主機指紋，之後指紋不符會拒絕連接。')}</p>`;
  return panel(t('SSH 部署金鑰'), `<div class="panel-body">${key}
    <div class="actions" style="margin-top:10px">${buttons}</div>
    <div class="prose" style="font-size:12px;margin-top:12px"><ol>
      <li>${t('倉庫地址填 SSH 形式，例如 <code>git@github.com:your-org/knowledge.git</code>。')}</li>
      <li>${t('產生部署金鑰，點「複製公鑰」。')}</li>
      <li>${t('到倉庫 <strong>Settings › Deploy keys › Add deploy key</strong> 貼上公鑰，勾選 <strong>Allow write access</strong>（知識寫入需要推送）。')}<a id="deploy-link" target="_blank" rel="noopener" hidden>${t('打開這個倉庫的 Deploy keys 頁面')}</a></li>
      <li>${t('點「測試連接」，通過後「保存並切換」。')}</li>
    </ol></div>${hosts}</div>`);
}

let repoDraft = null; // 金鑰操作後重繪頁面時保留表單中尚未保存的輸入

PAGES.repo = async () => {
  const s = await get('/admin/api/settings');
  const g = s.git;
  const ssh = s.ssh;
  const src = k => (g[`${k}Source`] ? `<small>${esc(t('由環境變數 {name} 提供', { name: g[`${k}Source`].replace('env:', '') }))}</small>` : '');
  const st = s.gitStatus;
  content().innerHTML = `<div class="two-col"><div class="stack">${panel(t('Git 倉庫'), `<div class="panel-body"><form id="git-form">
    ${field(t('倉庫地址'), input('url', g.url, `placeholder="${esc(t('git@github.com:your-org/knowledge.git 或 https://…（留空為純本地倉庫）'))}"`), t('支持 SSH（部署金鑰）與 HTTPS（存取權杖）；知識以 YAML 檔案存放，每次寫入一個提交'))}${src('url')}
    <p class="muted" style="font-size:12px;margin:6px 0 0">${t('認證方式：')}<strong id="auth-mode"></strong></p>
    <div class="field-pair" style="margin-top:12px">${field(t('分支'), input('branch', g.branch))}${field(t('知識目錄'), input('subdir', g.subdir), t('倉庫內存放知識的子目錄'))}</div>
    <div class="field-pair">${field(t('存取權杖（僅 HTTPS）'), input('token', g.token, `type="password" autocomplete="off" placeholder="${esc(t('GitHub PAT 等；只存本地，不入庫'))}"`))}${field(t('權杖用戶名'), input('username', g.username))}</div>
    <div class="field-pair">${field(t('提交者名稱'), input('authorName', g.authorName))}${field(t('提交者郵箱'), input('authorEmail', g.authorEmail))}</div>
    <div class="field-pair">${field(t('自動拉取間隔（秒）'), input('pullIntervalSec', g.pullIntervalSec, 'type="number" min="15"'), t('定期拉取他人在 Git 中直接做的修改；重啟後生效'))}<label class="check" style="margin-top:22px"><input type="checkbox" name="autoPush" ${g.autoPush ? 'checked' : ''}> ${t('寫入後自動推送')}</label></div>
    <div class="actions" style="margin-top:14px"><button class="button" type="button" id="git-test">${t('測試連接')}</button><button class="button primary" type="submit">${t('保存並切換')}</button></div></form></div>`)}
    ${sshPanel(ssh)}</div>
    <div class="stack">${panel(t('同步狀態'), `<div class="panel-body"><dl class="kv"><dt>${t('遠端')}</dt><dd>${esc(st.remote || t('未配置'))}</dd><dt>${t('分支')}</dt><dd>${esc(st.branch)}</dd><dt>${t('認證')}</dt><dd>${esc(authText(st.auth) || '—')}</dd><dt>${t('本地目錄')}</dt><dd class="mono">${esc(s.repoDir)}</dd><dt>${t('最近拉取')}</dt><dd>${fmtTime(st.lastPullAt)}</dd><dt>${t('最近推送')}</dt><dd>${fmtTime(st.lastPushAt)}</dd><dt>${t('錯誤')}</dt><dd style="white-space:pre-wrap">${esc(st.lastError || t('無'))}</dd></dl><div class="actions" style="margin-top:12px"><button class="button" id="git-sync">${t('立即同步')}</button></div></div>`)}
    ${panel(t('示例資料'), `<div class="panel-body"><p style="font-size:12px">${t('載入設計文件中的「可售庫存」示例及庫存域試點主體（約 26 個主體、示意管道與 Action）。走真實流程：先提交為 L1/L2，再經 Action 校驗和負責人確認晉升。系統名、表名、接口名均為示意。')}${locale() === 'zh-TW' ? '' : ` ${t('示例資料的知識內容為繁體中文。')}`}</p><div class="actions" style="margin-top:10px"><button class="button" id="seed">${t('載入示例資料')}</button></div></div>`)}</div></div>`;
  const form = $('#git-form');
  if (repoDraft) {
    for (const [k, v] of Object.entries(repoDraft)) if (form[k]) form[k].type === 'checkbox' ? (form[k].checked = v) : (form[k].value = v);
    repoDraft = null;
  }
  const rerender = () => { repoDraft = formData(form); render(); };
  const updateAuth = () => {
    const url = form.url.value.trim();
    $('#auth-mode').textContent = authText(urlAuth(url, form.token.value, ssh.hasKey));
    const link = $('#deploy-link');
    if (link) {
      const href = isSshUrl(url) ? githubDeployKeyUrl(url) : null;
      link.hidden = !href;
      if (href) link.href = href;
    }
  };
  form.url.oninput = updateAuth;
  form.token.oninput = updateAuth;
  updateAuth();
  $('#git-test').onclick = async () => { try { const r = await post('/admin/api/settings/git/test', formData(form)); const detail = r.data.empty ? t('倉庫為空，首次寫入會建立分支') : `${t('分支 {list}', { list: r.data.branches.join(t('、')) })}${r.data.branchExists ? '' : t('（目標分支尚不存在，將自動建立）')}`; toast(t('可連接（{auth}）：{detail}', { auth: authText(r.data.auth), detail }), 6000); } catch (e) { showError(e); } };
  form.onsubmit = async e => { e.preventDefault(); try { await put('/admin/api/settings/git', formData(form)); toast(t('已切換知識倉庫')); render(); } catch (err) { showError(err); } };
  $('#git-sync').onclick = async () => { try { const r = await post('/admin/api/sync'); toast(r.data.changed ? t('已拉取遠端更新並重新載入') : t('已是最新')); render(); } catch (e) { showError(e); } };
  $('#seed').onclick = async () => {
    const button = $('#seed');
    button.disabled = true;
    try {
      const { data } = await post('/admin/api/seed');
      toast(data.subjects ? t('已載入示例資料（{n} 個主體）', { n: data.subjects }) : data.docsAdded ? t('已補齊示例資料（新增 {n} 篇文檔，保留現有知識）', { n: data.docsAdded }) : t('示例資料已齊全，保留現有內容'));
      location.hash = data.subjects ? `subject/${data.focus}` : 'docs';
    } catch (e) { showError(e); }
    finally { button.disabled = false; }
  };
  if ($('#copy-pub')) $('#copy-pub').onclick = () => copy(ssh.publicKey);
  const generate = async () => { await post('/admin/api/settings/git/ssh-key'); toast(t('已產生部署金鑰：複製公鑰並添加到倉庫的 Deploy keys（勾選 Allow write access）'), 6000); rerender(); };
  if ($('#ssh-generate')) $('#ssh-generate').onclick = () => (ssh.hasKey
    ? modal(t('重新產生部署金鑰'), `<p class="notice warn">${t('舊的部署金鑰會立即被替換。需要把新公鑰添加到倉庫的 Deploy keys（並刪除舊的），否則同步會失敗。')}</p>`, { label: t('重新產生'), run: generate })
    : generate().catch(showError));
  if ($('#ssh-import')) $('#ssh-import').onclick = () => modal(t('貼上 SSH 私鑰'), `<p class="notice">${t('私鑰只存在服務本地的 DATA_DIR/ssh/（權限 0600），不進入知識倉庫，接口也不會返回私鑰。不支持有密碼保護的私鑰。')}</p>${field(t('私鑰'), textarea('privateKey', '', 'placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellcheck="false" autocomplete="off"'))}`, {
    label: t('保存'),
    run: async () => { await post('/admin/api/settings/git/ssh-key', formData($('#dialog-content'))); toast(t('已保存私鑰；請確認對應公鑰已添加到倉庫的 Deploy keys')); rerender(); }
  });
  if ($('#ssh-remove')) $('#ssh-remove').onclick = () => modal(t('刪除部署金鑰'), `<p>${t('刪除後，SSH 倉庫地址將無法用部署金鑰認證；記得也到倉庫的 Deploy keys 刪除對應公鑰。')}</p>`, { label: t('刪除'), run: async () => { await del('/admin/api/settings/git/ssh-key'); rerender(); } });
  if ($('#ssh-clear-hosts')) $('#ssh-clear-hosts').onclick = () => modal(t('清除主機指紋'), `<p>${t('只在遠端主機確實更換了金鑰時使用。清除後，下次連接會重新記下主機指紋。')}</p>`, { label: t('清除'), run: async () => { await del('/admin/api/settings/git/known-hosts'); rerender(); } });
};

PAGES.llm = async () => {
  const s = await get('/admin/api/settings');
  const l = s.llm;
  content().innerHTML = `<div class="two-col"><div>${panel('OpenRouter', `<div class="panel-body"><form id="llm-form">${field('API Key', input('apiKey', l.apiKey, 'type="password" autocomplete="off" placeholder="sk-or-…"'), l.apiKeySource ? t('由環境變數 {name} 提供', { name: l.apiKeySource.replace('env:', '') }) : t('只存本地 settings.json，不入知識倉庫'))}${field(t('模型'), input('model', l.model, 'placeholder="anthropic/claude-sonnet-4.5"'), t('OpenRouter 模型 ID，可隨時更換'))}${field(t('API 地址'), input('baseUrl', l.baseUrl))}<div class="field-pair">${field('Temperature', input('temperature', l.temperature, 'type="number" step="0.1" min="0" max="1"'))}${field(t('超時（毫秒）'), input('timeoutMs', l.timeoutMs, 'type="number" min="1000"'))}</div>${field(t('應用名稱（X-Title）'), input('appTitle', l.appTitle))}<div class="actions" style="margin-top:14px"><button class="button" type="button" id="llm-test">${t('測試')}</button><button class="button primary" type="submit">${t('保存')}</button></div></form></div>`)}</div>
    <div>${panel(t('說明'), `<div class="panel-body prose"><p>${t('消費型 API 的 <code>/ask</code> 先按規約完成術語解析、動態取值和知識檢索，再把結構化知識交給模型組織成自然語言。')}</p><ul><li>${t('模型只能依據提供的知識作答，每個結論標註〔ID·層級〕。')}</li><li>${t('模型返回的引用會被校驗，不在知識範圍內的 ID 會被丟棄。')}</li><li>${t('未配置或調用失敗時，自動回退為規則模板組織的答案。')}</li><li>${t('答案使用與問題相同的語言；無法判斷時使用提問者的介面語言。')}</li></ul></div>`)}</div></div>`;
  $('#llm-form').onsubmit = async e => { e.preventDefault(); try { await put('/admin/api/settings/llm', formData($('#llm-form'))); toast(t('已保存')); render(); } catch (err) { showError(err); } };
  $('#llm-test').onclick = async () => { try { const r = await post('/admin/api/settings/llm/test'); toast(t('可用：{model}', { model: r.data.model })); } catch (e) { showError(e); } };
};

PAGES.rules = async () => {
  const s = await get('/admin/api/settings');
  const r = s.rules;
  const exp = r.expiryDays;
  const num = (name, v) => input(name, v, 'type="number" min="1" style="width:90px"');
  content().innerHTML = `<form id="rules-form" class="stack"><div class="two-col"><div class="stack">${panel(t('領域代碼'), `<div class="panel-body">${field(t('每行一個：代碼 名稱'), textarea('domains', r.domains.map(d => `${d.code} ${d.name}`).join('\n'), 'style="min-height:140px"'), t('代碼 2–6 個大寫字母，決定主體 ID 前綴，如 S-INV-0012'))}</div>`)}
    ${panel(t('其他參數'), `<div class="panel-body">${field(t('高頻主體比例'), input('highFrequencyRatio', r.highFrequencyRatio, 'type="number" step="0.05" min="0.01" max="1"'), t('L0 覆蓋率按被問得最多的前 N% 主體計算'))}${field(t('定期校驗間隔（小時，0 為關閉）'), input('validationIntervalHours', r.validationIntervalHours, 'type="number" min="0"'))}${field(t('對外訪問地址（教程中的 API 根地址）'), input('publicBaseUrl', s.server.publicBaseUrl, 'placeholder="https://knowledge.example.com"'), t('留空時按請求的 Host 推斷'))}</div>`)}</div>
    <div>${panel(t('有效期初值（天）'), table([t('條目'), t('類型'), t('天數')], [...Object.entries(exp.assertion).map(([k, v]) => `<tr><td>${t('斷言')}</td><td>${esc(tv(k))}</td><td>${num(`assertion.${k}`, v)}</td></tr>`), ...Object.entries(exp.relation).map(([k, v]) => `<tr><td>${t('關係')}</td><td>${esc(tv(k, 'rel'))}</td><td>${num(`relation.${k}`, v)}</td></tr>`), ...Object.entries(exp.binding).map(([k, v]) => `<tr><td>${t('綁定')}</td><td>${esc(t('{category}客體', { category: tv(k) }))}</td><td>${num(`binding.${k}`, v)}</td></tr>`)]))}</div></div><div class="actions"><button class="button primary" type="submit">${t('保存規則參數')}</button></div></form>`;
  $('#rules-form').onsubmit = async e => {
    e.preventDefault();
    const d = formData($('#rules-form'));
    const domains = d.domains.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [code, ...name] = l.split(/\s+/); return { code: code.toUpperCase(), name: name.join(' ') }; });
    const expiryDays = { assertion: {}, relation: {}, binding: {} };
    for (const [k, v] of Object.entries(d)) { const m = /^(assertion|relation|binding)\.(.+)$/.exec(k); if (m) expiryDays[m[1]][m[2]] = Number(v); }
    try {
      await put('/api/v1/config', { domains, expiryDays, highFrequencyRatio: Number(d.highFrequencyRatio), validationIntervalHours: Number(d.validationIntervalHours) });
      await put('/admin/api/settings/server', { publicBaseUrl: d.publicBaseUrl });
      schema = await get('/api/v1/schema');
      toast(t('已保存（規則參數已提交到知識倉庫）'));
      render();
    } catch (err) { showError(err); }
  };
};

const displayName = () => (me?.isAdmin ? t('管理員') : me?.name);
const roleText = () => (me?.isAdmin ? t('管理員（負責人權限）') : mapText(ROLE_TEXT, me?.role));

PAGES.account = async () => {
  const s = me.isAdmin ? await get('/admin/api/settings') : null;
  content().innerHTML = `<div class="two-col"><div>${panel(t('目前身份'), `<div class="panel-body"><dl class="kv"><dt>${t('名稱')}</dt><dd>${esc(displayName())}</dd><dt>ID</dt><dd class="mono">${esc(me.id)}</dd><dt>${t('角色')}</dt><dd>${esc(roleText())}</dd><dt>${t('語言')}</dt><dd>${localeSelect('account-lang')}</dd></dl><div class="actions" style="margin-top:12px"><button class="button" id="logout">${t('登出')}</button></div></div>`)}</div>
    <div>${s ? panel(t('修改管理員密碼'), `<div class="panel-body">${s.adminPasswordFromEnv ? `<p class="notice">${t('密碼由環境變數 ADMIN_PASSWORD 提供，請在部署環境中修改。')}</p>` : `<form id="pw-form">${field(t('新密碼（至少 8 位）'), input('password', '', 'type="password" autocomplete="new-password" required minlength="8"'))}<div class="actions" style="margin-top:12px"><button class="button primary" type="submit">${t('修改')}</button></div></form>`}</div>`) : ''}</div></div>`;
  $('#account-lang').onchange = e => setLocale(e.target.value);
  $('#logout').onclick = logout;
  $('#pw-form')?.addEventListener('submit', async e => { e.preventDefault(); try { await put('/admin/api/password', formData($('#pw-form'))); toast(t('密碼已修改')); e.target.reset(); } catch (err) { showError(err); } });
};

// ------------------------------------------------------------------ 啟動
async function render() {
  if (!me) return;
  const r = route();
  r.page = r.page.split('?')[0];
  const entry = shell(navFor(), r);
  const page = PAGES[r.page] && (r.page === entry.id || (entry.aliases || []).includes(r.page)) ? r.page : entry.id;
  content().innerHTML = `<div class="panel panel-body muted">${t('載入中…')}</div>`;
  try {
    await PAGES[page]({ ...r, page });
  } catch (err) {
    if (err.status === 401) return;
    content().innerHTML = `<div class="notice warn">${esc(err.message)}</div>`;
  }
}

async function logout() {
  await post('/admin/api/logout').catch(() => {});
  me = null;
  showLogin();
}

function showLogin() {
  $('#login').hidden = false;
  $('#login-mark').innerHTML = icon('node');
  $('#login-form input').focus();
}

async function boot() {
  try {
    me = await get('/admin/api/me');
  } catch {
    me = null;
  }
  if (!me) return showLogin();
  $('#login').hidden = true;
  $('#avatar').textContent = (displayName() || t('管')).slice(0, 1).toUpperCase();
  schema = await get('/api/v1/schema');
  get('/api/v1/status').then(s => ($('#foot-git').textContent = t('知識倉庫：{remote} · {branch}', { remote: s.git.remote || t('本地'), branch: s.git.branch }))).catch(() => {});
  render();
}

// 語言切換：頂欄與登入頁各一個下拉選單，選擇後重新載入頁面。
$('#lang-slot').innerHTML = localeSelect('lang-select');
// 頂欄全局搜索：Enter 打開搜索頁；按 / 聚焦
$('#top-search').onsubmit = e => { e.preventDefault(); const q = $('#top-q').value.trim(); if (q) location.hash = `search?q=${encodeURIComponent(q)}`; };
document.addEventListener('keydown', e => { if (e.key === '/' && !e.target.closest?.('input, textarea, select, [contenteditable]') && !$('#dialog').open) { e.preventDefault(); $('#top-q').focus(); } });
$('#login-lang-slot').innerHTML = localeSelect('login-lang');
for (const id of ['#lang-select', '#login-lang']) $(id).onchange = e => setLocale(e.target.value);

setUnauthorizedHandler(() => { if (me) { me = null; showLogin(); } });
$('#login-form').onsubmit = async e => {
  e.preventDefault();
  const secret = $('#login-form input[name=secret]').value;
  $('#login-error').hidden = true;
  try {
    await post('/admin/api/login', secret.startsWith('kk_') ? { apiKey: secret } : { password: secret });
    $('#login-form').reset();
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').hidden = false;
  }
};
$('#menu-toggle').onclick = () => { const open = $('#sidebar').classList.toggle('open'); $('#menu-toggle').setAttribute('aria-expanded', String(open)); };
$('#dialog-close').onclick = () => closeModal();
$('.skip').onclick = e => { e.preventDefault(); $('#main').setAttribute('tabindex', '-1'); $('#main').focus(); };
$('#sidenav').onclick = e => { if (e.target.closest('a')) { $('#sidebar').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); } };
$('#avatar').onclick = () => {
  if (me?.isAdmin) { location.hash = 'account'; return; }
  modal(t('目前身份'), `<dl class="kv"><dt>${t('名稱')}</dt><dd>${esc(displayName())}</dd><dt>ID</dt><dd class="mono">${esc(me?.id)}</dd><dt>${t('角色')}</dt><dd>${esc(roleText())}</dd></dl>`, { label: t('登出'), run: logout });
};
window.addEventListener('hashchange', render);
boot();

export { LEVEL_TEXT };
