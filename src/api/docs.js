// 文檔庫 API（設計文件 §12），掛在 /api/v1 下。回應格式與其他端點相同：{ data, commit?, warnings?, problems? }。
// 讀已發布和已廢止的文檔：consumer；讀草稿、修訂、差異與一切寫入：contributor；發布、審閱、廢止等由文檔庫按模板與身份再判定。
import fs from 'node:fs/promises';
import express from 'express';
import { HttpError, requireAdmin } from './auth.js';
import { docMessages, ASSET_MAX } from '../store/docs.js';
import { localizeTemplate, skeleton, checkFields } from '../store/doc-templates.js';
import { lintDoc } from '../services/doc-lint.js';
import { docHistory, docDiff, readVersion } from '../services/doc-history.js';
import { serializeDoc } from '../store/docs.js';
import { convertToMarkdown, CONVERT_MAX } from '../services/doc-convert.js';
import { markdownZip } from '../services/doc-export.js';
import { tokenize } from '../services/doc-search.js';
import { tr } from '../i18n/index.js';

/** 遠端是 GitHub 或 GitLab 時，檔案在網頁上的地址（不帶憑證）；其他遠端返回 null。 */
export function gitWebUrl(remote, branch, file) {
  if (!remote || !file) return null;
  let host;
  let repo;
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(remote);
  if (ssh) [, host, repo] = ssh;
  else {
    try {
      const u = new URL(remote);
      if (!/^https?:$/.test(u.protocol)) return null;
      host = u.hostname;
      repo = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    } catch { return null; }
  }
  if (!host || !repo || !/^[\w.-]+(\/[\w.-]+)+$/.test(repo)) return null;
  // 只開放 443 端口時用的 SSH 主機，網頁在主站
  if (/^ssh\.github\.com$/i.test(host)) host = 'github.com';
  else if (/^altssh\.gitlab\.com$/i.test(host)) host = 'gitlab.com';
  const encPath = file.split('/').map(encodeURIComponent).join('/');
  const ref = encodeURIComponent(branch || 'main');
  if (/(^|\.)github\./i.test(host) || /^github\.com$/i.test(host)) return `https://${host}/${repo}/blob/${ref}/${encPath}`;
  if (/(^|\.)gitlab\./i.test(host) || /^gitlab\.com$/i.test(host)) return `https://${host}/${repo}/-/blob/${ref}/${encPath}`;
  return null;
}

const json = (res, out, status = 200) => {
  const { problems, ...data } = out.result && typeof out.result === 'object' ? out.result : { value: out.result };
  res.status(status).json({ data, commit: out.commit, warnings: out.warnings, ...(problems ? { problems } : {}) });
};

