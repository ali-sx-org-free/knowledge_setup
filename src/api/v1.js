// /api/v1：生產型 API（三方智能體生產與管理知識）+ 消費型 API（獲取結構化知識與自然語言答案）。
import path from 'node:path';
import express from 'express';
import { requireRole, requireAdmin, HttpError } from './auth.js';
import { buildPrompt, buildSchema } from '../services/prompt.js';
import { buildOpenApi } from './openapi.js';
import { RuleError } from '../store/validity.js';
import { kindOfId } from '../store/model.js';
import { tr } from '../i18n/index.js';
import { RpaClient, RpaError, conformance, draftAction } from '../services/rpa.js';
import { executionView } from '../services/executions.js';
import { parseLocator, renderSceneInputs, renderValue } from '../store/rpa.js';
import { docRoutes } from './docs.js';

const consumer = requireRole('consumer');
const contributor = requireRole('contributor');
const owner = requireRole('owner');

const list = v => (v === undefined || v === '' ? undefined : String(v).split(',').map(s => s.trim()).filter(Boolean));

function ok(res, data, extra = {}, status = 200) {
  res.status(status).json({ data, ...extra });
}

function txOut(res, out, status = 200) {
  res.status(status).json({ data: out.result, commit: out.commit, warnings: out.warnings });
}

export function baseUrlOf(ctx, req) {
  const configured = ctx.settings.value('server.publicBaseUrl');
  if (configured) return configured.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

/** 批量提交中的 "$ref:名字" 替換。 */
function resolveRefs(value, refs, index) {
  if (typeof value === 'string' && value.startsWith('$ref:')) {
    const name = value.slice(5);
    if (!refs.has(name)) throw new RuleError(tr('第 {index} 條引用了未定義的 ref「{name}」（ref 必須在前面的條目中定義）', { index, name }), 400, 'unknown_ref');
    return refs.get(name);
  }
  if (Array.isArray(value)) return value.map(v => resolveRefs(v, refs, index));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, refs, index)]));
  return value;
}

/** RPA 的錯誤轉成知識庫的 HTTP 錯誤：找不到照舊 404，其餘一律 502（上游問題），錯誤碼帶 rpa_ 前綴。 */
async function rpaCall(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof RpaError)) throw err;
    const code = err.code?.startsWith('rpa_') ? err.code : `rpa_${err.code}`;
    throw new HttpError(err.status === 404 ? 404 : 502, tr('RPA：{message}', { message: err.message }), code);
  }
}

