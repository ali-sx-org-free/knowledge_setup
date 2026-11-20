// 動力層：管道（數據源連接）與 Action（校驗 / 取值）。MVP 只讀不寫。
import crypto from 'node:crypto';
import { RuleError } from '../store/validity.js';
import { tr, tk, SOURCE_LOCALE } from '../i18n/index.js';

/** 校驗結果說明：寫入知識倉庫的一律用繁體原文，返回給調用方的按請求語言。 */
const say = (key, params) => [tr(key, params, SOURCE_LOCALE), tr(key, params)];

function getPath(obj, dotted) {
  if (!dotted) return obj;
  return String(dotted).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function seededInt(seed, min, max) {
  const h = crypto.createHash('sha256').update(seed).digest().readUInt32BE(0);
  return min + (h % (max - min + 1));
}

/** 模板替換：{input.sku}、{object.locator}、{item.structured.value}、{query.x}、{params.x}、{rand:0:500}、${env:NAME} */
export function renderTemplate(value, ctx, env = process.env) {
  if (typeof value === 'string') {
    const whole = /^\{rand:(-?\d+):(-?\d+)\}$/.exec(value);
    if (whole) return seededInt(JSON.stringify(ctx.seed || ''), Number(whole[1]), Number(whole[2]));
    return value
      .replace(/\$\{env:([A-Z0-9_]+)\}/gi, (_, n) => env[n] ?? '')
      .replace(/\{rand:(-?\d+):(-?\d+)\}/g, (_, a, b) => String(seededInt(JSON.stringify(ctx.seed || ''), Number(a), Number(b))))
      .replace(/\{([a-zA-Z_][\w.]*)\}/g, (m, p) => {
        const v = getPath(ctx, p);
        return v === undefined || v === null ? '' : String(v);
      });
  }
  if (Array.isArray(value)) return value.map(v => renderTemplate(v, ctx, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderTemplate(v, ctx, env)]));
  return value;
}

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
  constructor({ store, env = process.env, fetchImpl = globalThis.fetch }) {
    this.store = store;
    this.env = env;
    this.fetch = fetchImpl;
  }

  async execute(action, { inputs = {}, object = null, item = null } = {}) {
    const pipeline = this.store.pipelines.get(action.pipelineId);
    if (!pipeline) throw new RuleError(tr('Action {id} 的管道 {pipelineId} 不存在', { id: action.id, pipelineId: action.pipelineId }), 422);
    const ctx = { input: inputs, object: object || {}, item: item || {} };
    const reqPath = renderTemplate(action.request?.path || '/', ctx, this.env);
    const query = Object.fromEntries(Object.entries(renderTemplate(action.request?.query || {}, ctx, this.env)).filter(([, v]) => v !== '' && v !== undefined));
    const method = (action.request?.method || 'GET').toUpperCase();
    const body = action.request?.body ? renderTemplate(action.request.body, ctx, this.env) : null;
    const started = Date.now();

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
  async validateItem(itemId, principal, { actionId } = {}) {
    const ref = this.store.getItem(itemId);
    let found;
    if (actionId) {
      const action = this.store.actions.get(actionId);
      if (!action || action.kind !== '校驗') throw new RuleError(tr('{id} 不是校驗 Action', { id: actionId }), 400);
      if (!this.store.actionSuits(action, ref)) throw new RuleError(ref.kind === 'assertion' ? tr('斷言只能用比對內容的校驗 Action（equals）驗證，且斷言需帶結構化值；客體存在不代表陳述正確') : ref.kind === 'relation' ? tr('關係需要以關係本身為參數（{from}/{to}）的校驗 Action', { from: '{item.from}', to: '{item.to}' }) : tr('綁定只能用檢查客體存在的校驗 Action（exists）'), 422, 'action_not_applicable');
      const objectId = ref.kind === 'binding' ? ref.item.objectId : ref.item.validity.evidence.objectIds.find(oid => this.store.objects.get(oid)?.actionIds?.includes(actionId)) || ref.item.validity.evidence.objectIds[0];
      found = { action, objectId };
    } else found = this.store.findValidateAction(ref);
    if (!found) throw new RuleError(tr('{id} 沒有可用的校驗 Action；請由負責人確認，或為證據客體配置校驗 Action', { id: itemId }), 422, 'no_validate_action');
    const { action, objectId } = found;
    const object = objectId ? this.store.objects.get(objectId) : null;
    if (object?.status === '下線') throw new RuleError(tr('證據客體 {id} 已下線', { id: objectId }), 409, 'object_offline');
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

  /** 定期校驗：對所有配置了校驗 Action 的知識執行一次。 */
  async validateAll(principal, { onlyPending = false } = {}) {
    const results = [];
    for (const ref of this.store.allValidityItems()) {
      const v = ref.item.validity;
      if (v.level === 'E1') continue;
      if (onlyPending && !v.pending) continue;
      if (!this.store.findValidateAction(ref)) continue;
      try {
        results.push(await this.validateItem(ref.item.id, principal));
      } catch (err) {
        results.push({ id: ref.item.id, outcome: 'error', detail: err.message });
      }
    }
    return { total: results.length, passed: results.filter(r => r.outcome === 'pass').length, mismatched: results.filter(r => r.outcome === 'mismatch').length, missing: results.filter(r => r.outcome === 'missing').length, errors: results.filter(r => r.outcome === 'error').length, results };
  }

  async testPipeline(pipelineId) {
    const p = this.store.pipelines.get(pipelineId);
    if (!p) throw new RuleError(tr('管道 {id} 不存在', { id: pipelineId }), 404);
    if (p.type === 'mock') return { ok: true, detail: tr('示意管道，共 {n} 條路由', { n: (p.routes || []).length }) };
    try {
      const res = await this.fetch(p.baseUrl, { method: 'GET', headers: renderTemplate(p.headers || {}, {}, this.env), signal: AbortSignal.timeout(p.timeoutMs || 8000) });
      return { ok: res.status < 500, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }
}
