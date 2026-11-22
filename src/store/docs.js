// 文檔庫：知識倉庫 docs/ 下的 Markdown 文檔（YAML front matter + 正文），設計見 docs/design/document-library.md。
// 文件夾就是 Git 目錄；已發布的當前版本在 docs/<文件夾>/DOC-xxxx-<標題>.md，草稿與修訂在 docs/_drafts/DOC-xxxx.md。
// 記憶體中按 ID 索引；所有寫入都在 KnowledgeStore.tx 內完成（t.writeRaw / t.removeRaw），一次操作一次提交。
// 寫入倉庫的內容（狀態、層級歷史備註、提交說明）保持繁體原文；返回給調用方的訊息經 tr() 按請求語言翻譯。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { RuleError, sourceOf, demoteToL1 } from './validity.js';
import { OBJECT_CATEGORIES, ID_PREFIX, kindOfId, ASSERTION_TYPES } from './model.js';
import { normalizeTemplate, checkFields, skeleton, localizeTemplate, HANDBOOK_TEMPLATE } from './doc-templates.js';
import { lintDoc, hasErrors } from '../services/doc-lint.js';
import { DocSearch } from '../services/doc-search.js';
import { parseSections, extractRefs } from '../../web/assets/markdown.js';
import { tr } from '../i18n/index.js';
import { renderHandbook } from '../services/doc-generate.js';