export function docRoutes(r, ctx, { consumer, contributor, baseUrlOf }) {
  const S = () => ctx.store;
  const L = () => ctx.store.docs;
  const tx = (req, message, fn) => S().tx(req.principal, message, fn);
  const needDrafts = req => {
    if (!L().canSeeDrafts(req.principal)) throw new HttpError(403, tr('讀草稿和修訂需要 contributor 權限'), 'forbidden');
  };

  // ------------------------------------------------------------ 列表、搜索、導出
  r.get('/docs', consumer, (req, res) => {
    const out = L().list(req.query, req.principal);
    res.json({ data: out.items, total: out.total, next: out.next, terms: out.terms, resolved: out.resolved, ...(out.unregistered ? { unregistered: out.unregistered } : {}) });
  });

  r.get('/doc-sections', consumer, (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) throw new HttpError(400, tr('{field} 必填', { field: 'q' }), 'invalid_input');
    let entries = L().visibleEntries(req.principal, { drafts: false, obsolete: req.query.obsolete === '1' });
    if (req.query.folder) entries = entries.filter(e => { const f = L().folderOf(e.doc); return f === req.query.folder || f.startsWith(`${req.query.folder}/`); });
    const out = L().search.sections(entries, q, Math.min(100, Number(req.query.limit) || 20));
    res.json({
      data: out.hits.map(h => ({ docId: h.doc.id, title: h.doc.pub.meta.title, version: h.doc.pub.meta.version ?? null, folder: L().folderOf(h.doc), anchor: h.section.anchor, heading: h.section.heading, path: h.section.path, snippet: h.snippet, text: req.query.full === '1' ? h.section.text : undefined, score: h.score, cite: `〔${h.doc.id}${h.section.anchor ? `§${h.section.heading}` : ''}·v${h.doc.pub.meta.version}〕` })),
      terms: out.terms
    });
  });

  r.get('/docs/export', consumer, async (req, res) => {
    const format = req.query.format || 'jsonl';
    if (!['jsonl', 'zip'].includes(format)) throw new HttpError(400, tr('{field} 必須為 {values}', { field: 'format', values: 'jsonl / zip' }), 'invalid_input');
    const base = baseUrlOf(ctx, req);
    const { items } = L().list({ ...req.query, q: undefined, limit: 500, view: undefined }, req.principal);
    if (format === 'zip') {
      // Markdown 壓縮包：已發布的文檔（obsolete=1 時含已廢止），圖片與 README 索引
      const docs = items.map(it => L().get(it.id)).filter(d => d.pub).map(doc => ({ doc }));
      const out = await markdownZip(L(), docs, { baseUrl: base });
      res.type('application/zip').setHeader('Content-Disposition', `attachment; filename="docs-${out.generatedAt.slice(0, 10)}.zip"`);
      res.setHeader('X-Doc-Count', String(out.docs));
      return res.send(out.buffer);
    }
    const lines = [];
    for (const it of items) {
      const doc = L().get(it.id);
      if (!doc.pub) continue;
      for (const s of L().sections(doc)) {
        lines.push(JSON.stringify({ docId: doc.id, title: it.title, version: it.version, status: it.status, folder: it.folder, template: it.template, tags: it.tags, subjects: it.subjects, anchor: s.anchor, heading: s.heading, path: s.path, text: s.text, refs: s.refs, cite: s.cite, url: `${base}/#doc/${doc.id}${s.anchor ? `/${encodeURIComponent(s.anchor)}` : ''}` }));
      }
    }
    res.type('application/x-ndjson; charset=utf-8').setHeader('Content-Disposition', 'attachment; filename="docs.jsonl"');
    res.send(lines.join('\n') + (lines.length ? '\n' : ''));
  });

  r.post('/docs/lint', contributor, (req, res) => {
    const b = req.body || {};
    const lib = L();
    const tpl = lib.getTemplate(b.template || (b.id && lib.docs.get(b.id) ? lib.head(lib.docs.get(b.id)).meta.template : 'TPL-0001'));
    const fc = checkFields(tpl, b.fields, { store: S(), docs: lib.docs, phase: b.phase || 'publish' });
    const meta = { id: b.id || null, title: b.title, template: tpl.id, summary: b.summary, owner: b.owner, ownerIds: b.ownerIds || [], tags: b.tags || [], subjects: [...new Set([...(b.subjects || []), ...fc.links.subjects])], objects: [...new Set([...(b.objects || []), ...fc.links.objects])], fields: fc.fields };
    const folder = b.folder || (b.id && lib.docs.get(b.id) ? lib.folderOf(lib.docs.get(b.id)) : null);
    res.json({ data: lintDoc(lib, { id: b.id, meta, body: String(b.body || ''), folder }, { phase: ['save', 'submit', 'publish'].includes(b.phase) ? b.phase : 'publish', fieldProblems: fc.problems }) });
  });

  r.post('/docs/register', contributor, async (req, res) => {
    const out = await tx(req, docMessages.register, t => L().registerFile(t, req.body || {}, req.principal));
    json(res, out, 201);
  });

  r.post('/docs/bulk', contributor, async (req, res) => {
    const out = await tx(req, docMessages.bulk, t => L().bulk(t, req.body || {}, req.principal));
    json(res, out);
  });

  // ------------------------------------------------------------ 第二期：導入、AI 起草、生成手冊
  // 導入 Word、PDF：請求體是檔案本身；convert 只轉換不寫入（預覽），import 轉換後建立草稿
  const rawDoc = express.raw({ type: () => true, limit: CONVERT_MAX + 1024 });
  const rawDocBody = (req, res, next) => rawDoc(req, res, err => {
    if (err?.type === 'entity.too.large') return next(new HttpError(413, tr('檔案不超過 {n} MB', { n: CONVERT_MAX / 1024 / 1024 }), 'file_too_large'));
    next(err);
  });
  const convertReq = req => convertToMarkdown(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), { name: String(req.query.name || req.headers['x-file-name'] || ''), contentType: req.headers['content-type'] });
  r.post('/docs/convert', contributor, rawDocBody, async (req, res) => {
    S().assertCanContribute(req.principal);
    res.json({ data: await convertReq(req) });
  });
  r.post('/docs/import', contributor, rawDocBody, async (req, res) => {
    const conv = await convertReq(req);
    const name = String(req.query.name || req.headers['x-file-name'] || conv.format).replace(/^.*[\\/]/, '');
    const title = String(req.query.title || conv.title || name.replace(/\.[^.]+$/, '')).trim();
    const out = await tx(req, docMessages.import, t => {
      for (const w of conv.warnings) t.warn(w);
      const created = L().create(t, { title, folder: req.query.folder, template: req.query.template, body: conv.body, tags: req.query.tags }, req.principal);
      return { ...created, importedFrom: name, format: conv.format };
    });
    json(res, out, 201);
  });

  // AI 起草：按模板和選中主體的 L0、L1 知識生成草稿，標記「AI 起草」；preview=1 只返回內容不寫入
  r.post('/docs/ai-draft', contributor, async (req, res) => {
    const draft = await ctx.docAi.draft(req.body || {}, req.principal);
    if (req.body?.preview === true || req.query.preview === '1') return res.json({ data: draft, warnings: draft.warnings });
    const out = await tx(req, docMessages.aiDraft, t => {
      for (const w of draft.warnings) t.warn(w);
      const created = L().create(t, { template: draft.template, title: draft.title, folder: draft.folder, summary: draft.summary, body: draft.body, subjects: draft.subjects, fields: draft.fields, tags: req.body?.tags }, req.principal, { aiDraft: draft.aiDraft });
      return { ...created, composer: draft.composer, filled: draft.filled };
    });
    json(res, out, 201);
  });

  // 從知識生成主體手冊（subjectId）或領域手冊（domain）；已經生成過時重新生成
  r.post('/docs/generate', contributor, async (req, res) => {
    const out = await tx(req, docMessages.generate, t => L().generate(t, req.body || {}, req.principal));
    json(res, out, out.result.created ? 201 : 200);
  });
  r.post('/docs/:id/regenerate', contributor, async (req, res) => {
    const out = await tx(req, docMessages.generate, t => L().regenerate(t, req.params.id, req.principal));
    json(res, out);
  });

  // 從文檔抽取斷言：items 是 [{ subjectId, type, content, anchor }]；建議（不寫入）走 extract-suggestions
  r.post('/docs/:id/extract', contributor, async (req, res) => {
    const out = await tx(req, docMessages.extract, t => L().extractAssertions(t, req.params.id, req.body || {}, req.principal));
    json(res, out, out.result.created.length ? 201 : 200);
  });
  r.post('/docs/:id/extract-suggestions', contributor, async (req, res) => {
    res.json({ data: await ctx.docAi.suggestAssertions(req.params.id, req.body || {}, req.principal) });
  });

  r.post('/docs/:id/migrate-basis', contributor, async (req, res) => {
    const out = await tx(req, docMessages.migrate, t => L().migrateBasis(t, req.params.id, req.principal));
    json(res, out);
  });

  // ------------------------------------------------------------ 全局搜索（主體和文檔一起搜）
  r.get('/search', consumer, (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) throw new HttpError(400, tr('{field} 必填', { field: 'q' }), 'invalid_input');
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    res.json({ data: globalSearch(S(), L(), q, limit, req.principal) });
  });

  // ------------------------------------------------------------ 單篇文檔
  r.post('/docs', contributor, async (req, res) => {
    const out = await tx(req, docMessages.create, t => L().create(t, req.body || {}, req.principal));
    json(res, out, 201);
  });

  r.get('/docs/:id', consumer, async (req, res) => {
    const lib = L();
    const doc = lib.get(req.params.id);
    let view;
    if (req.query.version) {
      const v = await readVersion(lib, doc, req.query.version);
      if (req.query.format === 'md') return res.type('text/markdown; charset=utf-8').send(serializeDoc(v.meta, v.body));
      view = { ...lib.view(doc, { side: 'pub', principal: req.principal }), version: v.version, title: v.meta.title, summary: v.meta.summary || null, fields: v.meta.fields || {}, tags: v.meta.tags || [], change: v.meta.change || null, body: v.body, refs: lib.refsOf(v.body), historical: { hash: v.hash, path: v.path, current: !v.hash } };
    } else {
      const draft = req.query.draft === '1';
      if (draft) needDrafts(req);
      if (!doc.pub && !lib.canSeeDrafts(req.principal)) throw new HttpError(404, tr('找不到文檔 {id}', { id: doc.id }), 'not_found');
      view = lib.view(doc, { side: draft ? 'draft' : 'pub', principal: req.principal });
      if (req.query.format === 'md') {
        const e = draft ? doc.draft : doc.pub || doc.draft;
        return res.type('text/markdown; charset=utf-8').send(serializeDoc(e.meta, e.body));
      }
      if (draft || (!doc.pub && doc.draft)) view.problems = lib.lintCurrent(doc, 'publish', doc.draft);
    }
    const file = view.historical?.path || view.path;
    const st = S();
    view.git = { file: `${st.subdir}/${file}`, url: gitWebUrl(st.repo.status.remote, st.repo.status.branch, `${st.subdir}/${file}`) };
    res.json({ data: view });
  });

  r.get('/docs/:id/sections', consumer, (req, res) => {
    const doc = L().get(req.params.id);
    if (req.query.draft === '1') needDrafts(req);
    res.json({ data: { id: doc.id, title: L().head(doc).meta.title, version: doc.pub?.meta.version ?? null, sections: L().sections(doc, { side: req.query.draft === '1' ? 'draft' : 'pub' }) } });
  });

  r.get('/docs/:id/history', consumer, async (req, res) => {
    const doc = L().get(req.params.id);
    if (!doc.pub) needDrafts(req);
    res.json({ data: await docHistory(L(), doc, { limit: Math.min(100, Number(req.query.limit) || 100) }) });
  });

  r.get('/docs/:id/diff', contributor, async (req, res) => {
    const doc = L().get(req.params.id);
    res.json({ data: await docDiff(L(), doc, { from: req.query.from, to: req.query.to }) });
  });

  r.get('/docs/:id/impact', consumer, (req, res) => {
    const doc = L().get(req.params.id);
    const objectId = doc.pub?.meta.objectId || null;
    // 按章節預選（第二期）：比較修訂與已發布版本的章節，sourceRef 指向沒改的章節的知識不預選
    const { items, changedSections, sectionAware } = L().impactWithSections(doc);
    const linked = L().head(doc).meta.subjects.filter(sid => !items.some(x => x.kind === 'binding' && x.subject?.id === sid)).map(sid => S().subjectSummary(S().subjects.get(sid))).filter(Boolean).filter(s => s.type !== '別名');
    res.json({ data: { objectId, items, bindable: linked, changedSections, sectionAware } });
  });

  r.put('/docs/:id/draft', contributor, async (req, res) => {
    const out = await tx(req, docMessages.save, t => L().saveDraft(t, req.params.id, req.body || {}, req.principal));
    json(res, out);
  });
  r.delete('/docs/:id/draft', contributor, async (req, res) => {
    const out = await tx(req, docMessages.discard, t => L().discardDraft(t, req.params.id, req.principal));
    json(res, out);
  });
  r.patch('/docs/:id', contributor, async (req, res) => {
    const out = await tx(req, docMessages.organize, t => L().organize(t, req.params.id, req.body || {}, req.principal));
    json(res, out);
  });
  r.post('/docs/:id/submit', contributor, async (req, res) => {
    const out = await tx(req, docMessages.submit, t => L().submit(t, req.params.id, req.principal));
    json(res, out);
  });
  r.post('/docs/:id/publish', contributor, async (req, res) => {
    const out = await tx(req, docMessages.publish, t => L().publish(t, req.params.id, req.body || {}, req.principal));
    json(res, out);
  });
  r.post('/docs/:id/reject', contributor, async (req, res) => {
    const out = await tx(req, docMessages.reject, t => L().reject(t, req.params.id, req.body || {}, req.principal));
    json(res, out);
  });
  r.post('/docs/:id/obsolete', contributor, async (req, res) => {
    const out = await tx(req, docMessages.obsolete, t => L().obsolete(t, req.params.id, req.body || {}, req.principal));
    json(res, out);
  });
  r.post('/docs/:id/review', contributor, async (req, res) => {
    const out = await tx(req, docMessages.review, t => L().confirmReview(t, req.params.id, req.body || {}, req.principal));
    json(res, out);
  });
  r.delete('/docs/:id', requireAdmin, async (req, res) => {
    const out = await tx(req, docMessages.remove, t => L().remove(t, req.params.id, req.principal));
    json(res, out);
  });

  // ------------------------------------------------------------ 附件（只收圖片；請求體是圖片本身）
  const raw = express.raw({ type: () => true, limit: ASSET_MAX + 1024 });
  r.post('/docs/:id/assets', contributor, (req, res, next) => raw(req, res, err => {
    if (err?.type === 'entity.too.large') return next(new HttpError(413, tr('單張圖片不超過 2 MB'), 'asset_too_large'));
    next(err);
  }), async (req, res) => {
    const out = await tx(req, docMessages.asset, t => L().uploadAsset(t, req.params.id, { name: req.query.name || req.headers['x-file-name'], contentType: req.headers['content-type'], data: req.body }, req.principal));
    json(res, out, 201);
  });
  r.get('/docs/:id/assets', contributor, async (req, res) => {
    L().get(req.params.id);
    res.json({ data: (await L().assetList(req.params.id)).map(a => ({ ...a, url: `/api/v1/docs/${req.params.id}/assets/${encodeURIComponent(a.name)}`, markdown: `![${a.name.replace(/\.[^.]+$/, '')}](assets/${a.name})` })) });
  });
  r.get('/docs/:id/assets/:name', consumer, async (req, res) => {
    const a = L().assetPath(req.params.id, req.params.name);
    if (!a) throw new HttpError(404, tr('找不到附件 {name}', { name: req.params.name }), 'not_found');
    let data;
    try { data = await fs.readFile(a.file); } catch { throw new HttpError(404, tr('找不到附件 {name}', { name: req.params.name }), 'not_found'); }
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type(a.type).send(data);
  });

  // ------------------------------------------------------------ 文件夾
  r.get('/doc-folders', consumer, (req, res) => res.json({ data: L().folderTree(req.principal), views: L().viewCounts(req.principal), unregistered: L().canSeeDrafts(req.principal) ? L().unregistered.length : 0 }));
  r.post('/doc-folders', contributor, async (req, res) => {
    const out = await tx(req, docMessages.folderCreate, t => L().createFolder(t, req.body || {}, req.principal));
    json(res, out, 201);
  });
  r.patch('/doc-folders', contributor, async (req, res) => {
    const out = await tx(req, docMessages.folderUpdate, t => L().updateFolder(t, req.body || {}, req.principal));
    json(res, out);
  });
  r.delete('/doc-folders', contributor, async (req, res) => {
    const out = await tx(req, docMessages.folderDelete, t => L().deleteFolder(t, { path: req.query.path || req.body?.path }, req.principal));
    json(res, out);
  });

  // ------------------------------------------------------------ 標籤
  r.get('/doc-tags', consumer, (req, res) => res.json({ data: L().listTags() }));
  r.post('/doc-tags/merge', contributor, async (req, res) => {
    const out = await tx(req, docMessages.tagMerge, t => L().mergeTags(t, req.body || {}, req.principal));
    json(res, out);
  });
  r.put('/doc-tags/:name', contributor, async (req, res) => {
    const out = await tx(req, docMessages.tagUpdate, t => L().updateTag(t, req.params.name, req.body || {}, req.principal));
    json(res, out);
  });

  // ------------------------------------------------------------ 模板
  const tplView = tpl => ({ ...localizeTemplate(tpl), usage: L().templateUsage()[tpl.id] || 0 });
  r.get('/doc-templates', consumer, (req, res) => res.json({ data: [...S().docTemplates.values()].sort((a, b) => a.id.localeCompare(b.id)).map(tplView) }));
  r.get('/doc-templates/:id', consumer, (req, res) => {
    const tpl = L().getTemplate(req.params.id);
    res.json({ data: { ...tplView(tpl), source: req.query.source === '1' ? tpl : undefined } });
  });
  r.post('/doc-templates/:id/render', contributor, (req, res) => {
    const tpl = L().getTemplate(req.params.id);
    const fc = req.body?.fields ? checkFields(tpl, req.body.fields, { store: S(), docs: L().docs, phase: 'publish' }) : null;
    res.json({ data: { template: tplView(tpl), body: skeleton(tpl), fields: localizeTemplate(tpl).fields, problems: fc?.problems || [] } });
  });
  r.post('/doc-templates', contributor, async (req, res) => {
    const out = await tx(req, docMessages.template, t => L().upsertTemplate(t, { ...(req.body || {}), id: undefined }, req.principal));
    json(res, out, 201);
  });
  r.put('/doc-templates/:id', contributor, async (req, res) => {
    const out = await tx(req, docMessages.template, t => L().upsertTemplate(t, { ...(req.body || {}), id: req.params.id }, req.principal));
    json(res, out);
  });
}

