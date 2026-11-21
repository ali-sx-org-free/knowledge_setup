// 文檔庫後台（設計文件 §10、§13）：文檔庫三欄頁、文檔頁、編輯器、歷史與差異、發布與廢止、模板頁、標籤頁，
// 以及主體頁、客體頁、健康指標、重驗隊列用到的小部件。由 app.js 調用 registerDocPages(PAGES, ctx) 註冊。
// 介面文字經 t()；狀態等枚舉值經 tv()；文檔內容按原文顯示，不翻譯。
import { $, $$, esc, icon, setHeading, toast, modal, closeModal, showError, download, copy, api, get, post, put, patch, del, level, pill, vpill, idLink, fmtTime, ago, panel, table, formData, field, input, select, textarea, LEVEL_TEXT, ApiError } from './core.js';
import { t, tk, tv, td, locale } from './i18n.js';
import { renderMarkdown, parseSections } from './markdown.js';

let ctx = null;
const me = () => ctx?.me() || null;
const canWrite = () => { const m = me(); return !!m && (m.isAdmin || m.role === 'contributor' || m.role === 'owner'); };
const isOwner = () => { const m = me(); return !!m && (m.isAdmin || m.role === 'owner'); };
const isReviewer = d => isOwner() && (me().isAdmin || !d.reviewers?.length || d.reviewers.includes(me().id));
const canPublish = d => canWrite() && (d.templateInfo?.approval === 'owner' ? isReviewer(d) : true);
const content = () => $('#content');
const setActions = html => ($('#page-actions').innerHTML = html);
const enc = encodeURIComponent;
const qs = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)).toString();
const hashParams = () => new URLSearchParams(location.hash.split('?')[1] || '');
const go = hash => { if (location.hash === `#${hash}`) ctx.render(); else location.hash = hash; };
const local = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 瀏覽器不允許本地存儲時略過 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 同上 */ } }
};
const ID_RE = /[A-Z]{1,4}-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/;
const parseId = v => (ID_RE.exec(String(v || '')) || [''])[0];
const splitList = v => String(v || '').split(/[,，、\n]/).map(x => x.trim()).filter(Boolean);
const isEmpty = v => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
const day = iso => (iso ? String(iso).slice(0, 10) : '—');

// ------------------------------------------------------------------ 代碼 → 文字（取用時經 t()）
const VIEWS = [['mine', tk('我的草稿')], ['review', tk('待我審閱')], ['recent', tk('最近更新')], ['review-soon', tk('即將複審')], ['review-overdue', tk('逾期複審')], ['broken-refs', tk('引用了失效知識')], ['unlinked', tk('未關聯')], ['unregistered', tk('待登記')], ['obsolete', tk('已廢止')]];
const DRAFT_VIEWS = ['mine', 'review', 'unregistered'];
const HOT_VIEWS = ['review', 'review-overdue', 'broken-refs'];
const APPROVAL_TEXT = { owner: tk('負責人審閱後發布'), contributor: tk('貢獻者可直接發布') };
const FIELD_TYPE_TEXT = { text: tk('文字'), longtext: tk('長文字'), number: tk('數字'), date: tk('日期'), enum: tk('單選'), enums: tk('多選'), subject: tk('主體'), subjects: tk('主體（多個）'), object: tk('客體'), objects: tk('客體（多個）'), doc: tk('文檔'), url: tk('網址'), person: tk('人員') };
const EVENT_TEXT = { publish: tk('發布'), obsolete: tk('廢止'), move: tk('移動'), rename: tk('改標題'), tags: tk('改標籤'), review: tk('確認複審'), git_edit: tk('在 Git 中直接修改'), organize: tk('整理') };
const LINT_LEVEL = { error: ['red', tk('錯誤')], warning: ['amber', tk('提醒')], info: ['blue', tk('建議')] };
const KIND_TEXT = { assertion: tk('斷言'), binding: tk('綁定'), relation: tk('關係') };
const CHANGE_TEXT = { added: tk('新增'), modified: tk('修改'), removed: tk('刪除') };
const META_TEXT = { title: tk('標題'), summary: tk('摘要'), tags: tk('標籤'), owner: tk('負責人'), subjects: tk('關聯主體'), objects: tk('涉及的客體'), related: tk('相關文檔') };
const TOOLS = [['h2', 'H2', tk('二級標題')], ['h3', 'H3', tk('三級標題')], ['bold', 'B', tk('粗體')], ['italic', 'I', tk('斜體')], ['ul', '•', tk('列表')], ['ol', '1.', tk('編號列表')], ['table', '⊞', tk('表格')], ['code', '</>', tk('代碼')], ['quote', '❝', tk('引用段落')], ['link', '↗', tk('鏈接')], ['ref', '[[ ]]', tk('插入引用')], ['image', '▣', tk('插入圖片')]];
const TIPS = [tk('用 ## 和 ### 分章節：檢索和智能體按章節切分、引用。'), tk('講到已登記的主體、知識或文檔時寫 [[ID]]，例如 [[S-INV-0012]]、[[DOC-0001#計算公式]]。'), tk('動態值（庫存數量、當前狀態）不寫數字，寫明以哪個系統為準、怎麼取。'), tk('「最近」「目前」寫成具體日期，日後才讀得懂。'), tk('不要放金鑰、密碼、權杖：疑似機密會被拒絕保存。'), tk('Ctrl/⌘ + S 保存草稿；瀏覽器每 5 秒自動暫存一次。')];

// ------------------------------------------------------------------ 快取
const cache = { templates: null, tags: null, subjects: null, objects: null, folders: null, docList: null };
async function loadTemplates(force) { if (!cache.templates || force) cache.templates = await get('/api/v1/doc-templates'); return cache.templates; }
async function loadTags(force) { if (!cache.tags || force) cache.tags = await get('/api/v1/doc-tags'); return cache.tags; }
async function loadFolders(force) { if (!cache.folders || force) cache.folders = await get('/api/v1/doc-folders'); return cache.folders; }
async function loadLookups(force) {
  if (cache.subjects && !force) return;
  const [s, o] = await Promise.all([get('/api/v1/subjects'), get('/api/v1/objects')]);
  cache.subjects = new Map(s.map(x => [x.id, x]));
  cache.objects = new Map(o.map(x => [x.id, x]));
}
async function loadDocList(force) {
  if (cache.docList && !force) return cache.docList;
  const list = await get(`/api/v1/docs?${qs({ limit: 500, drafts: canWrite() ? '1' : '' })}`);
  cache.docList = new Map(list.map(d => [d.id, d]));
  return cache.docList;
}
const tplOf = id => cache.templates?.find(x => x.id === id) || null;
const tplLabel = (id, fallback) => tplOf(id)?.label || fallback || id;
const nameOf = id => (!id ? null : cache.subjects?.get(id)?.name || cache.objects?.get(id)?.name || (cache.docList?.get(id) ? `《${cache.docList.get(id).title}》` : null));
const tplOptions = () => (cache.templates || []).map(x => [x.id, `${x.label}（${tv(x.purpose)}）`]);
/** 文件夾的設定，未設定的項沿用上層（與服務端 folderDefaults 相同）。 */
function folderSetting(path, key) {
  const parts = String(path || '').split('/').filter(Boolean);
  let out = null;
  for (let i = 1; i <= parts.length; i++) {
    const f = cache.folders?.find(x => x.path === parts.slice(0, i).join('/'));
    if (f && !isEmpty(f[key])) out = f[key];
  }
  return out;
}

// ------------------------------------------------------------------ 格式化
const who = s => (s ? `${td(s.name) || s.id}${s.kind === 'agent' ? t('（智能體）') : s.kind === 'pipeline' ? t('（管道）') : ''}` : '—');

function statusBadges(d, { review = true } = {}) {
  const out = [];
  if (d.status === '已發布' || d.status === '已廢止') out.push(`<span class="badge ${d.status === '已發布' ? 'green' : 'red'}" title="${esc(d.status)}">${esc(tv(d.status))}${d.version ? ` v${esc(d.version)}` : ''}</span>`);
  else out.push(vpill(d.status, d.status === '待審' ? 'amber' : ''));
  if (d.revision) out.push(vpill(d.revision, 'amber'));
  if (review && d.status === '已發布' && d.review?.overdue) out.push(pill(t('逾期複審'), 'red'));
  else if (review && d.status === '已發布' && d.review?.dueSoon) out.push(pill(t('即將複審'), 'amber'));
  return out.join(' ');
}

function docTag(name) {
  const info = cache.tags?.tags.find(x => x.name.toLowerCase() === String(name).toLowerCase());
  return `<a class="doc-tag${info?.color ? ` c-${esc(info.color)}` : ''}" href="#docs?tag=${enc(name)}" title="${esc(info?.description || name)}">${esc(name)}</a>`;
}
const tagsHtml = tags => (tags || []).map(docTag).join(' ');

/** 引用標籤（與正文中的 [[ID]] 同一外觀）。 */
function refChip(id, { label, lvl, state = 'ok' } = {}) {
  const name = label ?? nameOf(id);
  const href = id.startsWith('S-') ? `#subject/${id}` : id.startsWith('O-') ? `#object/${id}` : id.startsWith('DOC-') ? `#doc/${id}` : `#item/${id}`;
  return `<a class="ref ref-${esc(state)}" href="${href}" title="${esc(id)}">${name ? `<span class="ref-id">${esc(id)}</span>${esc(name)}` : esc(id)}${lvl ? `<span class="ref-level lvl-${esc(lvl)}">${esc(lvl)}</span>` : ''}</a>`;
}

