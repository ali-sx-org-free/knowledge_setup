// 動力層：管道（數據源連接）與 Action（校驗 / 取值）。MVP 只讀不寫。
import { RuleError } from '../store/validity.js';
import { renderTemplate, getPath } from './template.js';
import { RpaClient, REQUIRED_SCOPES, EXCESS_SCOPES } from './rpa.js';
import { tr, tk, SOURCE_LOCALE } from '../i18n/index.js';

/** 校驗結果說明：寫入知識倉庫的一律用繁體原文，返回給調用方的按請求語言。 */
const say = (key, params) => [tr(key, params, SOURCE_LOCALE), tr(key, params)];

export { renderTemplate };

function matchPath(pattern, actual) {
  const p = pattern.split('/').filter(Boolean);
  const a = actual.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== decodeURIComponent(a[i])) return null;
  }
  return params;
}

export class ActionRunner {
  constructor({ store, env = process.env, fetchImpl = globalThis.fetch, executions = null }) {
    this.store = store;
    this.env = env;
    this.fetch = fetchImpl;
    this.executions = executions; // RPA 管道的異步執行服務（services/executions.js）
  }

  async execute(action, { inputs = {}, object = null, item = null } = {}) {
    const pipeline = this.store.pipelines.get(action.pipelineId);
    if (!pipeline) throw new RuleError(tr('Action {id} 的管道 {pipelineId} 不存在', { id: action.id, pipelineId: action.pipelineId }), 422);
    if (pipeline.type === 'rpa') throw new RuleError(tr('Action {id} 走 RPA 管道，只能經校驗異步執行（POST /validate/{條目}）', { id: action.id }), 422, 'async_only');
    const ctx = { input: inputs, object: object || {}, item: item || {} };
    const reqPath = renderTemplate(action.request?.path || '/', ctx, this.env);
    const query = Object.fromEntries(Object.entries(renderTemplate(action.request?.query || {}, ctx, this.env)).filter(([, v]) => v !== '' && v !== undefined));
    const method = (action.request?.method || 'GET').toUpperCase();
    const body = action.request?.body ? renderTemplate(action.request.body, ctx, this.env) : null;
    const started = Date.now();

    if (pipeline.type === 'docs') {
      // 內置文檔庫管道：路徑 /docs/{object.id}，結果來自文檔庫本身。
      const m = /^\/docs\/([^/?#]+)/.exec(reqPath);
      const r = m && this.store.docs ? this.store.docs.docObjectStatus(decodeURIComponent(m[1])) : { status: 404, body: { error: 'not found' } };
      return { ok: r.status < 300, status: r.status, body: r.body, value: getPath(r.body, action.output?.path), url: `docs://${pipeline.id}${reqPath}`, durationMs: Date.now() - started, pipeline: { id: pipeline.id, name: pipeline.name, type: pipeline.type } };
    }

    if (pipeline.type === 'mock') {
      for (const route of pipeline.routes || []) {
        if ((route.method || 'GET').toUpperCase() !== method) continue;
        const params = matchPath(route.path || '/', reqPath);
        if (!params) continue;
        const rctx = { query, params, body, seed: { path: reqPath, query, day: new Date().toISOString().slice(0, 13) } };
        const resBody = renderTemplate(route.body ?? {}, rctx, this.env);
        const status = route.status || 200;
        return { ok: status < 300, status, body: resBody, value: getPath(resBody, action.output?.path), url: `mock://${pipeline.id}${reqPath}`, durationMs: Date.now() - started, pipeline: { id: pipeline.id, name: pipeline.name, type: pipeline.type } };
      }
      return { ok: false, status: 404, body: { error: 'not found' }, value: undefined, url: `mock://${pipeline.id}${reqPath}`, durationMs: Date.now() - started, pipeline: { id: pipeline.id, name: pipeline.name, type: pipeline.type } };
    }

    const url = new URL(reqPath.replace(/^\//, ''), pipeline.baseUrl.endsWith('/') ? pipeline.baseUrl : pipeline.baseUrl + '/');
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers = renderTemplate(pipeline.headers || {}, {}, this.env);
    if (body) headers['content-type'] ||= 'application/json';
    let res;
    try {
      res = await this.fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(pipeline.timeoutMs || 8000) });
    } catch (err) {
      return { ok: false, status: 0, error: tr('管道不可達：{error}', { error: err.message }), url: url.toString(), durationMs: Date.now() - started, pipeline: { id: pipeline.id, name: pipeline.name, type: pipeline.type } };
    }
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
    return { ok: res.ok, status: res.status, body: parsed, value: getPath(parsed, action.output?.path), url: url.toString(), durationMs: Date.now() - started, pipeline: { id: pipeline.id, name: pipeline.name, type: pipeline.type } };
  }

  canInvoke(action, principal) {
    if (principal?.isAdmin) return true;
    const order = { consumer: 0, contributor: 1, owner: 2 };
    const role = principal?.kind === 'pipeline' ? 'contributor' : principal?.role;
    return (order[role] ?? -1) >= (order[action.permission || 'consumer'] ?? 0);
  }

  checkInputs(action, inputs) {
    const missing = [];
    const clean = {};
    for (const def of action.inputs || []) {
      const v = inputs?.[def.name];
      if (v === undefined || v === null || v === '') {
        if (def.required) missing.push(def);
        continue;
      }
      if (def.pattern && !new RegExp(`^(?:${def.pattern})$`, 'i').test(String(v))) throw new RuleError(tr('參數 {name} 格式不符（{pattern}）', { name: def.name, pattern: def.pattern }), 400, 'invalid_input');
      clean[def.name] = String(v);
    }
    return { missing, inputs: clean };
  }

  /** 取值 Action：實時讀取動態值。動態值不作為知識存儲。 */
  async fetchValue(actionId, inputs, principal) {
    const action = this.store.actions.get(actionId);
    if (!action) throw new RuleError(tr('Action {id} 不存在', { id: actionId }), 404, 'not_found');
    if (action.kind !== '取值') throw new RuleError(tr('{id} 不是取值 Action', { id: actionId }), 400);
    if (!this.canInvoke(action, principal)) throw new RuleError(tr('無權調用此 Action'), 403, 'forbidden');
    const checked = this.checkInputs(action, inputs);
    if (checked.missing.length) throw Object.assign(new RuleError(tr('缺少參數：{list}', { list: checked.missing.map(d => d.label || d.name).join(tr('、')) }), 400, 'missing_inputs'), { missing: checked.missing });
    const r = await this.execute(action, { inputs: checked.inputs });
    if (!r.ok) throw new RuleError(r.error ? tr('取值失敗（HTTP {status}）：{error}', { status: r.status, error: r.error }) : tr('取值失敗（HTTP {status}）', { status: r.status }), 502, 'action_failed');
    return { actionId: action.id, name: action.name, inputs: checked.inputs, value: r.value, unit: action.output?.unit || null, label: action.output?.label || null, fetchedAt: new Date().toISOString(), pipeline: r.pipeline, durationMs: r.durationMs, note: tr('實時取值，未使用任何存儲值') };
  }

  /** 校驗 Action：檢查客體是否存在、內容是否與斷言一致，結果寫回有效性。 */
  /**
   * 受理校驗前的同步檢查（設計 §8.1）：調用權限、Action 已啟用並掛在客體上、客體種類適用、條目不是 E1、客體在用。
   * 返回 { ref, action, object }。
   */
  prepareValidation(itemId, principal, { actionId } = {}) {
    const ref = this.store.getItem(itemId);
    let found;
    if (actionId) {
      const action = this.store.actions.get(actionId);
      if (!action || action.kind !== '校驗') throw new RuleError(tr('{id} 不是校驗 Action', { id: actionId }), 400);
      if (!this.store.actionSuits(action, ref)) throw new RuleError(action.enabled === false ? tr('Action {id} 未啟用', { id: actionId }) : ref.kind === 'assertion' ? tr('斷言只能用比對內容的校驗 Action（equals）驗證，且斷言需帶結構化值；客體存在不代表陳述正確') : ref.kind === 'relation' ? tr('關係需要以關係本身為參數（{from}/{to}）的校驗 Action', { from: '{item.from}', to: '{item.to}' }) : tr('綁定只能用檢查客體存在的校驗 Action（exists）'), 422, action.enabled === false ? 'action_disabled' : 'action_not_applicable');
      const objectIds = ref.kind === 'binding' ? [ref.item.objectId] : ref.item.validity.evidence.objectIds;
      const objectId = objectIds.find(oid => this.store.objects.get(oid)?.actionIds?.includes(actionId));
      if (!objectId) throw new RuleError(ref.kind === 'binding' ? tr('Action {id} 沒有掛在 {item} 的綁定客體上；請先在客體的「可用 Action」裡掛上', { id: actionId, item: itemId }) : tr('Action {id} 沒有掛在 {item} 的證據客體上；請先在客體的「可用 Action」裡掛上', { id: actionId, item: itemId }), 422, 'action_not_attached');
      found = { action, objectId };
    } else found = this.store.findValidateAction(ref);
    if (!found) throw new RuleError(tr('{id} 沒有可用的校驗 Action；請由負責人確認，或為證據客體配置校驗 Action', { id: itemId }), 422, 'no_validate_action');
    const { action, objectId } = found;
    if (!this.canInvoke(action, principal)) throw new RuleError(tr('無權調用 Action {id}（需要 {role}）', { id: action.id, role: action.permission }), 403, 'forbidden');
    const object = objectId ? this.store.objects.get(objectId) : null;
    if (object?.status === '下線') throw new RuleError(tr('證據客體 {id} 已下線', { id: objectId }), 409, 'object_offline');
    if (object && action.objectKinds?.length && !action.objectKinds.includes(object.kind)) throw new RuleError(tr('Action {id} 只適用於 {kinds}，客體 {object} 是 {kind}', { id: action.id, kinds: action.objectKinds.join(tr('、')), object: object.id, kind: object.kind || tr('未標種類') }), 422, 'object_kind_mismatch');
    return { ref, action, object };
  }

  /**
   * 校驗。http / mock 管道同步執行並返回結果；RPA 管道受理後異步執行，
   * 返回 { async: true, execution, deduped }（API 回 202）。
   */
  async validateItem(itemId, principal, { actionId } = {}) {
    const { ref, action, object } = this.prepareValidation(itemId, principal, { actionId });
    const objectId = object?.id || null;
    if (this.store.pipelines.get(action.pipelineId)?.type === 'rpa') {
      if (ref.item.validity.level === 'E1') throw new RuleError(tr('{id} 已失效（E1），不再校驗', { id: itemId }), 409, 'item_invalid');
      if (!this.executions) throw new RuleError(tr('RPA 執行服務未啟動'), 503, 'executions_unavailable');
      const out = this.executions.start({ ref, action, object, principal });
      return { async: true, ...out };
    }
    const r = await this.execute(action, { object, item: ref.item });
    let outcome;
    let detail; // 寫入倉庫（繁體原文）
    let shown; // 返回給調用方（請求語言）
    if (r.status === 404 || r.status === 410) { outcome = 'missing'; detail = shown = `HTTP ${r.status}`; }
    else if (!r.ok) { outcome = 'error'; detail = shown = r.error || `HTTP ${r.status}`; }
    else if (action.check?.mode === 'equals') {
      const expected = ref.item.structured?.value;
      if (expected === undefined) { outcome = 'error'; [detail, shown] = say(tk('斷言沒有結構化值，無法比對')); }
      else if (String(r.value).trim() === String(expected).trim()) { outcome = 'pass'; [detail, shown] = say(tk('實際值 {value} 與斷言一致'), { value: r.value }); }
      else { outcome = 'mismatch'; [detail, shown] = say(tk('實際值 {value}，斷言值 {expected}'), { value: JSON.stringify(r.value), expected: JSON.stringify(expected) }); }
    } else { outcome = 'pass'; [detail, shown] = say(tk('客體存在（HTTP {status}）'), { status: r.status }); }

    const runner = { kind: 'pipeline', id: action.id, name: `Action ${action.id} ${action.name}`.slice(0, 80) };
    if (outcome === 'error') {
      return { id: itemId, outcome, detail: shown, effect: 'none', action: { id: action.id, name: action.name }, request: { url: r.url, status: r.status } };
    }
    const { result, commit } = await this.store.tx(runner, `[校驗] ${action.id} → ${itemId}：${outcome}（觸發者 ${principal?.id || 'system'}）`, t => this.store.applyValidationResult(t, itemId, { outcome, actionId: action.id, detail, objectId }, runner));
    return { ...result, outcome, detail: shown, commit, action: { id: action.id, name: action.name }, request: { url: r.url, status: r.status } };
  }

  /**
   * 批量校驗所選主體：主體的斷言、綁定，以及以它為起點的關係中，未失效、能找到合適校驗 Action 的條目逐條校驗。
   * RPA 校驗照單條方式異步受理（進度在執行記錄），其餘同步返回結果；沒有可用 Action 的條目計入 noAction。
   */
  async validateSubjects(subjectIds, principal, { max = 500 } = {}) {
    const ids = new Set((subjectIds || []).map(String));
    if (!ids.size) throw new RuleError(tr('請提供 subjectIds'), 400, 'invalid_input');
    const refs = this.store.allValidityItems().filter(ref => ref.subject && ids.has(ref.subject.id) && ref.item.validity.level !== 'E1');
    const runnable = [];
    let noAction = 0;
    for (const ref of refs) (this.store.findValidateAction(ref) ? runnable.push(ref) : noAction++);
    if (runnable.length > max) throw new RuleError(tr('可校驗的條目有 {n} 條，超過單次上限 {max}；請少選一些主體', { n: runnable.length, max }), 400, 'too_many_items');
    const results = [];
    for (const ref of runnable) {
      try {
        const out = await this.validateItem(ref.item.id, principal);
        results.push(out.async ? { id: ref.item.id, outcome: 'async', executionId: out.execution.id } : out);
      } catch (err) {
        results.push({ id: ref.item.id, outcome: 'error', detail: err.message });
      }
    }
    const count = o => results.filter(r => r.outcome === o).length;
    return { subjects: ids.size, total: results.length, passed: count('pass'), mismatched: count('mismatch'), missing: count('missing'), errors: count('error'), async: count('async'), noAction, results };
  }

  /** 定期校驗：對所有配置了校驗 Action 的知識執行一次。 */
  async validateAll(principal, { onlyPending = false } = {}) {
    const results = [];
    const skipped = [];
    for (const ref of this.store.allValidityItems()) {
      const v = ref.item.validity;
      if (v.level === 'E1') continue;
      if (onlyPending && !v.pending) continue;
      const found = this.store.findValidateAction(ref);
      if (!found) continue;
      // RPA 校驗第一期只手動發起；定期複驗在第二期支持（設計 §10）
      if (this.store.pipelines.get(found.action.pipelineId)?.type === 'rpa') { skipped.push(ref.item.id); continue; }
      try {
        results.push(await this.validateItem(ref.item.id, principal));
      } catch (err) {
        results.push({ id: ref.item.id, outcome: 'error', detail: err.message });
      }
    }
    return { total: results.length, passed: results.filter(r => r.outcome === 'pass').length, mismatched: results.filter(r => r.outcome === 'mismatch').length, missing: results.filter(r => r.outcome === 'missing').length, errors: results.filter(r => r.outcome === 'error').length, skipped: skipped.length, skippedIds: skipped, results };
  }

  async testPipeline(pipelineId) {
    const p = this.store.pipelines.get(pipelineId);
    if (!p) throw new RuleError(tr('管道 {id} 不存在', { id: pipelineId }), 404);
    if (p.type === 'mock') return { ok: true, detail: tr('示意管道，共 {n} 條路由', { n: (p.routes || []).length }) };
    if (p.type === 'rpa') return this.testRpaPipeline(p);
    if (p.type === 'docs') return { ok: true, detail: tr('內置文檔庫管道，讀本系統的文檔狀態') };
    try {
      const res = await this.fetch(p.baseUrl, { method: 'GET', headers: renderTemplate(p.headers || {}, {}, this.env), signal: AbortSignal.timeout(p.timeoutMs || 8000) });
      return { ok: res.status < 500, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }

  /**
   * RPA 管道的連接測試與最小權限體檢（設計 §7.1）：讀 /meta 與 /workers，
   * 缺必要權限報錯，多餘權限、回傳頁面內容、並發不小於排隊上限時警告。
   */
  async testRpaPipeline(p) {
    const client = new RpaClient(p, { env: this.env, fetchImpl: this.fetch });
    const checks = [];
    const add = (level, text) => checks.push({ level, text });
    let meta;
    try {
      meta = await client.meta();
    } catch (err) {
      const hint = err.status === 401 ? tr('（金鑰無效、已撤銷或環境變數沒有設定）') : err.status === 404 ? tr('（地址不是 Agent API，應為 {example}）', { example: 'http://host:8081/agent-api/v1' }) : '';
      return { ok: false, detail: `${err.message}${hint}`, checks: [{ level: 'error', text: `${err.message}${hint}` }] };
    }
    const scopes = Array.isArray(meta.scopes) ? meta.scopes : [];
    const missing = REQUIRED_SCOPES.filter(s => !scopes.includes(s));
    const excess = EXCESS_SCOPES.filter(s => scopes.includes(s));
    add(missing.length ? 'error' : 'ok', missing.length ? tr('缺少權限範圍：{list}', { list: missing.join(tr('、')) }) : tr('權限範圍：{list}', { list: scopes.join(tr('、')) }));
    if (excess.length) add('warn', tr('知識庫不需要這些權限，建議在 RPA 收回：{list}', { list: excess.join(tr('、')) }));
    if (meta.pageContent) add('warn', tr('這個 API 用戶端開著「回傳頁面內容」：知識庫不需要，建議關閉'));
    const queued = meta.limits?.queuedRuns;
    if (queued && p.rpa?.maxConcurrent >= queued) add('warn', tr('管道並發 {n} 不小於 RPA 的排隊上限 {limit}：多出的提交會收到 429', { n: p.rpa.maxConcurrent, limit: queued }));
    if (meta.expiresAt) add(Date.parse(meta.expiresAt) - Date.now() < 14 * 24 * 3600 * 1000 ? 'warn' : 'ok', tr('金鑰到期：{at}', { at: meta.expiresAt }));
    if (meta.target && p.rpa?.target && meta.target !== 'any' && meta.target !== p.rpa.target) add('warn', tr('管道的執行位置 {mine} 與 API 用戶端允許的 {allowed} 不同', { mine: p.rpa.target, allowed: meta.target }));
    let workers = null;
    try {
      const w = await client.workers();
      workers = Array.isArray(w) ? w : w?.workers || [];
      const online = workers.filter(x => x.online || x.status === 'online');
      add(online.length || p.rpa?.target === 'local' ? 'ok' : 'warn', tr('在線 Worker {online} / {total}', { online: online.length, total: workers.length }));
    } catch (err) {
      add('warn', tr('讀不到 Worker：{message}', { message: err.message }));
    }
    const ok = !checks.some(c => c.level === 'error');
    return {
      ok,
      detail: ok ? tr('已連接 {client}（RPA {server}，API {api}）', { client: meta.client?.name || meta.client?.id || 'API', server: meta.serverVersion || '?', api: meta.apiVersion || '?' }) : checks.filter(c => c.level === 'error').map(c => c.text).join(tr('；')),
      checks,
      meta: { client: meta.client || null, scopes, domains: meta.domains ?? null, limits: meta.limits || null, target: meta.target || null, workers: meta.workers ?? null, expiresAt: meta.expiresAt || null, apiVersion: meta.apiVersion || null, serverVersion: meta.serverVersion || null, pageContent: !!meta.pageContent },
      workers
    };
  }
}
