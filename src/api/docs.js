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

  r.get('/docs/export', consumer, (req, res) => {
    if ((req.query.format || 'jsonl') !== 'jsonl') throw new HttpError(400, tr('{field} 必須為 {values}', { field: 'format', values: 'jsonl' }), 'invalid_input');
    const base = baseUrlOf(ctx, req);
    const { items } = L().list({ ...req.query, q: undefined, limit: 500, view: undefined }, req.principal);
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
    const items = L().impactOf(objectId);
    const linked = L().head(doc).meta.subjects.filter(sid => !items.some(x => x.kind === 'binding' && x.subject?.id === sid)).map(sid => S().subjectSummary(S().subjects.get(sid))).filter(Boolean).filter(s => s.type !== '別名');
    res.json({ data: { objectId, items, bindable: linked } });
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