function fieldHtml(f, v) {
  if (isEmpty(v)) return '<span class="muted">—</span>';
  const list = Array.isArray(v) ? v : [v];
  if (['subject', 'subjects', 'object', 'objects', 'doc'].includes(f.type)) return list.map(id => refChip(id, { lvl: cache.subjects?.get(id)?.level })).join(' ');
  if (f.type === 'url') return list.map(u => (/^https?:\/\//i.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>` : esc(u))).join('<br>');
  if (f.type === 'enum' || f.type === 'enums') return list.map(x => esc(f.optionLabels?.[x] || x)).join(t('、'));
  if (f.type === 'longtext') return `<span class="pre-line">${esc(v)}</span>`;
  return esc(list.join(t('、')));
}
function fieldPlain(f, v) {
  if (isEmpty(v)) return '';
  const list = Array.isArray(v) ? v : [v];
  if (['subject', 'subjects', 'object', 'objects', 'doc'].includes(f.type)) return list.map(id => (nameOf(id) ? `${nameOf(id)} ${id}` : id)).join('; ');
  if (f.type === 'enum' || f.type === 'enums') return list.map(x => f.optionLabels?.[x] || x).join('; ');
  return list.join('; ');
}
function reviewCell(d) {
  if (!d.review?.nextAt) return '—';
  const cls = d.review.overdue ? 'red' : d.review.dueSoon ? 'amber' : '';
  const text = `${day(d.review.nextAt)}${d.review.everyDays ? t('（每 {n} 天）', { n: d.review.everyDays }) : ''}`;
  return cls ? `<span class="badge ${cls}">${esc(text)}</span>` : esc(text);
}
function impactBar(impact) {
  const lv = impact?.byLevel || {};
  const total = impact?.total || 0;
  const seg = ['L0', 'L1', 'L2'].map(k => (lv[k] ? `<i class="${k}" style="width:${(lv[k] / Math.max(1, total)) * 100}%"></i>` : '')).join('');
  return `<div class="impact-bar"><strong>${esc(t('{n} 條知識', { n: total }))}</strong><div class="bar">${seg}</div><small class="muted">${['L0', 'L1', 'L2'].filter(k => lv[k]).map(k => `${k} ${lv[k]}`).join(' · ') || '—'}</small></div>`;
}
function impactDesc(x) {
  const s = x.subject?.name || '';
  if (x.kind === 'binding') return `${s} · ${t('綁定')}`;
  if (x.kind === 'assertion') return `${s} · ${tv(x.type)}${t('：')}${x.content || ''}`;
  return `${x.from?.name || ''} –${tv(x.type, 'rel')}→ ${x.to?.name || ''}`;
}
function highlight(text, terms) {
  const list = [...new Set((terms || []).filter(Boolean))].sort((a, b) => b.length - a.length).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!list.length) return esc(text);
  return String(text ?? '').split(new RegExp(`(${list.join('|')})`, 'gi')).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}
const hrefOfDoc = (id, anchor) => `#doc/${id}${anchor ? `/${enc(anchor)}` : ''}`;
const problemLi = (p, i, interactive = false) => `<li class="lint-${esc(p.level)}"${interactive ? ` data-lint="${i}"` : ''}><span class="badge ${LINT_LEVEL[p.level]?.[0] || ''}">${esc(p.rule)} ${esc(t(LINT_LEVEL[p.level]?.[1] || p.level))}</span> <span>${esc(p.message)}</span>${p.section ? `<small class="muted"> · § ${esc(p.section)}</small>` : ''}${interactive && p.subjectId ? ` <button type="button" class="text-btn" data-link-subject="${esc(p.subjectId)}">${t('關聯')}</button>` : ''}</li>`;

/** 正文中 [[ID]] 的解析：優先用服務端給的 refs（帶層級和狀態），否則用本地快取的名稱。 */
function refResolver(refs = {}) {
  return id => {
    const r = refs[id];
    if (r) {
      const title = [id, r.title || r.label, r.level ? LEVEL_TEXT[r.level] : null, r.state === 'e1' ? t('已失效') : r.state === 'missing' ? t('不存在') : null, r.replacedBy ? t('替代者 {id}', { id: r.replacedBy }) : null].filter(Boolean).join(' · ');
      return { label: r.label ? (r.kind === 'doc' ? `《${r.label}》` : r.label) : id, level: r.level || null, state: r.state, title };
    }
    const n = nameOf(id);
    if (n) return { label: n, level: cache.subjects?.get(id)?.level || null, state: cache.objects?.get(id)?.status === '下線' ? 'e1' : 'ok', title: id };
    if (/^(S|O)-/.test(id) && cache.subjects) return { label: id, state: 'missing', title: t('不存在') };
    return { label: id, state: 'ok', title: id };
  };
}
const assetUrlOf = id => name => `/api/v1/docs/${enc(id)}/assets/${enc(name)}`;

// ------------------------------------------------------------------ 標籤式輸入（標籤、主體、客體、文檔）
const chip = (v, ids) => `<span class="chip" data-v="${esc(v)}">${ids ? `<span class="mono">${esc(v)}</span>${nameOf(v) ? ` ${esc(nameOf(v))}` : ''}` : esc(v)}<button type="button" class="chip-x" aria-label="${esc(t('移除 {name}', { name: v }))}">×</button></span>`;
function chipBox(name, values = [], listId = '', { ids = false, max = 0, placeholder } = {}) {
  return `<div class="chips" data-chips="${esc(name)}"${ids ? ' data-ids="1"' : ''}${max ? ` data-max="${max}"` : ''}>${(values || []).map(v => chip(v, ids)).join('')}<input${listId ? ` list="${listId}"` : ''} placeholder="${esc(placeholder || t('輸入後按 Enter'))}" autocomplete="off"></div>`;
}
const chipValues = (root, name) => $$(`[data-chips="${CSS.escape(name)}"] .chip`, root).map(c => c.dataset.v);
function addChip(box, raw) {
  const ids = box.dataset.ids === '1';
  const max = Number(box.dataset.max) || 0;
  const field = box.querySelector('input');
  const vals = ids ? [...String(raw).matchAll(new RegExp(ID_RE.source, 'g'))].map(m => m[0]) : splitList(raw);
  for (const v of vals) {
    if ($$('.chip', box).some(c => c.dataset.v.toLowerCase() === v.toLowerCase())) continue;
    if (max === 1) $$('.chip', box).forEach(c => c.remove());
    field.insertAdjacentHTML('beforebegin', chip(v, ids));
  }
  field.value = '';
  box.dispatchEvent(new Event('chips-change', { bubbles: true }));
}
/** 不用 <label> 包住的欄位：裡面有多個可聚焦元素（標籤式輸入）時，label 會把點擊轉給第一個按鈕。 */
const boxField = (label, inner, hint = '') => `<div class="field box-field"><span class="field-label">${esc(label)}</span>${inner}${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
const tagDatalist = () => `<datalist id="tag-options">${(cache.tags?.tags || []).map(x => `<option value="${esc(x.name)}">`).join('')}</datalist>`;
const folderDatalist = () => `<datalist id="folder-options">${(cache.folders || []).map(f => `<option value="${esc(f.path)}">`).join('')}</datalist>`;
const objectDatalist = () => `<datalist id="object-options">${[...(cache.objects?.values() || [])].map(o => `<option value="${esc(o.id)} ${esc(o.name)}">`).join('')}</datalist>`;
const docDatalist = () => `<datalist id="doc-options">${[...(cache.docList?.values() || [])].map(d => `<option value="${esc(d.id)} ${esc(d.title)}">`).join('')}</datalist>`;

function bindGlobalInputs() {
  document.addEventListener('click', e => {
    const x = e.target.closest('.chip-x');
    if (!x) return;
    e.preventDefault();
    const box = x.closest('.chips');
    x.closest('.chip').remove();
    box?.dispatchEvent(new Event('chips-change', { bubbles: true }));
  });
  document.addEventListener('keydown', e => {
    const box = e.target.closest?.('.chips');
    if (!box || e.target.tagName !== 'INPUT') return;
    if ((e.key === 'Enter' || e.key === ',' || e.key === '，') && e.target.value.trim()) { e.preventDefault(); addChip(box, e.target.value); }
    else if (e.key === 'Backspace' && !e.target.value) { const last = $$('.chip', box).pop(); if (last) { last.remove(); box.dispatchEvent(new Event('chips-change', { bubbles: true })); } }
  });
  document.addEventListener('input', e => {
    const box = e.target.closest?.('.chips');
    if (!box || e.target.tagName !== 'INPUT') return;
    // 從 datalist 選中一項時直接加入
    const list = e.target.list;
    if (e.inputType === 'insertReplacementText' || (list && [...list.options].some(o => o.value === e.target.value))) addChip(box, e.target.value);
  });
  document.addEventListener('focusout', e => {
    const box = e.target.closest?.('.chips');
    if (box && e.target.tagName === 'INPUT' && e.target.value.trim()) addChip(box, e.target.value);
  });
}

// ------------------------------------------------------------------ 新建、導入、文件夾
/** 新建文檔對話框。preset：{ template, folder, domain, title, subjects, tags, fields, body, summary }。也供主體頁「為這個主體寫文檔」使用。 */
export async function openNewDoc(preset = {}) {
  await Promise.all([loadTemplates(), loadFolders(), loadLookups()]);
  let folder = preset.folder || '';
  if (!folder && preset.domain) {
    const name = ctx.schema()?.domains?.find(d => d.code === preset.domain)?.name;
    folder = (cache.folders.find(f => f.domain === preset.domain) || cache.folders.find(f => f.path === name))?.path || '';
  }
  const tplId = preset.template || folderSetting(folder, 'defaultTemplate') || 'TPL-0001';
  const groups = ['知識', '管理'].map(g => [g, cache.templates.filter(x => x.purpose === g)]).filter(([, l]) => l.length);
  const cards = groups.map(([g, list]) => `<fieldset class="tpl-pick"><legend>${esc(t('{purpose}文檔', { purpose: tv(g) }))}</legend>${list.map(x => `<label class="tpl-card"><input type="radio" name="template" value="${esc(x.id)}" ${x.id === tplId ? 'checked' : ''}><span><strong>${esc(x.label)}</strong><small>${esc(x.descriptionText || '')}</small><small class="muted">${esc(t(APPROVAL_TEXT[x.approval] || ''))}${x.reviewEveryDays ? ` · ${esc(t('每 {n} 天複審', { n: x.reviewEveryDays }))}` : ''}${x.immutable ? ` · ${esc(t('發布後不可修訂'))}` : ''}</small></span></label>`).join('')}</fieldset>`).join('');
  const takeable = [...cache.objects.values()].filter(o => o.category === '制度' && o.status !== '下線' && !o.docId);
  modal(preset.body ? t('複製為新文檔') : t('新建文檔'), `${folderDatalist()}
    ${cards}
    ${field(t('標題'), input('title', preset.title || '', `required maxlength="40" placeholder="${esc(t('寫明講的是什麼，例如「缺貨率口徑定義」'))}"`))}
    ${field(t('文件夾'), input('folder', folder, `list="folder-options" placeholder="${esc(t('留空則放在模板的預設文件夾'))}"`))}
    ${field(t('摘要（選填，發布時必填）'), textarea('summary', preset.summary || '', 'rows="2"'))}
    ${takeable.length && !preset.body ? `<details class="takeover"><summary>${t('接管已有的制度客體（選填）')}</summary><p class="muted">${t('已登記為客體的制度文檔（例如外部的口徑文檔）可以由文檔庫接管：不改客體的定位、不觸發降級，版本從你填的數字起算。')}</p><div class="field-pair">${field(t('客體'), select('takeOverObjectId', [['', '—'], ...takeable.map(o => [o.id, `${o.id} ${o.name}`])]))}${field(t('起始版本'), input('startVersion', '', 'type="number" min="1" max="999" placeholder="1"'))}</div></details>` : ''}`, {
    label: t('建立草稿'),
    run: async () => {
      const c = $('#dialog-content');
      const d = formData(c);
      const template = $('input[name=template]:checked', c)?.value || tplId;
      const tpl = tplOf(template);
      const fields = { ...(preset.fields || {}) };
      // 從主體頁進來時，把主體填進模板第一個可關聯的主體欄位（類型相符時）
      const sf = tpl?.fields.find(f => (f.type === 'subject' || f.type === 'subjects') && f.link);
      const s0 = preset.subjects?.[0] && cache.subjects.get(preset.subjects[0]);
      if (sf && s0 && isEmpty(fields[sf.key]) && (!sf.subjectTypes?.length || sf.subjectTypes.includes(s0.type))) fields[sf.key] = sf.type === 'subject' ? s0.id : [s0.id];
      const body = { template, title: d.title.trim(), folder: d.folder.trim() || undefined, summary: d.summary, subjects: preset.subjects, tags: preset.tags, fields: Object.keys(fields).length ? fields : undefined, body: preset.body };
      if (d.takeOverObjectId) Object.assign(body, { takeOverObjectId: d.takeOverObjectId, startVersion: d.startVersion || undefined });
      const r = await post('/api/v1/docs', body);
      cache.docList = null;
      toast(t('已建立草稿 {id}', { id: r.data.id }));
      location.hash = `doc-edit/${r.data.id}`;
    }
  });
}

function stripFrontMatter(text) {
  let s = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  s = s.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const m = /^\s*#\s+(.+)\n?/.exec(s);
  return { body: m ? s.slice(m[0].length).replace(/^\n+/, '') : s, title: m ? m[1].trim() : '' };
}

async function importDialog(folder) {
  await Promise.all([loadTemplates(), loadFolders()]);
  modal(t('導入 Markdown'), `${folderDatalist()}<p class="notice">${t('貼上或選擇 .md、.txt 檔案。第一行的「# 標題」會成為文檔標題；導入後在編輯器中按體檢結果補齊章節。')}</p>
    ${field(t('檔案'), '<input type="file" id="imp-file" accept=".md,.markdown,.txt,text/markdown,text/plain">')}
    ${field(t('內容'), textarea('body', '', 'id="imp-body" class="code" rows="10" required'))}
    ${field(t('標題'), input('title', '', 'id="imp-title" required maxlength="40"'))}
    <div class="field-pair">${field(t('模板'), select('template', tplOptions(), folderSetting(folder, 'defaultTemplate') || 'TPL-0001'))}${field(t('文件夾'), input('folder', folder || '', `list="folder-options" placeholder="${esc(t('留空則放在模板的預設文件夾'))}"`))}</div>`, {
    label: t('導入為草稿'),
    run: async () => {
      const d = formData($('#dialog-content'));
      const { body, title } = stripFrontMatter(d.body);
      const r = await post('/api/v1/docs', { template: d.template, title: d.title.trim() || title, folder: d.folder.trim() || undefined, body });
      cache.docList = null;
      toast(t('已導入為草稿 {id}', { id: r.data.id }));
      location.hash = `doc-edit/${r.data.id}`;
    }
  });
  const fill = text => {
    const { title } = stripFrontMatter(text);
    if (title && !$('#imp-title').value) $('#imp-title').value = title.slice(0, 40);
  };
  $('#imp-file').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 1024 * 1024) return toast(t('檔案超過 1 MB，請拆分成多篇文檔'));
    const text = await f.text();
    $('#imp-body').value = text;
    if (!$('#imp-title').value) $('#imp-title').value = (stripFrontMatter(text).title || f.name.replace(/\.[^.]+$/, '')).slice(0, 40);
  };
  $('#imp-body').addEventListener('change', e => fill(e.target.value));
}

function folderDialog({ folder = null, parent = '', onDone } = {}) {
  const f = folder ? cache.folders.find(x => x.path === folder) : null;
  const domains = ctx.schema()?.domains || [];
  modal(f ? t('文件夾設定 · {path}', { path: f.path }) : t('新建文件夾'), `${folderDatalist()}${tagDatalist()}
    ${field(f ? t('路徑（改這裡即重命名或移動，裡面的文檔一起移動，一次提交）') : t('路徑（用 / 分隔，最多 5 層）'), input('path', f ? f.path : parent ? `${parent}/` : '', 'required list="folder-options"'))}
    ${field(t('說明'), input('description', f?.description || ''))}
    <div class="field-pair">${field(t('預設模板'), select('defaultTemplate', [['', t('（沿用上層）')], ...tplOptions()], f?.defaultTemplate || ''))}${field(t('領域'), select('domain', [['', '—'], ...domains.map(d => [d.code, `${d.code} ${tv(d.name)}`])], f?.domain || ''))}</div>
    ${field(t('預設標籤（逗號分隔）'), input('defaultTags', (f?.defaultTags || []).join(', ')), t('在這個文件夾新建文檔時自動加上'))}
    ${isOwner() ? field(t('審閱人（金鑰 ID，逗號分隔）'), input('ownerIds', (f?.ownerIds || []).join(', ')), t('留空表示所有負責人都可以審閱；子文件夾沿用')) : ''}`, {
    label: f ? t('保存') : t('新建'),
    run: async () => {
      const d = formData($('#dialog-content'));
      const path = d.path.trim().replace(/^\/+|\/+$/g, '');
      const body = { description: d.description, defaultTemplate: d.defaultTemplate, domain: d.domain, defaultTags: splitList(d.defaultTags) };
      if (isOwner()) body.ownerIds = splitList(d.ownerIds);
      if (f) {
        const r = await patch('/api/v1/doc-folders', { path: f.path, ...(path !== f.path ? { newPath: path } : {}), ...body });
        toast(r.data.moved ? t('已移動到 {path}，{n} 篇文檔一起移動', { path: r.data.path, n: r.data.moved.docs }) : t('已保存'));
        onDone?.(r.data.path);
      } else {
        const r = await post('/api/v1/doc-folders', { path, ...body });
        toast(t('已新建文件夾 {path}', { path: r.data.path }));
        onDone?.(r.data.path);
      }
    }
  });
}

// ------------------------------------------------------------------ 文檔庫（三欄）
async function pageLibrary() {
  const p = hashParams();
  const st = {
    q: p.get('q') || '', folder: p.get('folder') || '', view: p.get('view') || '', template: p.get('template') || '', status: p.get('status') || '', tag: p.get('tag') || '',
    mode: p.get('mode') || local.get('docs.mode', 'list'), sub: local.get('docs.sub', true), sel: p.get('sel') || '', sort: null, dir: 1
  };
  const drafts = canWrite();
  const [tree] = await Promise.all([api('GET', '/api/v1/doc-folders'), loadTemplates(), loadTags(true), loadLookups()]);
  cache.folders = tree.data;
  const views = tree.views || {};
  const collapsed = new Set(local.get('docs.collapsed', []));
  const selected = new Set();
  let items = [];
  let unregistered = [];
  let terms = [];
  let seq = 0;

  setHeading(t('文檔'), t('知識倉庫中的 Markdown 文檔。文件夾就是 Git 目錄；內容走版本，整理即時生效。'), `${t('文檔庫')} › ${t('文檔')}${st.folder ? ` › ${st.folder.split('/').join(' › ')}` : ''}`);
  setActions(`<a class="button" id="docs-export" href="#">${t('導出 JSONL')}</a>${canWrite() ? `<button class="button" id="docs-import">${t('導入 Markdown')}</button><button class="button primary" id="docs-new">${t('+ 新建文檔')}</button>` : ''}`);
  const statusOptions = [['', t('不含已廢止')], ['all', t('全部（含已廢止）')], ...(drafts ? [['草稿', tv('草稿')], ['待審', tv('待審')]] : []), ['已發布', tv('已發布')], ['已廢止', tv('已廢止')]];
  content().innerHTML = `<div class="docs-layout" id="docs-root">
    <aside class="panel docs-nav" id="docs-nav" aria-label="${esc(t('智能視圖與文件夾'))}"></aside>
    <section class="panel docs-main">
      <div class="toolbar">
        <label class="grow"><input id="d-q" type="search" value="${esc(st.q)}" placeholder="${esc(t('搜索標題、正文、標籤，支持別名（如 ATP）'))}" aria-label="${esc(t('搜索'))}"></label>
        <label>${t('模板')} ${select('template', [['', t('全部')], ...cache.templates.map(x => [x.id, x.label])], st.template, 'id="d-tpl"')}</label>
        <label>${t('狀態')} ${select('status', statusOptions, st.status, 'id="d-status"')}</label>
        <label>${t('標籤')} ${select('tag', [['', t('全部')], ...cache.tags.tags.map(x => [x.name, t('{name}（{n}）', { name: x.name, n: x.count })])], st.tag, 'id="d-tag"')}</label>
        <div class="segmented" role="group" aria-label="${esc(t('顯示方式'))}">${[['list', t('列表')], ['ledger', t('台賬')]].map(([k, l]) => `<button type="button" data-mode="${k}" class="${st.mode === k ? 'active' : ''}" aria-pressed="${st.mode === k}">${l}</button>`).join('')}</div>
      </div>
      <div id="docs-suggest"></div>
      <div class="docs-crumb" id="docs-crumb"></div>
      <div id="docs-resolved"></div>
      <div id="docs-list"></div>
      <div class="docs-bulk" id="docs-bulk" hidden></div>
    </section>
    <aside class="panel docs-preview" id="docs-preview" aria-live="polite"></aside>
  </div>`;

  const syncUrl = () => {
    const q = qs({ q: st.q, folder: st.folder, view: st.view, template: st.template, status: st.status, tag: st.tag, mode: st.mode === 'list' ? '' : st.mode, sel: st.sel });
    history.replaceState(null, '', `#docs${q ? `?${q}` : ''}`);
    $('#docs-export').href = `/api/v1/docs/export?${qs({ format: 'jsonl', folder: st.folder, tags: st.tag, template: st.template })}`;
  };

  // ---- 左欄：智能視圖與文件夾樹
  function renderNav() {
    const viewRows = VIEWS.filter(([k]) => drafts || !DRAFT_VIEWS.includes(k)).map(([k, label]) => `<a href="#docs?view=${k}" class="docs-nav-row${st.view === k ? ' active' : ''}" data-view="${k}"${st.view === k ? ' aria-current="true"' : ''}><span class="nav-icon">${icon('list')}</span><span class="grow">${esc(t(label))}</span><small class="${views[k] && HOT_VIEWS.includes(k) ? 'hot' : ''}">${views[k] ?? 0}</small></a>`).join('');
    const kids = new Map();
    for (const f of cache.folders) {
      const k = f.parent || '';
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k).push(f);
    }
    const rows = [];
    const walk = parent => {
      for (const f of kids.get(parent) || []) {
        const has = kids.has(f.path);
        const open = !collapsed.has(f.path);
        rows.push(`<div class="docs-folder${st.folder === f.path && !st.view ? ' active' : ''}" data-folder="${esc(f.path)}" draggable="${canWrite()}" style="--depth:${f.depth - 1}" title="${esc(f.description || f.path)}">${has ? `<button type="button" class="caret${open ? ' open' : ''}" data-toggle="${esc(f.path)}" aria-expanded="${open}" aria-label="${esc(open ? t('收起 {name}', { name: f.name }) : t('展開 {name}', { name: f.name }))}">▸</button>` : '<span class="caret"></span>'}<a href="#docs?folder=${enc(f.path)}" data-folder-link="${esc(f.path)}" draggable="false"><span class="nav-icon">${icon('folder')}</span><span class="grow">${esc(f.name)}</span></a><small>${f.counts.total}</small></div>`);
        if (has && open) walk(f.path);
      }
    };
    walk('');
    $('#docs-nav').innerHTML = `<div class="docs-nav-section"><h3>${t('智能視圖')}</h3>${viewRows}</div>
      <div class="docs-nav-section"><h3 data-drop-root="1"><a href="#docs" data-folder-link="">${t('文件夾')}</a></h3>${rows.join('') || `<p class="muted">${t('還沒有文件夾')}</p>`}</div>
      ${canWrite() ? `<div class="docs-nav-foot"><button type="button" class="button" id="new-folder">${t('+ 新建文件夾')}</button></div>` : ''}`;
  }
  async function refreshTree() {
    const r = await api('GET', '/api/v1/doc-folders');
    cache.folders = r.data;
    Object.assign(views, r.views || {});
    renderNav();
  }

  // ---- 建議的初始文件夾（第一次打開時）
  function renderSuggest() {
    const box = $('#docs-suggest');
    const domains = ctx.schema()?.domains || [];
    const missing = domains.filter(d => !cache.folders.some(f => f.path === d.name));
    if (!canWrite() || me().kind !== 'human' || cache.folders.length > 2 || !missing.length || local.get('docs.skipSuggest')) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="notice docs-suggest">${esc(t('按領域建議一套初始文件夾：{list}。可以之後再改名或移動。', { list: missing.map(d => d.name).join(t('、')) }))} <button type="button" class="button" id="suggest-go">${t('建立')}</button> <button type="button" class="text-btn" id="suggest-skip">${t('跳過')}</button></div>`;
    $('#suggest-skip').onclick = () => { local.set('docs.skipSuggest', true); renderSuggest(); };
    $('#suggest-go').onclick = async e => {
      e.target.disabled = true;
      try {
        for (const d of missing) await post('/api/v1/doc-folders', { path: d.name, domain: d.code });
        toast(t('已建立 {n} 個文件夾', { n: missing.length }));
        await refreshTree();
        renderSuggest();
      } catch (err) { showError(err); e.target.disabled = false; }
    };
  }

  // ---- 中欄
  function renderCrumb() {
    const f = cache.folders.find(x => x.path === st.folder);
    const parts = st.folder ? st.folder.split('/') : [];
    const trail = st.view
      ? `<span class="nav-icon">${icon('list')}</span><strong>${esc(t(VIEWS.find(v => v[0] === st.view)?.[1] || st.view))}</strong>`
      : `<span class="nav-icon">${icon('folder')}</span><a href="#docs" data-folder-link="">${t('全部文檔')}</a>${parts.map((x, i) => ` › <a href="#docs?folder=${enc(parts.slice(0, i + 1).join('/'))}" data-folder-link="${esc(parts.slice(0, i + 1).join('/'))}">${esc(x)}</a>`).join('')}`;
    const defTpl = st.folder ? folderSetting(st.folder, 'defaultTemplate') : null;
    const meta = [st.view === 'unregistered' ? t('{n} 個檔案', { n: unregistered.length }) : t('{n} 篇', { n: items.length }), defTpl ? t('預設模板：{name}', { name: tplLabel(defTpl) }) : null, f?.description || null].filter(Boolean).map(esc).join(' · ');
    const ops = [];
    if (st.folder && !st.view) {
      ops.push(`<label class="check"><input type="checkbox" id="d-sub" ${st.sub ? 'checked' : ''}> ${t('含子文件夾')}</label>`);
      if (canWrite() && me().kind === 'human') ops.push(`<button type="button" class="text-btn" id="folder-sub">${t('新建子文件夾')}</button><button type="button" class="text-btn" id="folder-edit">${t('設定')}</button>`);
      if (isOwner()) ops.push(`<button type="button" class="text-btn danger-text" id="folder-del">${t('刪除')}</button>`);
    }
    if (st.mode === 'ledger' && st.view !== 'unregistered') ops.push(`<button type="button" class="button" id="ledger-csv">${t('導出 CSV')}</button>`);
    $('#docs-crumb').innerHTML = `<div class="docs-trail">${trail} <small class="muted">· ${meta}</small></div><div class="actions">${ops.join('')}</div>`;
  }

  function listTable() {
    const pick = canWrite();
    const head = `<tr>${pick ? `<th class="check-cell"><input type="checkbox" id="pick-all" aria-label="${esc(t('全選'))}" ${items.length && items.every(d => selected.has(d.id)) ? 'checked' : ''}></th>` : ''}<th>${t('文檔')}</th><th>${t('狀態')}</th><th>${t('標籤')}</th><th>${t('關聯主體')}</th><th>${t('負責人')}</th><th>${t('更新')}</th></tr>`;
    const rows = items.map(d => {
      const subj = d.subjects?.length ? `${esc(nameOf(d.subjects[0]) || d.subjects[0])}${d.subjects.length > 1 ? esc(t(' 等 {n} 個', { n: d.subjects.length })) : ''}` : '<span class="muted">—</span>';
      const match = d.match ? `<a class="doc-match" href="${hrefOfDoc(d.id, d.match.anchor)}"><b>§ ${esc(d.match.heading || t('前言'))}</b> ${highlight(d.match.snippet, terms)}</a>` : '';
      return `<tr data-id="${esc(d.id)}" class="${st.sel === d.id ? 'selected' : ''}" draggable="${pick && me().kind === 'human'}">${pick ? `<td class="check-cell"><input type="checkbox" data-pick="${esc(d.id)}" ${selected.has(d.id) ? 'checked' : ''} aria-label="${esc(t('選擇 {id}', { id: d.id }))}"></td>` : ''}<td class="wrap doc-cell"><a href="#doc/${esc(d.id)}" class="doc-title" draggable="false">${esc(d.title)}</a><span class="cell-sub">${esc(d.id)} · ${esc(d.templateInfo?.label || tplLabel(d.template))}${!d.version && d.createdBy ? ` · ${esc(who(d.createdBy))}` : ''}${st.folder !== d.folder ? ` · ${esc(d.folder)}` : ''}</span>${match}</td><td>${statusBadges(d)}</td><td class="wrap-sm">${tagsHtml(d.tags) || '<span class="muted">—</span>'}</td><td class="wrap-sm">${subj}</td><td>${esc(d.owner || '—')}</td><td title="${esc(fmtTime(d.updatedAt))}">${ago(d.updatedAt)}</td></tr>`;
    });
    const empty = st.q ? t('沒有找到相符的文檔。試試更短的詞，或勾選「全部（含已廢止）」。') : st.view ? t('這個視圖目前沒有文檔') : t('這裡還沒有文檔');
    return `<div class="table-scroll"><table class="docs-table"><thead>${head}</thead><tbody>${rows.join('') || `<tr><td colspan="7" class="empty-cell">${esc(empty)}</td></tr>`}</tbody></table></div>`;
  }

  function ledgerColumns(tpl) {
    return [
      { key: 'id', label: 'ID', get: d => d.id, html: d => idLink(d.id) },
      { key: 'title', label: t('標題'), get: d => d.title, html: d => `<a href="#doc/${esc(d.id)}">${esc(d.title)}</a>`, wrap: true },
      { key: 'status', label: t('狀態'), get: d => `${tv(d.status)}${d.version ? ` v${d.version}` : ''}${d.revision ? ` ${tv(d.revision)}` : ''}`, html: d => statusBadges(d, { review: false }) },
      ...tpl.fields.map(f => ({ key: `f:${f.key}`, label: f.labelText, get: d => fieldPlain(f, d.fields?.[f.key]), html: d => fieldHtml(f, d.fields?.[f.key]), wrap: f.type === 'longtext' })),
      { key: 'review', label: t('下次複審'), get: d => d.review?.nextAt || '', html: reviewCell },
      { key: 'owner', label: t('負責人'), get: d => d.owner || '', html: d => esc(d.owner || '—') },
      { key: 'updated', label: t('更新'), get: d => d.updatedAt || '', html: d => esc(fmtTime(d.updatedAt)) }
    ];
  }
  function ledgerTemplate() {
    if (st.template) return st.template;
    const def = st.folder ? folderSetting(st.folder, 'defaultTemplate') : null;
    if (def) return def;
    const used = [...new Set(items.map(d => d.template))];
    return used.length === 1 ? used[0] : null;
  }
  function ledgerTable() {
    const tplId = ledgerTemplate();
    const tpl = tplOf(tplId);
    if (!tpl) {
      const counts = {};
      for (const d of items) counts[d.template] = (counts[d.template] || 0) + 1;
      return `<div class="panel-body"><p class="notice">${t('台賬按模板顯示：每篇文檔一行，模板欄位就是列。請選一個模板：')}</p><div class="chip-row" style="margin-top:10px">${Object.entries(counts).map(([id, n]) => `<button type="button" class="button" data-ledger-tpl="${esc(id)}">${esc(tplLabel(id))}（${n}）</button>`).join('') || `<span class="muted">${t('這裡還沒有文檔')}</span>`}</div></div>`;
    }
    const cols = ledgerColumns(tpl);
    const rows = items.filter(d => d.template === tpl.id);
    if (st.sort) {
      const col = cols.find(c => c.key === st.sort);
      if (col) rows.sort((a, b) => String(col.get(a)).localeCompare(String(col.get(b)), undefined, { numeric: true }) * st.dir);
    }
    return `<div class="ledger-note muted">${esc(t('{name} 台賬 · {n} 篇', { name: tpl.label, n: rows.length }))}</div><div class="table-scroll"><table class="ledger"><thead><tr>${cols.map(c => `<th><button type="button" class="sort-btn" data-sort="${esc(c.key)}">${esc(c.label)}${st.sort === c.key ? (st.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}</tr></thead><tbody>${rows.map(d => `<tr data-id="${esc(d.id)}" class="${st.sel === d.id ? 'selected' : ''}">${cols.map(c => `<td${c.wrap ? ' class="wrap"' : ''}>${c.html(d)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="empty-cell">${t('沒有相符項目')}</td></tr>`}</tbody></table></div>`;
  }
  function exportLedger() {
    const tpl = tplOf(ledgerTemplate());
    if (!tpl) return toast(t('請先選擇模板'));
    const cols = ledgerColumns(tpl);
    const rows = items.filter(d => d.template === tpl.id);
    const cell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [cols.map(c => cell(c.label)).join(','), ...rows.map(d => cols.map(c => cell(c.get(d))).join(','))];
    download(`${tpl.id}-${day(new Date().toISOString())}.csv`, `﻿${lines.join('\r\n')}\r\n`, 'text/csv;charset=utf-8');
  }

  function unregisteredTable() {
    return table([t('檔案'), t('文件夾'), t('推測標題'), '#' + t('大小'), t('操作')], unregistered.map(u => `<tr><td class="mono wrap">${esc(u.path)}</td><td>${esc(u.folder || '—')}</td><td>${esc(u.title)}</td><td class="numeric">${Math.ceil(u.size / 1024)} KB</td><td>${me().kind === 'human' ? `<button type="button" class="text-btn" data-register="${esc(u.path)}">${t('登記')}</button>` : ''}</td></tr>`), t('沒有待登記的檔案：在 Git 中直接新增的 .md 如果沒有 front matter，會出現在這裡'));
  }

  function renderList() {
    renderCrumb();
    $('#docs-list').innerHTML = st.view === 'unregistered' ? unregisteredTable() : st.mode === 'ledger' ? ledgerTable() : listTable();
    renderBulk();
  }

  function renderBulk() {
    const el = $('#docs-bulk');
    for (const id of [...selected]) if (!items.some(d => d.id === id)) selected.delete(id);
    el.hidden = !selected.size || st.mode === 'ledger';
    if (el.hidden) return;
    el.innerHTML = `<span>${esc(t('已選 {n} 篇：', { n: selected.size }))}</span>${me().kind === 'human' ? `<button type="button" class="text-btn" data-bulk="folder">${t('移動到…')}</button>` : ''}<button type="button" class="text-btn" data-bulk="addTags">${t('加標籤')}</button><button type="button" class="text-btn" data-bulk="removeTags">${t('去標籤')}</button><button type="button" class="text-btn" data-bulk="addSubjects">${t('關聯主體')}</button>${isOwner() ? `<button type="button" class="text-btn" data-bulk="owner">${t('改負責人')}</button>` : ''}<button type="button" class="text-btn muted" data-bulk="clear">${t('取消選擇')}</button>`;
  }

  async function bulkDialog(kind) {
    const ids = [...selected];
    const titles = { folder: t('移動到文件夾'), addTags: t('加標籤'), removeTags: t('去標籤'), addSubjects: t('關聯主體'), owner: t('改負責人') };
    let inner;
    if (kind === 'folder') inner = folderDatalist() + field(t('目標文件夾'), input('value', st.folder, 'list="folder-options" required'));
    else if (kind === 'addTags' || kind === 'removeTags') inner = tagDatalist() + boxField(t('標籤'), chipBox('value', [], 'tag-options'));
    else if (kind === 'addSubjects') inner = (await ctx.subjectOptions()) + boxField(t('主體'), chipBox('value', [], 'subject-options', { ids: true }));
    else inner = field(t('負責人'), input('value', '', 'required'));
    modal(`${titles[kind]} · ${t('{n} 篇', { n: ids.length })}`, `<p class="notice">${t('一次操作一次 Git 提交；不改文檔版本。')}</p>${inner}`, {
      label: t('確定'),
      run: async () => {
        const c = $('#dialog-content');
        const value = ['addTags', 'removeTags', 'addSubjects'].includes(kind) ? chipValues(c, 'value') : $('[name=value]', c).value.trim();
        if (isEmpty(value)) throw new Error(t('請填寫內容'));
        const r = await post('/api/v1/docs/bulk', { ids, [kind]: value });
        toast(t('已更新 {n} 篇', { n: r.data.changed }));
        selected.clear();
        if (kind === 'folder') await refreshTree();
        await loadList();
      }
    });
  }

  async function renderPreview() {
    const box = $('#docs-preview');
    const id = st.sel;
    if (!id || !items.some(d => d.id === id)) { box.innerHTML = `<div class="panel-body docs-preview-empty"><span class="nav-icon">${icon('doc')}</span><p class="muted">${t('點選一篇文檔，在這裡看摘要、欄位、依據它的知識和目錄。')}</p></div>`; return; }
    box.innerHTML = `<div class="panel-body muted">${t('載入中…')}</div>`;
    try {
      const d = await get(`/api/v1/docs/${enc(id)}`);
      if (st.sel !== id) return;
      const tpl = tplOf(d.template);
      const toc = parseSections(d.body).filter(s => s.level && s.level <= 3);
      box.innerHTML = `<div class="panel-body docs-preview-body">
        <div class="chip-row">${idLink(d.id)} ${statusBadges(d)}</div>
        <h2 class="preview-title">${esc(d.title)}</h2>
        ${d.summary ? `<p class="muted preview-summary">${esc(d.summary)}</p>` : ''}
        <dl class="kv">
          <dt>${t('模板')}</dt><dd>${esc(tpl?.label || d.template)}${tpl ? `（${esc(tv(tpl.purpose))}）` : ''}</dd>
          ${(tpl?.fields || []).filter(f => !isEmpty(d.fields?.[f.key])).map(f => `<dt>${esc(f.labelText)}</dt><dd>${fieldHtml(f, d.fields[f.key])}</dd>`).join('')}
          ${d.review?.nextAt ? `<dt>${t('下次複審')}</dt><dd>${reviewCell(d)}</dd>` : ''}
          <dt>${t('負責人')}</dt><dd>${esc(d.owner || '—')}</dd>
          <dt>${t('文件夾')}</dt><dd>${esc(d.folder)}</dd>
        </dl>
        ${d.object ? `<h3>${t('以本文檔為依據')}</h3><a class="impact-box" href="#doc/${esc(d.id)}">${impactBar(d.impact)}</a>` : ''}
        ${toc.length ? `<h3>${t('目錄')}</h3><ol class="toc">${toc.map(s => `<li class="toc-${s.level}"><a href="${hrefOfDoc(d.id, s.anchor)}">${esc(s.heading)}</a></li>`).join('')}</ol>` : ''}
        <div class="actions"><a class="button primary" href="#doc/${esc(d.id)}">${t('打開')}</a>${d.revision ? `<a class="button" href="#doc/${esc(d.id)}?diff=draft">${t('查看修訂差異')}</a>` : ''}</div>
      </div>`;
    } catch (err) { box.innerHTML = `<div class="panel-body"><p class="notice warn">${esc(err.message)}</p></div>`; }
  }

  async function loadList() {
    const mine = ++seq;
    const status = st.status === 'all' ? '' : st.status;
    const r = await api('GET', `/api/v1/docs?${qs({ q: st.q, folder: st.folder, view: st.view, template: st.template, status, tags: st.tag, drafts: drafts ? '1' : '', obsolete: st.status === 'all' || st.status === '已廢止' ? '1' : '', limit: 500 })}`);
    if (mine !== seq) return;
    items = r.data;
    terms = r.terms || [];
    unregistered = r.unregistered || [];
    if (st.folder && !st.sub && !st.view) items = items.filter(d => d.folder === st.folder);
    const res = r.resolved;
    $('#docs-resolved').innerHTML = res && (res.canonical?.length || res.ambiguous?.length) ? `<p class="notice docs-resolved">${res.canonical?.length ? esc(t('已把查詢中的術語解析為：{list}；關聯了這些主體的文檔排在前面。', { list: res.canonical.map(id => `${nameOf(id) || id}（${id}）`).join(t('、')) })) : ''}${res.ambiguous?.length ? ` ${esc(t('多義：{list}', { list: res.ambiguous.map(a => `${a.term} → ${a.candidates.map(c => nameOf(c) || c).join(' / ')}`).join(t('；')) }))}` : ''}</p>` : '';
    renderList();
    renderPreview();
  }

  // ---- 事件
  const root = $('#docs-root');
  root.addEventListener('click', async e => {
    const viewLink = e.target.closest('[data-view]');
    const folderLink = e.target.closest('[data-folder-link]');
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      e.preventDefault();
      const f = toggle.dataset.toggle;
      if (collapsed.has(f)) collapsed.delete(f); else collapsed.add(f);
      local.set('docs.collapsed', [...collapsed]);
      return renderNav();
    }
    if (viewLink) {
      e.preventDefault();
      st.view = st.view === viewLink.dataset.view ? '' : viewLink.dataset.view;
      st.folder = '';
      selected.clear();
      syncUrl(); renderNav(); return loadList().catch(showError);
    }
    if (folderLink) {
      e.preventDefault();
      st.folder = folderLink.dataset.folderLink;
      st.view = '';
      selected.clear();
      setHeading(t('文檔'), t('知識倉庫中的 Markdown 文檔。文件夾就是 Git 目錄；內容走版本，整理即時生效。'), `${t('文檔庫')} › ${t('文檔')}${st.folder ? ` › ${st.folder.split('/').join(' › ')}` : ''}`);
      syncUrl(); renderNav(); return loadList().catch(showError);
    }
    const b = e.target.closest('button');
    if (b?.dataset.mode) {
      st.mode = b.dataset.mode;
      local.set('docs.mode', st.mode);
      $$('[data-mode]', root).forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      syncUrl(); return renderList();
    }
    if (b?.dataset.sort) { st.dir = st.sort === b.dataset.sort ? -st.dir : 1; st.sort = b.dataset.sort; return renderList(); }
    if (b?.dataset.ledgerTpl) { st.template = b.dataset.ledgerTpl; $('#d-tpl').value = st.template; syncUrl(); return loadList().catch(showError); }
    if (b?.dataset.bulk) { if (b.dataset.bulk === 'clear') { selected.clear(); return renderList(); } return bulkDialog(b.dataset.bulk).catch(showError); }
    if (b?.dataset.register) return registerDialog(unregistered.find(u => u.path === b.dataset.register));
    if (b?.id === 'new-folder') return folderDialog({ parent: st.folder, onDone: async path => { await refreshTree(); st.folder = path; st.view = ''; syncUrl(); renderNav(); loadList(); } });
    if (b?.id === 'folder-sub') return folderDialog({ parent: st.folder, onDone: async path => { await refreshTree(); st.folder = path; syncUrl(); renderNav(); loadList(); } });
    if (b?.id === 'folder-edit') return folderDialog({ folder: st.folder, onDone: async path => { await refreshTree(); st.folder = path; syncUrl(); renderNav(); loadList(); } });
    if (b?.id === 'folder-del') return modal(t('刪除文件夾 {path}', { path: st.folder }), `<p class="notice warn">${t('只能刪除空文件夾。文件夾裡有文檔時，請先移走或廢止。')}</p>`, { label: t('確認刪除'), run: async () => { await del(`/api/v1/doc-folders?path=${enc(st.folder)}`); toast(t('已刪除')); st.folder = st.folder.includes('/') ? st.folder.slice(0, st.folder.lastIndexOf('/')) : ''; await refreshTree(); syncUrl(); loadList(); } });
    if (b?.id === 'ledger-csv') return exportLedger();
    if (b?.id === 'pick-all' || e.target.id === 'pick-all') return;
    const row = e.target.closest('tr[data-id]');
    if (row && !e.target.closest('a, input, button')) {
      st.sel = row.dataset.id;
      $$('tr[data-id]', root).forEach(r => r.classList.toggle('selected', r === row));
      syncUrl(); renderPreview();
    }
  });
  root.addEventListener('change', e => {
    if (e.target.dataset.pick) { if (e.target.checked) selected.add(e.target.dataset.pick); else selected.delete(e.target.dataset.pick); const all = $('#pick-all'); if (all) all.checked = items.length > 0 && items.every(d => selected.has(d.id)); return renderBulk(); }
    if (e.target.id === 'pick-all') { for (const d of items) if (e.target.checked) selected.add(d.id); else selected.delete(d.id); $$('[data-pick]', root).forEach(x => (x.checked = e.target.checked)); return renderBulk(); }
    if (e.target.id === 'd-sub') { st.sub = e.target.checked; local.set('docs.sub', st.sub); return loadList().catch(showError); }
    const map = { 'd-tpl': 'template', 'd-status': 'status', 'd-tag': 'tag' };
    if (map[e.target.id]) { st[map[e.target.id]] = e.target.value; syncUrl(); loadList().catch(showError); }
  });
  let timer;
  $('#d-q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { st.q = $('#d-q').value.trim(); syncUrl(); loadList().catch(showError); }, 250); };

  // 拖曳：文檔拖到文件夾即移動；文件夾拖到另一個文件夾即移入（拖到「文件夾」標題移到最上層）
  root.addEventListener('dragstart', e => {
    const row = e.target.closest?.('tr[data-id]');
    const folder = e.target.closest?.('[data-folder]');
    if (row) {
      const ids = selected.has(row.dataset.id) ? [...selected] : [row.dataset.id];
      e.dataTransfer.setData('application/x-doc-ids', JSON.stringify(ids));
      e.dataTransfer.setData('text/plain', ids.join(' '));
      e.dataTransfer.effectAllowed = 'move';
    } else if (folder) {
      e.dataTransfer.setData('application/x-doc-folder', folder.dataset.folder);
      e.dataTransfer.setData('text/plain', folder.dataset.folder);
      e.dataTransfer.effectAllowed = 'move';
    }
  });
  const dropTarget = e => e.target.closest?.('[data-folder], [data-drop-root]');
  root.addEventListener('dragover', e => {
    const target = dropTarget(e);
    if (!target) return;
    const types = [...e.dataTransfer.types];
    if (!types.includes('application/x-doc-ids') && !types.includes('application/x-doc-folder')) return;
    if (target.dataset.dropRoot && !types.includes('application/x-doc-folder')) return;
    e.preventDefault();
    target.classList.add('drop');
  });
  root.addEventListener('dragleave', e => dropTarget(e)?.classList.remove('drop'));
  root.addEventListener('drop', async e => {
    const target = dropTarget(e);
    if (!target) return;
    e.preventDefault();
    target.classList.remove('drop');
    const to = target.dataset.folder || '';
    const ids = e.dataTransfer.getData('application/x-doc-ids');
    const folder = e.dataTransfer.getData('application/x-doc-folder');
    try {
      if (ids && to) {
        const list = JSON.parse(ids);
        if (list.length === 1) await patch(`/api/v1/docs/${enc(list[0])}`, { folder: to });
        else await post('/api/v1/docs/bulk', { ids: list, folder: to });
        toast(t('已移動 {n} 篇到「{folder}」', { n: list.length, folder: to }));
        selected.clear();
      } else if (folder) {
        const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
        if (to === folder || to.startsWith(`${folder}/`) || to === parent) return;
        const newPath = to ? `${to}/${folder.split('/').pop()}` : folder.split('/').pop();
        const r = await patch('/api/v1/doc-folders', { path: folder, newPath });
        toast(t('已移動到 {path}，{n} 篇文檔一起移動', { path: r.data.path, n: r.data.moved?.docs ?? 0 }));
        if (st.folder === folder || st.folder.startsWith(`${folder}/`)) st.folder = newPath + st.folder.slice(folder.length);
        syncUrl();
      } else return;
      await refreshTree();
      await loadList();
    } catch (err) { showError(err); }
  });

  const registerDialog = u => {
    if (!u) return;
    modal(t('登記文檔 · {path}', { path: u.path }), `${folderDatalist()}<p class="notice">${t('補上 front matter、分配文檔 ID，作為草稿進入流程；原檔案移到草稿區。一次提交。')}</p>
      ${field(t('標題'), input('title', u.title.slice(0, 40), 'required maxlength="40"'))}
      <div class="field-pair">${field(t('模板'), select('template', tplOptions(), folderSetting(u.folder, 'defaultTemplate') || 'TPL-0001'))}${field(t('文件夾'), input('folder', u.folder || '通用', 'list="folder-options"'))}</div>`, {
      label: t('登記'),
      run: async () => { const r = await post('/api/v1/docs/register', { path: u.path, ...formData($('#dialog-content')) }); toast(t('已登記為 {id}', { id: r.data.id })); location.hash = `doc-edit/${r.data.id}`; }
    });
  };

  $('#docs-new')?.addEventListener('click', () => openNewDoc({ folder: st.folder }).catch(showError));
  $('#docs-import')?.addEventListener('click', () => importDialog(st.folder).catch(showError));
  syncUrl();
  renderNav();
  renderSuggest();
  await loadList();
}

// ------------------------------------------------------------------ 文檔頁
function timelineHtml(d, history, { compact = false } = {}) {
  const items = [];
  if (d.draft) items.push(`<li class="tl-draft"><strong>${esc(t('v{v} 草稿', { v: d.nextVersion }))} · ${esc(tv(d.revision || d.draft.status))}</strong><span class="cell-sub">${esc(who(d.draft.updatedBy))} · ${ago(d.draft.updatedAt)}</span>${compact ? '' : ` <a class="text-btn" href="#doc/${esc(d.id)}?draft=1">${t('查看')}</a>`}</li>`);
  const firstVersion = Math.min(...history.versions.map(v => Number(v.version)));
  for (const ev of history.events) {
    if (ev.type === 'publish') {
      const kind = Number(ev.version) === firstVersion ? t('首次發布') : ev.major ? t('重大修訂') : t('小修');
      items.push(`<li class="tl-publish"><strong>v${esc(ev.version)} · ${esc(kind)}</strong>${ev.note ? ` ${esc(ev.note)}` : ''}<span class="cell-sub">${esc(t('{who} 發布', { who: ev.publishedBy ? who(ev.publishedBy) : td(ev.author) }))} · ${esc(fmtTime(ev.date))}${ev.fromGit ? ` · ${esc(t('確認 Git 中的修改'))}` : ''}</span>${compact ? '' : `<span class="tl-ops"><a class="text-btn" href="#doc/${esc(d.id)}?version=${esc(ev.version)}">${t('查看此版本')}</a>${Number(ev.version) !== firstVersion ? `<button type="button" class="text-btn" data-diff-to="${esc(ev.version)}">${t('與上一版比較')}</button>` : ''}</span>`}</li>`);
      continue;
    }
    const detail = ev.type === 'move' ? `${ev.from} → ${ev.to}` : ev.type === 'rename' ? `${ev.from} → ${ev.to}` : ev.type === 'tags' ? [...(ev.added || []).map(x => `+${x}`), ...(ev.removed || []).map(x => `−${x}`)].join(' ') : ev.type === 'review' ? t('下次複審 {date}', { date: day(ev.nextAt) }) : ev.type === 'obsolete' ? td(ev.reason) || '' : '';
    items.push(`<li class="tl-${esc(ev.type)}"><strong>${esc(t(EVENT_TEXT[ev.type] || ev.type))}</strong>${detail ? ` ${esc(detail)}` : ''}<span class="cell-sub">${esc(td(ev.author))} · ${esc(fmtTime(ev.date))}</span></li>`);
  }
  return `<ul class="timeline doc-timeline">${items.join('') || `<li>${t('還沒有發布過')}</li>`}</ul>`;
}

const metaVal = v => (isEmpty(v) ? '—' : Array.isArray(v) ? v.join(t('、')) : String(v));
function diffHtml(x, tpl) {
  const fieldLabel = k => tpl?.fields.find(f => f.key === k)?.labelText || k;
  const meta = [...x.meta.map(m => [t(META_TEXT[m.key] || m.key), m.from, m.to]), ...x.fields.map(f => [fieldLabel(f.key), f.from, f.to])];
  const sec = x.sections.filter(s => s.change !== 'unchanged');
  return `<div class="diff-head"><strong>${esc(x.from.label)} → ${esc(x.to.label)}</strong> <span class="diff-add">+${x.stats.added}</span> <span class="diff-del">−${x.stats.removed}</span></div>
    ${meta.length ? `<div class="table-scroll"><table class="diff-meta"><thead><tr><th>${t('項目')}</th><th>${esc(x.from.label)}</th><th>${esc(x.to.label)}</th></tr></thead><tbody>${meta.map(([k, a, b]) => `<tr><td>${esc(k)}</td><td class="wrap"><del>${esc(metaVal(a))}</del></td><td class="wrap"><ins>${esc(metaVal(b))}</ins></td></tr>`).join('')}</tbody></table></div>` : ''}
    ${sec.length ? `<div class="chip-row diff-sections">${sec.map(s => `<span class="badge ${s.change === 'added' ? 'green' : s.change === 'removed' ? 'red' : 'amber'}">${esc(t(CHANGE_TEXT[s.change]))} ${esc(s.heading || t('前言'))}</span>`).join(' ')}</div>` : ''}
    ${x.hunks.length ? x.hunks.map(h => `<div class="diff"><div class="dl hunk">${esc(h.header)}</div>${h.lines.map(l => `<div class="dl${l.op === '+' ? ' add' : l.op === '-' ? ' del' : ''}"><span class="ln">${l.a ?? ''}</span><span class="ln">${l.b ?? ''}</span><span class="op">${esc(l.op)}</span>${esc(l.text) || ' '}</div>`).join('')}</div>`).join('') : `<p class="muted">${t('正文沒有變化')}</p>`}`;
}

function historyDialog(d, history, { diff } = {}) {
  const tpl = tplOf(d.template);
  const opts = [...(d.draft && canWrite() ? [['draft', t('修訂草稿')]] : []), ...history.versions.map(v => [String(v.version), `v${v.version}`])];
  const canDiff = canWrite() && opts.length > 1;
  const cur = history.versions[0] ? String(history.versions[0].version) : null;
  const to0 = diff ? String(diff) : d.draft && canWrite() ? 'draft' : cur;
  // 版本號不一定連續（接管時從 v3 起算），上一版按歷史列表找
  const prevOf = v => { const i = history.versions.findIndex(x => String(x.version) === String(v)); return i >= 0 && history.versions[i + 1] ? String(history.versions[i + 1].version) : null; };
  const from0 = to0 === 'draft' ? cur : prevOf(to0);
  modal(t('歷史與差異 · {id}', { id: d.id }), `<div id="hist-root">${canDiff ? `<div class="inline-form diff-pick">${field(t('從'), select('from', opts, from0 && opts.some(o => o[0] === from0) ? from0 : to0))}${field(t('到'), select('to', opts, to0))}<button type="button" class="button" id="diff-go">${t('比較')}</button></div><div id="diff-out" class="diff-out"></div>` : ''}<h3 class="dialog-h">${t('時間線')}</h3>${timelineHtml(d, history)}${history.events.length >= 100 ? `<p class="muted">${t('只顯示最近 100 個提交；更早的請在 Git 中查看。')}</p>` : ''}</div>`);
  const show = async () => {
    const out = $('#diff-out');
    if (!out) return;
    const from = $('#dialog-content [name=from]').value;
    const to = $('#dialog-content [name=to]').value;
    if (from === to) { out.innerHTML = `<p class="notice">${esc(to !== 'draft' && !prevOf(to) ? t('v{v} 是第一個發布的版本，沒有更早的版本可比較。', { v: to }) : t('請選擇兩個不同的版本。'))}</p>`; return; }
    out.innerHTML = `<p class="muted">${t('載入中…')}</p>`;
    try { out.innerHTML = diffHtml(await get(`/api/v1/docs/${enc(d.id)}/diff?${qs({ from, to })}`), tpl); } catch (err) { out.innerHTML = `<p class="notice warn">${esc(err.message)}</p>`; }
  };
  $('#diff-go')?.addEventListener('click', show);
  $('#hist-root').addEventListener('click', e => {
    const b = e.target.closest('[data-diff-to]');
    if (!b || !$('#diff-out')) return;
    $('#dialog-content [name=to]').value = b.dataset.diffTo;
    $('#dialog-content [name=from]').value = prevOf(b.dataset.diffTo) || b.dataset.diffTo;
    show();
    $('#diff-out').scrollIntoView({ block: 'start' });
  });
  if (canDiff && (diff || to0)) show();
}

async function publishDialog(d, { confirmGitEdit = false } = {}) {
  const [draft, impact] = await Promise.all([confirmGitEdit || !d.draft ? null : get(`/api/v1/docs/${enc(d.id)}?draft=1`), get(`/api/v1/docs/${enc(d.id)}/impact`)]);
  const problems = draft?.problems || (d.side === 'draft' ? d.problems || [] : []);
  const errors = problems.filter(x => x.level === 'error');
  const first = !d.version;
  const next = confirmGitEdit ? Number(d.version) + 1 : d.nextVersion;
  const groups = new Map();
  for (const x of impact.items) {
    const k = x.subject ? `${x.subject.name} ${x.subject.id}` : '—';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const impactHtml = impact.items.length ? `<div class="impact-head"><span>${esc(t('以本文檔為依據的知識（{n}）', { n: impact.items.length }))} · ${esc(t('已勾選'))} <b id="pub-count">0</b></span> <button type="button" class="text-btn" data-all="1">${t('全選')}</button> <button type="button" class="text-btn" data-all="0">${t('全不選')}</button></div>${[...groups].map(([k, list]) => `<div class="impact-group"><h4>${esc(k)}</h4>${list.map(x => `<label class="impact-pick"><input type="checkbox" name="affect" value="${esc(x.id)}"><span class="mono">${esc(x.id)}</span><span class="grow">${esc(impactDesc(x))}</span>${level(x.level)}</label>`).join('')}</div>`).join('')}` : '';
  const bindHtml = impact.bindable.length ? `<h3 class="dialog-h">${t('關聯了、但還沒有以本文檔為依據的主體')}</h3>${impact.bindable.map(s => `<label class="check"><input type="checkbox" name="bind" value="${esc(s.id)}"> ${esc(t('為「{name} {id}」建立綁定（L1，之後由負責人確認或校驗到 L0）', { name: s.name, id: s.id }))}</label>`).join('')}` : '';
  modal(t('審閱並發布 {id} v{v}', { id: d.id, v: next }), `<div id="pub-root">
    <div class="lint-line">${errors.length ? pill(t('體檢未通過'), 'red') : pill(t('體檢通過'), 'green')} <span class="muted">${esc(t('{e} 個錯誤 · {w} 個提醒', { e: errors.length, w: problems.length - errors.length }))}</span></div>
    ${problems.length ? `<ul class="lint-list compact">${problems.slice(0, 8).map(p => problemLi(p)).join('')}</ul>` : ''}
    ${!first && !confirmGitEdit ? `<details class="pub-diff" id="pub-diff"><summary>${t('查看本次差異')}</summary><div id="pub-diff-body"><p class="muted">${t('載入中…')}</p></div></details>` : ''}
    ${first ? `<p class="notice">${t('首次發布：登記或寫回制度客體，文檔從此可以作為主體的依據和斷言的證據。')}</p>` : `<h3 class="dialog-h">${t('這次修訂屬於')}</h3><div class="radio-cards"><label class="radio-card"><input type="radio" name="major" value="0" checked><span><strong>${t('小修')}</strong><small>${t('錯字、措辭、補示例，不影響含義。依賴它的知識保持不變。')}</small></span></label><label class="radio-card"><input type="radio" name="major" value="1"><span><strong>${t('重大修訂')}</strong><small>${t('改了口徑、規則或步驟。勾選的知識降為 L1 並排入重驗。')}</small></span></label></div>`}
    ${field(t('版本說明'), input('note', '', `maxlength="200" placeholder="${esc(t('這一版改了什麼'))}"`))}
    ${impactHtml}
    ${bindHtml}
    <p class="notice warn" id="pub-summary"></p>
    ${d.draft?.status === '待審' && isReviewer(d) && !confirmGitEdit ? `<div class="dialog-inline-actions"><button type="button" class="button" id="pub-reject">${t('退回修改')}</button></div>` : ''}</div>`, {
    label: t('發布 v{v}', { v: next }),
    run: async () => {
      const c = $('#pub-root');
      const body = { major: $('[name=major]:checked', c)?.value === '1', note: $('[name=note]', c).value, affect: $$('[name=affect]:checked', c).map(x => x.value), bindSubjects: $$('[name=bind]:checked', c).map(x => x.value) };
      if (confirmGitEdit) body.confirmGitEdit = true;
      const r = await post(`/api/v1/docs/${enc(d.id)}/publish`, body);
      const x = r.data;
      cache.docList = null;
      toast(x.first ? t('已發布 {id} v{v}；客體 {obj}', { id: x.id, v: x.version, obj: x.objectId }) : t('已發布 {id} v{v}：{l0} 條 L0 降為 L1，{n} 條排入重驗', { id: x.id, v: x.version, l0: x.demoted, n: x.queued }), 6000);
      go(`doc/${x.id}`);
    }
  });
  const c = $('#pub-root');
  const update = () => {
    const major = $('[name=major]:checked', c)?.value === '1';
    const picked = $$('[name=affect]:checked', c).map(x => x.value);
    const l0 = picked.filter(id => impact.items.find(x => x.id === id)?.level === 'L0').length;
    const binds = $$('[name=bind]:checked', c).length;
    if ($('#pub-count')) $('#pub-count').textContent = picked.length;
    $('#pub-summary').textContent = [
      first ? t('發布後：v{v} 成為第一個已發布版本。', { v: next }) : t('發布後：v{v} 成為當前版本（{kind}）。', { v: next, kind: major ? t('重大修訂') : t('小修') }),
      picked.length ? t('{l0} 條 L0 降為 L1，{n} 條排入重驗（原因：客體已變化）。', { l0, n: picked.length }) : t('依賴它的知識不變。'),
      binds ? t('新建 {n} 個綁定。', { n: binds }) : '',
      t('一次 Git 提交。')
    ].filter(Boolean).join(' ');
  };
  c.addEventListener('change', e => {
    if (e.target.name === 'major') $$('[name=affect]', c).forEach(x => (x.checked = e.target.value === '1'));
    update();
  });
  c.addEventListener('click', e => {
    const all = e.target.closest('[data-all]');
    if (all) { $$('[name=affect]', c).forEach(x => (x.checked = all.dataset.all === '1')); update(); }
    if (e.target.id === 'pub-reject') rejectDialog(d);
  });
  $('#pub-diff')?.addEventListener('toggle', async e => {
    if (!e.target.open || e.target.dataset.loaded) return;
    e.target.dataset.loaded = '1';
    try { $('#pub-diff-body').innerHTML = diffHtml(await get(`/api/v1/docs/${enc(d.id)}/diff`), tplOf(d.template)); } catch (err) { $('#pub-diff-body').innerHTML = `<p class="notice warn">${esc(err.message)}</p>`; }
  });
  update();
}

function rejectDialog(d) {
  modal(t('退回修改 · {id}', { id: d.id }), `<p class="notice">${t('退回後草稿回到「草稿」狀態，作者在文檔頁和編輯器裡看到你的意見。')}</p>${field(t('意見'), textarea('note', '', 'required'))}`, {
    label: t('退回'),
    run: async () => { await post(`/api/v1/docs/${enc(d.id)}/reject`, formData($('#dialog-content'))); toast(t('已退回')); go(`doc/${d.id}`); }
  });
}

async function obsoleteDialog(d) {
  const [impact] = await Promise.all([get(`/api/v1/docs/${enc(d.id)}/impact`), loadDocList(true)]);
  const bindings = impact.items.filter(x => x.kind === 'binding').length;
  const others = impact.items.length - bindings;
  const candidates = [...cache.docList.values()].filter(x => x.id !== d.id && x.status === '已發布');
  modal(t('廢止 {id}', { id: d.id }), `<p class="notice warn">${esc(t('廢止後文檔仍可閱讀，但不能再修訂。它的客體 {obj} 下線：{b} 個綁定轉為 E1，{n} 條以它為證據的知識降為 L1 並排入重驗。', { obj: d.objectId || '—', b: bindings, n: others }))}</p>
    ${field(t('廢止原因'), textarea('reason', '', 'required'))}
    ${field(t('替代文檔（選填）'), select('replacedBy', [['', '—'], ...candidates.map(x => [x.id, `${x.id} ${x.title}`])]))}`, {
    label: t('確認廢止'),
    run: async () => {
      const r = await post(`/api/v1/docs/${enc(d.id)}/obsolete`, formData($('#dialog-content')));
      toast(t('{id} 已廢止；{b} 個綁定轉為 E1，{n} 條知識降為 L1', { id: d.id, b: r.data.affected?.bindings?.length || 0, n: r.data.affected?.demoted?.length || 0 }), 6000);
      cache.docList = null;
      go(`doc/${d.id}`);
    }
  });
}

async function organizeDialog(d) {
  await Promise.all([loadFolders(), loadDocList(), loadTags()]);
  const opts = await ctx.subjectOptions();
  const reviewer = isReviewer(d);
  modal(t('標籤與關聯 · {id}', { id: d.id }), `${opts}${tagDatalist()}${objectDatalist()}${docDatalist()}${folderDatalist()}
    <p class="notice">${t('整理即時生效，不改版本號；已發布版本和修訂草稿一起改。')}</p>
    ${boxField(t('標籤'), chipBox('tags', d.tags, 'tag-options'))}
    ${boxField(t('關聯主體'), chipBox('subjects', d.subjects, 'subject-options', { ids: true }))}
    ${boxField(t('涉及的客體'), chipBox('objects', d.objects, 'object-options', { ids: true }))}
    ${boxField(t('相關文檔'), chipBox('related', d.related, 'doc-options', { ids: true }))}
    ${me().kind === 'human' ? field(t('文件夾（改這裡即移動）'), input('folder', d.folder, 'list="folder-options"')) : ''}
    ${reviewer ? `<div class="field-pair">${field(t('負責人'), input('owner', d.owner || ''))}${field(t('審閱人（金鑰 ID，逗號分隔）'), input('ownerIds', (d.ownerIds || []).join(', ')))}</div>` : ''}`, {
    label: t('保存'),
    run: async () => {
      const c = $('#dialog-content');
      const body = {};
      for (const k of ['tags', 'subjects', 'objects', 'related']) { const v = chipValues(c, k); if (JSON.stringify(v) !== JSON.stringify(d[k] || [])) body[k] = v; }
      const folder = $('[name=folder]', c)?.value.trim();
      if (folder && folder !== d.folder) body.folder = folder;
      if (reviewer) {
        const owner = $('[name=owner]', c).value.trim();
        if (owner !== (d.owner || '')) body.owner = owner;
        const ids = splitList($('[name=ownerIds]', c).value);
        if (JSON.stringify(ids) !== JSON.stringify(d.ownerIds || [])) body.ownerIds = ids;
      }
      if (!Object.keys(body).length) return;
      await patch(`/api/v1/docs/${enc(d.id)}`, body);
      toast(t('已保存'));
      go(`doc/${d.id}`);
    }
  });
}

function printDoc(d, html) {
  const w = window.open('', '_blank');
  if (!w) return toast(t('瀏覽器攔截了新視窗，請允許彈出視窗後重試'));
  const meta = [d.id, tplLabel(d.template), d.version ? `v${d.version}` : tv(d.status), d.change?.publishedAt ? day(d.change.publishedAt) : null, d.owner].filter(Boolean).join(' · ');
  const css = 'body{font:14px/1.75 system-ui,sans-serif;color:#24334a;max-width:760px;margin:32px auto;padding:0 16px}h1{font-size:22px;margin:0 0 4px}header p{margin:0;color:#64758b}.summary{margin-top:8px;color:#24334a}h2{font-size:17px;margin:22px 0 8px}h3{font-size:15px}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #d7dee8;padding:5px 8px;text-align:left}pre{background:#f6f8fb;padding:10px;white-space:pre-wrap}.ref{color:inherit;text-decoration:none;border-bottom:1px dotted #8aa}.ref-id{font:11px ui-monospace,monospace;color:#64758b;margin-right:3px}.ref-level{font-size:10px;margin-left:3px;color:#248569}.ref-e1{text-decoration:line-through}img{max-width:100%}footer{margin-top:32px;font-size:11px;color:#8896a8;border-top:1px solid #e3e8ef;padding-top:8px}.anchor-link{display:none}';
  w.document.open();
  w.document.write(`<!doctype html><html lang="${esc(document.documentElement.lang || 'zh-Hant')}"><head><meta charset="utf-8"><title>${esc(d.title)}</title><style>${css}</style></head><body><header><h1>${esc(d.title)}</h1><p>${esc(meta)}</p>${d.summary ? `<p class="summary">${esc(d.summary)}</p>` : ''}</header>${html}<footer>${esc(t('打印於 {time} · 以知識倉庫中的版本為準', { time: fmtTime(new Date().toISOString()) }))}</footer></body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

async function downloadMd(d, { version, draft } = {}) {
  const res = await fetch(`/api/v1/docs/${enc(d.id)}?${qs({ format: 'md', version, draft: draft ? '1' : '' })}`, { credentials: 'same-origin', headers: { 'accept-language': locale() } });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
  download(`${d.id}-${d.title.replace(/[\\/:*?"<>|]+/g, '-')}${version ? `-v${version}` : ''}.md`, await res.text(), 'text/markdown;charset=utf-8');
}

async function pageDoc({ param }) {
  const [id, ...rest] = String(param || '').split('?')[0].split('/');
  const anchor = rest.length ? rest.join('/') : null;
  const p = hashParams();
  const version = p.get('version') || '';
  const draftMode = p.get('draft') === '1';
  const [d] = await Promise.all([get(`/api/v1/docs/${enc(id)}?${qs({ version, draft: draftMode ? '1' : '' })}`), loadTemplates(), loadTags(), loadLookups()]);
  const history = await get(`/api/v1/docs/${enc(id)}/history`).catch(() => ({ events: [], versions: [] }));
  const tpl = tplOf(d.template);
  const historical = !!d.historical?.hash;
  const published = !!d.version && !draftMode;
  const firstVersion = history.versions.length ? Math.min(...history.versions.map(v => Number(v.version))) : null;
  const kind = d.change ? (Number(d.version) === firstVersion ? t('首次發布') : d.change.major ? t('重大修訂') : t('小修')) : null;
  const metaLine = [d.id, tpl?.label || d.template, draftMode ? t('修訂草稿') : d.version ? `v${d.version}` : tv(d.status), d.change?.publishedAt && !draftMode ? t('{who} 於 {date} 發布（{kind}）', { who: who(d.change.publishedBy), date: day(d.change.publishedAt), kind }) : null].filter(Boolean).join(' · ');
  setHeading(d.title, metaLine, [t('文檔庫'), t('文檔'), ...d.folder.split('/')].join(' › '));
  document.title = `${d.title} · ${ctx.title}`;
  const obsolete = d.status === '已廢止';
  const immutableNow = tpl?.immutable && d.version;
  const editable = canWrite() && !obsolete && !historical && !(immutableNow && !d.draft);
  const editLabel = !d.version ? t('編輯草稿') : d.draft ? t('繼續修訂') : t('修訂');
  const more = [];
  if (canWrite() && !obsolete) more.push(`<button type="button" data-act="copy">${t('複製為新文檔')}</button>`);
  if (d.draft && canWrite()) more.push(`<button type="button" data-act="discard">${d.version ? t('丟棄修訂') : t('刪除草稿')}</button>`);
  if (d.version && !obsolete && isReviewer(d)) more.push(`<button type="button" data-act="obsolete" class="danger-text">${t('廢止')}</button>`);
  if (me()?.isAdmin) more.push(`<button type="button" data-act="remove" class="danger-text">${t('刪除（管理員）')}</button>`);
  setActions(`<div class="actions" id="doc-actions"><button class="button" id="doc-history">${t('歷史與差異')}</button>${d.git?.url ? `<a class="button" href="${esc(d.git.url)}" target="_blank" rel="noopener noreferrer">${t('在 Git 中查看')}</a>` : `<button class="button" id="doc-git">${t('在 Git 中查看')}</button>`}<details class="menu"><summary class="button">${t('導出')}</summary><div class="menu-list"><button type="button" data-act="md">${t('下載 Markdown')}</button><button type="button" data-act="print">${t('打印 / 存為 PDF')}</button></div></details>${more.length ? `<details class="menu"><summary class="button">${t('更多')}</summary><div class="menu-list">${more.join('')}</div></details>` : ''}${editable ? `<a class="button primary" href="#doc-edit/${esc(d.id)}">${esc(editLabel)}</a>` : ''}</div>`);

  // ---- 提示條
  const notes = [];
  if (historical) notes.push(`<div class="notice">${esc(t('你在看歷史版本 v{v}；當前版本是 v{cur}。', { v: d.version, cur: d.nextVersion - 1 }))} <a href="#doc/${esc(d.id)}">${t('回到當前版本')}</a> · <a href="#doc/${esc(d.id)}?diff=${esc(d.nextVersion - 1)}">${t('看之後的改動')}</a></div>`);
  if (obsolete) notes.push(`<div class="notice warn">${esc(t('已廢止（{date}）：{reason}', { date: day(d.obsoleteAt), reason: d.obsoleteReason || '—' }))}${d.replacedBy ? ` ${t('替代文檔：')}${refChip(d.replacedBy)}` : ''}</div>`);
  if (draftMode) notes.push(`<div class="notice">${t('你在看修訂草稿，尚未發布；讀者看到的仍是已發布版本。')} <a href="#doc/${esc(d.id)}">${t('看已發布版本')}</a></div>`);
  if (d.draft && d.version && !draftMode && !historical && canWrite()) {
    const text = d.draft.status === '待審' ? t('有一份修訂待審閱：v{v} 草稿由 {who} 於 {time} 提交。', { v: d.nextVersion, who: who(d.draft.submittedBy || d.draft.updatedBy), time: fmtTime(d.draft.submittedAt || d.draft.updatedAt) }) : t('有一份修訂正在進行：v{v} 草稿由 {who} 最後修改於 {time}。', { v: d.nextVersion, who: who(d.draft.updatedBy), time: fmtTime(d.draft.updatedAt) });
    notes.push(`<div class="notice warn">${esc(text)} <a href="#doc/${esc(d.id)}?draft=1">${t('查看修訂')}</a> · <button type="button" class="text-btn" data-act="diff-draft">${t('查看差異')}</button>${canPublish(d) ? ` · <button type="button" class="text-btn" data-act="publish">${d.draft.status === '待審' ? t('審閱並發布') : t('發布')}</button>` : ''}</div>`);
  }
  if (d.draft?.reviewNote && canWrite()) notes.push(`<div class="notice warn">${esc(t('被 {who} 退回（{time}）：{note}', { who: who(d.draft.reviewNote.by), time: fmtTime(d.draft.reviewNote.at), note: d.draft.reviewNote.note }))}</div>`);
  if (!d.version && canWrite()) {
    const problems = d.problems || [];
    const errors = problems.filter(x => x.level === 'error').length;
    const can = canPublish(d);
    notes.push(`<div class="notice${errors ? ' warn' : ''}">${esc(d.status === '待審' ? t('草稿待審閱，從未發布。') : t('草稿，從未發布。'))} ${esc(t('體檢：{e} 個錯誤、{w} 個提醒。', { e: errors, w: problems.length - errors }))}${d.status === '草稿' && !can ? ` <button type="button" class="text-btn" data-act="submit">${t('提交審閱')}</button>` : ''}${can ? ` <button type="button" class="text-btn" data-act="publish">${t('發布')}</button>` : ''}${problems.length ? `<ul class="lint-list compact">${problems.slice(0, 6).map(x => problemLi(x)).join('')}</ul>` : ''}</div>`);
  }
  if (history.editedInGit && published && !historical && isReviewer(d) && !obsolete) notes.push(`<div class="notice warn">${t('已發布的檔案在 Git 中被直接修改過，還沒有確認為新版本。')} <button type="button" class="text-btn" data-act="confirm-git">${t('確認為新版本')}</button></div>`);

  // ---- 正文
  const { html } = renderMarkdown(d.body, { resolveRef: refResolver(d.refs), assetUrl: assetUrlOf(d.id) });
  const fieldRows = (tpl?.fields || []).map(f => `<dt>${esc(f.labelText)}</dt><dd>${fieldHtml(f, d.fields?.[f.key])}</dd>`).join('');
  const canReview = published && !obsolete && !historical && d.review && isReviewer(d);
  const chips = list => list.map(x => (x.missing ? refChip(x.id, { state: 'missing' }) : refChip(x.id, { label: x.name || (x.title ? `《${x.title}》` : null), lvl: x.level, state: x.status === '下線' || x.status === '已廢止' ? 'e1' : 'ok' }))).join('') || '<span class="muted">—</span>';
  const canOrganize = canWrite() && !obsolete && !historical;
  content().innerHTML = `<div id="doc-root"><div class="doc-notes">${notes.join('')}</div><div class="doc-page">
    <article class="panel doc-article"><div class="panel-body prose doc-prose" id="doc-prose">${d.summary ? `<p class="doc-summary">${esc(d.summary)}</p>` : ''}${html || `<p class="muted">${t('正文為空')}</p>`}</div></article>
    <aside class="stack doc-side">
      ${panel(t('欄位'), `<div class="panel-body"><dl class="kv">${fieldRows}<dt>${t('負責人')}</dt><dd>${esc(d.owner || '—')}</dd>${d.reviewers?.length ? `<dt>${t('審閱人')}</dt><dd>${d.reviewers.map(esc).join(t('、'))}</dd>` : ''}${d.review ? `<dt>${t('下次複審')}</dt><dd>${reviewCell(d)}${canReview ? ` <button type="button" class="text-btn" data-act="review">${t('確認複審')}</button>` : ''}</dd>` : ''}<dt>${t('文件夾')}</dt><dd><a href="#docs?folder=${enc(d.folder)}">${esc(d.folder)}</a></dd><dt>${t('檔案')}</dt><dd class="mono small">${esc(d.git?.file || d.path)}</dd></dl></div>`, `<small class="muted">${esc(t('模板：{name}', { name: tpl?.label || d.template }))}</small>`)}
      ${panel(t('標籤與關聯'), `<div class="panel-body doc-links"><h3>${t('標籤')}</h3><div class="chip-row">${tagsHtml(d.tags) || '<span class="muted">—</span>'}</div><h3>${t('關聯主體')}</h3><div class="chip-col">${chips(d.subjectInfo)}</div><h3>${t('涉及的客體')}</h3><div class="chip-col">${chips(d.objectInfo)}</div>${d.relatedInfo.length ? `<h3>${t('相關文檔')}</h3><div class="chip-col">${chips(d.relatedInfo)}</div>` : ''}${d.object ? `<h3>${t('本文檔的客體')}</h3><div>${idLink(d.object.id)} <small class="muted">${esc(tv('制度'))} · ${esc(tv(d.object.kind) || '')}${d.object.managed ? ` · ${esc(t('由文檔庫管理'))}` : ''}${d.object.status === '下線' ? ` · ${esc(tv('下線'))}` : ''}</small></div>` : ''}</div>`, canOrganize ? `<button type="button" class="text-btn" data-act="organize">${t('編輯')}</button>` : '')}
      ${d.object ? panel(t('以本文檔為依據（{n}）', { n: d.impact.total }), `<div class="panel-body" id="impact-body"><p class="muted">${t('載入中…')}</p></div>`, d.impact.total ? `<button type="button" class="text-btn" data-act="impact-all">${t('全部')}</button>` : '') : ''}
      ${panel(t('版本'), `<div class="panel-body">${timelineHtml(d, history, { compact: true })}</div>`, `<button type="button" class="text-btn" data-act="history">${t('比較')}</button>`)}
    </aside></div></div>`;

  // 章節錨點：複製鏈接
  for (const h of $$('#doc-prose [data-anchor]')) h.insertAdjacentHTML('beforeend', ` <button type="button" class="anchor-link" data-anchor-copy="${esc(h.dataset.anchor)}" title="${esc(t('複製本節鏈接'))}" aria-label="${esc(t('複製本節鏈接'))}">#</button>`);
  if (anchor) document.getElementById(`sec-${anchor}`)?.scrollIntoView({ block: 'start' });

  let impactItems = [];
  if (d.object) {
    get(`/api/v1/docs/${enc(d.id)}/impact`).then(r => {
      impactItems = r.items;
      const box = $('#impact-body');
      if (!box) return;
      const lv = d.impact.byLevel;
      box.innerHTML = r.items.length ? `${r.items.slice(0, 6).map(x => `<div class="impact-row"><span class="mono">${idLink(x.id)}</span><span class="grow">${esc(impactDesc(x))}</span>${level(x.level)}</div>`).join('')}<p class="muted small">${esc(r.items.length > 6 ? t('另 {n} 條 · {levels}', { n: r.items.length - 6, levels: Object.entries(lv).map(([k, v]) => `${k} ${v}`).join(' · ') }) : Object.entries(lv).map(([k, v]) => `${k} ${v}`).join(' · '))}</p>` : `<p class="muted">${t('還沒有知識以本文檔為依據。綁定主體或在斷言的證據中選這份文檔的客體後，修訂時就能選擇哪些知識要重驗。')}</p>`;
    }).catch(() => {});
  }

  const act = async name => {
    switch (name) {
      case 'md': return downloadMd(d, { version: historical ? d.version : undefined, draft: draftMode });
      case 'print': return printDoc(d, $('#doc-prose').innerHTML);
      case 'copy': return openNewDoc({ template: d.template, folder: d.folder, title: t('{title}（副本）', { title: d.title }).slice(0, 40), tags: d.tags, subjects: d.subjects, fields: d.fields, body: d.body, summary: d.summary });
      case 'discard': return modal(d.version ? t('丟棄修訂 {id}', { id: d.id }) : t('刪除草稿 {id}', { id: d.id }), `<p class="notice warn">${d.version ? t('丟棄後修訂草稿刪除，已發布版本不變。') : t('這份文檔從未發布，刪除後只在 Git 歷史中保留。')}</p>`, { label: t('確認'), run: async () => { const r = await del(`/api/v1/docs/${enc(d.id)}/draft`); local.del(`docs.autosave:${d.id}`); toast(t('已丟棄')); cache.docList = null; if (r.data.deleted) location.hash = 'docs'; else go(`doc/${d.id}`); } });
      case 'obsolete': return obsoleteDialog(d);
      case 'remove': return modal(t('刪除 {id}', { id: d.id }), `<p class="notice warn">${t('刪除會移除檔案（Git 歷史仍保留），客體不再由文檔庫管理。正常情況請用「廢止」。')}</p>`, { label: t('確認刪除'), run: async () => { await del(`/api/v1/docs/${enc(d.id)}`); toast(t('已刪除')); cache.docList = null; location.hash = 'docs'; } });
      case 'publish': return publishDialog(d);
      case 'confirm-git': return publishDialog(d, { confirmGitEdit: true });
      case 'submit': await post(`/api/v1/docs/${enc(d.id)}/submit`); toast(t('已提交審閱')); return go(`doc/${d.id}`);
      case 'diff-draft': return historyDialog(d, history, { diff: 'draft' });
      case 'history': return historyDialog(d, history);
      case 'organize': return organizeDialog(d);
      case 'review': return modal(t('確認複審 · {id}', { id: d.id }), `<p class="notice">${esc(t('確認內容仍然有效；下次複審日期順延 {n} 天。不改版本號。', { n: d.review.everyDays || '' }))}</p>${field(t('說明（選填）'), input('note'))}`, { label: t('確認複審'), run: async () => { await post(`/api/v1/docs/${enc(d.id)}/review`, formData($('#dialog-content'))); toast(t('已確認複審')); go(`doc/${d.id}`); } });
      case 'impact-all': {
        const list = impactItems.length ? impactItems : (await get(`/api/v1/docs/${enc(d.id)}/impact`)).items;
        return modal(t('以本文檔為依據（{n}）', { n: list.length }), table(['ID', t('類型'), t('主體'), t('內容'), t('層級')], list.map(x => `<tr><td>${idLink(x.id)}</td><td>${esc(t(KIND_TEXT[x.kind]))}</td><td>${x.subject ? `${idLink(x.subject.id)} ${esc(x.subject.name)}` : '—'}</td><td class="wrap">${esc(impactDesc(x))}</td><td>${level(x.level)}${x.pending ? ` ${pill(t('待重驗'), 'amber')}` : ''}</td></tr>`)));
      }
      default: return null;
    }
  };
  $('#doc-root').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    const a = e.target.closest('[data-anchor-copy]');
    if (a) { const url = `${location.origin}${location.pathname}${hrefOfDoc(d.id, a.dataset.anchorCopy)}`; history.replaceState(null, '', hrefOfDoc(d.id, a.dataset.anchorCopy)); return copy(url); }
    if (b) act(b.dataset.act).catch(showError);
  });
  $('#doc-actions').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    b.closest('details')?.removeAttribute('open');
    act(b.dataset.act).catch(showError);
  });
  $('#doc-history').onclick = () => historyDialog(d, history);
  $('#doc-git')?.addEventListener('click', () => {
    modal(t('在 Git 中查看'), `<p class="notice">${t('知識倉庫的遠端不是 GitHub 或 GitLab，或還沒有配置遠端。檔案在倉庫中的路徑：')}</p><div class="copy-row" style="margin-top:10px"><code>${esc(d.git?.file || d.path)}</code><button type="button" class="button" id="copy-path">${t('複製')}</button></div>`);
    $('#copy-path').onclick = () => copy(d.git?.file || d.path);
  });
  if (p.get('diff')) historyDialog(d, history, { diff: p.get('diff') });
  else if (p.get('publish') === '1' && canPublish(d) && d.draft) publishDialog(d).catch(showError);
}