/**
 * 全局搜索：主體（名稱、ID、別名、定義、標籤；查詢中的術語按最長匹配解析）與文檔（同文檔庫搜索）一起返回。
 * 結果按相關度排序：精確命中名稱或 ID 最前，其次是查詢中解析出的術語、名稱包含、別名、定義。
 */
export function globalSearch(store, lib, q, limit, principal) {
  const nq = q.toLowerCase();
  const resolved = store.resolveTerms(q);
  const viaTerm = new Map();
  for (const m of resolved.matches) {
    const s = store.subjects.get(m.id);
    const targets = s?.type === '別名' ? store.aliasTargets(s) : [m.id];
    for (const id of targets) if (!viaTerm.has(id)) viaTerm.set(id, { term: m.term, alias: s?.type === '別名' ? s.name : null });
  }
  const terms = tokenize(q).key;
  const scored = [];
  for (const s of store.subjects.values()) {
    if (s.type === '別名') continue;
    const name = (s.name || '').toLowerCase();
    const aliases = store.aliasesOf(s.id);
    let score = 0;
    let match = null;
    if (s.id.toLowerCase() === nq || name === nq) { score = 100; match = { field: 'name' }; }
    else if (viaTerm.has(s.id)) { score = 60; match = viaTerm.get(s.id).alias ? { field: 'alias', text: viaTerm.get(s.id).alias } : { field: 'name' }; }
    else if (name.includes(nq) || s.id.toLowerCase().includes(nq)) { score = 40; match = { field: 'name' }; }
    else if (aliases.some(a => (a.name || '').toLowerCase().includes(nq))) { score = 30; match = { field: 'alias', text: aliases.find(a => (a.name || '').toLowerCase().includes(nq)).name }; }
    else if ((s.tags || []).some(t => t.toLowerCase().includes(nq))) { score = 15; match = { field: 'tag' }; }
    else if ((s.definition || '').toLowerCase().includes(nq)) { score = 12; match = { field: 'definition' }; }
    else if (terms.length > 1) {
      const hay = `${name} ${(s.definition || '').toLowerCase()} ${aliases.map(a => a.name).join(' ').toLowerCase()}`;
      const hit = terms.filter(t => hay.includes(t)).length;
      if (hit / terms.length >= 0.6) { score = 5 + hit; match = { field: 'tokens' }; }
    }
    if (!score) continue;
    scored.push({ ...store.subjectSummary(s), definition: s.definition || null, aliases: aliases.map(a => a.name), assertions: s.assertions.filter(a => a.validity.level !== 'E1').length, documents: lib.documentsFor(s.id).length, score: score + Math.min(5, (store.usage.subjects[s.id]?.count || 0) / 20), match });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const docs = lib.list({ q, limit, drafts: lib.canSeeDrafts(principal) ? '1' : undefined }, principal);
  return {
    q,
    subjects: scored.slice(0, limit),
    subjectTotal: scored.length,
    documents: docs.items,
    documentTotal: docs.total,
    resolved: { canonical: resolved.canonical, ambiguous: resolved.ambiguous.map(a => ({ term: a.term, candidates: a.candidates.map(c => c.id) })) },
    terms: docs.terms
  };
}
