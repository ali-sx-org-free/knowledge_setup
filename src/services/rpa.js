// 瀏覽器 RPA 的 Agent API 客戶端（/agent-api/v1）。只用到讀場景、正式執行、讀運行、取消。
// 參考 web_browser_robotic_process_automation 的 apps/server/src/rpa_server/agent_api.py。
import YAML from 'yaml';
import { renderTemplate } from './template.js';
import { tr, tk } from '../i18n/index.js';

/** RPA 返回錯誤或連不上。status 0 表示網絡錯誤或逾時（可以用同一個冪等鍵重試）。 */
export class RpaError extends Error {
  constructor(message, { status = 0, code = 'rpa_unreachable', details = {} } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** 可以稍後重試：網絡錯誤、逾時、5xx、429。 */
  get retryable() {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

/** 知識庫需要的權限範圍；多出來的權限只會放大誤用的影響。 */
export const REQUIRED_SCOPES = ['scenes:read', 'runs:execute', 'runs:read'];
export const EXCESS_SCOPES = ['scenes:write', 'debug', 'runs:validate', 'scenes:publish', 'files:write', 'projects:write', 'projects:publish'];

export class RpaClient {
  constructor(pipeline, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
    this.pipeline = pipeline;
    this.env = env;
    this.fetch = fetchImpl;
    this.base = String(pipeline.baseUrl || '').replace(/\/+$/, '');
  }

  async request(method, path, body) {
    const headers = renderTemplate(this.pipeline.headers || {}, {}, this.env);
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await this.fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.pipeline.timeoutMs || 10000) });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new RpaError(timeout ? tr('RPA 請求逾時（{ms} ms）：{request}', { ms: this.pipeline.timeoutMs || 10000, request: `${method} ${path}` }) : tr('RPA 不可達：{message}', { message: err.message }), { code: timeout ? 'rpa_timeout' : 'rpa_unreachable' });
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const e = data?.error || {};
      const { code, message, ...details } = e;
      throw new RpaError(tr('RPA 返回 {status}：{message}', { status: code ? `${res.status} ${code}` : res.status, message: message || text.slice(0, 200) || res.statusText }), { status: res.status, code: code || `http_${res.status}`, details });
    }
    if (data === null) throw new RpaError(tr('RPA 返回的不是 JSON：{request}', { request: `${method} ${path}` }), { status: res.status, code: 'rpa_bad_response' });
    return data;
  }

  meta() { return this.request('GET', '/meta'); }
  workers() { return this.request('GET', '/workers'); }
  roles() { return this.request('GET', '/roles'); }
  scenes(query = {}) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v)).toString();
    return this.request('GET', `/scenes${qs ? `?${qs}` : ''}`);
  }
  scene(sceneId) { return this.request('GET', `/scenes/${encodeURIComponent(sceneId)}`); }
  revision(sceneId, number) { return this.request('GET', `/scenes/${encodeURIComponent(sceneId)}/revisions/${Number(number)}`); }
  createRun(sceneId, body) { return this.request('POST', `/scenes/${encodeURIComponent(sceneId)}/runs`, body); }
  getRun(runId) { return this.request('GET', `/runs/${encodeURIComponent(runId)}`); }
  cancelRun(runId) { return this.request('POST', `/runs/${encodeURIComponent(runId)}/cancel`, {}); }

  /** 人看運行報告的地址（RPA Portal 管權限）。 */
  portalUrl(run) {
    const portal = this.pipeline.rpa?.portalUrl;
    if (!portal || !run?.id) return null;
    return `${portal}${run.portalPath || `/runs/${encodeURIComponent(run.id)}`}`;
  }

  /** 讀某個版本的場景契約：入參、出參、登入角色、Secrets、期限、獨立斷言條數。 */
  async contract(sceneId, number) {
    const rev = await this.revision(sceneId, number);
    const text = rev.files?.['scenario.yaml'];
    if (typeof text !== 'string') throw new RpaError(tr('場景 {id} v{n} 沒有 scenario.yaml', { id: sceneId, n: number }), { status: 200, code: 'rpa_bad_response' });
    return { revision: rev, contract: parseScenario(text) };
  }
}

/** 解析場景檔：只取知識庫用得到的契約欄位。 */
export function parseScenario(text) {
  let doc;
  try { doc = YAML.parse(text) || {}; } catch (err) { throw new RpaError(tr('場景檔無法解析：{message}', { message: err.message }), { status: 200, code: 'rpa_bad_response' }); }
  const spec = v => (v && typeof v === 'object' ? v : {});
  const inputs = Object.fromEntries(Object.entries(spec(doc.inputs)).map(([k, v]) => [k, { type: v?.type || 'string', description: v?.description || null, enum: Array.isArray(v?.enum) ? v.enum : null, pattern: v?.pattern || null, default: v?.default ?? undefined }]));
  const outputs = Object.fromEntries(Object.entries(spec(doc.outputs)).map(([k, v]) => [k, { type: v?.type || 'string', description: v?.description || null }]));
  const verify = Array.isArray(doc.verify) ? doc.verify.length : doc.verify && typeof doc.verify === 'object' ? Object.keys(doc.verify).length : 0;
  return {
    id: doc.id || null,
    name: doc.name || null,
    description: doc.description || null,
    inputs,
    outputs,
    loginRole: doc.login?.role || null,
    secrets: Array.isArray(doc.secrets) ? doc.secrets : [],
    deadlineMs: Number.isFinite(Number(doc.deadline)) && doc.deadline !== null ? Number(doc.deadline) : null,
    verifyCount: verify,
    script: !!doc.script
  };
}