export const DOCS = 'docs';
export const DRAFTS = 'docs/_drafts';
export const ASSETS = 'docs/_assets';
export const TAGS_FILE = 'docs/_tags.yaml';
export const FOLDER_FILE = '_folder.yaml';
export const DEFAULT_FOLDER = '通用';
export const MAX_DEPTH = 5;
export const MAX_BODY = 1024 * 1024;
export const ASSET_MAX = 2 * 1024 * 1024;
export const ASSET_TOTAL = 20 * 1024 * 1024;
export const ASSET_TYPES = { 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/gif': ['gif'], 'image/webp': ['webp'] };
export const TAG_COLORS = ['gray', 'blue', 'green', 'amber', 'red', 'purple'];
export const VIEWS = ['mine', 'review', 'recent', 'review-soon', 'review-overdue', 'broken-refs', 'unlinked', 'unregistered', 'obsolete'];
const DAY = 86400000;

const META_ORDER = ['id', 'title', 'template', 'status', 'version', 'summary', 'tags', 'owner', 'ownerIds', 'subjects', 'objects', 'related', 'objectId', 'fields', 'review', 'change',
  'generated', 'aiDraft', 'editors', 'folder', 'startVersion', 'baseVersion', 'reviewNote', 'submittedAt', 'submittedBy', 'replacedBy', 'obsoleteReason', 'obsoleteAt', 'obsoleteBy', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'];
const LIST_KEYS = ['tags', 'ownerIds', 'subjects', 'objects', 'related'];

const nowIso = () => new Date().toISOString();
const clean = v => (typeof v === 'string' ? v.trim() : v);
const uniq = list => [...new Set(list)];
const etagOf = raw => crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
const dateOnly = ms => new Date(ms).toISOString().slice(0, 10);
const fail = (status, code, message, extra = {}) => Object.assign(new RuleError(message, status, code), extra);
const idList = v => (Array.isArray(v) ? v : v ? String(v).split(/[,，\s]+/) : []).map(x => String(x).trim()).filter(Boolean);
/** 這一版的編寫者（四眼原則用）：草稿的建立者（從未發布時）、每個保存過的人、提交人。 */
const addEditor = (list, by) => [...(Array.isArray(list) ? list : []).filter(x => x?.id !== by.id), by];
export function authorsOf(meta, { firstVersion = false } = {}) {
  const ids = new Set((Array.isArray(meta.editors) ? meta.editors : []).map(x => x?.id).filter(Boolean));
  if (meta.updatedBy?.id) ids.add(meta.updatedBy.id);
  if (meta.submittedBy?.id) ids.add(meta.submittedBy.id);
  if (firstVersion && meta.createdBy?.id) ids.add(meta.createdBy.id);
  return [...ids];
}
/** sourceRef 指向本文檔的章節：DOC-0001§計算公式 v4 → 計算公式。 */
export function sectionOfSourceRef(ref, docId) {
  const m = /^(DOC-\d+)§(.+?)(?:\s+v(\d+))?$/.exec(String(ref || '').trim());
  return m && (!docId || m[1] === docId) ? { docId: m[1], heading: m[2].trim(), version: m[3] ? Number(m[3]) : null } : null;
}
const sameText = (a, b) => String(a || '').replace(/[\s，。、；：,.;:！!？?（）()「」『』"'“”‘’]/g, '').toLowerCase() === String(b || '').replace(/[\s，。、；：,.;:！!？?（）()「」『』"'“”‘’]/g, '').toLowerCase();

// ---------------------------------------------------------------- 檔案格式
/** 解析文檔檔案：返回 { meta, body }；沒有 front matter 時 meta 為 null。front matter 不是合法 YAML 時拋錯。 */
export function parseDocFile(text) {
  const s = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(s);
  if (!m) return { meta: null, body: s };
  const meta = YAML.parse(m[1]);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { meta: null, body: s };
  return { meta, body: m[2].replace(/^\n+/, '') };
}

export function serializeDoc(meta, body) {
  const ordered = {};
  const put = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v) && !v.length) return;
    if (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) return;
    ordered[k] = v;
  };
  for (const k of META_ORDER) put(k, meta[k]);
  for (const [k, v] of Object.entries(meta)) if (!META_ORDER.includes(k)) put(k, v);
  return `---\n${YAML.stringify(ordered, { lineWidth: 0 })}---\n\n${String(body ?? '').replace(/^\n+/, '').replace(/\s+$/, '')}\n`;
}

function normalizeMeta(meta) {
  const m = { ...meta };
  for (const k of LIST_KEYS) m[k] = idList(m[k]);
  m.fields = m.fields && typeof m.fields === 'object' && !Array.isArray(m.fields) ? m.fields : {};
  if (m.title !== undefined) m.title = String(m.title);
  return m;
}

/** 文件夾路徑 docs/庫存/口徑 → 庫存/口徑；檔案路徑取其所在目錄。 */
export const folderOfDir = rel => rel.replace(/^docs\/?/, '');
export const folderOfPath = rel => folderOfDir(path.posix.dirname(rel));

const ILLEGAL = /[/\\:*?"<>|\u0000-\u001f]/;
const ILLEGAL_G = /[/\\:*?"<>|\u0000-\u001f]/g;

/** 文件夾名規則（§4.6）。 */
export function checkFolderName(name) {
  const s = String(name ?? '');
  const bad = message => fail(400, 'invalid_folder', message);
  if (!s.trim()) throw bad(tr('文件夾名不能為空'));
  if (ILLEGAL.test(s)) throw bad(tr('文件夾名「{name}」不能包含 / \\ : * ? " < > |', { name: s }));
  if (/^[._ ]/.test(s) || /[. ]$/.test(s)) throw bad(tr('文件夾名「{name}」不能以 .、_ 或空格開頭，不能以 . 或空格結尾', { name: s }));
  if ([...s].length > 40) throw bad(tr('文件夾名「{name}」最長 40 字', { name: s }));
  if (s.toLowerCase() === 'readme.md') throw bad(tr('「{name}」是保留名', { name: s }));
  return s;
}

export function normalizeFolderPath(p) {
  const raw = String(p ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!raw) throw fail(400, 'invalid_folder', tr('文件夾不能為空'));
  const parts = raw.split('/');
  parts.forEach(checkFolderName);
  if (parts.length > MAX_DEPTH) throw fail(400, 'invalid_folder', tr('文件夾最多 {n} 層', { n: MAX_DEPTH }));
  return parts.join('/');
}

export const fileNameFor = (id, title) => `${id}-${String(title).replace(ILLEGAL_G, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'untitled'}.md`;

export const DOCS_README = `# 文檔庫

本目錄由「供應鏈技術知識體系」服務的文檔庫維護，也可以直接在 Git 中瀏覽與修改。

| 路徑 | 內容 |
| --- | --- |
| \`<文件夾>/DOC-0001-<標題>.md\` | 已發布文檔的當前版本。文件夾就是目錄，最多 5 層 |
| \`<文件夾>/_folder.yaml\` | 文件夾說明、預設模板、預設標籤、預設審閱人 |
| \`_drafts/DOC-0001.md\` | 未發布的草稿，或已發布文檔正在修訂的下一版 |
| \`_assets/DOC-0001/\` | 文檔圖片（PNG、JPEG、GIF、WebP） |
| \`_tags.yaml\` | 標籤字典：分組、顏色、說明、合併記錄 |

- 每個檔案開頭是 YAML front matter（\`id\`、\`title\`、\`template\`、\`status\`、\`version\` 等），之後是 Markdown 正文。
- 系統以 front matter 的 \`id\` 為準；檔名只是為了在 Git 中好認。移動、重命名檔案不影響鏈接。
- 版本歷史就是已發布檔案的 \`git log --follow\`；每次發布版本號加 1。
- 在文件夾裡放入沒有 front matter 的 \`.md\`，會出現在後台「待登記」視圖。
- \`_\` 開頭的名稱和 \`README.md\` 是保留名。
`;

// ---------------------------------------------------------------- 文檔庫
export class DocLibrary {
  constructor(store) {
    this.store = store;
    this.search = new DocSearch(this);
    this.reset();
  }

  reset() {
    this.docs = new Map();
    this.folders = new Map();
    this.tags = {};
    this.merged = {};
    this.unregistered = [];
    this.search?.clear();
  }

  get templates() { return this.store.docTemplates; }
  has(id) { return this.docs.has(id); }

  // ------------------------------------------------------------ 載入
  async load() {
    this.reset();
    const st = this.store;
    try {
      const t = YAML.parse(await fs.readFile(path.join(st.root, TAGS_FILE), 'utf8')) || {};
      const { merged, ...rest } = t;
      for (const [name, v] of Object.entries(rest)) this.tags[name] = v && typeof v === 'object' ? v : {};
      this.merged = merged && typeof merged === 'object' ? merged : {};
    } catch (err) {
      if (err.code !== 'ENOENT') st.loadErrors.push({ file: TAGS_FILE, error: err.message });
    }
    const readText = async rel => fs.readFile(path.join(st.root, rel), 'utf8');
    const walk = async rel => {
      let entries;
      try { entries = await fs.readdir(path.join(st.root, rel), { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (rel === DOCS && e.name === '_drafts') await this.loadDrafts(child);
          else if (!e.name.startsWith('_') && !e.name.startsWith('.')) {
            if (!this.folders.has(folderOfDir(child))) this.folders.set(folderOfDir(child), {});
            await walk(child);
          }
        } else if (e.name === FOLDER_FILE && rel !== DOCS) {
          try { this.folders.set(folderOfDir(rel), normalizeFolderSettings(YAML.parse(await readText(child)) || {})); } catch (err) { st.loadErrors.push({ file: child, error: err.message }); }
        } else if (e.name.endsWith('.md') && e.name !== 'README.md') {
          await this.loadPublished(child, await readText(child));
        }
      }
    };
    await walk(DOCS);
    for (const id of this.docs.keys()) st.bumpCounter(id);
  }

  async loadPublished(rel, text) {
    const st = this.store;
    let parsed;
    try { parsed = parseDocFile(text); } catch (err) { st.loadErrors.push({ file: rel, error: tr('front matter 不是合法的 YAML：{error}', { error: err.message }) }); return; }
    if (!parsed.meta?.id) {
      const heading = /^#{1,3}\s+(.+)$/m.exec(parsed.body)?.[1];
      this.unregistered.push({ path: rel, folder: rel.split('/').length > 2 ? folderOfPath(rel) : null, title: clean(heading) || path.posix.basename(rel, '.md'), size: text.length });
      return;
    }
    const id = String(parsed.meta.id);
    if (kindOfId(id) !== 'doc') { st.loadErrors.push({ file: rel, error: tr('文檔 ID {id} 格式不正確（應為 DOC-0001）', { id }) }); return; }
    const doc = this.docs.get(id) || { id, pub: null, draft: null };
    if (doc.pub) {
      // 重複 ID：檔名按規範以 ID 開頭的那份為準（例如在 Git 中複製出的副本不會頂替原文檔）
      const canonical = f => path.posix.basename(f).startsWith(`${id}-`) || path.posix.basename(f) === `${id}.md`;
      if (!canonical(rel) || canonical(doc.pub.path)) { st.loadErrors.push({ file: rel, error: tr('文檔 ID {id} 與 {other} 重複，已忽略', { id, other: doc.pub.path }) }); return; }
      st.loadErrors.push({ file: doc.pub.path, error: tr('文檔 ID {id} 與 {other} 重複，已忽略', { id, other: rel }) });
    }
    const meta = normalizeMeta(parsed.meta);
    if (!['已發布', '已廢止'].includes(meta.status)) meta.status = '已發布';
    doc.pub = { path: rel, meta, body: parsed.body, etag: etagOf(text) };
    this.docs.set(id, doc);
  }

  async loadDrafts(rel) {
    const st = this.store;
    let names = [];
    try { names = (await fs.readdir(path.join(st.root, rel))).filter(n => n.endsWith('.md')).sort(); } catch { return; }
    for (const name of names) {
      const file = `${rel}/${name}`;
      const text = await fs.readFile(path.join(st.root, file), 'utf8');
      let parsed;
      try { parsed = parseDocFile(text); } catch (err) { st.loadErrors.push({ file, error: tr('front matter 不是合法的 YAML：{error}', { error: err.message }) }); continue; }
      const id = parsed.meta?.id ? String(parsed.meta.id) : null;
      if (!id || kindOfId(id) !== 'doc') { st.loadErrors.push({ file, error: tr('草稿缺少 id 或格式不正確') }); continue; }
      const doc = this.docs.get(id) || { id, pub: null, draft: null };
      if (doc.draft) { st.loadErrors.push({ file, error: tr('文檔 ID {id} 與 {other} 重複，已忽略', { id, other: doc.draft.path }) }); continue; }
      const meta = normalizeMeta(parsed.meta);
      if (!['草稿', '待審'].includes(meta.status)) meta.status = '草稿';
      doc.draft = { path: file, meta, body: parsed.body, etag: etagOf(text) };
      this.docs.set(id, doc);
    }
  }

  // ------------------------------------------------------------ 查詢輔助
  get(id) {
    const d = this.docs.get(id);
    if (!d) throw fail(404, 'not_found', tr('找不到文檔 {id}', { id }));
    return d;
  }

  getTemplate(id) {
    const tpl = this.templates.get(id);
    if (!tpl) throw fail(422, 'unknown_template', tr('模板 {id} 不存在', { id }));
    return tpl;
  }

  statusOf(doc) { return doc.pub ? doc.pub.meta.status : doc.draft.meta.status; }
  revisionOf(doc) { return doc.pub && doc.draft ? (doc.draft.meta.status === '待審' ? '修訂待審' : '修訂中') : null; }
  folderOf(doc) { return doc.pub ? folderOfPath(doc.pub.path) : doc.draft.meta.folder || DEFAULT_FOLDER; }
  head(doc) { return doc.pub || doc.draft; }
  canSeeDrafts(p) { return !!p && (p.isAdmin || p.kind === 'pipeline' || ['contributor', 'owner'].includes(p.role)); }

  /** 文件夾的設定，未設定的項沿用上層文件夾。 */
  folderDefaults(folder) {
    const out = { defaultTemplate: null, defaultTags: [], ownerIds: [], domain: null };
    const parts = String(folder || '').split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const s = this.folders.get(parts.slice(0, i).join('/'));
      if (!s) continue;
      if (s.defaultTemplate) out.defaultTemplate = s.defaultTemplate;
      if (s.defaultTags?.length) out.defaultTags = s.defaultTags;
      if (s.ownerIds?.length) out.ownerIds = s.ownerIds;
      if (s.domain) out.domain = s.domain;
    }
    return out;
  }

  reviewersOf(doc) {
    const own = this.head(doc).meta.ownerIds;
    return own?.length ? own : this.folderDefaults(this.folderOf(doc)).ownerIds;
  }

  /** 已有的文件夾（大小寫不敏感）；返回規範寫法或 null。 */
  findFolder(folder) {
    const lower = folder.toLowerCase();
    for (const f of this.allFolders()) if (f.toLowerCase() === lower) return f;
    return null;
  }

  allFolders() {
    const set = new Set(this.folders.keys());
    for (const d of this.docs.values()) {
      const f = this.folderOf(d);
      const parts = f.split('/');
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  assertUniqueTitle(folder, title, selfId) {
    const lower = title.toLowerCase();
    for (const d of this.docs.values()) {
      if (d.id === selfId) continue;
      if (this.folderOf(d).toLowerCase() !== folder.toLowerCase()) continue;
      const titles = [d.pub?.meta.title, d.draft?.meta.title].filter(Boolean);
      if (titles.some(x => x.toLowerCase() === lower)) throw fail(409, 'duplicate_title', tr('文件夾「{folder}」已有同名文檔 {id}《{title}》', { folder, id: d.id, title }));
    }
  }

  checkTitle(title) {
    const s = clean(title);
    if (!s) throw fail(400, 'invalid_input', tr('文檔標題必填'));
    if (/[\u0000-\u001f]/.test(s)) throw fail(400, 'invalid_title', tr('標題不能包含換行或控制字元'));
    if ([...s].length > 40) throw fail(400, 'invalid_title', tr('標題最長 40 字'));
    return s;
  }

  // ------------------------------------------------------------ 權限
  assertHuman(p, message) {
    if (!p) throw fail(401, 'unauthorized', tr('需要身份驗證'));
    this.store.assertCanContribute(p);
    if (p.kind !== 'human') throw fail(403, 'forbidden', message);
  }

  assertReviewer(p, doc) {
    if (!p) throw fail(401, 'unauthorized', tr('需要身份驗證'));
    if (p.kind === 'agent' || p.kind === 'pipeline') throw fail(403, 'agent_cannot_publish', tr('智能體和管道不能發布、審閱或廢止文檔；請提交審閱，由人發布'));
    if (!p.isAdmin && p.role !== 'owner') throw fail(403, 'forbidden', tr('只有負責人可以執行此操作'));
    const ids = doc ? this.reviewersOf(doc) : [];
    if (!p.isAdmin && ids.length && !ids.includes(p.id)) throw fail(403, 'forbidden', tr('你不是 {id} 的指定負責人', { id: doc.id }));
  }

  assertOwnerRole(p) {
    if (!p) throw fail(401, 'unauthorized', tr('需要身份驗證'));
    if (p.kind === 'agent' || p.kind === 'pipeline') throw fail(403, 'forbidden', tr('只有負責人（人）可以執行此操作'));
    if (!p.isAdmin && p.role !== 'owner') throw fail(403, 'forbidden', tr('只有負責人可以執行此操作'));
  }

  assertCanPublish(p, tpl, doc) {
    if (!p) throw fail(401, 'unauthorized', tr('需要身份驗證'));
    if (p.kind === 'agent' || p.kind === 'pipeline') throw fail(403, 'agent_cannot_publish', tr('智能體和管道不能發布、審閱或廢止文檔；請提交審閱，由人發布'));
    if (tpl.approval === 'owner') {
      if (!p.isAdmin && p.role !== 'owner') throw fail(403, 'approval_required', tr('模板「{name}」的文檔要由負責人審閱後發布；請提交審閱', { name: tpl.name }));
      this.assertReviewer(p, doc);
    } else this.store.assertCanContribute(p);
  }

  // ------------------------------------------------------------ 視圖
  templateBrief(id) {
    const tpl = this.templates.get(id);
    if (!tpl) return { id, missing: true };
    const v = localizeTemplate(tpl);
    return { id, name: tpl.name, label: v.label, purpose: tpl.purpose, approval: tpl.approval, immutable: !!tpl.immutable, requireOtherApprover: !!tpl.requireOtherApprover, generator: tpl.generator || null };
  }

  /** 文檔摘要（列表、搜索結果）。side：pub 已發布版本、draft 草稿或修訂；預設有已發布版本時用它。 */
  summary(doc, side) {
    const e = side === 'draft' ? doc.draft || doc.pub : side === 'pub' ? doc.pub || doc.draft : this.head(doc);
    const m = e.meta;
    const pubM = doc.pub?.meta;
    const review = pubM?.review || null;
    const now = Date.now();
    const nextAt = review?.nextAt ? Date.parse(review.nextAt) : null;
    return {
      id: doc.id,
      title: m.title,
      template: m.template,
      templateInfo: this.templateBrief(m.template),
      status: this.statusOf(doc),
      revision: this.revisionOf(doc),
      draftStatus: doc.draft?.meta.status || null,
      side: e === doc.draft ? 'draft' : 'published',
      version: pubM?.version ?? null,
      summary: m.summary || null,
      tags: m.tags,
      owner: m.owner || null,
      ownerIds: m.ownerIds,
      subjects: m.subjects,
      objects: m.objects,
      related: m.related,
      objectId: pubM?.objectId || m.objectId || null,
      fields: m.fields,
      folder: this.folderOf(doc),
      review: review ? { ...review, overdue: nextAt !== null && nextAt < now, dueSoon: nextAt !== null && nextAt >= now && nextAt - now <= 14 * DAY } : null,
      change: pubM?.change || null,
      publishedAt: pubM?.change?.publishedAt || null,
      replacedBy: pubM?.replacedBy || null,
      obsoleteReason: pubM?.obsoleteReason || null,
      obsoleteAt: pubM?.obsoleteAt || null,
      generated: pubM?.generated ? { kind: pubM.generated.kind, target: pubM.generated.target } : null,
      aiDraft: doc.draft?.meta.aiDraft || null,
      createdAt: m.createdAt || null,
      createdBy: m.createdBy || null,
      updatedAt: m.updatedAt || pubM?.change?.publishedAt || null,
      updatedBy: m.updatedBy || null
    };
  }

  /** 讀一篇文檔（GET /docs/:id）。 */
  view(doc, { side = 'pub', principal } = {}) {
    const e = side === 'draft' ? doc.draft : doc.pub || (this.canSeeDrafts(principal) ? doc.draft : null);
    if (!e) throw fail(404, 'not_found', side === 'draft' ? tr('{id} 沒有草稿或修訂', { id: doc.id }) : tr('找不到文檔 {id}', { id: doc.id }));
    const s = this.summary(doc, e === doc.draft ? 'draft' : 'pub');
    const m = e.meta;
    const objectId = s.objectId;
    const obj = objectId ? this.store.objects.get(objectId) : null;
    const impact = this.impactOf(doc.pub?.meta.objectId || null);
    return {
      ...s,
      path: e.path,
      etag: e.etag,
      body: e.body,
      draft: doc.draft && this.canSeeDrafts(principal) ? { etag: doc.draft.etag, status: doc.draft.meta.status, updatedAt: doc.draft.meta.updatedAt || null, updatedBy: doc.draft.meta.updatedBy || null, reviewNote: doc.draft.meta.reviewNote || null, submittedAt: doc.draft.meta.submittedAt || null, submittedBy: doc.draft.meta.submittedBy || null, editors: doc.draft.meta.editors || [], aiDraft: doc.draft.meta.aiDraft || null } : null,
      generated: this.generatedState(doc),
      publishedEtag: doc.pub?.etag || null,
      startVersion: m.startVersion || null,
      baseVersion: m.baseVersion || null,
      nextVersion: doc.pub ? (doc.pub.meta.version || 0) + 1 : m.startVersion || 1,
      reviewNote: m.reviewNote || null,
      reviewers: this.reviewersOf(doc),
      object: obj ? { id: obj.id, name: obj.name, status: obj.status, kind: obj.kind, locator: obj.locator, managed: obj.docId === doc.id } : null,
      subjectInfo: s.subjects.map(id => this.store.subjectSummary(this.store.subjects.get(id)) || { id, missing: true }),
      objectInfo: s.objects.map(id => { const o = this.store.objects.get(id); return o ? { id, name: o.name, status: o.status, category: o.category } : { id, missing: true }; }),
      relatedInfo: s.related.map(id => { const d = this.docs.get(id); return d ? { id, title: this.head(d).meta.title, status: this.statusOf(d) } : { id, missing: true }; }),
      refs: this.refsOf(e.body),
      impact: { total: impact.length, byLevel: impact.reduce((acc, x) => ({ ...acc, [x.level]: (acc[x.level] || 0) + 1 }), {}) }
    };
  }

  /** 正文引用的條目及其當前狀態（渲染引用標籤用）。 */
  refsOf(body) {
    const out = {};
    for (const r of extractRefs(body)) if (!out[r.id]) out[r.id] = this.resolveRef(r.id);
    return out;
  }

  resolveRef(id) {
    const st = this.store;
    const kind = kindOfId(id);
    if (kind === 'subject') {
      const s = st.subjects.get(id);
      if (!s) return { id, kind, state: 'missing' };
      return { id, kind, label: s.name, level: s.type === '別名' ? null : st.subjectLevel(s), state: 'ok' };
    }
    if (kind === 'object') {
      const o = st.objects.get(id);
      if (!o) return { id, kind, state: 'missing' };
      return { id, kind, label: o.name, state: o.status === '下線' ? 'e1' : 'ok', status: o.status };
    }
    if (['assertion', 'binding', 'relation'].includes(kind)) {
      let ref;
      try { ref = st.getItem(id); } catch { return { id, kind, state: 'missing' }; }
      const v = ref.item.validity;
      const label = kind === 'assertion' ? ref.item.content : kind === 'binding' ? `${ref.subject?.name} ← ${st.objects.get(ref.item.objectId)?.name || ref.item.objectId}` : `${st.subjects.get(ref.item.from)?.name} –${ref.item.type}→ ${st.subjects.get(ref.item.to)?.name}`;
      return { id, kind, label: label.length > 40 ? `${label.slice(0, 39)}…` : label, title: label, level: v.level, state: v.level === 'E1' ? 'e1' : 'ok', replacedBy: v.replacedBy || null };
    }
    if (kind === 'doc') {
      const d = this.docs.get(id);
      if (!d || !d.pub) return { id, kind, state: 'missing', label: d ? this.head(d).meta.title : undefined };
      const m = d.pub.meta;
      return { id, kind, label: m.title, version: m.version, state: m.status === '已廢止' ? 'e1' : 'ok', replacedBy: m.replacedBy || null, anchors: parseSections(d.pub.body).filter(s => s.level).map(s => s.anchor) };
    }
    return { id, kind, state: 'missing' };
  }

  /** 以文檔客體為依據的知識：綁定該客體的綁定、證據含該客體的斷言和關係（不含 E1）。 */
  impactOf(objectId) {
    if (!objectId) return [];
    const st = this.store;
    const out = [];
    for (const ref of st.allValidityItems()) {
      const v = ref.item.validity;
      if (v.level === 'E1') continue;
      const uses = ref.kind === 'binding' ? ref.item.objectId === objectId : v.evidence.objectIds.includes(objectId);
      if (!uses) continue;
      const it = ref.item;
      out.push({
        id: it.id, kind: ref.kind, level: v.level, pending: v.pending?.reason || null,
        subject: st.subjectSummary(ref.subject),
        type: it.type || null,
        content: ref.kind === 'assertion' ? it.content : null,
        objectId: ref.kind === 'binding' ? it.objectId : null,
        sourceRef: ref.kind === 'binding' ? null : v.evidence.sourceRef || null,
        from: ref.kind === 'relation' ? st.subjectSummary(st.subjects.get(it.from)) : null,
        to: ref.kind === 'relation' ? st.subjectSummary(st.subjects.get(it.to)) : null
      });
    }
    return out.sort((a, b) => (a.subject?.id || '').localeCompare(b.subject?.id || '') || a.id.localeCompare(b.id));
  }

  /** 知識卡的 documents：以文檔客體為依據（綁定）或關聯了該主體的已發布文檔。 */
  documentsFor(subjectId) {
    const s = this.store.subjects.get(subjectId);
    if (!s) return [];
    const bound = new Map(s.bindings.map(b => [b.objectId, b]));
    const out = [];
    for (const d of this.docs.values()) {
      if (!d.pub) continue;
      const m = d.pub.meta;
      const b = m.objectId ? bound.get(m.objectId) : null;
      const linked = m.subjects.includes(subjectId);
      if (!b && !linked) continue;
      out.push({ id: d.id, title: m.title, template: m.template, templateName: this.templates.get(m.template)?.name || null, status: m.status, version: m.version ?? null, summary: m.summary || null, folder: this.folderOf(d), relation: b ? 'binding' : 'link', bindingId: b?.id || null, level: b?.validity.level || null, linked, ...(m.generated ? { generated: true } : {}) });
    }
    return out.sort((a, b) => (a.relation === b.relation ? a.id.localeCompare(b.id) : a.relation === 'binding' ? -1 : 1));
  }

  documentsForObject(objectId) {
    const out = [];
    for (const d of this.docs.values()) {
      if (!d.pub) continue;
      const m = d.pub.meta;
      if (m.objectId === objectId || m.objects.includes(objectId)) out.push({ id: d.id, title: m.title, status: m.status, version: m.version ?? null, relation: m.objectId === objectId ? 'own' : 'link' });
    }
    return out;
  }

  managedInfo(object) {
    if (!object?.docId) return null;
    const d = this.docs.get(object.docId);
    if (!d) return { id: object.docId, missing: true };
    const m = this.head(d).meta;
    return { id: d.id, title: m.title, status: this.statusOf(d), version: d.pub?.meta.version ?? null };
  }

  // ------------------------------------------------------------ 標籤
  canonicalTag(name) {
    let n = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!n) return null;
    for (let i = 0; i < 5; i++) {
      const hit = Object.keys(this.merged).find(k => k.toLowerCase() === n.toLowerCase());
      if (!hit) break;
      n = this.merged[hit];
    }
    return Object.keys(this.tags).find(k => k.toLowerCase() === n.toLowerCase()) || n;
  }

  normalizeTags(list) {
    const out = [];
    const seen = new Set();
    for (const raw of idList(Array.isArray(list) ? list : String(list || '').split(/[,，]/))) {
      const n = this.canonicalTag(raw);
      if (!n) continue;
      if ([...n].length > 30) throw fail(400, 'invalid_input', tr('標籤「{tag}」最長 30 字', { tag: n }));
      if (seen.has(n.toLowerCase())) continue;
      seen.add(n.toLowerCase());
      out.push(n);
    }
    return out;
  }

  /** 新標籤自動加入字典（未分組）。 */
  ensureTags(t, tags) {
    let changed = false;
    for (const n of tags) if (!Object.keys(this.tags).some(k => k.toLowerCase() === n.toLowerCase())) { this.tags[n] = {}; changed = true; }
    if (changed) this.writeTags(t);
  }

  writeTags(t) {
    const out = {};
    for (const k of Object.keys(this.tags).sort((a, b) => a.localeCompare(b))) {
      const v = Object.fromEntries(Object.entries(this.tags[k] || {}).filter(([, x]) => x !== null && x !== undefined && x !== ''));
      out[k] = v;
    }
    if (Object.keys(this.merged).length) out.merged = this.merged;
    t.writeRaw(TAGS_FILE, YAML.stringify(out, { lineWidth: 0, flowCollectionPadding: true }).replace(/: \{\}\n/g, ': {}\n'));
  }

  listTags() {
    const stats = new Map();
    for (const d of this.docs.values()) {
      for (const e of [d.pub, d.draft].filter(Boolean)) {
        for (const tg of e.meta.tags) {
          const key = this.canonicalTag(tg);
          const s = stats.get(key) || { docs: new Set(), lastUsedAt: null };
          s.docs.add(d.id);
          const at = e.meta.updatedAt || e.meta.change?.publishedAt || e.meta.createdAt;
          if (at && (!s.lastUsedAt || at > s.lastUsedAt)) s.lastUsedAt = at;
          stats.set(key, s);
        }
      }
    }
    const names = uniq([...Object.keys(this.tags), ...stats.keys()]);
    return {
      tags: names.map(name => ({ name, ...(this.tags[name] || {}), count: stats.get(name)?.docs.size || 0, lastUsedAt: stats.get(name)?.lastUsedAt || null })).sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.name.localeCompare(b.name)),
      merged: this.merged,
      colors: TAG_COLORS
    };
  }

  /** 改寫所有文檔中的標籤（重命名、合併）：返回改動的篇數。 */
  rewriteTags(t, mapping) {
    const lower = new Map(Object.entries(mapping).map(([k, v]) => [k.toLowerCase(), v]));
    let n = 0;
    for (const d of this.docs.values()) {
      let touched = false;
      for (const side of ['pub', 'draft']) {
        const e = d[side];
        if (!e) continue;
        if (!e.meta.tags.some(x => lower.has(x.toLowerCase()))) continue;
        const next = [];
        for (const x of e.meta.tags) {
          const y = lower.get(x.toLowerCase()) || x;
          if (!next.some(z => z.toLowerCase() === y.toLowerCase())) next.push(y);
        }
        e.meta.tags = next;
        this.writeEntry(t, d, side);
        touched = true;
      }
      if (touched) n++;
    }
    return n;
  }

  updateTag(t, name, input, principal) {
    this.assertOwnerRole(principal);
    const key = Object.keys(this.tags).find(k => k.toLowerCase() === String(name).toLowerCase()) || this.canonicalTag(name);
    const info = { ...(this.tags[key] || {}) };
    for (const k of ['group', 'description']) if (input[k] !== undefined) info[k] = clean(input[k]) || null;
    if (input.color !== undefined) {
      if (input.color && !TAG_COLORS.includes(input.color)) throw fail(400, 'invalid_input', tr('{field} 必須為 {values}', { field: 'color', values: TAG_COLORS.join(' / ') }));
      info.color = input.color || null;
    }
    let renamed = null;
    const newName = clean(input.newName);
    if (newName && newName !== key) {
      if ([...newName].length > 30) throw fail(400, 'invalid_input', tr('標籤「{tag}」最長 30 字', { tag: newName }));
      const clash = Object.keys(this.tags).find(k => k.toLowerCase() === newName.toLowerCase() && k !== key);
      if (clash) throw fail(409, 'duplicate_tag', tr('標籤「{tag}」已存在；要合併請用合併標籤', { tag: clash }));
      delete this.tags[key];
      this.merged[key] = newName;
      for (const [k, v] of Object.entries(this.merged)) if (v === key) this.merged[k] = newName;
      const n = this.rewriteTags(t, { [key]: newName });
      renamed = { from: key, to: newName, docs: n };
    }
    this.tags[renamed ? newName : key] = info;
    this.writeTags(t);
    return { name: renamed ? newName : key, ...info, renamed };
  }

  mergeTags(t, input, principal) {
    this.assertOwnerRole(principal);
    const to = this.canonicalTag(input.to);
    if (!to) throw fail(400, 'invalid_input', tr('{field} 必填', { field: 'to' }));
    const from = idList(input.from).map(x => Object.keys(this.tags).find(k => k.toLowerCase() === x.toLowerCase()) || x).filter(x => x.toLowerCase() !== to.toLowerCase());
    if (!from.length) throw fail(400, 'invalid_input', tr('{field} 必填', { field: 'from' }));
    const mapping = Object.fromEntries(from.map(f => [f, to]));
    const n = this.rewriteTags(t, mapping);
    for (const f of from) {
      delete this.tags[f];
      this.merged[f] = to;
    }
    for (const [k, v] of Object.entries(this.merged)) if (from.includes(v)) this.merged[k] = to;
    this.tags[to] ||= {};
    this.writeTags(t);
    return { from, to, docs: n };
  }

  // ------------------------------------------------------------ 寫入輔助
  writeEntry(t, doc, side) {
    const e = doc[side];
    const raw = serializeDoc(e.meta, e.body);
    t.writeRaw(e.path, raw);
    e.etag = etagOf(raw);
    this.search.invalidate(doc.id);
  }

  checkLinks(meta) {
    const st = this.store;
    meta.subjects = uniq(idList(meta.subjects));
    meta.objects = uniq(idList(meta.objects));
    meta.related = uniq(idList(meta.related)).filter(x => x !== meta.id);
    for (const id of meta.subjects) if (!st.subjects.has(id)) throw fail(422, 'unknown_subject', tr('主體 {id} 不存在', { id }));
    for (const id of meta.objects) if (!st.objects.has(id)) throw fail(422, 'unknown_object', tr('客體 {id} 不存在', { id }));
    for (const id of meta.related) if (!this.docs.has(id)) throw fail(422, 'unknown_doc', tr('文檔 {id} 不存在', { id }));
  }

  /** 確保文件夾存在：已有則返回規範寫法；不存在時人可以直接建立，智能體只能建在模板預設或「通用」文件夾。 */
  ensureFolder(t, folder, principal, tpl) {
    const found = this.findFolder(folder);
    if (found) return found;
    const allowed = principal?.kind === 'human' || folder === DEFAULT_FOLDER || folder === tpl?.defaultFolder;
    if (!allowed) throw fail(400, 'invalid_folder', tr('文件夾「{folder}」不存在；智能體只能把文檔放在已有的文件夾。已有：{list}', { folder, list: this.allFolders().slice(0, 20).join(tr('、')) || DEFAULT_FOLDER }));
    this.createFolderEntry(t, folder, {});
    return folder;
  }

  createFolderEntry(t, folder, settings) {
    const parts = folder.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const f = parts.slice(0, i).join('/');
      if (this.folders.has(f)) continue;
      const s = i === parts.length ? normalizeFolderSettings(settings) : {};
      this.folders.set(f, s);
      t.writeRaw(`${DOCS}/${f}/${FOLDER_FILE}`, folderYaml(s));
    }
  }

  /** 保存草稿（新建與修改共用）：校驗欄位與關聯、體檢、拒絕疑似機密、寫入 _drafts/。 */
  writeDraft(t, { doc, meta, body, fieldsInput, principal }) {
    const tpl = this.getTemplate(meta.template);
    const fc = checkFields(tpl, fieldsInput !== undefined ? fieldsInput : meta.fields, { store: this.store, docs: this.docs, phase: 'save' });
    meta.fields = fc.fields;
    meta.subjects = uniq([...idList(meta.subjects), ...fc.links.subjects]);
    meta.objects = uniq([...idList(meta.objects), ...fc.links.objects]);
    meta.related = uniq([...idList(meta.related), ...fc.links.related]);
    this.checkLinks(meta);
    if (Buffer.byteLength(body) > MAX_BODY) throw fail(413, 'doc_too_large', tr('正文超過 1 MB，請拆分成多篇文檔'));
    const folder = doc?.pub ? folderOfPath(doc.pub.path) : meta.folder;
    const problems = lintDoc(this, { id: meta.id, meta, body, folder }, { phase: 'save', fieldProblems: fc.problems });
    const secrets = problems.filter(p => p.rule === 'D10');
    if (secrets.length) throw fail(422, 'secret_detected', tr('內容疑似包含機密（金鑰、權杖、密碼或私鑰），拒絕保存：{detail}', { detail: secrets.map(p => p.message).join(tr('；')) }), { problems: secrets });
    this.ensureTags(t, meta.tags);
    const rel = `${DRAFTS}/${meta.id}.md`;
    const d = doc || { id: meta.id, pub: null, draft: null };
    d.draft = { path: rel, meta, body, etag: null };
    this.docs.set(meta.id, d);
    this.writeEntry(t, d, 'draft');
    return { ...this.summary(d, 'draft'), etag: d.draft.etag, path: rel, problems };
  }

  conflict(entry) {
    return fail(409, 'draft_conflict', tr('草稿已被別人修改：請先讀取最新內容（etag {etag}），合併後再保存', { etag: entry.etag }), {
      current: { etag: entry.etag, title: entry.meta.title, summary: entry.meta.summary || null, body: entry.body, fields: entry.meta.fields, updatedAt: entry.meta.updatedAt || null, updatedBy: entry.meta.updatedBy || null }
    });
  }

  checkTakeover(objectId, selfId) {
    const o = this.store.getObject(objectId);
    if (o.category !== '制度') throw fail(422, 'invalid_takeover', tr('只能接管制度類客體；{id} 是{category}類', { id: o.id, category: o.category }));
    if (o.status === '下線') throw fail(409, 'object_offline', tr('客體 {id} 已下線，不能接管', { id: o.id }));
    if (o.docId && o.docId !== selfId) throw fail(409, 'object_managed_by_doc', tr('客體 {id} 已由文檔 {doc} 管理', { id: o.id, doc: o.docId }));
    for (const d of this.docs.values()) if (d.id !== selfId && (d.draft?.meta.objectId === o.id || d.pub?.meta.objectId === o.id)) throw fail(409, 'object_managed_by_doc', tr('客體 {id} 已由文檔 {doc} 管理', { id: o.id, doc: d.id }));
    return o;
  }

  // ------------------------------------------------------------ 生命週期
  create(t, input = {}, principal, { aiDraft = null } = {}) {
    this.store.assertCanContribute(principal);
    const folderIn = clean(input.folder) ? normalizeFolderPath(input.folder) : null;
    const tpl = this.getTemplate(input.template || (folderIn && this.folderDefaults(folderIn).defaultTemplate) || 'TPL-0001');
    const folder = this.ensureFolder(t, folderIn || normalizeFolderPath(tpl.defaultFolder || DEFAULT_FOLDER), principal, tpl);
    const title = this.checkTitle(input.title);
    this.assertUniqueTitle(folder, title, null);
    let takeover = null;
    if (clean(input.takeOverObjectId)) takeover = this.checkTakeover(clean(input.takeOverObjectId), null);
    let startVersion;
    if (takeover && input.startVersion !== undefined && input.startVersion !== null && input.startVersion !== '') {
      startVersion = Number(input.startVersion);
      if (!Number.isInteger(startVersion) || startVersion < 1 || startVersion > 999) throw fail(400, 'invalid_input', tr('起始版本必須是 1–999 的整數'));
    }
    const id = this.store.nextId(ID_PREFIX.doc);
    const by = sourceOf(principal);
    const at = nowIso();
    const meta = {
      id, title, template: tpl.id, status: '草稿',
      summary: clean(input.summary) || null,
      tags: this.normalizeTags([...this.folderDefaults(folder).defaultTags, ...idList(input.tags)]),
      owner: clean(input.owner) || null,
      ownerIds: [],
      subjects: idList(input.subjects), objects: idList(input.objects), related: idList(input.related),
      objectId: takeover?.id || null, startVersion,
      fields: {}, folder, createdAt: at, createdBy: by, updatedAt: at, updatedBy: by,
      editors: [by], ...(aiDraft ? { aiDraft } : {})
    };
    if (idList(input.ownerIds).length) {
      if (principal.kind === 'human' && (principal.isAdmin || principal.role === 'owner')) meta.ownerIds = idList(input.ownerIds);
      else t.warn(tr('只有負責人可以指定審閱人（ownerIds），已忽略'));
    }
    const body = input.body !== undefined && input.body !== null ? String(input.body) : skeleton(tpl);
    return this.writeDraft(t, { doc: null, meta, body, fieldsInput: input.fields, principal });
  }

  saveDraft(t, id, input = {}, principal) {
    this.store.assertCanContribute(principal);
    const doc = this.get(id);
    if (doc.pub?.meta.status === '已廢止') throw fail(409, 'doc_obsolete', tr('{id} 已廢止，不能修改', { id }));
    if (doc.pub?.meta.generated) throw this.generatedError(id);
    const base = doc.draft || doc.pub;
    const tpl0 = this.getTemplate(base.meta.template);
    if (doc.pub && !doc.draft && tpl0.immutable) throw fail(409, 'immutable_doc', tr('模板「{name}」的文檔發布後不能修訂；有誤時請廢止並另發一份', { name: tpl0.name }));
    if (doc.draft) {
      if (input.etag !== doc.draft.etag) throw this.conflict(doc.draft);
    } else if (input.etag && input.etag !== doc.pub.etag) throw this.conflict(doc.pub);
    const meta = doc.draft ? structuredClone(doc.draft.meta) : revisionMeta(doc.pub.meta);
    if (input.template !== undefined && input.template !== meta.template) {
      if (doc.pub) throw fail(409, 'immutable_template', tr('已發布的文檔不能更換模板'));
      meta.template = this.getTemplate(input.template).id;
    }
    if (input.title !== undefined) {
      const title = this.checkTitle(input.title);
      if (title !== meta.title) this.assertUniqueTitle(doc.pub ? folderOfPath(doc.pub.path) : meta.folder, title, id);
      meta.title = title;
    }
    if (input.folder !== undefined && !doc.pub) {
      const folder = this.ensureFolder(t, normalizeFolderPath(input.folder), principal, this.templates.get(meta.template));
      if (folder !== meta.folder) this.assertUniqueTitle(folder, meta.title, id);
      meta.folder = folder;
    }
    if (input.summary !== undefined) meta.summary = clean(input.summary) || null;
    if (input.owner !== undefined) meta.owner = clean(input.owner) || null;
    if (input.tags !== undefined) meta.tags = this.normalizeTags(input.tags);
    for (const k of ['subjects', 'objects', 'related']) if (input[k] !== undefined) meta[k] = idList(input[k]);
    if (input.ownerIds !== undefined && JSON.stringify(idList(input.ownerIds)) !== JSON.stringify(meta.ownerIds)) {
      this.assertReviewer(principal, doc);
      meta.ownerIds = idList(input.ownerIds);
    }
    meta.updatedAt = nowIso();
    meta.updatedBy = sourceOf(principal);
    meta.editors = addEditor(meta.editors, meta.updatedBy);
    const body = input.body !== undefined && input.body !== null ? String(input.body) : base.body;
    return this.writeDraft(t, { doc, meta, body, fieldsInput: input.fields !== undefined ? input.fields : meta.fields, principal });
  }

  discardDraft(t, id, principal) {
    this.store.assertCanContribute(principal);
    const doc = this.get(id);
    if (!doc.draft) throw fail(409, 'no_draft', tr('{id} 沒有草稿或修訂', { id }));
    const deleted = !doc.pub;
    if (deleted) {
      const creator = doc.draft.meta.createdBy?.id;
      const owner = principal.kind === 'human' && (principal.isAdmin || principal.role === 'owner');
      if (!owner && creator !== principal.id) throw fail(403, 'forbidden', tr('只有建立者本人或負責人可以刪除從未發布過的草稿'));
      this.docs.delete(id);
    }
    t.removeRaw(doc.draft.path);
    doc.draft = null;
    this.search.invalidate(id);
    return { id, deleted, title: this.head(doc)?.meta.title };
  }

  lintCurrent(doc, phase, entry = doc.draft) {
    return lintDoc(this, { id: doc.id, meta: entry.meta, body: entry.body, folder: doc.pub ? folderOfPath(doc.pub.path) : entry.meta.folder }, { phase });
  }

  lintFailed(problems) {
    const errors = problems.filter(p => p.level === 'error');
    return fail(422, 'lint_failed', tr('文檔體檢有 {n} 個錯誤：{detail}', { n: errors.length, detail: errors.slice(0, 5).map(p => p.message).join(tr('；')) }), { problems });
  }

  submit(t, id, principal) {
    this.store.assertCanContribute(principal);
    const doc = this.get(id);
    if (!doc.draft) throw fail(409, 'no_draft', tr('{id} 沒有草稿或修訂', { id }));
    if (doc.draft.meta.status === '待審') throw fail(409, 'already_submitted', tr('{id} 已在待審', { id }));
    const problems = this.lintCurrent(doc, 'submit');
    if (hasErrors(problems)) throw this.lintFailed(problems);
    const m = doc.draft.meta;
    m.status = '待審';
    m.submittedAt = nowIso();
    m.submittedBy = sourceOf(principal);
    delete m.reviewNote;
    this.writeEntry(t, doc, 'draft');
    return { ...this.summary(doc, 'draft'), etag: doc.draft.etag, problems };
  }

  reject(t, id, input = {}, principal) {
    const doc = this.get(id);
    if (doc.draft?.meta.status !== '待審') throw fail(409, 'not_in_review', tr('{id} 不在待審狀態', { id }));
    this.assertReviewer(principal, doc);
    const note = clean(input.note);
    if (!note) throw fail(400, 'invalid_input', tr('退回需要填寫意見'));
    const m = doc.draft.meta;
    m.status = '草稿';
    m.reviewNote = { note, by: sourceOf(principal), at: nowIso() };
    this.writeEntry(t, doc, 'draft');
    return { ...this.summary(doc, 'draft'), etag: doc.draft.etag, reviewNote: m.reviewNote };
  }

  /**
   * 發布：草稿或修訂成為新版本（版本加 1）。首次發布時登記制度客體（或寫回接管的客體）；
   * affect 中的知識降為 L1 並排入重驗（客體已變化）；bindSubjects 為這些主體綁定文檔客體（L1）。一次提交。
   */
  publish(t, id, input = {}, principal) {
    const st = this.store;
    const doc = this.get(id);
    let source = doc.draft;
    if (!source) {
      if (input.confirmGitEdit && doc.pub) source = doc.pub;
      else throw fail(409, 'no_draft', tr('{id} 沒有草稿或修訂', { id }));
    }
    if (doc.pub?.meta.status === '已廢止') throw fail(409, 'doc_obsolete', tr('{id} 已廢止，不能修改', { id }));
    if (doc.pub?.meta.generated) throw this.generatedError(id);
    const tpl = this.getTemplate(source.meta.template);
    this.assertCanPublish(principal, tpl, doc);
    const authors = source === doc.pub ? [] : authorsOf(source.meta, { firstVersion: !doc.pub });
    if (tpl.requireOtherApprover && authors.includes(principal.id)) throw fail(403, 'four_eyes_required', tr('模板「{name}」要求四眼審閱：這一版有你參與編寫，需要另一位負責人審閱並發布', { name: tpl.name }));
    const folder = doc.pub ? folderOfPath(doc.pub.path) : source.meta.folder || DEFAULT_FOLDER;
    const problems = this.lintCurrent(doc, 'publish', source);
    if (hasErrors(problems)) throw this.lintFailed(problems);
    this.assertUniqueTitle(folder, source.meta.title, id);
    const at = nowIso();
    const by = sourceOf(principal);
    const hadPub = !!doc.pub;
    const version = doc.pub ? (Number(doc.pub.meta.version) || 0) + 1 : Number(source.meta.startVersion) || 1;
    const major = input.major === true;
    const note = clean(input.note) || null;

    // 文檔自己的客體：已發布過的沿用；首次發布時寫回接管的客體，或登記新的制度客體
    let objectId = doc.pub?.meta.objectId || null;
    let registered = false;
    let tookOver = false;
    if (!objectId && source.meta.objectId) {
      const o = this.checkTakeover(source.meta.objectId, id);
      o.docId = id;
      objectId = o.id;
      tookOver = true;
    }
    let obj = objectId ? st.objects.get(objectId) : null;
    if (!obj) {
      obj = st.createObject(t, { name: `《${source.meta.title}》`, category: '制度', kind: tpl.objectKind || '知識文檔', locator: `doc://${id}`, description: source.meta.summary || null }, principal);
      obj.docId = id;
      objectId = obj.id;
      registered = true;
    }
    const objName = `《${source.meta.title}》`;
    if (obj.name !== objName) obj.name = objName;
    if (!tookOver && obj.locator === `doc://${id}` && source.meta.summary) obj.description = source.meta.summary;
    // 內置校驗 Action「文檔已發布」：讓綁定文檔客體的綁定可以經校驗升到 L0
    const validator = this.ensureDocValidator(t);
    if (!(obj.actionIds || []).includes(validator)) obj.actionIds = [...(obj.actionIds || []), validator];
    obj.updatedAt = at;
    t.touch('object', obj.id);

    // 受影響的知識：只能從「以本文檔為依據」的條目中選
    const impact = new Map(this.impactOf(objectId).map(x => [x.id, x]));
    const affect = uniq(idList(input.affect));
    for (const iid of affect) if (!impact.has(iid)) throw fail(400, 'invalid_affect', tr('{id} 不是以本文檔為依據的知識（或已是 E1）', { id: iid }));
    let demoted = 0;
    const kindText = major ? '重大修訂' : '小修';
    for (const iid of affect) {
      const ref = st.getItem(iid);
      const wasL0 = ref.item.validity.level === 'L0';
      demoteToL1(ref.item.validity, 'object_changed', { by: by.id, note: note ? `${id} v${version} ${kindText}：${note}` : `${id} v${version} ${kindText}` });
      if (wasL0) demoted++;
      st.touchItem(t, ref);
    }

    // 順手綁定：為關聯的主體建立以本文檔為依據的綁定（L1）
    const bound = [];
    for (const sid of uniq(idList(input.bindSubjects))) {
      const s = st.getSubject(sid);
      if (s.bindings.some(b => b.objectId === objectId && b.validity.level !== 'E1')) continue;
      const b = st.createBinding(t, sid, { objectId, note: `文檔 ${id} 發布時綁定` }, principal);
      bound.push({ subjectId: sid, bindingId: b.id, level: b.validity.level });
    }

    const meta = structuredClone(source.meta);
    const aiDraft = meta.aiDraft || null;
    const editors = Array.isArray(meta.editors) ? meta.editors : [];
    for (const k of ['folder', 'startVersion', 'baseVersion', 'reviewNote', 'submittedAt', 'submittedBy', 'aiDraft', 'editors']) delete meta[k];
    meta.status = '已發布';
    meta.version = version;
    meta.objectId = objectId;
    meta.subjects = uniq([...meta.subjects, ...bound.map(b => b.subjectId)]);
    const everyDays = Number(doc.pub?.meta.review?.everyDays) || Number(tpl.reviewEveryDays) || null;
    meta.review = everyDays ? { everyDays, nextAt: dateOnly(Date.now() + everyDays * DAY), lastAt: at, lastBy: by.id } : null;
    const author = source.meta.updatedBy?.id || source.meta.createdBy?.id || null;
    meta.change = { major, note, publishedAt: at, publishedBy: by, approvedBy: by, ...(author === by.id ? { selfApproved: true } : {}), ...(source === doc.pub ? { fromGit: true } : {}), ...(editors.length ? { authors: editors } : {}), ...(aiDraft ? { aiDraft } : {}) };
    meta.updatedAt = at;
    meta.updatedBy = by;
    const rel = `${DOCS}/${folder}/${fileNameFor(id, meta.title)}`;
    if (doc.pub && doc.pub.path !== rel) t.removeRaw(doc.pub.path);
    if (doc.draft) t.removeRaw(doc.draft.path);
    doc.pub = { path: rel, meta, body: source.body, etag: null };
    doc.draft = null;
    if (!this.folders.has(folder)) this.createFolderEntry(t, folder, {});
    this.writeEntry(t, doc, 'pub');
    return { id, title: meta.title, version, first: !hadPub, major, note, objectId, registered, tookOver, affected: affect.length, demoted, queued: affect.length, bound, path: rel, problems };
  }

  obsolete(t, id, input = {}, principal) {
    const st = this.store;
    const doc = this.get(id);
    if (!doc.pub) throw fail(409, 'not_published', tr('{id} 還沒有發布', { id }));
    if (doc.pub.meta.status === '已廢止') throw fail(409, 'doc_obsolete', tr('{id} 已廢止，不能修改', { id }));
    this.assertReviewer(principal, doc);
    const reason = clean(input.reason);
    if (!reason) throw fail(400, 'invalid_input', tr('廢止需要填寫原因'));
    const replacedBy = clean(input.replacedBy) || null;
    if (replacedBy) {
      const r = this.get(replacedBy);
      if (replacedBy === id || !r.pub || r.pub.meta.status !== '已發布') throw fail(422, 'invalid_replacement', tr('替代文檔 {id} 必須是另一篇已發布的文檔', { id: replacedBy }));
    }
    const at = nowIso();
    const m = doc.pub.meta;
    Object.assign(m, { status: '已廢止', obsoleteReason: reason, obsoleteAt: at, obsoleteBy: sourceOf(principal), replacedBy, updatedAt: at, updatedBy: sourceOf(principal) });
    if (doc.draft) { t.removeRaw(doc.draft.path); doc.draft = null; }
    this.writeEntry(t, doc, 'pub');
    let affected = { bindings: [], demoted: [] };
    const obj = m.objectId ? st.objects.get(m.objectId) : null;
    if (obj && obj.status !== '下線') affected = st.takeObjectOffline(t, obj, `文檔 ${id} 已廢止：${reason}`, principal);
    const migrated = replacedBy && input.migrate === true ? this.migrateBindings(t, doc, principal) : [];
    return { id, title: m.title, replacedBy, objectId: obj?.id || null, affected, migrated };
  }

  /**
   * 把依據遷移到替代文檔（設計 §6.5 第 4 步）：綁定了舊文檔客體的主體，改為綁定替代文檔的客體（L1，等待確認或校驗）。
   * 舊綁定保持 E1，歷史可追溯。已經有替代文檔有效綁定的主體跳過。
   */
  migrateBindings(t, doc, principal) {
    const st = this.store;
    const m = doc.pub.meta;
    const target = this.docs.get(m.replacedBy);
    const newObj = target?.pub?.meta.objectId ? st.objects.get(target.pub.meta.objectId) : null;
    if (!newObj || newObj.status === '下線') { t.warn(tr('替代文檔 {id} 沒有在用的客體，沒有遷移依據', { id: m.replacedBy })); return []; }
    const out = [];
    for (const s of st.subjects.values()) {
      if (!s.bindings.some(b => b.objectId === m.objectId)) continue;
      if (s.bindings.some(b => b.objectId === newObj.id && b.validity.level !== 'E1')) continue;
      const b = st.createBinding(t, s.id, { objectId: newObj.id, note: `文檔 ${doc.id} 廢止，依據遷移到 ${target.id}` }, principal);
      out.push({ subjectId: s.id, bindingId: b.id, objectId: newObj.id, level: b.validity.level });
    }
    return out;
  }

  /** 已廢止的文檔補做「遷移依據」。 */
  migrateBasis(t, id, principal) {
    const doc = this.get(id);
    if (doc.pub?.meta.status !== '已廢止') throw fail(409, 'not_obsolete', tr('{id} 沒有廢止，不需要遷移依據', { id }));
    if (!doc.pub.meta.replacedBy) throw fail(409, 'no_replacement', tr('{id} 沒有指定替代文檔', { id }));
    this.assertReviewer(principal, doc);
    return { id, replacedBy: doc.pub.meta.replacedBy, migrated: this.migrateBindings(t, doc, principal) };
  }

  /** 修訂影響（第二期）：按改動的章節與斷言、關係的 sourceRef 預選真正受影響的知識。 */
  impactWithSections(doc) {
    const items = this.impactOf(doc.pub?.meta.objectId || null);
    let changes = null;
    if (doc.pub && doc.draft) {
      const before = new Map(parseSections(doc.pub.body).map(x => [x.heading.trim().toLowerCase(), x.text]));
      const after = new Map(parseSections(doc.draft.body).map(x => [x.heading.trim().toLowerCase(), x.text]));
      changes = new Map();
      for (const [h, text] of before) changes.set(h, !after.has(h) ? 'removed' : after.get(h) === text ? 'unchanged' : 'modified');
      for (const h of after.keys()) if (!before.has(h)) changes.set(h, 'added');
    }
    const out = items.map(x => {
      const sec = sectionOfSourceRef(x.sourceRef, doc.id);
      const change = sec && changes ? changes.get(sec.heading.toLowerCase()) || 'missing' : null;
      return { ...x, section: sec?.heading || null, sectionChange: change, suggested: !changes || !sec || change !== 'unchanged' };
    });
    const changed = changes ? [...changes.entries()].filter(([, c]) => c !== 'unchanged').map(([heading, change]) => ({ heading, change })) : [];
    return { items: out, changedSections: changed, sectionAware: !!changes };
  }

  // ------------------------------------------------------------ 內置校驗 Action
  /** 找到或建立內置的「文檔庫」管道與「文檔已發布」校驗 Action；新建時掛到所有已發布文檔的客體上。返回 Action ID。 */
  ensureDocValidator(t) {
    const st = this.store;
    let pipe = [...st.pipelines.values()].find(p => p.type === 'docs');
    if (!pipe) {
      pipe = { id: st.nextId(ID_PREFIX.pipeline), name: '文檔庫（內置）', type: 'docs', description: '內置管道：讀文檔庫中文檔的狀態，不訪問外部系統', baseUrl: null, headers: {}, timeoutMs: 1000, routes: [], builtin: true, updatedAt: nowIso() };
      st.pipelines.set(pipe.id, pipe);
      t.touch('pipeline', pipe.id);
    }
    let action = [...st.actions.values()].find(a => a.pipelineId === pipe.id && a.kind === '校驗');
    if (!action) {
      action = {
        id: st.nextId(ID_PREFIX.action), name: '文檔已發布', kind: '校驗', builtin: true,
        description: '內置：客體由文檔庫管理、文檔處於已發布狀態，即客體存在。用於綁定文檔客體的綁定（L1 → L0）',
        objectKinds: [], pipelineId: pipe.id,
        request: { method: 'GET', path: '/docs/{object.id}', query: {}, body: null },
        inputs: [], output: null, check: { mode: 'exists' }, permission: 'contributor', updatedAt: nowIso()
      };
      st.actions.set(action.id, action);
      t.touch('action', action.id);
      for (const o of st.objects.values()) {
        const d = o.docId ? this.docs.get(o.docId) : null;
        if (!d?.pub || d.pub.meta.status !== '已發布' || o.status === '下線' || (o.actionIds || []).includes(action.id)) continue;
        o.actionIds = [...(o.actionIds || []), action.id];
        t.touch('object', o.id);
      }
    }
    return action.id;
  }

  /** 內置管道的「請求」：/docs/O-0001 → 文檔已發布返回 200，否則 404。 */
  docObjectStatus(objectId) {
    const o = this.store.objects.get(objectId);
    const d = o?.docId ? this.docs.get(o.docId) : null;
    if (!o || !d?.pub) return { status: 404, body: { objectId, error: 'not managed by the document library' } };
    const m = d.pub.meta;
    if (m.status !== '已發布' || o.status === '下線') return { status: 410, body: { objectId, docId: d.id, status: m.status } };
    return { status: 200, body: { objectId, docId: d.id, title: m.title, version: m.version, status: m.status } };
  }

  // ------------------------------------------------------------ 生成文檔（主體手冊）
  generatedError(id) {
    return fail(409, 'generated_doc', tr('{id} 由知識生成，正文只讀；知識變化後請「重新生成」', { id }));
  }

  /** 主體手冊模板：舊倉庫裡沒有時以下一個模板編號寫入（隨本次提交）。 */
  handbookTemplate(t) {
    const found = [...this.templates.values()].find(x => x.generator === 'handbook');
    if (found) return found;
    const id = this.templates.has(HANDBOOK_TEMPLATE.id) ? this.store.nextId(ID_PREFIX.template) : HANDBOOK_TEMPLATE.id;
    if (id === HANDBOOK_TEMPLATE.id) this.store.bumpCounter(id);
    const tpl = { ...structuredClone(HANDBOOK_TEMPLATE), id };
    this.templates.set(id, tpl);
    t.touch('template', id);
    return tpl;
  }

  findGenerated(kind, target) {
    for (const d of this.docs.values()) {
      const g = d.pub?.meta.generated;
      if (g && g.kind === kind && g.target === target) return d;
    }
    return null;
  }

  /** 生成或重新生成主體手冊（一個主體）或領域手冊（一個領域）。直接成為已發布版本：內容全部來自知識，沒有新的陳述。 */
  generate(t, input = {}, principal) {
    this.assertHuman(principal, tr('智能體和管道不能生成手冊；手冊直接發布，需要由人觸發'));
    const st = this.store;
    const kind = input.domain ? 'domain' : 'subject';
    let target;
    if (kind === 'subject') {
      const s = st.getSubject(clean(input.subjectId));
      if (s.type === '別名') throw fail(422, 'invalid_input', tr('別名沒有自己的知識；請為它指向的規範主體生成手冊'));
      target = s.id;
    } else {
      target = clean(input.domain);
      if (!st.config.domains?.some(d => d.code === target)) throw fail(422, 'invalid_input', tr('領域 {code} 不存在', { code: target }));
    }
    const existing = this.findGenerated(kind, target);
    if (existing) return this.regenerate(t, existing.id, principal);
    const tpl = this.handbookTemplate(t);
    const out = renderHandbook(st, this, { kind, target });
    const folder = this.ensureFolder(t, clean(input.folder) ? normalizeFolderPath(input.folder) : this.handbookFolder(out.domain), principal, tpl);
    this.assertUniqueTitle(folder, out.title, null);
    const id = st.nextId(ID_PREFIX.doc);
    const by = sourceOf(principal);
    const at = nowIso();
    const meta = {
      id, title: out.title, template: tpl.id, status: '已發布', version: 1, summary: out.summary,
      tags: this.normalizeTags(['手冊']), owner: null, ownerIds: [],
      subjects: out.subjects, objects: [], related: out.related, objectId: null, fields: {}, review: null,
      change: { major: false, note: '由知識生成', publishedAt: at, publishedBy: by, approvedBy: by, generated: true },
      generated: { kind, target, hash: out.hash, at, by: by.id },
      createdAt: at, createdBy: by, updatedAt: at, updatedBy: by
    };
    this.ensureTags(t, meta.tags);
    const doc = { id, pub: { path: `${DOCS}/${folder}/${fileNameFor(id, meta.title)}`, meta, body: out.body, etag: null }, draft: null };
    this.docs.set(id, doc);
    this.writeEntry(t, doc, 'pub');
    return { id, title: meta.title, version: 1, created: true, changed: true, folder, path: doc.pub.path };
  }

  regenerate(t, id, principal) {
    this.assertHuman(principal, tr('智能體和管道不能生成手冊；手冊直接發布，需要由人觸發'));
    const doc = this.get(id);
    const g = doc.pub?.meta.generated;
    if (!g) throw fail(409, 'not_generated', tr('{id} 不是生成的文檔', { id }));
    if (doc.pub.meta.status === '已廢止') throw fail(409, 'doc_obsolete', tr('{id} 已廢止，不能修改', { id }));
    const out = renderHandbook(this.store, this, { kind: g.kind, target: g.target });
    const m = doc.pub.meta;
    if (out.hash === g.hash && out.title === m.title && out.body === doc.pub.body) return { id, title: m.title, version: m.version, created: false, changed: false, folder: this.folderOf(doc), path: doc.pub.path };
    const folder = this.folderOf(doc);
    if (out.title !== m.title) this.assertUniqueTitle(folder, out.title, id);
    const by = sourceOf(principal);
    const at = nowIso();
    Object.assign(m, {
      title: out.title, summary: out.summary, subjects: out.subjects, related: out.related, version: (Number(m.version) || 0) + 1,
      change: { major: false, note: '知識變化後重新生成', publishedAt: at, publishedBy: by, approvedBy: by, generated: true },
      generated: { ...g, hash: out.hash, at, by: by.id }, updatedAt: at, updatedBy: by
    });
    const rel = `${DOCS}/${folder}/${fileNameFor(id, m.title)}`;
    if (rel !== doc.pub.path) t.removeRaw(doc.pub.path);
    doc.pub = { path: rel, meta: m, body: out.body, etag: null };
    this.writeEntry(t, doc, 'pub');
    return { id, title: m.title, version: m.version, created: false, changed: true, folder, path: rel };
  }

  /** 手冊放在領域文件夾下的「手冊」子文件夾；找不到領域文件夾時放在「通用/手冊」。 */
  handbookFolder(domain) {
    const top = [...this.folders.entries()].find(([p, f]) => !p.includes('/') && f?.domain === domain)?.[0];
    return `${top || DEFAULT_FOLDER}/手冊`;
  }

  /** 生成文檔是否落後於知識（知識變化後應重新生成）。 */
  generatedState(doc) {
    const g = doc.pub?.meta.generated;
    if (!g) return null;
    let stale = false;
    let missing = false;
    try { stale = renderHandbook(this.store, this, { kind: g.kind, target: g.target }).hash !== g.hash; } catch { missing = true; }
    return { ...g, stale, missing };
  }

  // ------------------------------------------------------------ 從文檔抽取斷言
  /**
   * 把文檔中的一段話提取為斷言（設計 §9.4）：證據是文檔的客體，sourceRef 寫「DOC-0001§計算公式 v4」。
   * 寫入上限照常：有客體證據最高 L1，要晉升 L0 仍需校驗或負責人確認。items 可以一次多條，一次提交。
   */
  extractAssertions(t, id, input = {}, principal) {
    const st = this.store;
    st.assertCanContribute(principal);
    const doc = this.get(id);
    const m = doc.pub?.meta;
    if (!m || m.status !== '已發布') throw fail(409, 'not_published', tr('{id} 還沒有發布：只能從已發布的版本提取斷言', { id }));
    if (m.generated) throw fail(409, 'generated_doc', tr('{id} 由知識生成，不能再作為知識的證據', { id }));
    const obj = m.objectId ? st.objects.get(m.objectId) : null;
    if (!obj || obj.status === '下線') throw fail(409, 'object_offline', tr('{id} 的客體不在用，不能作為證據', { id }));
    const sections = parseSections(doc.pub.body);
    const list = Array.isArray(input.items) ? input.items : [input];
    if (!list.length || list.length > 50) throw fail(400, 'invalid_input', tr('一次提取 1–50 條'));
    const created = [];
    const skipped = [];
    list.forEach((it, index) => {
      const subjectId = clean(it?.subjectId);
      const s = st.getSubject(subjectId);
      if (s.type === '別名') throw fail(422, 'invalid_input', tr('第 {n} 條：斷言要寫在規範主體上，{id} 是別名', { n: index + 1, id: s.id }));
      const type = clean(it.type) || '屬性';
      if (!ASSERTION_TYPES[type]) throw fail(400, 'invalid_input', tr('第 {n} 條：斷言類型必須為 {list}', { n: index + 1, list: Object.keys(ASSERTION_TYPES).join(' / ') }));
      const content = String(it.content || '').replace(/\[\[([A-Z]+-[A-Z0-9-]+)(#[^\]]*)?\]\]/g, (all, rid) => st.subjects.get(rid)?.name || rid).replace(/\s+/g, ' ').trim();
      if (!content) throw fail(400, 'invalid_input', tr('第 {n} 條：內容不能為空', { n: index + 1 }));
      if (content.length > 500) throw fail(400, 'invalid_input', tr('第 {n} 條：一條斷言不超過 500 字；請拆成幾條', { n: index + 1 }));
      let heading = null;
      const key = clean(it.anchor) || clean(it.heading);
      if (key) {
        const sec = sections.find(x => x.anchor === key || x.heading === key);
        if (!sec) throw fail(422, 'invalid_input', tr('第 {n} 條：{id} 的當前版本沒有章節「{heading}」', { n: index + 1, id, heading: key }));
        heading = sec.heading;
      }
      if (s.assertions.some(a => a.validity.level !== 'E1' && sameText(a.content, content))) { skipped.push({ index, subjectId, content, reason: tr('{id} 已有相同內容的斷言', { id: subjectId }) }); return; }
      const sourceRef = heading ? `${id}§${heading} v${m.version}` : `${id} v${m.version}`;
      const a = st.createAssertion(t, subjectId, { type, content, structured: it.structured || undefined, evidence: { objectIds: [obj.id], sourceRef } }, principal);
      created.push({ id: a.id, subjectId, type, content, level: a.validity.level, sourceRef });
    });
    return { docId: id, version: m.version, objectId: obj.id, created, skipped };
  }

  /** 廢止前的影響預覽。 */
  obsoletePreview(id) {
    const doc = this.get(id);
    const items = this.impactOf(doc.pub?.meta.objectId || null);
    return { objectId: doc.pub?.meta.objectId || null, bindings: items.filter(x => x.kind === 'binding'), demoted: items.filter(x => x.kind !== 'binding') };
  }

  confirmReview(t, id, input = {}, principal) {
    const doc = this.get(id);
    if (!doc.pub || doc.pub.meta.status !== '已發布') throw fail(409, 'not_published', tr('{id} 還沒有發布', { id }));
    this.assertReviewer(principal, doc);
    const tpl = this.templates.get(doc.pub.meta.template);
    const days = Number(input.everyDays) || Number(doc.pub.meta.review?.everyDays) || Number(tpl?.reviewEveryDays) || null;
    if (!days) throw fail(409, 'no_review_cycle', tr('{id} 的模板沒有複審週期', { id }));
    const at = nowIso();
    doc.pub.meta.review = { everyDays: days, nextAt: dateOnly(Date.now() + days * DAY), lastAt: at, lastBy: principal.id, ...(clean(input.note) ? { note: clean(input.note) } : {}) };
    this.writeEntry(t, doc, 'pub');
    return { id, review: doc.pub.meta.review };
  }

  /** 整理：標籤、關聯、負責人、移動。已發布版本和修訂草稿一起改，不改版本號。 */
  organize(t, id, patch = {}, principal) {
    this.store.assertCanContribute(principal);
    const doc = this.get(id);
    if (doc.pub?.meta.status === '已廢止') throw fail(409, 'doc_obsolete', tr('{id} 已廢止，不能修改', { id }));
    const changes = {};
    const sides = ['pub', 'draft'].filter(s => doc[s]);
    const head = this.head(doc).meta;
    if (patch.tags !== undefined || patch.addTags !== undefined || patch.removeTags !== undefined) {
      let next = patch.tags !== undefined ? this.normalizeTags(patch.tags) : [...head.tags];
      if (patch.addTags !== undefined) next = this.normalizeTags([...next, ...idList(patch.addTags)]);
      if (patch.removeTags !== undefined) {
        const rm = new Set(this.normalizeTags(patch.removeTags).map(x => x.toLowerCase()));
        next = next.filter(x => !rm.has(x.toLowerCase()));
      }
      const before = head.tags;
      const added = next.filter(x => !before.some(y => y.toLowerCase() === x.toLowerCase()));
      const removed = before.filter(x => !next.some(y => y.toLowerCase() === x.toLowerCase()));
      if (added.length || removed.length) {
        for (const s of sides) doc[s].meta.tags = [...next];
        changes.tags = { added, removed };
        this.ensureTags(t, next);
      }
    }
    for (const k of ['subjects', 'objects', 'related']) {
      const add = k === 'subjects' ? patch.addSubjects : undefined;
      if (patch[k] === undefined && add === undefined) continue;
      let next = patch[k] !== undefined ? idList(patch[k]) : [...head[k]];
      if (add !== undefined) next = uniq([...next, ...idList(add)]);
      const probe = { id, subjects: k === 'subjects' ? next : [], objects: k === 'objects' ? next : [], related: k === 'related' ? next : [] };
      this.checkLinks(probe);
      next = probe[k];
      if (JSON.stringify(next) !== JSON.stringify(head[k])) {
        for (const s of sides) doc[s].meta[k] = [...next];
        (changes.links ||= []).push(k);
      }
    }
    if (patch.owner !== undefined || patch.ownerIds !== undefined) {
      this.assertReviewer(principal, doc);
      for (const s of sides) {
        if (patch.owner !== undefined) doc[s].meta.owner = clean(patch.owner) || null;
        if (patch.ownerIds !== undefined) doc[s].meta.ownerIds = idList(patch.ownerIds);
      }
      changes.owner = true;
    }
    if (patch.folder !== undefined) {
      this.assertHuman(principal, tr('只有人可以移動文檔'));
      const target = this.ensureFolder(t, normalizeFolderPath(patch.folder), principal);
      const from = this.folderOf(doc);
      if (target !== from) {
        this.assertUniqueTitle(target, head.title, id);
        if (doc.pub) {
          const rel = `${DOCS}/${target}/${path.posix.basename(doc.pub.path)}`;
          t.removeRaw(doc.pub.path);
          doc.pub.path = rel;
        }
        if (doc.draft && !doc.pub) doc.draft.meta.folder = target;
        changes.moved = { from, to: target };
      }
    }
    if (!Object.keys(changes).length) return { id, changes, unchanged: true };
    const by = sourceOf(principal);
    for (const s of sides) {
      if (s === 'draft' || changes.links || changes.owner || changes.tags) { doc[s].meta.updatedAt = nowIso(); doc[s].meta.updatedBy = by; }
      this.writeEntry(t, doc, s);
    }
    return { id, title: head.title, changes };
  }

  /** 批量整理：移動、加或去標籤、關聯主體、改負責人。一次提交。 */
  bulk(t, input = {}, principal) {
    const ids = uniq(idList(input.ids));
    if (!ids.length) throw fail(400, 'invalid_input', tr('{field} 必填', { field: 'ids' }));
    if (ids.length > 500) throw fail(400, 'invalid_input', tr('單批最多 {n} 條', { n: 500 }));
    const patch = {};
    if (input.folder !== undefined) patch.folder = input.folder;
    if (input.addTags !== undefined) patch.addTags = input.addTags;
    if (input.removeTags !== undefined) patch.removeTags = input.removeTags;
    if (input.addSubjects !== undefined) patch.addSubjects = input.addSubjects;
    if (input.owner !== undefined) patch.owner = input.owner;
    if (!Object.keys(patch).length) throw fail(400, 'invalid_input', tr('沒有要執行的批量操作'));
    const results = ids.map(id => this.organize(t, id, patch, principal));
    return { ids, changed: results.filter(r => !r.unchanged).length, results };
  }

  remove(t, id, principal) {
    if (!principal?.isAdmin) throw fail(403, 'forbidden', tr('只有管理員可以刪除已發布的文檔（Git 歷史仍保留）；正常情況請廢止'));
    const doc = this.get(id);
    if (doc.pub) t.removeRaw(doc.pub.path);
    if (doc.draft) t.removeRaw(doc.draft.path);
    const objectId = doc.pub?.meta.objectId || doc.draft?.meta.objectId;
    const obj = objectId ? this.store.objects.get(objectId) : null;
    if (obj?.docId === id) {
      delete obj.docId;
      t.touch('object', obj.id);
      t.warn(tr('客體 {id} 不再由文檔庫管理；需要時請另行標記下線', { id: obj.id }));
    }
    this.docs.delete(id);
    this.search.invalidate(id);
    return { id, deleted: true };
  }

  /** 登記 Git 中沒有 front matter 的 .md：補上 front matter、分配 ID，作為草稿進入流程（一次提交）。 */
  async registerFile(t, input, principal) {
    this.assertHuman(principal, tr('只有人可以登記文檔'));
    const rel = String(input.path || '');
    const hit = this.unregistered.find(u => u.path === rel);
    if (!hit) throw fail(404, 'not_found', tr('找不到待登記的檔案 {path}', { path: rel }));
    const text = await fs.readFile(path.join(this.store.root, rel), 'utf8');
    const { body } = parseDocFile(text);
    const tpl = this.getTemplate(input.template || (hit.folder && this.folderDefaults(hit.folder).defaultTemplate) || 'TPL-0001');
    const out = this.create(t, { template: tpl.id, title: clean(input.title) || hit.title, folder: clean(input.folder) || hit.folder || DEFAULT_FOLDER, summary: input.summary, tags: input.tags, body }, principal);
    t.removeRaw(rel);
    this.unregistered = this.unregistered.filter(u => u.path !== rel);
    return { ...out, registeredFrom: rel };
  }

  // ------------------------------------------------------------ 附件
  async uploadAsset(t, id, { name, contentType, data }, principal) {
    this.store.assertCanContribute(principal);
    const doc = this.get(id);
    if (doc.pub?.meta.status === '已廢止') throw fail(409, 'doc_obsolete', tr('{id} 已廢止，不能修改', { id }));
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    const exts = ASSET_TYPES[type];
    if (!exts) throw fail(415, 'unsupported_media_type', tr('只收 PNG、JPEG、GIF、WebP 圖片'));
    if (!Buffer.isBuffer(data) || !data.length) throw fail(400, 'invalid_input', tr('請求體是圖片本身'));
    if (data.length > ASSET_MAX) throw fail(413, 'asset_too_large', tr('單張圖片不超過 2 MB'));
    if (!sniffImage(data, type)) throw fail(415, 'unsupported_media_type', tr('檔案內容與 Content-Type {type} 不符', { type }));
    let base = String(name || '').trim().replace(/\.[A-Za-z0-9]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
    if (!base) base = `image-${Date.now().toString(36)}`;
    const dir = `${ASSETS}/${id}`;
    const existing = await this.assetList(id);
    let file = `${base}.${exts[0]}`;
    for (let i = 2; existing.some(a => a.name === file); i++) file = `${base}-${i}.${exts[0]}`;
    const total = existing.reduce((n, a) => n + a.size, 0) + data.length;
    if (total > ASSET_TOTAL) throw fail(413, 'asset_too_large', tr('每篇文檔的圖片合計不超過 20 MB'));
    t.writeRaw(`${dir}/${file}`, data);
    return { id, name: file, size: data.length, markdown: `![${base}](assets/${file})`, url: `/api/v1/docs/${id}/assets/${encodeURIComponent(file)}` };
  }

  async assetList(id) {
    const dir = path.join(this.store.root, ASSETS, id);
    let names = [];
    try { names = await fs.readdir(dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      const s = await fs.stat(path.join(dir, n)).catch(() => null);
      if (s?.isFile()) out.push({ name: n, size: s.size });
    }
    return out;
  }

  assetPath(id, name) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return null;
    const ext = name.split('.').pop().toLowerCase();
    const type = Object.entries(ASSET_TYPES).find(([, e]) => e.includes(ext))?.[0];
    if (!type) return null;
    return { file: path.join(this.store.root, ASSETS, id, name), type };
  }

  // ------------------------------------------------------------ 文件夾
  folderTree(principal) {
    const drafts = this.canSeeDrafts(principal);
    const counts = new Map();
    for (const d of this.docs.values()) {
      if (!d.pub && !drafts) continue;
      const f = this.folderOf(d);
      const c = counts.get(f) || { published: 0, drafts: 0, obsolete: 0 };
      if (d.pub?.meta.status === '已廢止') c.obsolete++;
      else if (d.pub) c.published++;
      else c.drafts++;
      counts.set(f, c);
    }
    return this.allFolders().map(f => {
      const own = counts.get(f) || { published: 0, drafts: 0, obsolete: 0 };
      let total = 0;
      for (const [k, c] of counts) if (k === f || k.startsWith(`${f}/`)) total += c.published + c.drafts;
      const s = this.folders.get(f) || {};
      return { path: f, name: f.split('/').pop(), depth: f.split('/').length, parent: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : null, ...s, counts: { ...own, total } };
    });
  }

  createFolder(t, input = {}, principal) {
    this.assertHuman(principal, tr('只有人可以新建或重命名文件夾'));
    const folder = normalizeFolderPath(input.path);
    const found = this.findFolder(folder);
    if (found) throw fail(409, 'duplicate_folder', tr('文件夾「{folder}」已存在', { folder: found }));
    const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : null;
    if (parent && !this.findFolder(parent)) this.createFolderEntry(t, parent, {});
    const settings = pickFolderSettings(input);
    if (settings.ownerIds?.length) this.assertOwnerRole(principal);
    if (settings.defaultTemplate) this.getTemplate(settings.defaultTemplate);
    this.createFolderEntry(t, folder, settings);
    return { path: folder, ...this.folders.get(folder) };
  }

  /** 修改文件夾設定，或重命名、移動（newPath）：裡面所有文檔一起移動，一次提交。 */
  async updateFolder(t, input = {}, principal) {
    this.assertHuman(principal, tr('只有人可以新建或重命名文件夾'));
    const folder = this.findFolder(normalizeFolderPath(input.path));
    if (!folder) throw fail(404, 'not_found', tr('找不到文件夾 {folder}', { folder: input.path }));
    let current = folder;
    let moved = null;
    if (clean(input.newPath)) {
      const target = normalizeFolderPath(input.newPath);
      if (target !== folder) {
        moved = await this.moveFolder(t, folder, target, principal);
        current = target;
      }
    }
    const settings = pickFolderSettings(input);
    if (Object.keys(settings).length) {
      if (settings.ownerIds !== undefined) this.assertOwnerRole(principal);
      if (settings.defaultTemplate) this.getTemplate(settings.defaultTemplate);
      const next = normalizeFolderSettings({ ...(this.folders.get(current) || {}), ...settings });
      this.folders.set(current, next);
      t.writeRaw(`${DOCS}/${current}/${FOLDER_FILE}`, folderYaml(next));
    }
    return { path: current, ...this.folders.get(current), moved };
  }

  async moveFolder(t, from, to, principal) {
    if (to.toLowerCase() === from.toLowerCase()) throw fail(400, 'invalid_folder', tr('只改大小寫的重命名請分兩次進行（先改成別的名稱）'));
    if (this.findFolder(to)) throw fail(409, 'duplicate_folder', tr('文件夾「{folder}」已存在', { folder: this.findFolder(to) }));
    if (to.startsWith(`${from}/`)) throw fail(400, 'invalid_folder', tr('不能把文件夾移到它自己的子文件夾裡'));
    const subtreeDepth = Math.max(0, ...this.allFolders().filter(f => f === from || f.startsWith(`${from}/`)).map(f => f.split('/').length - from.split('/').length));
    if (to.split('/').length + subtreeDepth > MAX_DEPTH) throw fail(400, 'invalid_folder', tr('文件夾最多 {n} 層', { n: MAX_DEPTH }));
    const swap = f => (f === from ? to : f.startsWith(`${from}/`) ? to + f.slice(from.length) : f);
    // 磁碟上目錄裡的所有檔案（文檔、_folder.yaml、其他檔案）一起移動
    const rootDir = path.join(this.store.root, DOCS, ...from.split('/'));
    const files = [];
    const walk = async dir => {
      let entries = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else files.push(full);
      }
    };
    await walk(rootDir);
    for (const full of files) {
      const rel = path.relative(this.store.root, full).split(path.sep).join('/');
      const folderRel = folderOfPath(rel);
      const target = `${DOCS}/${swap(folderRel)}/${path.posix.basename(rel)}`;
      const isPub = [...this.docs.values()].find(d => d.pub?.path === rel);
      if (isPub) continue;
      t.writeRaw(target, await fs.readFile(full));
      t.removeRaw(rel);
    }
    let docs = 0;
    for (const d of this.docs.values()) {
      if (d.pub) {
        const f = folderOfPath(d.pub.path);
        if (f === from || f.startsWith(`${from}/`)) {
          t.removeRaw(d.pub.path);
          d.pub.path = `${DOCS}/${swap(f)}/${path.posix.basename(d.pub.path)}`;
          this.writeEntry(t, d, 'pub');
          docs++;
        }
      } else if (d.draft) {
        const f = d.draft.meta.folder || DEFAULT_FOLDER;
        if (f === from || f.startsWith(`${from}/`)) {
          d.draft.meta.folder = swap(f);
          this.writeEntry(t, d, 'draft');
          docs++;
        }
      }
    }
    const nextFolders = new Map();
    for (const [f, s] of this.folders) nextFolders.set(swap(f), s);
    this.folders = nextFolders;
    if (!this.folders.has(to)) this.folders.set(to, {});
    const parts = to.split('/');
    for (let i = 1; i < parts.length; i++) if (!this.findFolder(parts.slice(0, i).join('/'))) this.createFolderEntry(t, parts.slice(0, i).join('/'), {});
    this.unregistered = this.unregistered.map(u => (u.folder && (u.folder === from || u.folder.startsWith(`${from}/`)) ? { ...u, folder: swap(u.folder), path: `${DOCS}/${swap(u.folder)}/${path.posix.basename(u.path)}` } : u));
    return { from, to, docs };
  }

  deleteFolder(t, input = {}, principal) {
    this.assertOwnerRole(principal);
    const folder = this.findFolder(normalizeFolderPath(input.path));
    if (!folder) throw fail(404, 'not_found', tr('找不到文件夾 {folder}', { folder: input.path }));
    const inside = f => f === folder || f.startsWith(`${folder}/`);
    const hasDocs = [...this.docs.values()].some(d => inside(this.folderOf(d)));
    const hasSub = this.allFolders().some(f => f.startsWith(`${folder}/`));
    const hasFiles = this.unregistered.some(u => u.folder && inside(u.folder));
    if (hasDocs || hasSub || hasFiles) throw fail(409, 'folder_not_empty', tr('只能刪除空文件夾；「{folder}」裡還有文檔或子文件夾', { folder }));
    t.removeRaw(`${DOCS}/${folder}/${FOLDER_FILE}`);
    this.folders.delete(folder);
    return { path: folder, deleted: true };
  }

  // ------------------------------------------------------------ 模板
  upsertTemplate(t, input = {}, principal) {
    this.assertOwnerRole(principal);
    const existing = input.id ? this.templates.get(input.id) : null;
    if (input.id && !existing) throw fail(404, 'not_found', tr('模板 {id} 不存在', { id: input.id }));
    const objectKinds = OBJECT_CATEGORIES.制度.kinds;
    const id = existing ? existing.id : this.store.nextId(ID_PREFIX.template);
    const tpl = normalizeTemplate({ ...(existing || {}), ...input, i18n: input.i18n ?? existing?.i18n, generator: existing?.generator }, { id, objectKinds });
    if (tpl.defaultFolder) tpl.defaultFolder = normalizeFolderPath(tpl.defaultFolder);
    this.templates.set(id, tpl);
    t.touch('template', id);
    return tpl;
  }

  templateUsage() {
    const out = {};
    for (const d of this.docs.values()) {
      const k = this.head(d).meta.template;
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  // ------------------------------------------------------------ 列表、視圖、搜索
  visibleEntries(principal, { drafts = false, obsolete = false } = {}) {
    const seeDrafts = drafts && this.canSeeDrafts(principal);
    const out = [];
    for (const d of this.docs.values()) {
      if (d.pub) {
        if (d.pub.meta.status === '已廢止' && !obsolete) continue;
        out.push({ doc: d, side: 'pub' });
      } else if (seeDrafts) out.push({ doc: d, side: 'draft' });
    }
    return out;
  }

  inView(view, { doc: d, side }, principal, now = Date.now()) {
    const pub = d.pub?.meta;
    const me = principal?.id;
    switch (view) {
      case 'mine': return !!d.draft && (d.draft.meta.createdBy?.id === me || d.draft.meta.updatedBy?.id === me);
      case 'review': {
        if (d.draft?.meta.status !== '待審') return false;
        const ids = this.reviewersOf(d);
        return principal?.isAdmin || (ids.length ? ids.includes(me) : principal?.role === 'owner' && principal?.kind === 'human');
      }
      case 'recent': {
        const ats = [pub?.change?.publishedAt, pub?.updatedAt, side === 'draft' || this.canSeeDrafts(principal) ? d.draft?.meta.updatedAt : null].filter(Boolean).map(Date.parse);
        return ats.some(x => now - x <= 14 * DAY);
      }
      case 'review-soon': {
        const n = pub?.status === '已發布' && pub.review?.nextAt ? Date.parse(pub.review.nextAt) : null;
        return n !== null && n >= now && n - now <= 14 * DAY;
      }
      case 'review-overdue': {
        const n = pub?.status === '已發布' && pub.review?.nextAt ? Date.parse(pub.review.nextAt) : null;
        return n !== null && n < now;
      }
      case 'broken-refs': return pub?.status === '已發布' && Object.values(this.refsOf(d.pub.body)).some(r => r.state !== 'ok');
      case 'unlinked': { const m = this.head(d).meta; return !pub?.generated && !m.subjects.length && !m.objects.length; }
      case 'obsolete': return pub?.status === '已廢止';
      default: return true;
    }
  }

  viewCounts(principal) {
    const drafts = this.canSeeDrafts(principal);
    const out = {};
    for (const v of VIEWS) {
      if (v === 'unregistered') { out[v] = drafts ? this.unregistered.length : 0; continue; }
      if (['mine', 'review'].includes(v) && !drafts) { out[v] = 0; continue; }
      const entries = this.visibleEntries(principal, { drafts: drafts && ['mine', 'review', 'recent', 'unlinked'].includes(v), obsolete: v === 'obsolete' });
      out[v] = entries.filter(e => this.inView(v, e, principal)).length;
    }
    return out;
  }

  /** GET /docs：篩選、智能視圖、搜索。 */
  list(query = {}, principal) {
    const view = query.view || null;
    if (view && !VIEWS.includes(view)) throw fail(400, 'invalid_input', tr('{field} 必須為 {values}', { field: 'view', values: VIEWS.join(' / ') }));
    if (view === 'unregistered') return { items: [], unregistered: this.canSeeDrafts(principal) ? this.unregistered : [], total: 0 };
    const drafts = query.drafts === '1' || query.drafts === true || ['mine', 'review'].includes(view);
    const obsolete = query.obsolete === '1' || query.obsolete === true || view === 'obsolete' || ['已廢止'].includes(query.status);
    let entries = this.visibleEntries(principal, { drafts, obsolete });
    if (view) entries = entries.filter(e => this.inView(view, e, principal));
    const folder = clean(query.folder);
    if (folder) entries = entries.filter(e => { const f = this.folderOf(e.doc); return f === folder || f.startsWith(`${folder}/`); });
    const tags = idList(query.tags).map(x => this.canonicalTag(x).toLowerCase());
    if (tags.length) {
      const any = query.tagMode === 'any';
      entries = entries.filter(e => {
        const own = this.head(e.doc).meta.tags.map(x => x.toLowerCase());
        return any ? tags.some(x => own.includes(x)) : tags.every(x => own.includes(x));
      });
    }
    const templates = idList(query.template);
    if (templates.length) entries = entries.filter(e => templates.includes(this.head(e.doc).meta.template));
    const statuses = idList(query.status);
    if (statuses.length) entries = entries.filter(e => statuses.includes(this.statusOf(e.doc)) || (e.doc.draft && statuses.includes(e.doc.draft.meta.status) && drafts));
    if (clean(query.owner)) { const o = clean(query.owner).toLowerCase(); entries = entries.filter(e => { const m = this.head(e.doc).meta; return (m.owner || '').toLowerCase().includes(o) || m.ownerIds.includes(clean(query.owner)); }); }
    if (clean(query.subjectId)) entries = entries.filter(e => this.head(e.doc).meta.subjects.includes(clean(query.subjectId)) || Object.values(this.head(e.doc).meta.fields || {}).flat().includes(clean(query.subjectId)));
    if (clean(query.objectId)) entries = entries.filter(e => { const m = this.head(e.doc).meta; return m.objects.includes(clean(query.objectId)) || m.objectId === clean(query.objectId) || e.doc.pub?.meta.objectId === clean(query.objectId); });
    if (query.since) { const since = Date.parse(query.since); if (!Number.isNaN(since)) entries = entries.filter(e => Date.parse(this.summary(e.doc, e.side).updatedAt || 0) >= since); }
    let items;
    let terms = [];
    const q = clean(query.q);
    if (q) {
      const res = this.search.search(entries, q);
      terms = res.terms;
      items = res.hits.map(h => ({ ...this.summary(h.doc, h.side), score: h.score, match: h.match }));
    } else {
      items = entries.map(e => this.summary(e.doc, e.side));
      const sort = query.sort || 'updated';
      if (sort === 'title') items.sort((a, b) => a.title.localeCompare(b.title));
      else if (sort === 'id') items.sort((a, b) => a.id.localeCompare(b.id));
      else if (sort === 'review') items.sort((a, b) => (a.review?.nextAt || '9999').localeCompare(b.review?.nextAt || '9999'));
      else items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || b.id.localeCompare(a.id));
    }
    const total = items.length;
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 100));
    const offset = Math.max(0, Number(query.cursor) || 0);
    const page = items.slice(offset, offset + limit);
    return { items: page, total, next: offset + limit < total ? String(offset + limit) : null, terms, resolved: q ? this.search.lastResolved : null };
  }

  /** 按章節分段（智能體按段讀取、外部 RAG 導入）。 */
  sections(doc, { side = 'pub' } = {}) {
    const e = side === 'draft' ? doc.draft : doc.pub;
    if (!e) throw fail(404, 'not_found', tr('找不到文檔 {id}', { id: doc.id }));
    const version = side === 'draft' ? null : e.meta.version ?? null;
    return parseSections(e.body).map(s => ({
      anchor: s.anchor, heading: s.heading, level: s.level, path: s.path, line: s.line, text: s.text, chars: [...s.text].length,
      refs: uniq(extractRefs(s.raw).map(r => r.id)),
      cite: `〔${doc.id}${s.anchor ? `§${s.heading}` : ''}${version ? `·v${version}` : ''}〕`
    }));
  }

  health(now = Date.now()) {
    const out = { total: this.docs.size, published: 0, drafts: 0, inReview: 0, obsolete: 0, reviewOverdue: 0, reviewSoon: 0, brokenRefs: 0, unregistered: this.unregistered.length, unlinked: 0 };
    for (const d of this.docs.values()) {
      const p = d.pub?.meta;
      if (p?.status === '已發布') out.published++;
      else if (p?.status === '已廢止') out.obsolete++;
      else out.drafts++;
      if (d.draft?.meta.status === '待審') out.inReview++;
      if (p?.status === '已發布') {
        const n = p.review?.nextAt ? Date.parse(p.review.nextAt) : null;
        if (n !== null && n < now) out.reviewOverdue++;
        else if (n !== null && n - now <= 14 * DAY) out.reviewSoon++;
        if (Object.values(this.refsOf(d.pub.body)).some(r => r.state !== 'ok')) out.brokenRefs++;
      }
      const m = this.head(d).meta;
      if (!m.subjects.length && !m.objects.length) out.unlinked++;
    }
    return out;
  }
}

function revisionMeta(pubMeta) {
  const m = structuredClone(pubMeta);
  for (const k of ['version', 'change', 'review', 'replacedBy', 'obsoleteReason', 'obsoleteAt', 'obsoleteBy', 'generated', 'aiDraft', 'editors']) delete m[k];
  m.status = '草稿';
  m.baseVersion = pubMeta.version ?? null;
  return m;
}

function pickFolderSettings(input) {
  const out = {};
  if (input.description !== undefined) out.description = clean(input.description) || null;
  if (input.domain !== undefined) out.domain = clean(input.domain) || null;
  if (input.defaultTemplate !== undefined) out.defaultTemplate = clean(input.defaultTemplate) || null;
  if (input.defaultTags !== undefined) out.defaultTags = idList(input.defaultTags);
  if (input.ownerIds !== undefined) out.ownerIds = idList(input.ownerIds);
  return out;
}

function normalizeFolderSettings(s) {
  const out = {};
  if (clean(s.description)) out.description = clean(s.description);
  if (clean(s.domain)) out.domain = clean(s.domain);
  if (clean(s.defaultTemplate)) out.defaultTemplate = clean(s.defaultTemplate);
  if (idList(s.defaultTags).length) out.defaultTags = idList(s.defaultTags);
  if (idList(s.ownerIds).length) out.ownerIds = idList(s.ownerIds);
  return out;
}

const folderYaml = s => (Object.keys(s).length ? YAML.stringify(s, { lineWidth: 0 }) : '# 文件夾設定：description、domain、ownerIds、defaultTemplate、defaultTags（見 docs/README.md）\n');

function sniffImage(buf, type) {
  const hex = buf.subarray(0, 12).toString('hex');
  if (type === 'image/png') return hex.startsWith('89504e470d0a1a0a');
  if (type === 'image/jpeg') return hex.startsWith('ffd8ff');
  if (type === 'image/gif') return hex.startsWith('474946383761') || hex.startsWith('474946383961');
  if (type === 'image/webp') return hex.startsWith('52494646') && buf.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

/** 文檔相關的提交說明（繁體原文，寫入 Git）。 */
export const docMessages = {
  create: r => `[文檔] 新建草稿 ${r.id}《${r.title}》`,
  save: r => `[文檔] 保存草稿 ${r.id}`,
  discard: r => (r.deleted ? `[文檔] 刪除草稿 ${r.id}《${r.title || ''}》` : `[文檔] 放棄修訂 ${r.id}`),
  submit: r => `[文檔] 提交審閱 ${r.id}《${r.title}》`,
  reject: r => `[文檔] 退回 ${r.id}：${String(r.reviewNote?.note || '').slice(0, 60)}`,
  publish: r => {
    const parts = [r.first ? '首次發布' : r.major ? '重大修訂' : '小修'];
    if (r.registered) parts.push(`登記客體 ${r.objectId}`);
    if (r.tookOver) parts.push(`接管客體 ${r.objectId}`);
    if (r.affected) parts.push(`${r.demoted} 條知識降為 L1，${r.queued} 條排入重驗`);
    if (r.bound.length) parts.push(`綁定 ${r.bound.length} 個主體`);
    return `[文檔] 發布 ${r.id} v${r.version}（${parts.join('，')}）${r.note ? `：${String(r.note).slice(0, 80)}` : ''}`;
  },
  obsolete: r => `[文檔] 廢止 ${r.id}${r.replacedBy ? `，由 ${r.replacedBy} 替代` : ''}${r.objectId ? `（客體 ${r.objectId} 下線）` : ''}${r.migrated?.length ? `，依據遷移到 ${r.replacedBy}（${r.migrated.length} 個主體）` : ''}`,
  migrate: r => `[文檔] ${r.id} 的依據遷移到 ${r.replacedBy}（${r.migrated.length} 個主體）`,
  aiDraft: r => `[文檔] AI 起草 ${r.id}《${r.title}》`,
  import: r => `[文檔] 導入 ${r.importedFrom} → ${r.id}《${r.title}》`,
  generate: r => (r.changed ? `[文檔] ${r.created ? '生成' : '重新生成'}手冊 ${r.id}《${r.title}》v${r.version}` : `[文檔] 手冊 ${r.id} 沒有變化`),
  extract: r => `[文檔] 從 ${r.docId} v${r.version} 提取 ${r.created.length} 條斷言${r.skipped.length ? `（跳過 ${r.skipped.length} 條重複）` : ''}`,
  review: r => `[文檔] 確認複審 ${r.id}（下次 ${r.review.nextAt}）`,
  organize: r => {
    const c = r.changes || {};
    if (c.moved && Object.keys(c).length === 1) return `[文檔] 移動 ${r.id} → ${c.moved.to}`;
    if (c.tags && Object.keys(c).length === 1) return `[文檔] 標籤 ${r.id}：${[...c.tags.added.map(x => `+${x}`), ...c.tags.removed.map(x => `−${x}`)].join(' ')}`;
    const what = [c.tags && '標籤', c.links && '關聯', c.owner && '負責人', c.moved && `移動 → ${c.moved.to}`].filter(Boolean).join('、');
    return `[文檔] 整理 ${r.id}（${what || '無變化'}）`;
  },
  bulk: r => `[文檔] 批量整理 ${r.changed} 篇`,
  remove: r => `[管理] 刪除文檔 ${r.id}`,
  register: r => `[文檔] 登記 ${r.registeredFrom} → ${r.id}《${r.title}》`,
  asset: r => `[文檔] 上傳圖片 ${r.id}/${r.name}`,
  folderCreate: r => `[文檔] 新建文件夾 ${r.path}`,
  folderUpdate: r => (r.moved ? `[文檔] 重命名文件夾 ${r.moved.from} → ${r.moved.to}（${r.moved.docs} 篇）` : `[文檔] 文件夾設定 ${r.path}`),
  folderDelete: r => `[文檔] 刪除文件夾 ${r.path}`,
  tagUpdate: r => (r.renamed ? `[文檔] 重命名標籤 ${r.renamed.from} → ${r.renamed.to}（${r.renamed.docs} 篇）` : `[文檔] 標籤設定 ${r.name}`),
  tagMerge: r => `[文檔] 合併標籤 ${r.from.join('、')} → ${r.to}（${r.docs} 篇）`,
  template: r => `[文檔] 模板 ${r.id} ${r.name}`
};
