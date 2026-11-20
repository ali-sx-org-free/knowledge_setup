// 精簡 OpenAPI 3.1 描述，方便三方智能體框架自動生成工具定義。說明文字按請求語言返回；枚舉值保持原文。
import { tr, tk, currentLocale } from '../i18n/index.js';

const E = (method, path, summary, role, { body, query, tag } = {}) => ({ method, path, summary, role, body, query, tag });

const ENDPOINTS = [
  E('get', '/prompt', tk('拉取智能體教程（Markdown）；?role=producer|consumer&format=json'), 'public', { tag: tk('教程'), query: ['role', 'format'] }),
  E('get', '/schema', tk('機器可讀的類型、關係方向、層級與寫入上限'), 'public', { tag: tk('教程') }),
  E('post', '/ask', tk('問答：返回自然語言答案、引用（含層級）與結構化知識卡'), 'consumer', { tag: tk('消費'), body: { question: 'string', subjectIds: 'string[]', inputs: 'object', compose: 'auto|llm|template', model: 'string', includeKnowledge: 'boolean' } }),
  E('get', '/resolve', tk('術語解析：別名 → 規範主體'), 'consumer', { tag: tk('消費'), query: ['text'] }),
  E('get', '/subjects', tk('搜索主體'), 'consumer', { tag: tk('消費'), query: ['q', 'type', 'domain', 'level'] }),
  E('get', '/subjects/{id}', tk('主體知識卡'), 'consumer', { tag: tk('消費') }),
  E('get', '/subjects/{id}/context', tk('知識卡 + 一跳鄰居'), 'consumer', { tag: tk('消費') }),
  E('get', '/subjects/{id}/history', tk('主體檔案的 Git 版本歷史'), 'consumer', { tag: tk('消費') }),
  E('get', '/graph', tk('圖譜子圖'), 'consumer', { tag: tk('消費'), query: ['focus', 'depth', 'domain', 'types', 'relationTypes', 'levels', 'aliases', 'e1'] }),
  E('get', '/objects', tk('客體列表'), 'consumer', { tag: tk('消費'), query: ['category', 'status', 'q'] }),
  E('get', '/assertions', tk('斷言列表'), 'consumer', { tag: tk('消費'), query: ['level', 'type', 'subjectId', 'q', 'pending'] }),
  E('get', '/relations', tk('關係列表'), 'consumer', { tag: tk('消費'), query: ['type', 'level', 'subjectId'] }),
  E('get', '/items/{id}', tk('帶有效性的條目（B-/A-/R-）'), 'consumer', { tag: tk('消費') }),
  E('post', '/actions/{id}/invoke', tk('調用取值 Action 獲取實時動態值'), 'consumer', { tag: tk('消費'), body: { inputs: 'object' } }),
  E('post', '/feedback', tk('反饋知識有誤（觸發降級與重驗）'), 'consumer', { tag: tk('消費'), body: { targetId: 'string', comment: 'string', question: 'string' } }),
  E('post', '/subjects', tk('新建主體'), 'contributor', { tag: tk('生產'), body: { name: 'string', type: '系統|業務對象|流程|規則|指標|別名', domain: 'string', definition: 'string', owner: 'string', errorCost: 'integer 1-5', aliasOf: 'string[]', tags: 'string[]' } }),
  E('patch', '/subjects/{id}', tk('修改主體'), 'contributor', { tag: tk('生產'), body: { name: 'string', definition: 'string', owner: 'string', errorCost: 'integer', expiryDays: 'integer' } }),
  E('post', '/objects', tk('登記客體'), 'contributor', { tag: tk('生產'), body: { name: 'string', category: '數字|制度|物理', kind: 'string', locator: 'string', description: 'string', actionIds: 'string[]' } }),
  E('patch', '/objects/{id}', tk('修改客體（status=下線 觸發級聯）'), 'contributor', { tag: tk('生產'), body: { status: '在用|下線', reason: 'string' } }),
  E('post', '/subjects/{id}/bindings', tk('綁定客體'), 'contributor', { tag: tk('生產'), body: { objectId: 'string', note: 'string', level: 'L1|L2|E1' } }),
  E('post', '/subjects/{id}/assertions', tk('新增斷言'), 'contributor', { tag: tk('生產'), body: { type: '定義|屬性|規則|約束', content: 'string', structured: '{key,value}', evidence: '{objectIds,sourceRef}', level: 'L1|L2|E1', invalidReason: 'string', replacedBy: 'string' } }),
  E('patch', '/assertions/{id}', tk('修改斷言'), 'contributor', { tag: tk('生產'), body: { content: 'string', structured: '{key,value}' } }),
  E('post', '/relations', tk('新增關係'), 'contributor', { tag: tk('生產'), body: { from: 'string', type: 'string', to: 'string', evidence: '{objectIds,sourceRef}', level: 'L1|L2|E1' } }),
  E('post', '/batch', tk('批量提交（單個 Git 提交，失敗整批回滾）'), 'contributor', { tag: tk('生產'), body: { message: 'string', items: '[{op, ref?, data}]' } }),
  E('post', '/items/{id}/evidence', tk('補充證據 L2 → L1'), 'contributor', { tag: tk('生產'), body: { objectIds: 'string[]', sourceRef: 'string', actionId: 'string' } }),
  E('post', '/validate/{id}', tk('執行校驗 Action 並寫回有效性'), 'contributor', { tag: tk('生產'), body: { actionId: 'string' } }),
  E('get', '/action-executions', tk('RPA 校驗的執行記錄（POST /validate 對 RPA Action 返回 202 與執行 ID）'), 'contributor', { tag: tk('生產'), query: ['itemId', 'actionId', 'state', 'runId', 'pipelineId', 'limit'] }),
  E('get', '/action-executions/{id}', tk('一次執行的狀態、結論、證據與寫回效果（輪詢到 terminal 為 true）'), 'contributor', { tag: tk('生產') }),
  E('post', '/action-executions/{id}/refresh', tk('已逾時的執行：重新讀取原運行'), 'contributor', { tag: tk('生產') }),
  E('post', '/conflicts', tk('登記衝突（雙方降為 L1）'), 'contributor', { tag: tk('治理'), body: { a: 'string', b: 'string', note: 'string' } }),
  E('get', '/conflicts', tk('衝突列表'), 'contributor', { tag: tk('治理') }),
  E('get', '/feedback', tk('反饋列表'), 'contributor', { tag: tk('治理') }),
  E('get', '/gaps', tk('知識缺口（未收錄查詢）'), 'contributor', { tag: tk('治理') }),
  E('get', '/queue', tk('重驗隊列（按 使用頻率 × 出錯代價 排序）'), 'contributor', { tag: tk('治理') }),
  E('get', '/metrics', tk('健康指標'), 'contributor', { tag: tk('治理'), query: ['days'] }),
  E('post', '/items/{id}/confirm', tk('負責人確認 L1 → L0（僅限人）'), 'owner', { tag: tk('負責人'), body: { note: 'string', expiryDays: 'integer' } }),
  E('post', '/items/{id}/invalidate', tk('判定失效 → E1'), 'owner', { tag: tk('負責人'), body: { reason: 'string', replacedBy: 'string' } }),
  E('post', '/conflicts/{id}/resolve', tk('裁決衝突'), 'owner', { tag: tk('負責人'), body: { winner: 'string', reason: 'string' } }),
  E('post', '/validate-all', tk('對全部可校驗知識執行校驗'), 'owner', { tag: tk('負責人'), body: { onlyPending: 'boolean' } }),
  E('post', '/pipelines', tk('新增管道'), 'owner', { tag: tk('動力層') }),
  E('post', '/actions', tk('新增 Action'), 'owner', { tag: tk('動力層') }),
  E('post', '/pipelines/{id}/test', tk('測試管道；RPA 管道另做最小權限體檢'), 'owner', { tag: tk('動力層') }),
  E('get', '/pipelines/{id}/scenes', tk('RPA 場景目錄（已發布、未歸檔；?all=1 全部）'), 'owner', { tag: tk('動力層'), query: ['q', 'domain', 'category', 'all'] }),
  E('get', '/pipelines/{id}/scenes/{sceneId}', tk('RPA 場景契約、可註冊規範檢查與 Action 草稿'), 'owner', { tag: tk('動力層'), query: ['revision', 'objectKind', 'source'] }),
  E('post', '/actions/{id}/preview', tk('RPA Action 預覽：定位分組、RPA 入參與守衛期望值（不派發）'), 'owner', { tag: tk('動力層'), body: { objectId: 'string', locator: 'string' } }),
  E('post', '/actions/{id}/review', tk('RPA Action 審閱新發布版本並鎖定'), 'owner', { tag: tk('動力層'), body: { readOnly: 'boolean', revision: 'integer' } }),
  E('post', '/actions/{id}/trial', tk('RPA Action 試運行（走完整流程，不寫回）'), 'owner', { tag: tk('動力層'), body: { objectId: 'string' } })
];