export function v1Router(ctx) {
  const r = express.Router();
  const S = () => ctx.store;
  const rpaPipeline = id => {
    const p = S().pipelines.get(id);
    if (!p) throw new HttpError(404, tr('找不到管道 {id}', { id }), 'not_found');
    if (p.type !== 'rpa') throw new HttpError(400, tr('管道 {id} 不是 RPA 管道', { id }), 'not_rpa_pipeline');
    return p;
  };
  const rpaAction = id => {
    const a = S().actions.get(id);
    if (!a) throw new HttpError(404, tr('找不到 Action {id}', { id }), 'not_found');
    const p = S().pipelines.get(a.pipelineId);
    if (p?.type !== 'rpa') throw new HttpError(400, tr('Action {id} 不是 RPA Action', { id }), 'not_rpa_action');
    return { action: a, pipeline: p };
  };
  const clientOf = p => new RpaClient(p, { env: ctx.env, fetchImpl: ctx.fetch });
  const listOf = (data, key) => (Array.isArray(data) ? data : Array.isArray(data?.[key]) ? data[key] : []);

  // ------------------------------------------------------------ 公開：教程、Schema、OpenAPI
  r.get('/prompt', (req, res) => {
    const role = req.query.role === 'consumer' ? 'consumer' : 'producer';
    const markdown = buildPrompt({ store: S(), baseUrl: baseUrlOf(ctx, req), role });
    if (req.query.format === 'json') return ok(res, { role, format: 'markdown', prompt: markdown, version: '0.1' });
    res.type('text/markdown; charset=utf-8').send(markdown);
  });
  r.get('/prompt/:role', (req, res) => {
    if (!['producer', 'consumer'].includes(req.params.role)) throw new HttpError(404, tr('{field} 必須為 {values}', { field: 'role', values: 'producer / consumer' }), 'not_found');
    const markdown = buildPrompt({ store: S(), baseUrl: baseUrlOf(ctx, req), role: req.params.role });
    if (req.query.format === 'json') return ok(res, { role: req.params.role, format: 'markdown', prompt: markdown, version: '0.1' });
    res.type('text/markdown; charset=utf-8').send(markdown);
  });
  r.get('/schema', (req, res) => ok(res, buildSchema(S())));
  r.get('/openapi.json', (req, res) => res.json(buildOpenApi(baseUrlOf(ctx, req))));
  r.get('/status', (req, res) => ok(res, { ok: true, version: '0.1.0', llm: ctx.llm.enabled ? { provider: 'openrouter', model: ctx.llm.model } : null, git: req.principal ? { remote: S().repo.status.remote, branch: S().repo.status.branch } : undefined }));

  // ------------------------------------------------------------ 消費：讀取
  r.get('/resolve', consumer, (req, res) => {
    const text = String(req.query.text || '');
    if (!text) throw new HttpError(400, tr('{field} 必填', { field: 'text' }), 'invalid_input');
    const out = S().resolveTerms(text);
    ok(res, { ...out, canonical: out.canonical.map(id => S().subjectSummary(S().subjects.get(id))) });
  });
  r.get('/subjects', consumer, (req, res) => ok(res, S().listSubjects({ q: req.query.q, type: req.query.type, domain: req.query.domain, level: req.query.level, limit: Number(req.query.limit) || 500 })));
  r.get('/subjects/:id', consumer, (req, res) => ok(res, S().card(req.params.id, { includeHistory: req.query.history === '1' })));
  r.get('/subjects/:id/context', consumer, (req, res) => {
    const card = S().card(req.params.id);
    const neighborIds = new Set();
    for (const rel of [...(card.relations?.outgoing || []), ...(card.relations?.incoming || [])]) for (const s of [rel.from, rel.to]) if (s && s.id !== req.params.id) neighborIds.add(s.id);
    const neighbors = [...neighborIds].map(id => {
      const s = S().subjects.get(id);
      return { ...S().subjectSummary(s), definition: s.definition, l0Assertions: s.assertions.filter(a => a.validity.level === 'L0').map(a => ({ id: a.id, type: a.type, content: a.content })) };
    });
    ok(res, { ...card, neighbors });
  });
  r.get('/subjects/:id/history', consumer, async (req, res) => {
    S().getSubject(req.params.id);
    ok(res, await S().repo.log({ limit: 50, file: path.join(S().subdir, 'subjects', `${req.params.id}.yaml`) }));
  });
  r.get('/objects', consumer, (req, res) => ok(res, S().listObjects({ category: req.query.category, status: req.query.status, q: req.query.q })));
  r.get('/objects/:id', consumer, (req, res) => {
    const o = S().getObject(req.params.id);
    ok(res, { ...o, boundSubjects: S().bindingsOfObject(o.id).map(({ subject, binding }) => ({ ...S().subjectSummary(subject), bindingId: binding.id, bindingLevel: binding.validity.level })), actions: (o.actionIds || []).map(id => S().actions.get(id)).filter(Boolean), managedBy: S().docs.managedInfo(o), documents: S().docs.documentsForObject(o.id) });
  });
  r.get('/assertions', consumer, (req, res) => ok(res, S().listAssertions({ level: req.query.level, type: req.query.type, subjectId: req.query.subjectId, q: req.query.q, pending: req.query.pending === '1' })));
  r.get('/relations', consumer, (req, res) => ok(res, S().listRelations({ type: req.query.type, level: req.query.level, subjectId: req.query.subjectId })));
  r.get('/items/:id', consumer, (req, res) => {
    const ref = S().getItem(req.params.id);
    ok(res, { kind: ref.kind, subject: S().subjectSummary(ref.subject), ...(ref.kind === 'relation' ? S().relationView(ref.item) : ref.item) });
  });
  r.get('/graph', consumer, (req, res) => ok(res, S().graph({
    domain: req.query.domain, types: list(req.query.types), relationTypes: list(req.query.relationTypes), levels: list(req.query.levels),
    focus: req.query.focus, depth: Math.min(4, Number(req.query.depth) || 2), includeAliases: req.query.aliases !== '0', includeE1: req.query.e1 === '1'
  })));
  r.get('/actions', consumer, (req, res) => ok(res, [...S().actions.values()]));
  r.get('/pipelines', consumer, (req, res) => ok(res, [...S().pipelines.values()]));

  // ------------------------------------------------------------ 消費：問答、取值、反饋
  r.post('/ask', consumer, async (req, res) => {
    const out = await ctx.ask.ask(req.body || {}, req.principal);
    ok(res, out);
  });
  r.post('/actions/:id/invoke', consumer, async (req, res) => ok(res, await ctx.actions.fetchValue(req.params.id, req.body?.inputs || {}, req.principal)));
  r.post('/feedback', consumer, async (req, res) => {
    const out = await S().tx(req.principal, o => `[反饋] ${o.id} → ${o.targetId}`, t => S().submitFeedback(t, req.body || {}, req.principal));
    txOut(res, out, 201);
  });

  // ------------------------------------------------------------ 生產：主體、客體、綁定、斷言、關係
  r.post('/subjects', contributor, async (req, res) => {
    const out = await S().tx(req.principal, s => `[生產] 新增主體 ${s.id} ${s.name}（${s.type}）`, t => S().createSubject(t, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.patch('/subjects/:id', contributor, async (req, res) => {
    const out = await S().tx(req.principal, `[生產] 修改主體 ${req.params.id}`, t => S().updateSubject(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });
  r.delete('/subjects/:id', requireAdmin, async (req, res) => {
    const out = await S().tx(req.principal, `[管理] 刪除主體 ${req.params.id}`, t => S().deleteSubject(t, req.params.id, req.principal));
    txOut(res, out);
  });
  r.post('/objects', contributor, async (req, res) => {
    const out = await S().tx(req.principal, o => `[生產] 登記客體 ${o.id} ${o.name}`, t => S().createObject(t, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.patch('/objects/:id', contributor, async (req, res) => {
    const out = await S().tx(req.principal, `[生產] 修改客體 ${req.params.id}${req.body?.status === '下線' ? '（下線）' : ''}`, t => S().updateObject(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });
  r.delete('/objects/:id', requireAdmin, async (req, res) => {
    const out = await S().tx(req.principal, `[管理] 刪除客體 ${req.params.id}`, t => S().deleteObject(t, req.params.id, req.principal));
    txOut(res, out);
  });
  r.post('/subjects/:id/bindings', contributor, async (req, res) => {
    const out = await S().tx(req.principal, b => `[生產] 綁定 ${b.id}：${req.params.id} ← ${b.objectId}（${b.validity.level}）`, t => S().createBinding(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.post('/subjects/:id/assertions', contributor, async (req, res) => {
    const out = await S().tx(req.principal, a => `[生產] 新增斷言 ${a.id} → ${req.params.id}（${a.type}，${a.validity.level}）`, t => S().createAssertion(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.patch('/assertions/:id', contributor, async (req, res) => {
    const out = await S().tx(req.principal, `[生產] 修改斷言 ${req.params.id}`, t => S().updateAssertion(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });
  r.post('/relations', contributor, async (req, res) => {
    const out = await S().tx(req.principal, x => `[生產] 新增關係 ${x.id}：${x.from} –${x.type}→ ${x.to}（${x.validity.level}）`, t => S().createRelation(t, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.delete('/relations/:id', requireAdmin, async (req, res) => {
    const out = await S().tx(req.principal, `[管理] 刪除關係 ${req.params.id}`, t => S().deleteRelation(t, req.params.id, req.principal));
    txOut(res, out);
  });

  r.post('/batch', contributor, async (req, res) => {
    const items = req.body?.items;
    if (!Array.isArray(items) || !items.length) throw new HttpError(400, tr('items 必須為非空陣列'), 'invalid_input');
    if (items.length > 500) throw new HttpError(400, tr('單批最多 {n} 條', { n: 500 }), 'invalid_input');
    const message = `[批量] ${String(req.body.message || '批量提交').slice(0, 100)}（${items.length} 條）`;
    const st = S();
    const out = await st.tx(req.principal, message, t => {
      const refs = new Map();
      const results = [];
      items.forEach((it, i) => {
        try {
          const d = resolveRefs(it.data || {}, refs, i);
          let r2;
          switch (it.op) {
            case 'subject.create': r2 = st.createSubject(t, d, req.principal); break;
            case 'subject.update': r2 = st.updateSubject(t, d.id, d, req.principal); break;
            case 'object.create': r2 = st.createObject(t, d, req.principal); break;
            case 'object.update': r2 = st.updateObject(t, d.id, d, req.principal); break;
            case 'binding.create': r2 = st.createBinding(t, d.subjectId, d, req.principal); break;
            case 'assertion.create': r2 = st.createAssertion(t, d.subjectId, d, req.principal); break;
            case 'assertion.update': r2 = st.updateAssertion(t, d.id, d, req.principal); break;
            case 'relation.create': r2 = st.createRelation(t, d, req.principal); break;
            case 'evidence.add': r2 = st.addEvidence(t, d.id, d, req.principal); break;
            case 'conflict.create': r2 = st.reportConflict(t, d, req.principal); break;
            case 'feedback.create': r2 = st.submitFeedback(t, d, req.principal); break;
            case 'doc.create': r2 = st.docs.create(t, d, req.principal); break;
            case 'doc.link': r2 = st.docs.organize(t, d.id, { subjects: d.subjects, objects: d.objects, related: d.related, tags: d.tags, addSubjects: d.addSubjects, addTags: d.addTags }, req.principal); break;
            default: throw new RuleError(tr('未知 op「{op}」', { op: it.op }), 400, 'unknown_op');
          }
          if (it.ref) refs.set(String(it.ref), r2.id);
          results.push({ index: i, op: it.op, ref: it.ref || null, id: r2.id, level: r2.validity?.level ?? r2.level ?? null });
        } catch (err) {
          err.message = tr('第 {index} 條（{op}）：{message}；整批已回滾', { index: i, op: `${it.op}${it.ref ? ` ref=${it.ref}` : ''}`, message: err.message });
          err.index = i;
          throw err;
        }
      });
      return { results, refs: Object.fromEntries(refs) };
    });
    txOut(res, out, 201);
  });

  // ------------------------------------------------------------ 有效性：證據、校驗、確認、失效
  r.post('/items/:id/evidence', contributor, async (req, res) => {
    const out = await S().tx(req.principal, x => `[證據] ${req.params.id} 補充證據（${x.level}）`, t => S().addEvidence(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });
  r.post('/validate/:id', contributor, async (req, res) => {
    const out = await ctx.actions.validateItem(req.params.id, req.principal, { actionId: req.body?.actionId });
    if (!out.async) return ok(res, out);
    // RPA：受理後異步執行，202 + 執行記錄地址；同一個（條目, Action）已有未結束的執行時返回那個
    const e = out.execution;
    ok(res, { executionId: e.id, state: e.state, deduped: out.deduped, statusUrl: `/api/v1/action-executions/${e.id}`, execution: executionView(e) }, {}, 202);
  });
  r.get('/action-executions', contributor, (req, res) => ok(res, ctx.executions.list({ itemId: req.query.itemId, actionId: req.query.actionId, state: req.query.state, runId: req.query.runId, pipelineId: req.query.pipelineId, limit: req.query.limit }).map(executionView)));
  r.get('/action-executions/:id', contributor, (req, res) => ok(res, executionView(ctx.executions.get(req.params.id))));
  r.post('/action-executions/:id/refresh', contributor, (req, res) => {
    const e = ctx.executions.get(req.params.id);
    const action = S().actions.get(e.actionId);
    if (action && !ctx.actions.canInvoke(action, req.principal)) throw new HttpError(403, tr('無權調用 Action {id}（需要 {role}）', { id: action.id, role: action.permission }), 'forbidden');
    ok(res, executionView(ctx.executions.refresh(req.params.id)), {}, 202);
  });
  r.post('/validate-all', owner, async (req, res) => ok(res, await ctx.actions.validateAll(req.principal, { onlyPending: req.body?.onlyPending === true })));
  r.post('/items/:id/confirm', owner, async (req, res) => {
    const out = await S().tx(req.principal, `[確認] ${req.params.id} → L0（負責人 ${req.principal.name}）`, t => S().confirm(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });
  r.post('/items/:id/invalidate', owner, async (req, res) => {
    const out = await S().tx(req.principal, `[失效] ${req.params.id} → E1：${String(req.body?.reason || '').slice(0, 60)}`, t => S().invalidateItem(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });

  // ------------------------------------------------------------ 治理：衝突、反饋、缺口、重驗隊列、指標
  r.get('/conflicts', contributor, (req, res) => ok(res, [...S().conflicts.values()].filter(c => !req.query.status || c.status === req.query.status).sort((a, b) => b.id.localeCompare(a.id))));
  r.post('/conflicts', contributor, async (req, res) => {
    const out = await S().tx(req.principal, c => `[衝突] ${c.id}：${c.a} ↔ ${c.b}（雙方降為 L1）`, t => S().reportConflict(t, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.post('/conflicts/:id/resolve', owner, async (req, res) => {
    const out = await S().tx(req.principal, c => `[裁決] ${c.id}：${c.winner} → L0，${c.loser} → E1`, t => S().resolveConflict(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });
  r.get('/feedback', contributor, (req, res) => ok(res, [...S().feedback.values()].filter(f => !req.query.status || f.status === req.query.status).sort((a, b) => b.id.localeCompare(a.id))));
  r.post('/feedback/:id/close', owner, async (req, res) => {
    const out = await S().tx(req.principal, `[反饋] 關閉 ${req.params.id}`, t => S().closeFeedback(t, req.params.id, req.body || {}, req.principal));
    txOut(res, out);
  });
  r.get('/gaps', contributor, (req, res) => ok(res, [...S().gaps.values()].filter(g => !req.query.status || g.status === req.query.status).sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))));
  r.post('/gaps/:id/close', owner, async (req, res) => {
    const out = await S().tx(req.principal, `[缺口] 關閉 ${req.params.id}`, t => S().closeGap(t, req.params.id, req.body || {}));
    txOut(res, out);
  });
  r.get('/queue', contributor, (req, res) => ok(res, S().revalidationQueue()));
  r.get('/metrics', contributor, (req, res) => ok(res, S().health({ windowDays: Number(req.query.days) || 7 })));

  // ------------------------------------------------------------ 動力層配置（負責人）
  r.post('/pipelines', owner, async (req, res) => {
    const out = await S().tx(req.principal, p => `[動力層] 管道 ${p.id} ${p.name}`, t => S().upsertPipeline(t, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.put('/pipelines/:id', owner, async (req, res) => {
    if (!S().pipelines.has(req.params.id)) throw new HttpError(404, tr('找不到管道 {id}', { id: req.params.id }), 'not_found');
    const out = await S().tx(req.principal, `[動力層] 更新管道 ${req.params.id}`, t => S().upsertPipeline(t, { ...req.body, id: req.params.id }, req.principal));
    txOut(res, out);
  });
  r.post('/pipelines/:id/test', owner, async (req, res) => ok(res, await ctx.actions.testPipeline(req.params.id)));

  // RPA 場景目錄：已發布、未歸檔的場景（?all=1 含未發布與已歸檔），標出登入角色狀態與已登記的 Action
  r.get('/pipelines/:id/scenes', owner, async (req, res) => {
    const p = rpaPipeline(req.params.id);
    const client = clientOf(p);
    const scenes = listOf(await rpaCall(() => client.scenes({ q: req.query.q, domain: req.query.domain, category: req.query.category })), 'scenes');
    const roles = await client.roles().then(x => listOf(x, 'roles')).catch(() => null);
    const registered = [...S().actions.values()].filter(a => a.pipelineId === p.id && a.rpa);
    const all = req.query.all === '1';
    ok(res, scenes.filter(sc => all || (sc.publishedRevision && !sc.archived)).map(sc => ({
      id: sc.id, name: sc.name, category: sc.category || null, description: sc.description || null, domainId: sc.domainId || null,
      publishedRevision: sc.publishedRevision || null, latestRevision: sc.latestRevision || null, archived: !!sc.archived,
      actions: registered.filter(a => a.rpa.sceneId === sc.id).map(a => ({ id: a.id, name: a.name, revision: a.rpa.revision, enabled: a.enabled !== false, needsReview: !!sc.publishedRevision && sc.publishedRevision !== a.rpa.revision }))
    })), { roles });
  });
  // 一個場景的契約：發布版本（或 ?revision=n）的入參、出參、登入角色、期限；按 §5 檢查；生成 Action 草稿（?objectKind=）
  r.get('/pipelines/:id/scenes/:sceneId', owner, async (req, res) => {
    const p = rpaPipeline(req.params.id);
    const client = clientOf(p);
    const scene = await rpaCall(() => client.scene(req.params.sceneId));
    const number = Number(req.query.revision) || scene.publishedRevision;
    const roles = await client.roles().then(x => listOf(x, 'roles')).catch(() => null);
    const registered = [...S().actions.values()].filter(a => a.pipelineId === p.id && a.rpa?.sceneId === scene.id);
    if (!number) return ok(res, { scene, revision: null, contract: null, conformance: [{ rule: 'R2', level: 'error', text: tr('沒有發布的版本，不能註冊') }], draft: null, actions: registered });
    const { revision, contract } = await rpaCall(() => client.contract(scene.id, number));
    const { files, ...revisionMeta } = revision;
    ok(res, {
      scene: { ...scene, revisions: undefined },
      revision: revisionMeta,
      scenario: req.query.source === '1' ? files?.['scenario.yaml'] ?? null : undefined,
      contract,
      conformance: conformance(scene, contract, roles),
      draft: draftAction({ pipelineId: p.id, scene, revision, contract, objectKind: req.query.objectKind || null }),
      actions: registered
    });
  });
  // 預覽：用一個客體（或一個定位字串）算出定位分組、提交給 RPA 的入參與守衛期望值，不派發運行
  r.post('/actions/:id/preview', owner, async (req, res) => {
    const { action, pipeline } = rpaAction(req.params.id);
    const object = req.body?.objectId ? S().getObject(req.body.objectId) : { id: null, name: null, locator: String(req.body?.locator || '') };
    const out = { objectId: object.id, locator: object.locator, groups: null, inputs: null, expect: null, problems: [], warnings: [] };
    if (object.id) {
      if (!(object.actionIds || []).includes(action.id)) out.warnings.push(tr('Action {id} 還沒有掛在客體 {object} 上', { id: action.id, object: object.id }));
      if (action.objectKinds?.length && !action.objectKinds.includes(object.kind)) out.warnings.push(tr('客體種類 {kind} 不在 Action 適用的 {kinds} 內', { kind: object.kind || tr('未標種類'), kinds: action.objectKinds.join(tr('、')) }));
    }
    try {
      out.groups = parseLocator(action, object.locator);
    } catch (err) {
      out.problems.push({ name: 'locator', code: err.code, message: err.message });
      return ok(res, out);
    }
    const contract = await ctx.executions.contractFor(pipeline, action).then(x => x.contract).catch(err => { out.warnings.push(tr('讀不到場景契約，未按場景宣告檢查：{message}', { message: err.message })); return null; });
    const rendered = renderSceneInputs(action, { object, groups: out.groups }, contract);
    out.inputs = rendered.inputs;
    out.problems.push(...rendered.problems);
    out.expect = (action.check?.expect || []).map(e => (e.nonEmpty ? { output: e.output, nonEmpty: true } : { output: e.output, equals: renderValue(e.equals, { locator: out.groups, object }) }));
    ok(res, out);
  });
  // 審閱新版本：負責人確認只讀後，把 Action 鎖到場景目前的發布版本（或指定版本）
  r.post('/actions/:id/review', owner, async (req, res) => {
    const { action, pipeline } = rpaAction(req.params.id);
    if (req.body?.readOnly !== true) throw new HttpError(400, tr('審閱需要確認場景只讀、沒有業務副作用（readOnly: true）'), 'review_required');
    const client = clientOf(pipeline);
    const scene = await rpaCall(() => client.scene(action.rpa.sceneId));
    const number = Number(req.body?.revision) || scene.publishedRevision;
    if (!number) throw new HttpError(409, tr('場景 {id} 沒有發布的版本', { id: scene.id }), 'not_published');
    if (number !== scene.publishedRevision) throw new HttpError(409, tr('只能審閱目前的發布版本 v{n}', { n: scene.publishedRevision }), 'revision_not_published');
    const { revision, contract } = await rpaCall(() => client.contract(scene.id, number));
    const mapped = Object.keys(action.rpa.inputs || {});
    const drift = [
      ...mapped.filter(n => !(n in contract.inputs)).map(n => tr('場景 v{n} 沒有入參 {name}；請修改 rpa.inputs', { n: number, name: n })),
      ...Object.entries(contract.inputs).filter(([n, sp]) => !mapped.includes(n) && sp.default === undefined).map(([n]) => tr('場景 v{n} 的入參 {name} 沒有映射，也沒有預設值；請修改 rpa.inputs', { n: number, name: n }))
    ];
    const input = { ...action, rpa: { ...action.rpa, revision: number, contentHash: revision.contentHash, loginRole: contract.loginRole }, review: { readOnly: true }, enabled: req.body?.enabled ?? action.enabled };
    const out = await S().tx(req.principal, `[動力層] 審閱 Action ${action.id}：${scene.id} v${action.rpa.revision} → v${number}`, t => {
      drift.forEach(w => t.warn(w));
      return S().upsertAction(t, input, req.principal);
    });
    txOut(res, out);
  });
  // 試運行：用一個客體走完整執行流程，但不寫回有效性
  r.post('/actions/:id/trial', owner, async (req, res) => {
    const { action } = rpaAction(req.params.id);
    const object = S().getObject(req.body?.objectId);
    const { execution } = ctx.executions.start({ ref: null, action, object, principal: req.principal, dryRun: true });
    ok(res, { executionId: execution.id, state: execution.state, statusUrl: `/api/v1/action-executions/${execution.id}`, execution: executionView(execution) }, {}, 202);
  });
  r.post('/actions', owner, async (req, res) => {
    const out = await S().tx(req.principal, a => `[動力層] Action ${a.id} ${a.name}（${a.kind}）`, t => S().upsertAction(t, req.body || {}, req.principal));
    txOut(res, out, 201);
  });
  r.put('/actions/:id', owner, async (req, res) => {
    if (!S().actions.has(req.params.id)) throw new HttpError(404, tr('找不到 Action {id}', { id: req.params.id }), 'not_found');
    const out = await S().tx(req.principal, `[動力層] 更新 Action ${req.params.id}`, t => S().upsertAction(t, { ...req.body, id: req.params.id }, req.principal));
    txOut(res, out);
  });

  // ------------------------------------------------------------ 規則參數（管理員）
  r.get('/config', consumer, (req, res) => ok(res, S().config));
  r.put('/config', requireAdmin, async (req, res) => {
    const out = await S().tx(req.principal, '[規則] 更新規則參數', t => S().updateConfig(t, req.body || {}, req.principal));
    txOut(res, out);
  });

  // ------------------------------------------------------------ 文檔庫
  docRoutes(r, ctx, { consumer, contributor, owner, baseUrlOf });

  r.use((req, res, next) => next(new HttpError(404, tr('未知端點 {endpoint}', { endpoint: `${req.method} ${req.baseUrl}${req.path}` }), 'not_found')));
  return r;
}

export { kindOfId };