// ------------------------------------------------------------------ 編輯器
let editor = null;

function fieldInput(f, v) {
  const name = `f:${f.key}`;
  const label = `${f.labelText}${f.required ? ' *' : ''}`;
  const arr = isEmpty(v) ? [] : Array.isArray(v) ? v : [v];
  switch (f.type) {
    case 'longtext': return field(label, textarea(name, v ?? '', 'rows="3"'));
    case 'number': return field(label, input(name, v ?? '', 'type="number" step="any"'));
    case 'date': return field(label, input(name, v ?? '', 'type="date"'));
    case 'url': return field(label, input(name, v ?? '', 'type="url" placeholder="https://"'));
    case 'enum': return field(label, select(name, [['', '—'], ...(f.options || []).map(o => [o, f.optionLabels?.[o] || o])], v ?? ''));
    case 'enums': return `<fieldset class="field-set"><legend>${esc(label)}</legend>${(f.options || []).map(o => `<label class="check"><input type="checkbox" name="${esc(name)}" value="${esc(o)}" ${arr.includes(o) ? 'checked' : ''}> ${esc(f.optionLabels?.[o] || o)}</label>`).join('')}</fieldset>`;
    case 'subject': case 'subjects': return boxField(label, chipBox(name, arr, 'subject-options', { ids: true, max: f.type === 'subject' ? 1 : 0 }), f.subjectTypes?.length ? t('主體類型：{types}', { types: f.subjectTypes.map(x => tv(x)).join(t('、')) }) : '');
    case 'object': case 'objects': return boxField(label, chipBox(name, arr, 'object-options', { ids: true, max: f.type === 'object' ? 1 : 0 }));
    case 'doc': return boxField(label, chipBox(name, arr, 'doc-options', { ids: true, max: 1 }));
    default: return field(label, input(name, v ?? ''));
  }
}
function collectFields(root, tpl) {
  const out = {};
  for (const f of tpl?.fields || []) {
    const name = `f:${f.key}`;
    if (['subject', 'object', 'doc'].includes(f.type)) out[f.key] = chipValues(root, name)[0] || null;
    else if (['subjects', 'objects'].includes(f.type)) out[f.key] = chipValues(root, name);
    else if (f.type === 'enums') out[f.key] = $$(`input[name="${CSS.escape(name)}"]:checked`, root).map(x => x.value);
    else {
      const el = $(`[name="${CSS.escape(name)}"]`, root);
      const v = el ? el.value.trim() : '';
      out[f.key] = v === '' ? null : f.type === 'number' ? Number(v) : v;
    }
  }
  return out;
}