function schemaFor(spec) {
  const props = {};
  for (const [k, v] of Object.entries(spec || {})) {
    if (v.endsWith('[]')) props[k] = { type: 'array', items: { type: 'string' }, description: v };
    else if (v === 'object' || v.startsWith('{') || v.startsWith('[')) props[k] = { type: v.startsWith('[') ? 'array' : 'object', description: v };
    else if (v.startsWith('integer')) props[k] = { type: 'integer', description: v };
    else if (v === 'boolean') props[k] = { type: 'boolean' };
    else props[k] = { type: 'string', description: v === 'string' ? undefined : v };
  }
  return { type: 'object', properties: props };
}

export function buildOpenApi(baseUrl) {
  const paths = {};
  for (const e of ENDPOINTS) {
    const params = [...(e.path.match(/\{(\w+)\}/g) || [])].map(p => ({ name: p.slice(1, -1), in: 'path', required: true, schema: { type: 'string' } }));
    for (const q of e.query || []) params.push({ name: q, in: 'query', required: false, schema: { type: 'string' } });
    const op = {
      summary: tr(e.summary),
      tags: [tr(e.tag)],
      operationId: `${e.method}_${e.path.replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      description: tr('所需角色：{role}', { role: e.role }),
      'x-role': e.role,
      parameters: params.length ? params : undefined,
      requestBody: e.body ? { required: true, content: { 'application/json': { schema: schemaFor(e.body) } } } : undefined,
      responses: { 200: { description: tr('成功：{shape}', { shape: '{ data, commit?, warnings? }' }) }, 202: { description: tr('已受理，異步執行：{shape}', { shape: '{ data: { executionId, state, statusUrl } }' }) }, 400: { description: tr('輸入錯誤') }, 401: { description: tr('未認證') }, 403: { description: tr('權限不足') }, 422: { description: tr('違反知識規則') } },
      security: e.role === 'public' ? [] : undefined
    };
    (paths[e.path] ||= {})[e.method] = op;
  }
  return {
    openapi: '3.1.0',
    info: { title: tr('供應鏈技術知識體系 API'), version: '0.1.0', description: tr('生產型 API 供三方智能體生產與管理知識；消費型 API 返回結構化知識與自然語言答案。先 GET /prompt 閱讀教程。'), 'x-locale': currentLocale() },
    servers: [{ url: `${baseUrl.replace(/\/+$/, '')}/api/v1` }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: tr('後台「接入 › API 金鑰」創建') } } },
    security: [{ bearer: [] }],
    paths
  };
}
