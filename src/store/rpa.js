// RPA 管道與 Action 的配置規則（純函數，知識庫存儲與執行服務共用）。
// 設計見 docs/design/rpa-integration.md：一條管道 = RPA 部署上的一個 API 用戶端；
// 一個 Action = 一個場景的一個審閱過的發布版本 + 參數映射 + 判定守衛。
import crypto from 'node:crypto';
import { RuleError } from './validity.js';

const clean = v => (typeof v === 'string' ? v.trim() : v);
const TARGETS = ['local', 'remote', 'any'];
const TEMPLATE = /\{([a-zA-Z_][\w.]*)\}/g;
const WHOLE_TEMPLATE = /^\{([a-zA-Z_][\w.]*)\}$/;

function intIn(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 管道地址：可以填伺服器根地址或 Agent API 地址，統一成 …/agent-api/v1。 */
export function normalizeRpaBaseUrl(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/i.test(u)) throw new RuleError('RPA 管道需要 baseUrl（http/https），例如 http://rpa.internal:8081/agent-api/v1', 400, 'invalid_input');
  return /\/agent-api\/v\d+$/.test(u) ? u : `${u}/agent-api/v1`;
}

/** 管道的 rpa 區塊：輪詢、期限、並發與執行位置。場景範圍、Worker 清單、權限範圍以 RPA 的 API 用戶端為準，不在這裡保存。 */
export function normalizePipelineRpa(input = {}) {
  const portalUrl = clean(input.portalUrl) || null;
  if (portalUrl && !/^https?:\/\//i.test(portalUrl)) throw new RuleError('rpa.portalUrl 必須是 http/https 地址', 400, 'invalid_input');
  if (input.target && !TARGETS.includes(input.target)) throw new RuleError(`rpa.target 必須為 ${TARGETS.join(' / ')}`, 400, 'invalid_input');
  const pollIntervalMs = intIn(input.pollIntervalMs, 3000, 10, 60000);
  return {
    portalUrl: portalUrl ? portalUrl.replace(/\/+$/, '') : null,
    target: input.target || null,
    workerId: clean(input.workerId) || null,
    pollIntervalMs,
    maxPollIntervalMs: Math.max(pollIntervalMs, intIn(input.maxPollIntervalMs, 15000, 10, 300000)),
    queueTimeoutSec: intIn(input.queueTimeoutSec, 300, 1, 86400),
    deadlineSec: input.deadlineSec === undefined || input.deadlineSec === null || input.deadlineSec === '' ? null : intIn(input.deadlineSec, 900, 1, 86400),
    maxConcurrent: intIn(input.maxConcurrent, 2, 1, 50)
  };
}

/** 模板中引用的變量（{locator.x}、{input.x}、{object.locator}…）。 */
export function templateRefs(value) {
  const out = [];
  const walk = v => {
    if (typeof v === 'string') for (const m of v.matchAll(TEMPLATE)) out.push(m[1]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return out;
}

function compileLocator(pattern) {
  try {
    return new RegExp(pattern, 'u');
  } catch (err) {
    throw new RuleError(`locator.pattern 不是合法的正則：${err.message}`, 400, 'invalid_input');
  }
}

function groupNames(pattern) {
  return [...String(pattern).matchAll(/\(\?<([A-Za-z_]\w*)>/g)].map(m => m[1]);
}

const isScalar = v => ['string', 'number', 'boolean'].includes(typeof v);

/**
 * 校驗並規範化 RPA Action 的專屬欄位。第一期只支持「校驗 · exists」：
 * 參數全部來自客體定位與固定值，調用者不能傳入參；成功要滿足全部守衛（expect）。
 */
export function normalizeRpaAction(input) {
  if (input.kind !== '校驗') throw new RuleError('RPA 管道第一期只支持「校驗」Action；取值在第二期支持', 400, 'not_supported');
  const mode = input.check?.mode || 'exists';
  if (mode !== 'exists') throw new RuleError('RPA 校驗 Action 第一期只支持 exists（存在性校驗）；斷言內容比對在第二期支持', 400, 'not_supported');
  const r = input.rpa || {};
  const sceneId = clean(r.sceneId);
  if (!sceneId) throw new RuleError('rpa.sceneId 必填：RPA 場景 ID', 400, 'invalid_input');
  const revision = Number(r.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new RuleError('rpa.revision 必填：審閱過的發布版本號', 400, 'invalid_input');
  const contentHash = clean(r.contentHash);
  if (!contentHash) throw new RuleError('rpa.contentHash 必填：審閱時該版本的內容雜湊（從場景目錄讀取）', 400, 'invalid_input');
  const inputs = r.inputs && typeof r.inputs === 'object' && !Array.isArray(r.inputs) ? r.inputs : null;
  if (!inputs) throw new RuleError('rpa.inputs 必填：場景入參 → 來源（{locator.分組}、{object.locator} 或固定值）', 400, 'invalid_input');
  for (const [k, v] of Object.entries(inputs)) if (!isScalar(v)) throw new RuleError(`rpa.inputs.${k} 必須是字串、數字或布林值`, 400, 'invalid_input');

  const pattern = clean(input.locator?.pattern) || null;
  const example = clean(input.locator?.example) || null;
  const groups = pattern ? groupNames(pattern) : [];
  if (pattern) {
    const re = compileLocator(pattern);
    if (!groups.length) throw new RuleError('locator.pattern 至少要有一個命名分組，例如 (?<table>[a-z_]+)', 400, 'invalid_input');
    if (example && !re.test(example)) throw new RuleError(`locator.example「${example}」不符合 locator.pattern`, 400, 'invalid_input');
  }

  const expect = Array.isArray(input.check?.expect) ? input.check.expect : [];
  if (!expect.length) throw new RuleError('check.expect 至少要有一項守衛：出參要回顯定位用的欄位，逐項精確比對，確認場景查的就是這個客體', 400, 'invalid_input');
  const cleanExpect = expect.map((e, i) => {
    const output = clean(e?.output);
    if (!output) throw new RuleError(`check.expect[${i}].output 必填`, 400, 'invalid_input');
    const hasEquals = e.equals !== undefined && e.equals !== null;
    if (!hasEquals && e.nonEmpty !== true) throw new RuleError(`check.expect[${i}] 需要 equals 或 nonEmpty: true`, 400, 'invalid_input');
    if (hasEquals && !isScalar(e.equals)) throw new RuleError(`check.expect[${i}].equals 必須是字串、數字或布林值`, 400, 'invalid_input');
    return hasEquals ? { output, equals: e.equals } : { output, nonEmpty: true };
  });

  const refs = templateRefs([inputs, cleanExpect]);
  for (const ref of refs) {
    const [root, name] = ref.split('.');
    if (root === 'input') throw new RuleError('校驗 Action 不接受調用者入參（{input.x}）：參數只能來自客體定位與固定值，避免被引導去查別的對象', 400, 'invalid_input');
    if (root === 'locator') {
      if (!pattern) throw new RuleError(`引用了 {${ref}}，但沒有設定 locator.pattern`, 400, 'invalid_input');
      if (!groups.includes(name)) throw new RuleError(`引用了 {${ref}}，但 locator.pattern 沒有分組「${name}」（現有：${groups.join('、')}）`, 400, 'invalid_input');
    } else if (!['object.locator', 'object.id', 'object.name'].includes(ref)) {
      throw new RuleError(`不支持的模板變量 {${ref}}：可用 {locator.分組}、{object.locator}、{object.id}、{object.name}`, 400, 'invalid_input');
    }
  }

  const list = v => (Array.isArray(v) ? [...new Set(v.map(x => clean(String(x))).filter(Boolean))] : []);
  const schedule = input.schedule || 'manual';
  if (schedule !== 'manual') throw new RuleError('RPA Action 第一期只支持手動發起（schedule: manual）；定期複驗在第二期支持', 400, 'not_supported');
  return {
    rpa: { sceneId, revision, contentHash, loginRole: clean(r.loginRole) || null, inputs },
    locator: pattern ? { pattern, example } : null,
    check: { mode: 'exists', expect: cleanExpect },
    evidence: { keep: list(input.evidence?.keep), digest: list(input.evidence?.digest) },
    schedule
  };
}

/** Action 的配置雜湊：只算會影響判定的欄位，用於寫回前確認配置沒有改過。 */
export function actionHash(action) {
  const { pipelineId, kind, objectKinds, rpa, locator, check, evidence } = action;
  const canon = v => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
  return crypto.createHash('sha256').update(JSON.stringify(canon({ pipelineId, kind, objectKinds: objectKinds || [], rpa, locator, check, evidence }))).digest('hex').slice(0, 16);
}

/** 解析客體定位；格式不符時 400 locator_invalid（提交前提示更正）。 */
export function parseLocator(action, locator) {
  if (!action.locator?.pattern) return {};
  const value = String(locator || '');
  const m = compileLocator(action.locator.pattern).exec(value);
  if (!m) {
    const hint = action.locator.example ? `，例如 ${action.locator.example}` : '';
    throw new RuleError(`客體定位「${value || '（空）'}」不符合 ${action.id || 'Action'} 要求的格式 ${action.locator.pattern}${hint}；請先更正客體定位`, 400, 'locator_invalid');
  }
  return { ...(m.groups || {}) };
}

function lookup(ctx, ref) {
  return ref.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
}

/** 模板渲染：整個值只有一個 {…} 時保留原型別。 */
export function renderValue(value, ctx) {
  if (typeof value !== 'string') return value;
  const whole = WHOLE_TEMPLATE.exec(value);
  if (whole) return lookup(ctx, whole[1]);
  return value.replace(TEMPLATE, (m, ref) => {
    const v = lookup(ctx, ref);
    return v === undefined || v === null ? '' : String(v);
  });
}

/** 按場景入參的宣告轉型（宣告缺失時原樣保留）。 */
function coerce(value, spec) {
  if (value === undefined || value === null || !spec?.type) return value;
  if (spec.type === 'integer' || spec.type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (spec.type === 'boolean' && typeof value === 'string') return value === 'true' ? true : value === 'false' ? false : value;
  if (spec.type === 'string' && typeof value !== 'string') return String(value);
  return value;
}

/** 由 Action 的映射算出提交給 RPA 的入參；contract 有時按場景入參宣告轉型並做本地檢查。 */
export function renderSceneInputs(action, { object, groups }, contract = null) {
  const ctx = { locator: groups, object: object || {} };
  const out = {};
  const problems = [];
  for (const [name, tpl] of Object.entries(action.rpa?.inputs || {})) {
    const spec = contract?.inputs?.[name];
    const v = coerce(renderValue(tpl, ctx), spec);
    if (v === undefined || v === '') {
      problems.push({ name, message: '映射結果為空' });
      continue;
    }
    if (spec?.enum && !spec.enum.some(e => e === v)) problems.push({ name, message: `不在可選值 ${spec.enum.join(' / ')} 內` });
    if (spec?.pattern && typeof v === 'string' && !new RegExp(spec.pattern, 'u').test(v)) problems.push({ name, message: `不符合格式 ${spec.pattern}` });
    out[name] = v;
  }
  if (contract?.inputs) {
    for (const [name, spec] of Object.entries(contract.inputs)) {
      if (!(name in out) && spec?.default === undefined && !problems.some(p => p.name === name) && spec?.required !== false) problems.push({ name, message: '場景入參沒有映射，也沒有預設值' });
    }
    for (const name of Object.keys(out)) if (!(name in contract.inputs)) problems.push({ name, message: '場景沒有這個入參' });
  }
  return { inputs: out, problems };
}

const sameValue = (a, b) => (typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) && String(a).trim() !== '' : String(a) === String(b));

/** 守衛：每一項都要精確滿足。返回失敗項的實際值與期望值。 */
export function evaluateExpect(action, output, { object, groups }) {
  const ctx = { locator: groups, object: object || {} };
  const failures = [];
  for (const e of action.check?.expect || []) {
    const actual = output ? lookup(output, e.output) : undefined;
    if (e.nonEmpty) {
      const empty = actual === undefined || actual === null || (typeof actual === 'string' && !actual.trim()) || (Array.isArray(actual) && !actual.length) || (typeof actual === 'object' && actual && !Array.isArray(actual) && !Object.keys(actual).length);
      if (empty) failures.push({ output: e.output, rule: 'nonEmpty', expected: '非空', actual: actual ?? null });
    } else {
      const expected = renderValue(e.equals, ctx);
      if (actual === undefined || actual === null || !sameValue(actual, expected)) failures.push({ output: e.output, rule: 'equals', expected, actual: actual ?? null });
    }
  }
  return { ok: failures.length === 0, failures };
}

/** 證據摘要：keep 的欄位存原值；digest 的欄位只存 sha256 與長度。 */
export function evidenceOf(action, output) {
  const outputs = {};
  const digests = {};
  for (const k of action.evidence?.keep || []) if (output && output[k] !== undefined) outputs[k] = output[k];
  for (const k of action.evidence?.digest || []) {
    if (!output || output[k] === undefined || output[k] === null) continue;
    const text = typeof output[k] === 'string' ? output[k] : JSON.stringify(output[k]);
    digests[k] = { sha256: crypto.createHash('sha256').update(text).digest('hex'), length: text.length };
  }
  return { outputs, digests };
}