const ROLE_STATUS = { logged_in: tk('已登入'), needs_login: tk('需要人工登入'), none: tk('從未登入'), unknown: tk('狀態未知') };
const stem = name => String(name).replace(/(Prefix|Name|Id|Code|Key)$/, '').toLowerCase();

/**
 * 按「可註冊場景規範」檢查場景（docs/design/rpa-integration.md §5）。
 * 返回 [{ rule, level: 'ok'|'warn'|'error', text }]。
 */
export function conformance(scene, contract, roles = null) {
  const out = [];
  const add = (rule, level, text) => out.push({ rule, level, text });
  add('R2', scene.publishedRevision ? 'ok' : 'error', scene.publishedRevision ? tr('已發布 v{n}', { n: scene.publishedRevision }) : tr('沒有發布的版本，不能註冊'));
  if (scene.archived) add('R2', 'error', tr('場景已歸檔'));
  const outs = Object.keys(contract.outputs);
  const ins = Object.keys(contract.inputs);
  add('R3', outs.length ? 'ok' : 'error', outs.length ? tr('出參 {list}', { list: outs.join(tr('、')) }) : tr('沒有出參：知識庫無法確認場景查的是哪個對象'));
  add('R3', contract.verifyCount ? 'ok' : 'warn', contract.verifyCount ? tr('獨立斷言 {n} 條', { n: contract.verifyCount }) : tr('沒有獨立斷言（verify）'));
  const echoed = outs.filter(o => ins.some(i => i === o || stem(i) === stem(o)));
  add('R3', echoed.length ? 'ok' : 'warn', echoed.length ? tr('出參回顯了入參：{list}', { list: echoed.join(tr('、')) }) : tr('出參沒有回顯任何入參，無法逐項比對'));
  add('R4', contract.deadlineMs ? 'ok' : 'warn', contract.deadlineMs ? tr('整次期限 {n} 秒', { n: Math.round(contract.deadlineMs / 1000) }) : tr('沒有宣告 deadline，知識庫只能用管道的整體期限'));
  if (contract.loginRole) {
    const role = roles?.find(r => r.id === contract.loginRole);
    if (!roles) add('R5', 'warn', tr('登入角色 {role}（無法讀取登入狀態）', { role: contract.loginRole }));
    else if (!role) add('R5', 'error', tr('登入角色 {role} 沒有綁定給這個 API 用戶端（RPA 會回 403 login_role_forbidden）', { role: contract.loginRole }));
    else add('R5', role.status === 'logged_in' ? 'ok' : 'warn', tr('登入角色 {role}：{status}', { role: contract.loginRole, status: ROLE_STATUS[role.status] ? tr(ROLE_STATUS[role.status]) : role.status }));
  } else add('R5', 'ok', tr('不需要登入角色'));
  if (contract.script) add('R1', 'warn', tr('這是 Python 腳本場景：審閱只讀時請特別留意腳本內容'));
  return out;
}

/**
 * 從場景契約生成 Action 草稿，負責人審閱後保存：
 *  - 沒有預設值、沒有可選值的入參當作「定位分組」，按宣告順序用「.」連接成 locator.pattern；
 *  - 有預設值或可選值的入參給固定值（預設值或第一個可選值）；
 *  - 與入參同名或同詞幹的出參（例如 databasePrefix ↔ databaseName）生成精確相等的守衛，其餘出參要求非空。
 */
export function draftAction({ pipelineId, scene, revision, contract, objectKind }) {
  const identity = Object.entries(contract.inputs).filter(([, s]) => s.default === undefined && !s.enum);
  const fixed = Object.entries(contract.inputs).filter(([, s]) => s.default !== undefined || s.enum);
  const group = name => (/^[A-Za-z_]\w*$/.test(name) ? name : `g${Math.abs([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`);
  const groups = identity.map(([name]) => [name, group(name)]);
  const inputs = {};
  for (const [name, g] of groups) inputs[name] = `{locator.${g}}`;
  for (const [name, s] of fixed) inputs[name] = s.default !== undefined ? s.default : s.enum[0];
  const expect = [];
  const keep = [];
  const digest = [];
  for (const out of Object.keys(contract.outputs)) {
    const match = Object.keys(contract.inputs).find(i => i === out) || Object.keys(contract.inputs).find(i => stem(i) === stem(out));
    if (match) {
      expect.push({ output: out, equals: inputs[match] });
      keep.push(out);
    } else {
      // 其他出參（例如建表語句）只要求非空；證據只存雜湊與長度，不把全文寫進知識倉庫
      expect.push({ output: out, nonEmpty: true });
      digest.push(out);
    }
  }
  return {
    name: contract.name || scene.name || scene.id,
    kind: '校驗',
    pipelineId,
    description: contract.description || scene.description || null,
    objectKinds: objectKind ? [objectKind] : [],
    permission: 'contributor',
    enabled: true,
    rpa: { sceneId: scene.id, revision: revision.number, contentHash: revision.contentHash, loginRole: contract.loginRole, inputs },
    review: { readOnly: false },
    locator: groups.length ? { pattern: `^${groups.map(([, g]) => `(?<${g}>[^.\\s]+)`).join('\\.')}$`, example: '' } : null,
    check: { mode: 'exists', expect },
    evidence: { keep, digest },
    schedule: 'manual'
  };
}