async function uploadImage(id, file) {
  const res = await fetch(`/api/v1/docs/${enc(id)}/assets?name=${enc(file.name || 'image')}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type || 'application/octet-stream', 'accept-language': locale() }, body: file });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json);
  return json.data;
}

function insertText(ta, text, { s = ta.selectionStart, e = ta.selectionEnd, select: range } = {}) {
  ta.focus();
  ta.setSelectionRange(s, e);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
  if (!ok) { ta.setRangeText(text, s, e, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
  if (range) ta.setSelectionRange(s + range[0], s + range[1]);
}
function applyTool(ta, kind) {
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const sel = value.slice(s, e);
  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  const wrap = (a, b, ph) => insertText(ta, a + (sel || ph) + b, { select: sel ? null : [a.length, a.length + ph.length] });
  const prefix = p => {
    const block = value.slice(lineStart, e);
    insertText(ta, block.split('\n').map((l, i) => (typeof p === 'function' ? p(i) : p) + l.replace(/^(#{1,6}\s+|[-*]\s+|\d+\.\s+|>\s?)/, '')).join('\n'), { s: lineStart, e });
  };
  switch (kind) {
    case 'h2': return prefix('## ');
    case 'h3': return prefix('### ');
    case 'bold': return wrap('**', '**', t('粗體文字'));
    case 'italic': return wrap('*', '*', t('斜體文字'));
    case 'ul': return prefix('- ');
    case 'ol': return prefix(i => `${i + 1}. `);
    case 'quote': return prefix('> ');
    case 'code': return !sel || sel.includes('\n') ? wrap('\n```\n', '\n```\n', 'code') : wrap('`', '`', 'code');
    case 'link': return wrap('[', '](https://)', t('鏈接文字'));
    case 'table': return insertText(ta, `${s > 0 && value[s - 1] !== '\n' ? '\n' : ''}\n| ${t('項目')} | ${t('說明')} |\n| --- | --- |\n|  |  |\n`);
    default: return null;
  }
}

function refDialog(onPick) {
  modal(t('插入引用'), `<p class="notice">${t('引用渲染為帶當前層級的標籤；被引用的知識失效時，體檢會提醒。')}</p>${field(t('搜索主體、斷言、客體、文檔'), input('q', '', `id="ref-q" autocomplete="off" placeholder="${esc(t('名稱、ID 或內容'))}"`))}<div id="ref-results" class="ref-results"></div>`);
  let timer;
  const box = $('#ref-results');
  const row = (id, label, extra = '') => `<div class="ref-row"><button type="button" class="ref-pick" data-ref="${esc(id)}"><span class="mono">${esc(id)}</span> ${esc(label)}</button>${extra}</div>`;
  const run = async () => {
    const q = $('#ref-q').value.trim();
    if (!q) { box.innerHTML = ''; return; }
    const [s, a, o, d] = await Promise.all([get(`/api/v1/subjects?${qs({ q, limit: 8 })}`), get(`/api/v1/assertions?${qs({ q })}`), get(`/api/v1/objects?${qs({ q })}`), get(`/api/v1/docs?${qs({ q, limit: 8 })}`)].map(x => x.catch(() => [])));
    if ($('#ref-q')?.value.trim() !== q) return;
    const group = (title, rows) => (rows.length ? `<h4>${esc(title)}</h4>${rows.join('')}` : '');
    box.innerHTML = [
      group(t('主體'), s.slice(0, 8).map(x => row(x.id, `${x.name}${x.level ? ` · ${x.level}` : ''}`))),
      group(t('斷言'), a.slice(0, 8).map(x => row(x.id, `${x.subject?.name || ''}：${x.content}`))),
      group(t('客體'), o.slice(0, 8).map(x => row(x.id, x.name))),
      group(t('文檔'), d.slice(0, 8).map(x => row(x.id, x.title, `<button type="button" class="text-btn" data-sections="${esc(x.id)}">${t('選章節')}</button><div class="ref-sections" data-for="${esc(x.id)}"></div>`)))
    ].join('') || `<p class="muted">${t('沒有相符項目')}</p>`;
  };
  $('#ref-q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => run().catch(() => {}), 250); };
  box.addEventListener('click', async e => {
    const pick = e.target.closest('[data-ref]');
    if (pick) { closeModal(); return onPick(pick.dataset.ref); }
    const sb = e.target.closest('[data-sections]');
    if (sb) {
      const id = sb.dataset.sections;
      const r = await get(`/api/v1/docs/${enc(id)}/sections`).catch(() => null);
      const target = $(`.ref-sections[data-for="${CSS.escape(id)}"]`, box);
      if (target && r) target.innerHTML = r.sections.filter(x => x.anchor).map(x => `<button type="button" class="chip-btn" data-ref="${esc(id)}#${esc(x.heading)}">§ ${esc(x.heading)}</button>`).join('') || `<span class="muted">${t('沒有章節')}</span>`;
    }
  });
}

async function pageEdit({ param }) {
  const id = String(param || '').split('?')[0].split('/')[0];
  if (!canWrite()) throw new Error(t('編輯文檔需要 contributor 權限'));
  await Promise.all([loadTemplates(), loadTags(), loadLookups(), loadFolders(), loadDocList()]);
  let base = await get(`/api/v1/docs/${enc(id)}`);
  if (base.draft && base.side !== 'draft') base = await get(`/api/v1/docs/${enc(id)}?draft=1`);
  if (base.status === '已廢止') throw new Error(t('{id} 已廢止，不能修改', { id }));
  const hasDraft = base.side === 'draft';
  const published = !!base.version;
  const tpl0 = tplOf(base.template);
  if (published && !hasDraft && tpl0?.immutable) throw new Error(t('模板「{name}」的文檔發布後不能修訂；有誤時請廢止並另發一份', { name: tpl0.label }));
  const key = `docs.autosave:${id}`;
  const state = { id, etag: hasDraft ? base.etag : base.publishedEtag, dirty: false, tpl: tpl0, bodyTouched: false, refs: base.refs || {}, lintTimer: null, previewTimer: null, autosave: null, save: null, stash: null };
  editor = state;
  const mode = local.get('docs.editMode', 'split');
  const subjOpts = await ctx.subjectOptions();
  const canPub = canPublish(base);

  setHeading(published ? t('修訂 {title}', { title: base.title }) : t('編輯草稿 {title}', { title: base.title }), `${base.id} · ${tplLabel(base.template)}${published ? ` · ${t('將發布為 v{v}', { v: base.nextVersion })}` : ''}`, [t('文檔庫'), t('文檔'), ...base.folder.split('/'), t('編輯')].join(' › '));
  document.title = `${t('編輯')} ${base.title} · ${ctx.title}`;
  setActions(`<span id="save-state" class="muted save-state">${hasDraft ? esc(t('草稿保存於 {time}', { time: fmtTime(base.draft?.updatedAt || base.updatedAt) })) : esc(t('尚未保存修訂'))}</span><a class="button" href="#doc/${esc(id)}">${t('返回')}</a>${hasDraft ? `<button class="button" id="ed-discard">${published ? t('丟棄修訂') : t('刪除草稿')}</button>` : ''}<button class="button" id="ed-save" title="Ctrl/⌘ + S">${t('保存草稿')}</button>${canPub ? `<button class="button primary" id="ed-publish">${t('保存並發布…')}</button>` : `<button class="button primary" id="ed-submit">${t('保存並提交審閱')}</button>`}`);

  const form = d => `
    ${panel(t('基本資訊'), `<div class="panel-body editor-meta">
      <div class="field-pair">${field(t('標題'), input('title', d.title, 'required maxlength="40"'))}${field(t('模板'), published ? `<input value="${esc(tplLabel(d.template))}" disabled>` : select('template', tplOptions(), d.template, 'id="ed-template"'))}</div>
      ${field(t('摘要'), textarea('summary', d.summary || '', 'rows="2" maxlength="400"'), t('一兩句話說明這篇文檔講什麼；發布時必填，不超過 200 字'))}
      <div class="field-pair">${field(t('文件夾'), published ? `<input value="${esc(base.folder)}" disabled>` : input('folder', d.folder || base.folder, 'list="folder-options"'))}${field(t('負責人'), input('owner', d.owner || ''))}</div>
      ${boxField(t('標籤'), chipBox('tags', d.tags, 'tag-options'))}
      <div id="ed-fields" class="field-grid">${(state.tpl?.fields || []).map(f => fieldInput(f, d.fields?.[f.key])).join('')}</div>
      <details class="ed-links"><summary>${esc(t('關聯：{s} 個主體、{o} 個客體、{r} 篇相關文檔', { s: d.subjects?.length || 0, o: d.objects?.length || 0, r: d.related?.length || 0 }))}</summary>
        ${boxField(t('關聯主體'), chipBox('subjects', d.subjects, 'subject-options', { ids: true }), t('模板中「關聯」類欄位填的主體會自動加入'))}
        ${boxField(t('涉及的客體'), chipBox('objects', d.objects, 'object-options', { ids: true }))}
        ${boxField(t('相關文檔'), chipBox('related', d.related, 'doc-options', { ids: true }))}
      </details>
    </div>`)}
    ${panel(t('正文'), `<div class="md-toolbar" role="toolbar" aria-label="${esc(t('格式'))}">${TOOLS.map(([k, label, title]) => `<button type="button" class="tool" data-tool="${k}" title="${esc(t(title))}" aria-label="${esc(t(title))}">${esc(label)}</button>`).join('')}<input type="file" id="ed-image" accept="image/png,image/jpeg,image/gif,image/webp" hidden></div><div class="md-split mode-${esc(mode)}" id="md-split"><textarea id="md-src" class="md-src" spellcheck="false" aria-label="${esc(t('Markdown 原文'))}">${esc(d.body)}</textarea><div class="md-preview prose doc-prose" id="md-preview" aria-live="off"></div></div>`, `<div class="segmented" role="group" aria-label="${esc(t('顯示方式'))}">${[['edit', t('只看原文')], ['split', t('分欄')], ['preview', t('只看預覽')]].map(([k, l]) => `<button type="button" data-view-mode="${k}" class="${mode === k ? 'active' : ''}">${l}</button>`).join('')}</div>`)}`;

  content().innerHTML = `${subjOpts}${tagDatalist()}${folderDatalist()}${objectDatalist()}${docDatalist()}
    <div id="editor-notes" class="doc-notes"></div>
    <div class="doc-editor" id="doc-editor"><div class="stack" id="ed-main"></div>
    <aside class="stack editor-side">
      ${panel(t('體檢'), `<div class="panel-body" id="lint-out"><p class="muted">${t('載入中…')}</p></div>`, '<small id="lint-state" class="muted"></small>')}
      ${panel(t('圖片'), `<div class="panel-body" id="asset-list"><p class="muted">${t('載入中…')}</p></div>`, `<button type="button" class="text-btn" data-tool="image">${t('上傳')}</button>`)}
      ${panel(t('寫作提示'), `<div class="panel-body"><ul class="tips">${TIPS.map(x => `<li>${esc(t(x))}</li>`).join('')}</ul></div>`)}
    </aside></div>`;

  const root = $('#doc-editor');
  const collect = () => {
    const out = { title: $('[name=title]', root).value.trim(), summary: $('[name=summary]', root).value, owner: $('[name=owner]', root).value.trim(), tags: chipValues(root, 'tags'), subjects: chipValues(root, 'subjects'), objects: chipValues(root, 'objects'), related: chipValues(root, 'related'), fields: collectFields(root, state.tpl), body: $('#md-src').value };
    if (!published) { out.template = state.tpl?.id || base.template; out.folder = $('[name=folder]', root).value.trim() || base.folder; }
    return out;
  };
  const renderForm = d => {
    $('#ed-main').innerHTML = form(d);
    renderPreview();
    loadAssets();
  };
  const setSaveState = text => { const el = $('#save-state'); if (el) el.textContent = text; };
  const renderPreview = () => {
    const el = $('#md-preview');
    if (el) el.innerHTML = renderMarkdown($('#md-src').value, { resolveRef: refResolver(state.refs), assetUrl: assetUrlOf(id) }).html || `<p class="muted">${t('預覽會顯示在這裡')}</p>`;
  };
  let problems = [];
  const showProblems = list => {
    problems = list || [];
    const out = $('#lint-out');
    if (!out) return;
    const n = { error: 0, warning: 0, info: 0 };
    for (const p of problems) n[p.level] = (n[p.level] || 0) + 1;
    $('#lint-state').textContent = t('{e} 錯誤 · {w} 提醒 · {i} 建議', { e: n.error, w: n.warning, i: n.info });
    out.innerHTML = problems.length ? `<ul class="lint-list">${problems.map((p, i) => problemLi(p, i, true)).join('')}</ul>` : `<p class="notice success">${t('體檢通過，可以提交或發布。')}</p>`;
  };
  const lint = async () => {
    try { const r = await post('/api/v1/docs/lint', { id, ...collect(), phase: 'publish' }); if (editor === state) showProblems(r.data); } catch { /* 體檢失敗不打斷編輯 */ }
  };
  const loadAssets = async () => {
    const box = $('#asset-list');
    if (!box) return;
    try {
      const list = await get(`/api/v1/docs/${enc(id)}/assets`);
      box.innerHTML = list.length ? list.map(a => `<div class="asset-row"><img src="${esc(a.url)}" alt="" loading="lazy"><span class="grow mono small">${esc(a.name)}<small class="muted"> · ${Math.ceil(a.size / 1024)} KB</small></span><button type="button" class="text-btn" data-insert="${esc(a.markdown)}">${t('插入')}</button></div>`).join('') : `<p class="muted">${t('還沒有圖片。可以直接把截圖貼到正文裡。')}</p>`;
    } catch { box.innerHTML = ''; }
  };
  const goLine = line => {
    const ta = $('#md-src');
    const lines = ta.value.split('\n');
    const at = lines.slice(0, Math.max(0, line - 1)).reduce((n, l) => n + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(at, at + (lines[line - 1]?.length || 0));
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, (line - 3) * lh);
  };
  const markDirty = ({ body = false } = {}) => {
    state.dirty = true;
    if (body) state.bodyTouched = true;
    setSaveState(t('有未保存的修改'));
    clearTimeout(state.lintTimer);
    state.lintTimer = setTimeout(lint, 900);
  };
  const save = async ({ quiet = false } = {}) => {
    const data = collect();
    try {
      const r = await put(`/api/v1/docs/${enc(id)}/draft`, { ...data, etag: state.etag });
      state.etag = r.data.etag;
      state.dirty = false;
      local.del(key);
      setSaveState(t('已保存 · {time}', { time: fmtTime(new Date().toISOString()) }));
      lint();
      if (!quiet) toast(t('草稿已保存'));
      cache.docList = null;
      return true;
    } catch (err) {
      if (err.code === 'draft_conflict' && err.body?.error?.current) { conflictDialog(err.body.error.current); return false; }
      if (err.body?.error?.problems) showProblems(err.body.error.problems);
      showError(err);
      return false;
    }
  };
  state.save = save;
  const conflictDialog = current => {
    modal(t('草稿已被別人修改'), `<p class="notice warn">${esc(t('{who} 於 {time} 保存了這份草稿。你可以以你的版本為準覆蓋，或載入對方的版本，對照著合併後再保存。', { who: who(current.updatedBy), time: fmtTime(current.updatedAt) }))}</p><div class="conflict-cols"><div><h3>${t('對方的正文')}</h3><textarea readonly class="code">${esc(current.body)}</textarea></div><div><h3>${t('你的正文')}</h3><textarea readonly class="code">${esc($('#md-src').value)}</textarea></div></div><div class="dialog-inline-actions"><button type="button" class="button" id="cf-merge">${t('合併後再保存')}</button></div>`, {
      label: t('以我的為準'),
      run: async () => { state.etag = current.etag; await save(); }
    });
    $('#cf-merge').onclick = () => {
      state.etag = current.etag;
      closeModal();
      $('#editor-notes').innerHTML = `<div class="notice warn merge-box"><div class="merge-head"><strong>${t('對方的版本（只讀）')}</strong> <span class="muted">${esc(t('把需要的內容合併到下方正文，然後保存。'))}</span> <button type="button" class="text-btn" id="merge-use">${t('改用對方的正文')}</button> <button type="button" class="text-btn" id="merge-close">${t('關閉')}</button></div><textarea readonly class="code">${esc(current.body)}</textarea></div>`;
      $('#merge-close').onclick = () => ($('#editor-notes').innerHTML = '');
      $('#merge-use').onclick = () => { const ta = $('#md-src'); ta.value = current.body; renderPreview(); markDirty({ body: true }); $('#editor-notes').innerHTML = ''; };
    };
  };

  renderForm(base);
  showProblems(base.problems || []);
  lint();

  // 瀏覽器暫存：有比伺服器新的未保存內容時提示恢復
  const saved = local.get(key);
  if (saved?.data && JSON.stringify(saved.data) !== JSON.stringify(collect())) {
    $('#editor-notes').innerHTML = `<div class="notice warn">${esc(t('瀏覽器裡有一份 {time} 暫存、尚未保存的內容。', { time: fmtTime(saved.at) }))}${saved.etag !== state.etag ? ` ${esc(t('伺服器上的草稿在那之後被修改過，恢復後保存時會提示衝突。'))}` : ''} <button type="button" class="text-btn" id="restore-local">${t('恢復')}</button> <button type="button" class="text-btn" id="drop-local">${t('丟棄')}</button></div>`;
    $('#restore-local').onclick = () => {
      if (saved.data.template && !published) state.tpl = tplOf(saved.data.template) || state.tpl;
      if (saved.etag && saved.etag !== state.etag) state.etag = saved.etag;
      renderForm({ ...base, ...saved.data });
      $('#editor-notes').innerHTML = '';
      markDirty({ body: true });
    };
    $('#drop-local').onclick = () => { local.del(key); $('#editor-notes').innerHTML = ''; };
  }

  // ---- 事件
  root.addEventListener('input', e => {
    if (e.target.id === 'md-src') { clearTimeout(state.previewTimer); state.previewTimer = setTimeout(renderPreview, 150); return markDirty({ body: true }); }
    if (e.target.closest('.chips') && e.target.tagName === 'INPUT') return;
    markDirty();
  });
  root.addEventListener('change', async e => {
    if (e.target.id === 'ed-template') {
      const next = tplOf(e.target.value);
      if (!next) return;
      const cur = collect();
      state.tpl = next;
      $('#ed-fields').innerHTML = next.fields.map(f => fieldInput(f, cur.fields?.[f.key])).join('');
      markDirty();
      const r = await post(`/api/v1/doc-templates/${enc(next.id)}/render`, {});
      if (!state.bodyTouched) { $('#md-src').value = r.data.body; renderPreview(); }
      else $('#editor-notes').innerHTML = `<div class="notice">${esc(t('已切換為「{name}」模板。', { name: next.label }))} <button type="button" class="text-btn" id="use-skeleton">${t('用新模板的章節骨架替換正文')}</button></div>`;
      $('#use-skeleton')?.addEventListener('click', () => { $('#md-src').value = r.data.body; renderPreview(); markDirty({ body: true }); $('#editor-notes').innerHTML = ''; });
      return;
    }
    if (!e.target.closest('.chips')) markDirty();
  });
  root.addEventListener('chips-change', () => markDirty());
  root.addEventListener('click', e => {
    const tool = e.target.closest('[data-tool]');
    const ta = $('#md-src');
    if (tool) {
      const kind = tool.dataset.tool;
      if (kind === 'ref') { const s = ta.selectionStart; const en = ta.selectionEnd; return refDialog(ref => insertText(ta, `[[${ref}]]`, { s, e: en })); }
      if (kind === 'image') return $('#ed-image').click();
      return applyTool(ta, kind);
    }
    const vm = e.target.closest('[data-view-mode]');
    if (vm) {
      local.set('docs.editMode', vm.dataset.viewMode);
      $('#md-split').className = `md-split mode-${vm.dataset.viewMode}`;
      $$('[data-view-mode]', root).forEach(x => x.classList.toggle('active', x === vm));
      return renderPreview();
    }
    const ins = e.target.closest('[data-insert]');
    if (ins) return insertText(ta, `\n${ins.dataset.insert}\n`);
    const link = e.target.closest('[data-link-subject]');
    if (link) { const box = $('[data-chips="subjects"]', root); if (box) { addChip(box, link.dataset.linkSubject); $('.ed-links', root)?.setAttribute('open', ''); } return; }
    const li = e.target.closest('[data-lint]');
    if (li) {
      const p = problems[Number(li.dataset.lint)];
      if (p?.line) return goLine(p.line);
      if (p?.section) { const n = ta.value.split('\n').findIndex(l => /^#{2,3}\s/.test(l) && l.replace(/^#+\s+/, '').trim() === p.section); if (n >= 0) return goLine(n + 1); }
    }
  });
  const upload = async file => {
    if (!file) return;
    setSaveState(t('正在上傳圖片…'));
    try {
      const a = await uploadImage(id, file);
      insertText($('#md-src'), `\n${a.markdown}\n`);
      toast(t('圖片已上傳：{name}', { name: a.name }));
      loadAssets();
    } catch (err) { showError(err); }
    setSaveState(state.dirty ? t('有未保存的修改') : '');
  };
  root.addEventListener('change', e => { if (e.target.id === 'ed-image') { upload(e.target.files[0]); e.target.value = ''; } });
  root.addEventListener('paste', e => {
    if (e.target.id !== 'md-src') return;
    const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
    if (file) { e.preventDefault(); upload(file); }
  });
  $('#ed-save').onclick = () => save();
  $('#ed-submit')?.addEventListener('click', async () => {
    if (!(await save({ quiet: true }))) return;
    try { await post(`/api/v1/docs/${enc(id)}/submit`); toast(t('已提交審閱')); location.hash = `doc/${id}`; } catch (err) { if (err.body?.error?.problems) showProblems(err.body.error.problems); showError(err); }
  });
  $('#ed-publish')?.addEventListener('click', async () => {
    if (!(await save({ quiet: true }))) return;
    location.hash = `doc/${id}?publish=1`;
  });
  $('#ed-discard')?.addEventListener('click', () => modal(published ? t('丟棄修訂 {id}', { id }) : t('刪除草稿 {id}', { id }), `<p class="notice warn">${published ? t('丟棄後修訂草稿刪除，已發布版本不變。') : t('這份文檔從未發布，刪除後只在 Git 歷史中保留。')}</p>`, {
    label: t('確認'),
    run: async () => { const r = await del(`/api/v1/docs/${enc(id)}/draft`); state.dirty = false; local.del(key); toast(t('已丟棄')); cache.docList = null; location.hash = r.data.deleted ? 'docs' : `doc/${id}`; }
  }));
  state.stash = () => local.set(key, { at: new Date().toISOString(), etag: state.etag, data: collect() });
  state.autosave = setInterval(() => {
    if (editor !== state || !$('#doc-editor')) { clearInterval(state.autosave); return; }
    if (state.dirty) state.stash();
  }, 5000);
}

// ------------------------------------------------------------------ 模板頁
async function pageTemplates() {
  const list = await loadTemplates(true);
  const purposes = ctx.schema()?.docs?.purposes || {};
  setActions(isOwner() ? `<button class="button" id="tpl-new">${t('新增模板')}</button>` : '');
  content().innerHTML = `<div class="stack" id="tpl-root">${['知識', '管理'].map(g => panel(esc(t('{purpose}文檔（{n}）', { purpose: tv(g), n: list.filter(x => x.purpose === g).length })), `${purposes[g]?.desc ? `<p class="panel-note muted">${esc(purposes[g].desc)}</p>` : ''}${table(['ID', t('名稱'), t('發布'), t('複審'), t('欄位'), t('章節（必填）'), t('預設文件夾'), '#' + t('使用'), t('操作')], list.filter(x => x.purpose === g).map(x => `<tr><td>${esc(x.id)}</td><td class="wrap"><strong>${esc(x.label)}</strong><span class="cell-sub">${esc(x.descriptionText || '')}</span></td><td>${x.approval === 'owner' ? pill(t('負責人審閱'), 'amber') : pill(t('貢獻者直接發布'), 'green')}${x.immutable ? ` ${pill(t('不可修訂'))}` : ''}</td><td>${x.reviewEveryDays ? esc(t('每 {n} 天', { n: x.reviewEveryDays })) : '—'}</td><td class="wrap-sm">${x.fields.map(f => esc(f.labelText)).join(t('、')) || '—'}</td><td class="wrap-sm">${esc(t('{n} 節（{r}）', { n: x.sections.length, r: x.sections.filter(s => s.required).length }))}</td><td>${esc(x.defaultFolder || '—')}</td><td class="numeric">${x.usage}</td><td><div class="cell-actions"><button type="button" class="text-btn" data-tpl-view="${esc(x.id)}">${t('查看')}</button>${canWrite() ? `<button type="button" class="text-btn" data-tpl-new="${esc(x.id)}">${t('用它新建')}</button>` : ''}${isOwner() ? `<button type="button" class="text-btn" data-tpl-edit="${esc(x.id)}">${t('編輯')}</button>` : ''}</div></td></tr>`), t('沒有模板'))}`)).join('')}</div>`;
  $('#tpl-root').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tplView) templateDialog(b.dataset.tplView).catch(showError);
    if (b.dataset.tplNew) openNewDoc({ template: b.dataset.tplNew }).catch(showError);
    if (b.dataset.tplEdit) templateEditor(b.dataset.tplEdit).catch(showError);
  });
  $('#tpl-new')?.addEventListener('click', () => templateEditor(null).catch(showError));
}

async function templateDialog(id) {
  const r = await post(`/api/v1/doc-templates/${enc(id)}/render`, {});
  const x = r.data.template;
  modal(`${x.id} ${x.label}`, `<p class="notice">${esc(x.descriptionText || '')}</p>
    <dl class="kv" style="margin-top:10px"><dt>${t('類別')}</dt><dd>${esc(t('{purpose}文檔', { purpose: tv(x.purpose) }))}</dd><dt>${t('發布')}</dt><dd>${esc(t(APPROVAL_TEXT[x.approval] || ''))}${x.immutable ? ` · ${esc(t('發布後不可修訂'))}` : ''}</dd><dt>${t('複審')}</dt><dd>${x.reviewEveryDays ? esc(t('每 {n} 天', { n: x.reviewEveryDays })) : '—'}</dd><dt>${t('客體種類')}</dt><dd>${esc(tv(x.objectKind) || '—')}</dd><dt>${t('預設文件夾')}</dt><dd>${esc(x.defaultFolder || '—')}</dd></dl>
    <h3 class="dialog-h">${t('欄位')}</h3>${table(['key', t('名稱'), t('類型'), t('必填'), t('說明')], x.fields.map(f => `<tr><td class="mono">${esc(f.key)}</td><td>${esc(f.labelText)}</td><td>${esc(t(FIELD_TYPE_TEXT[f.type] || f.type))}</td><td>${f.required ? t('是') : ''}</td><td class="wrap-sm">${[f.options ? Object.values(f.optionLabels || {}).join(' / ') : '', f.subjectTypes?.length ? f.subjectTypes.map(s => tv(s)).join(' / ') : '', f.link ? t('自動關聯') : ''].filter(Boolean).map(esc).join(' · ')}</td></tr>`), t('沒有欄位'))}
    <h3 class="dialog-h">${t('章節')}</h3>${table([t('章節'), t('必填'), t('提示')], x.sections.map(s => `<tr><td>${esc(s.headingText)}</td><td>${s.required ? t('是') : ''}</td><td class="wrap">${esc(s.guidanceText || '')}</td></tr>`))}
    <h3 class="dialog-h">${t('生成的正文骨架')}</h3><pre class="mono-block">${esc(r.data.body)}</pre>`);
}

async function templateEditor(id) {
  const source = id ? (await get(`/api/v1/doc-templates/${enc(id)}?source=1`)).data.source : {
    name: '新模板', purpose: '管理', objectKind: '知識文檔', approval: 'owner', reviewEveryDays: 180, immutable: false, defaultFolder: '通用', description: '一句話說明什麼時候用這個模板',
    fields: [{ key: 'effectiveFrom', label: '生效日期', type: 'date', required: true }],
    sections: [{ heading: '目的', required: true, guidance: '為什麼需要這份文檔' }, { heading: '內容', required: true }]
  };
  const { id: _id, ...editable } = source || {};
  modal(id ? t('編輯模板 {id}', { id }) : t('新增模板'), `<p class="notice">${t('模板以 JSON 編輯，保存到知識倉庫的 doc-templates/。名稱、欄位名、章節名用繁體原文；i18n 可選填簡體與英文譯名。已有文檔的欄位不會被改寫。')}</p>${field('JSON', textarea('json', JSON.stringify(editable, null, 2), 'class="code" spellcheck="false" rows="18"'))}`, {
    label: t('保存'),
    run: async () => {
      let body;
      try { body = JSON.parse($('#dialog-content [name=json]').value); } catch (err) { throw new Error(t('JSON 格式不正確：{error}', { error: err.message })); }
      const r = id ? await put(`/api/v1/doc-templates/${enc(id)}`, body) : await post('/api/v1/doc-templates', body);
      toast(t('已保存模板 {id}', { id: r.data.id }));
      cache.templates = null;
      ctx.render();
    }
  });
}

// ------------------------------------------------------------------ 標籤頁
async function pageTags() {
  const d = await loadTags(true);
  const owner = isOwner();
  setActions(owner ? `<button class="button" id="tag-merge">${t('合併標籤')}</button>` : '');
  const groups = [...new Set(d.tags.map(x => x.group || ''))].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  const row = x => `<tr><td>${docTag(x.name)}</td><td class="wrap-sm">${esc(x.description || '—')}</td><td class="numeric"><a href="#docs?tag=${enc(x.name)}">${x.count}</a></td><td>${x.lastUsedAt ? ago(x.lastUsedAt) : '—'}</td><td>${owner ? `<div class="cell-actions"><button type="button" class="text-btn" data-tag-edit="${esc(x.name)}">${t('編輯')}</button><button type="button" class="text-btn" data-tag-merge="${esc(x.name)}">${t('合併到…')}</button></div>` : ''}</td></tr>`;
  const head = [t('標籤'), t('說明'), '#' + t('文檔'), t('最近使用'), t('操作')];
  const rare = d.tags.filter(x => x.count <= 1);
  const merged = Object.entries(d.merged || {});
  content().innerHTML = `<div class="two-col" id="tags-root"><div class="stack">${groups.map(g => panel(esc(g || t('未分組')), table(head, d.tags.filter(x => (x.group || '') === g).map(row)))).join('') || panel(t('標籤'), `<div class="panel-body muted">${t('還沒有標籤：在文檔上加標籤後會自動出現在這裡。')}</div>`)}</div>
    <div class="stack">${panel(t('只用過一次或未使用（{n}）', { n: rare.length }), `<div class="panel-body"><p class="muted small">${t('用得很少的標籤通常是拼寫不一或重複，可以合併到常用的標籤。')}</p><div class="chip-row" style="margin-top:8px">${rare.map(x => `${docTag(x.name)}<small class="muted">${x.count}</small>`).join(' ') || '—'}</div></div>`)}
    ${panel(t('合併與重命名記錄'), merged.length ? table([t('舊名'), t('現在')], merged.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${docTag(b)}</td></tr>`)) : `<div class="panel-body muted">${t('還沒有合併或重命名過。舊名在搜索和篩選中繼續可用。')}</div>`)}
    ${panel(t('說明'), `<div class="panel-body"><ul class="tips"><li>${t('貢獻者可以新增標籤，新標籤自動加入字典（未分組）。')}</li><li>${t('負責人可以設定分組、顏色和說明；重命名和合併會改寫所有用到它的文檔，一次提交。')}</li><li>${t('比對時忽略大小寫和首尾空格。')}</li></ul></div>`)}</div></div>`;
  const groupList = `<datalist id="tag-groups">${[...new Set(d.tags.map(x => x.group).filter(Boolean))].map(g => `<option value="${esc(g)}">`).join('')}</datalist>`;
  const editDialog = name => {
    const x = d.tags.find(y => y.name === name);
    modal(t('編輯標籤 {name}', { name }), `${groupList}${field(t('名稱（改名會改寫 {n} 篇文檔）', { n: x.count }), input('newName', x.name, 'required maxlength="30"'))}<div class="field-pair">${field(t('分組'), input('group', x.group || '', 'list="tag-groups"'))}${field(t('顏色'), select('color', [['', t('預設')], ...d.colors.map(c => [c, c])], x.color || ''))}</div>${field(t('說明'), input('description', x.description || ''))}`, {
      label: t('保存'),
      run: async () => { const r = await put(`/api/v1/doc-tags/${enc(name)}`, formData($('#dialog-content'))); toast(r.data.renamed ? t('已重命名，改寫了 {n} 篇文檔', { n: r.data.renamed.docs }) : t('已保存')); cache.tags = null; ctx.render(); }
    });
  };
  const mergeDialog = from => {
    modal(t('合併標籤'), `${tagDatalist()}<p class="notice">${t('把選中的標籤合併到目標標籤：所有用到它們的文檔一起改寫，一次提交；舊名記入合併記錄，繼續可用。')}</p>${field(t('合併這些標籤'), `<select name="from" multiple size="${Math.min(8, Math.max(3, d.tags.length))}">${d.tags.map(x => `<option value="${esc(x.name)}" ${x.name === from ? 'selected' : ''}>${esc(x.name)}（${x.count}）</option>`).join('')}</select>`)}${field(t('合併到'), input('to', '', 'required list="tag-options"'))}`, {
      label: t('合併'),
      run: async () => { const f = formData($('#dialog-content')); const r = await post('/api/v1/doc-tags/merge', { from: f.from, to: f.to.trim() }); toast(t('已合併到「{to}」，改寫了 {n} 篇文檔', { to: r.data.to, n: r.data.docs })); cache.tags = null; ctx.render(); }
    });
  };
  $('#tags-root').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b?.dataset.tagEdit) editDialog(b.dataset.tagEdit);
    if (b?.dataset.tagMerge) mergeDialog(b.dataset.tagMerge);
  });
  $('#tag-merge')?.addEventListener('click', () => mergeDialog(null));
}

// ------------------------------------------------------------------ 其他頁面用到的部件
/** 主體頁「相關文檔」面板。 */
export function subjectDocsPanel(s, docs = []) {
  const rows = docs.map(d => `<tr><td>${idLink(d.id)}</td><td class="wrap"><a href="#doc/${esc(d.id)}">${esc(d.title)}</a><span class="cell-sub">${esc(tplLabel(d.template, d.templateName))} · ${esc(d.folder)}</span></td><td>${d.relation === 'binding' ? `${pill(t('以它為依據'), 'blue')} ${level(d.level)}` : pill(t('提到它'))}</td><td>${statusBadges(d, { review: false })}</td></tr>`);
  return panel(t('相關文檔（{n}）', { n: docs.length }), table(['ID', t('標題'), t('關係'), t('狀態')], rows, t('還沒有文檔關聯這個主體')), canWrite() ? `<button type="button" class="text-btn" id="write-doc" data-subject="${esc(s.id)}" data-domain="${esc(s.domain || '')}">${t('為這個主體寫文檔')}</button>` : '');
}

/** 客體頁：由文檔庫管理的提示與相關文檔。 */
export function objectDocsHtml(o) {
  const managed = o.managedBy ? `<div class="notice" style="margin-bottom:12px">${esc(t('這個客體由文檔庫管理：'))}${refChip(o.managedBy.id, { label: `《${o.managedBy.title}》`, state: o.managedBy.status === '已廢止' ? 'e1' : 'ok' })} ${o.managedBy.version ? `v${esc(o.managedBy.version)}` : esc(tv(o.managedBy.status))}${esc(t('。名稱和狀態隨文檔變化；要下線請廢止文檔。'))}</div>` : '';
  const docs = (o.documents || []).length ? panel(t('相關文檔（{n}）', { n: o.documents.length }), table(['ID', t('標題'), t('關係'), t('狀態')], o.documents.map(d => `<tr><td>${idLink(d.id)}</td><td class="wrap"><a href="#doc/${esc(d.id)}">${esc(d.title)}</a></td><td>${d.relation === 'own' ? pill(t('本文檔的客體'), 'blue') : pill(t('提到它'))}</td><td>${statusBadges(d, { review: false })}</td></tr>`))) : '';
  return { managed, docs };
}

/** 健康指標頁的「文檔」面板。 */
export function docsDashboardPanel(h) {
  if (!h) return '';
  const rows = [[t('已發布'), h.published, '#docs'], [t('待審'), h.inReview, '#docs?view=review'], [t('草稿'), h.drafts, '#docs?view=mine'], [t('逾期複審'), h.reviewOverdue, '#docs?view=review-overdue'], [t('即將複審'), h.reviewSoon, '#docs?view=review-soon'], [t('引用了失效知識'), h.brokenRefs, '#docs?view=broken-refs'], [t('未關聯'), h.unlinked, '#docs?view=unlinked'], [t('待登記'), h.unregistered, '#docs?view=unregistered'], [t('已廢止'), h.obsolete, '#docs?view=obsolete']];
  const warn = new Set([t('逾期複審'), t('引用了失效知識'), t('待審')]);
  return panel(t('文檔'), `<div class="panel-body"><dl class="kv">${rows.map(([k, v, href]) => `<dt>${esc(k)}</dt><dd><a href="${href}">${v && warn.has(k) ? `<span class="badge amber">${v}</span>` : v ?? 0}</a></dd>`).join('')}</dl></div>`, `<a class="text-btn" href="#docs">${t('文檔庫')}</a>`);
}

/** 重驗隊列、層級歷史的備註：「DOC-0001 v5 重大修訂：…」鏈接到該版本的差異。 */
export function docNoteHtml(note) {
  const text = esc(td(note) || '');
  return text.replace(/(DOC-\d+) v(\d+)/, (m, id, v) => `<a href="#doc/${id}?diff=${v}">${id} v${v}</a>`);
}

// ------------------------------------------------------------------ 註冊
export function registerDocPages(PAGES, context) {
  ctx = context;
  PAGES.docs = pageLibrary;
  PAGES.doc = pageDoc;
  PAGES['doc-edit'] = pageEdit;
  PAGES['doc-templates'] = pageTemplates;
  PAGES['doc-tags'] = pageTags;
  bindGlobalInputs();
  document.addEventListener('click', e => {
    const b = e.target.closest('#write-doc');
    if (b) openNewDoc({ subjects: [b.dataset.subject], domain: b.dataset.domain || undefined }).catch(showError);
    // 點選選單外時收起下拉選單
    if (!e.target.closest('details.menu')) $$('details.menu[open]').forEach(x => x.removeAttribute('open'));
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && editor && $('#doc-editor')) { e.preventDefault(); editor.save(); }
  });
  window.addEventListener('beforeunload', e => { if (editor?.dirty && $('#doc-editor')) { e.preventDefault(); e.returnValue = ''; } });
  // 編輯器有未保存的修改時，離開前確認（先於 app.js 的路由監聽執行）
  window.addEventListener('hashchange', e => {
    if (editor?.dirty && $('#doc-editor') && !location.hash.startsWith(`#doc-edit/${editor.id}`)) {
      if (!window.confirm(t('有未保存的修改，確定離開嗎？（內容已暫存在瀏覽器裡）'))) {
        e.stopImmediatePropagation();
        history.replaceState(null, '', e.oldURL);
        return;
      }
      editor.stash?.();
      editor = null;
    }
  });
}
