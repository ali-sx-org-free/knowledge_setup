// 精簡 OpenAPI 3.1 描述，方便三方智能體框架自動生成工具定義。說明文字按請求語言返回；枚舉值保持原文。
import { tr, tk, currentLocale } from '../i18n/index.js';
import { VERSION } from '../version.js';

const E = (method, path, summary, role, { body, query, tag, scope } = {}) => ({ method, path, summary, role, body, query, tag, scope });
// 確認端點：負責人，或持此附加權限的 API 金鑰（只能確認斷言，必須附 reviewVersion）
const CONFIRM_SCOPE = 'assertions:confirm';

const ENDPOINTS = [
  E('get', '/prompt', tk('拉取智能體教程（Markdown）；?role=producer|consumer&format=json'), 'public', { tag: tk('教程'), query: ['role', 'format'] }),
  E('get', '/schema', tk('機器可讀的類型、關係方向、層級與寫入上限'), 'public', { tag: tk('教程') }),
  E('post', '/ask', tk('問答：返回自然語言答案、引用（含層級）、結構化知識卡，以及相關文檔章節的補充原文（documents，與知識引用分開）'), 'consumer', { tag: tk('消費'), body: { question: 'string', subjectIds: 'string[]', inputs: 'object', compose: 'auto|llm|template', model: 'string', includeKnowledge: 'boolean', includeDocuments: 'boolean' } }),
  E('get', '/resolve', tk('術語解析：別名 → 規範主體'), 'consumer', { tag: tk('消費'), query: ['text'] }),
  E('get', '/subjects', tk('主體列表：多值用逗號分隔，前綴 ! 表示排除；返回 page.total'), 'consumer', { tag: tk('消費'), query: ['q', 'type', 'domain', 'level', 'state', 'owner', 'tag', 'mine', 'view', 'ids', 'updatedSince', 'sort', 'offset', 'limit'] }),
  E('get', '/subjects/facets', tk('主體各維度的計數（每組在其他篩選條件下計算）與領域 × 層級分佈'), 'consumer', { tag: tk('消費'), query: ['q', 'type', 'domain', 'level', 'state', 'owner', 'tag', 'mine', 'view', 'ids'] }),
  E('get', '/subjects/export', tk('按篩選條件導出主體 CSV'), 'consumer', { tag: tk('消費'), query: ['q', 'type', 'domain', 'level', 'state', 'owner', 'tag', 'view', 'ids', 'sort', 'columns'] }),
  E('get', '/subjects/similar', tk('名稱相似或同名的主體與別名（新增前查重）'), 'consumer', { tag: tk('消費'), query: ['name', 'limit'] }),
  E('get', '/subjects/{id}', tk('主體知識卡'), 'consumer', { tag: tk('消費') }),
  E('get', '/subjects/{id}/context', tk('知識卡 + 一跳鄰居'), 'consumer', { tag: tk('消費') }),
  E('get', '/subjects/{id}/history', tk('主體檔案的 Git 版本歷史'), 'consumer', { tag: tk('消費') }),
  E('get', '/graph', tk('圖譜子圖'), 'consumer', { tag: tk('消費'), query: ['focus', 'depth', 'domain', 'types', 'relationTypes', 'levels', 'aliases', 'e1'] }),
  E('get', '/objects', tk('客體列表'), 'consumer', { tag: tk('消費'), query: ['category', 'status', 'q'] }),
  E('get', '/assertions', tk('斷言列表（含 reviewVersion）'), 'consumer', { tag: tk('消費'), query: ['level', 'type', 'subjectId', 'q', 'pending'] }),
  E('post', '/assertions/confirm-batch', tk('批量確認所選 L1 斷言為 L0：每條附審閱版本，任何一條不符整批拒絕；note 只寫入審計'), 'owner', { tag: tk('負責人'), scope: CONFIRM_SCOPE, body: { items: '[{id,version:reviewVersion}]', note: 'string' } }),
  E('get', '/relations', tk('關係列表（含 reviewVersion）'), 'consumer', { tag: tk('消費'), query: ['type', 'level', 'subjectId'] }),
  E('get', '/items/{id}', tk('帶有效性的條目（B-/A-/R-），含 reviewVersion'), 'consumer', { tag: tk('消費') }),
  E('post', '/actions/{id}/invoke', tk('調用取值 Action 獲取實時動態值'), 'consumer', { tag: tk('消費'), body: { inputs: 'object' } }),
  E('post', '/feedback', tk('反饋知識有誤（觸發降級與重驗）'), 'consumer', { tag: tk('消費'), body: { targetId: 'string', comment: 'string', question: 'string' } }),
  E('post', '/subjects', tk('新建主體'), 'contributor', { tag: tk('生產'), body: { name: 'string', type: '系統|業務對象|流程|規則|指標|別名', domain: 'string', definition: 'string', owner: 'string', errorCost: 'integer 1-5', aliasOf: 'string[]', tags: 'string[]' } }),
  E('patch', '/subjects/{id}', tk('修改主體'), 'contributor', { tag: tk('生產'), body: { name: 'string', definition: 'string', owner: 'string', errorCost: 'integer', expiryDays: 'integer', tags: 'string[]' } }),
  E('post', '/subjects/batch', tk('批量整理主體：負責人、指定負責人、出錯代價、有效期、標籤；dryRun 只返回計畫；一個提交，可撤銷'), 'contributor', { tag: tk('生產'), body: { ids: 'string[]', query: 'object', set: '{owner, ownerIds, errorCost, expiryDays}', addTags: 'string[]', removeTags: 'string[]', dryRun: 'boolean' } }),
  E('post', '/subjects/batch/undo', tk('撤銷一次批量整理：寫反向提交，批量之後又被改過的主體跳過'), 'contributor', { tag: tk('生產'), body: { commit: 'string' } }),
  E('post', '/subjects/import', tk('批量導入主體與別名；dryRun 返回每行的查重與校驗結果'), 'contributor', { tag: tk('生產'), body: { rows: '[{name, type, domain, definition, owner, aliases, tags, errorCost}]', dryRun: 'boolean' } }),
  E('post', '/relations/batch', tk('所選主體逐個與目標主體建立同一種關係；dryRun 返回計畫'), 'contributor', { tag: tk('生產'), body: { subjectIds: 'string[]', type: 'string', target: 'string', direction: 'out|in', evidence: '{objectIds,sourceRef}', level: 'L1|L2', dryRun: 'boolean' } }),
  E('post', '/validate-batch', tk('校驗所選主體下全部可校驗的條目'), 'contributor', { tag: tk('生產'), body: { subjectIds: 'string[]' } }),
  E('post', '/items/confirmable', tk('列出所選主體下可以確認為 L0 的條目（附證據的 L1，含審閱版本）'), 'contributor', { tag: tk('負責人'), body: { subjectIds: 'string[]' } }),
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
  E('post', '/items/{id}/confirm', tk('確認 L1 → L0：負責人，或持 assertions:confirm 的金鑰（只限斷言，必須附 version）'), 'owner', { tag: tk('負責人'), scope: CONFIRM_SCOPE, body: { version: 'reviewVersion', note: 'string', expiryDays: 'integer' } }),
  E('post', '/items/confirm-batch', tk('批量確認條目為 L0：每條附審閱版本，條目已變更時整批拒絕；assertions:confirm 金鑰只能包含斷言'), 'owner', { tag: tk('負責人'), scope: CONFIRM_SCOPE, body: { items: '[{id,version:reviewVersion}]', note: 'string' } }),
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
  E('post', '/actions/{id}/trial', tk('RPA Action 試運行（走完整流程，不寫回）'), 'owner', { tag: tk('動力層'), body: { objectId: 'string' } }),
  E('get', '/docs', tk('文檔列表與搜索；view 是智能視圖名'), 'consumer', { tag: tk('文檔'), query: ['q', 'folder', 'tags', 'tagMode', 'template', 'status', 'subjectId', 'objectId', 'owner', 'view', 'drafts', 'obsolete', 'sort', 'limit', 'cursor'] }),
  E('get', '/doc-sections', tk('段級搜索：返回命中的章節、錨點、摘錄與引用寫法'), 'consumer', { tag: tk('文檔'), query: ['q', 'folder', 'limit', 'full'] }),
  E('get', '/docs/{id}', tk('讀文檔：預設當前已發布版本；version= 讀舊版本，draft=1 讀草稿或修訂（contributor），format=md 返回原文'), 'consumer', { tag: tk('文檔'), query: ['version', 'draft', 'format'] }),
  E('get', '/docs/{id}/sections', tk('按章節分段，每段帶錨點、標題路徑、正文、引用的 ID 與引用寫法'), 'consumer', { tag: tk('文檔'), query: ['draft'] }),
  E('get', '/docs/{id}/history', tk('版本與整理事件（來自 Git 歷史）'), 'consumer', { tag: tk('文檔') }),
  E('get', '/docs/{id}/diff', tk('版本差異：欄位、按章節的增刪改、逐行差異；to=draft 比較修訂'), 'contributor', { tag: tk('文檔'), query: ['from', 'to'] }),
  E('get', '/docs/{id}/impact', tk('以本文檔為依據的知識；有修訂時按改動的章節和 sourceRef 給出 suggested（預選）'), 'consumer', { tag: tk('文檔') }),
  E('get', '/docs/export', tk('導出：format=jsonl 段級 JSONL（可直接導入其他 RAG 系統）；format=zip Markdown 壓縮包（含圖片與索引）'), 'consumer', { tag: tk('文檔'), query: ['format', 'folder', 'tags', 'template', 'obsolete'] }),
  E('get', '/search', tk('全局搜索：主體和文檔一起搜'), 'consumer', { tag: tk('文檔'), query: ['q', 'limit'] }),
  E('post', '/docs/convert', tk('Word（.docx）、PDF 轉 Markdown，不寫入：請求體是檔案本身（20 MB 以內）'), 'contributor', { tag: tk('文檔'), query: ['name'] }),
  E('post', '/docs/import', tk('導入 Word、PDF：轉成 Markdown 後建立草稿'), 'contributor', { tag: tk('文檔'), query: ['name', 'title', 'folder', 'template', 'tags'] }),
  E('post', '/docs/ai-draft', tk('AI 起草：按模板與選中主體的 L0、L1 知識生成草稿，標記「AI 起草」，必須由人發布；preview=true 只返回內容'), 'contributor', { tag: tk('文檔'), body: { template: 'string', title: 'string', folder: 'string', instruction: 'string', subjectIds: 'string[]', compose: 'auto|llm|template', preview: 'boolean' } }),
  E('post', '/docs/generate', tk('從知識生成主體手冊（subjectId）或領域手冊（domain）；正文只讀，已有時重新生成（限人）'), 'contributor', { tag: tk('文檔'), body: { subjectId: 'string', domain: 'string', folder: 'string' } }),
  E('post', '/docs/{id}/regenerate', tk('知識變化後重新生成手冊；沒有變化時不產生新版本'), 'contributor', { tag: tk('文檔') }),
  E('post', '/docs/{id}/extract', tk('從已發布的文檔提取斷言：證據是文檔客體，sourceRef 寫章節與版本，最高 L1'), 'contributor', { tag: tk('文檔'), body: { items: '[{ subjectId, type, content, anchor }]' } }),
  E('post', '/docs/{id}/extract-suggestions', tk('按章節建議可提取的斷言（不寫入）；compose=llm 用模型'), 'contributor', { tag: tk('文檔'), body: { anchor: 'string', compose: 'auto|llm|template' } }),
  E('post', '/docs/{id}/migrate-basis', tk('已廢止的文檔：把依據遷移到替代文檔（為受影響的主體綁定替代文檔的客體，L1）'), 'owner', { tag: tk('文檔') }),
  E('post', '/docs', tk('新建草稿；回應帶 problems（體檢結果）'), 'contributor', { tag: tk('文檔'), body: { template: 'string', title: 'string', folder: 'string', summary: 'string', fields: 'object', tags: 'string[]', subjects: 'string[]', objects: 'string[]', related: 'string[]', owner: 'string', body: 'string', takeOverObjectId: 'string', startVersion: 'integer' } }),
  E('put', '/docs/{id}/draft', tk('保存草稿（整篇），帶上次讀到的 etag；已發布文檔第一次保存即開始修訂'), 'contributor', { tag: tk('文檔'), body: { etag: 'string', title: 'string', summary: 'string', fields: 'object', tags: 'string[]', subjects: 'string[]', objects: 'string[]', owner: 'string', body: 'string' } }),
  E('delete', '/docs/{id}/draft', tk('放棄草稿或修訂'), 'contributor', { tag: tk('文檔') }),
  E('patch', '/docs/{id}', tk('整理：標籤、關聯、負責人、移動（移動限人）'), 'contributor', { tag: tk('文檔'), body: { tags: 'string[]', subjects: 'string[]', objects: 'string[]', related: 'string[]', folder: 'string', owner: 'string', ownerIds: 'string[]' } }),
  E('post', '/docs/{id}/submit', tk('提交審閱（體檢有錯誤時返回 422 lint_failed）'), 'contributor', { tag: tk('文檔') }),
  E('post', '/docs/{id}/publish', tk('發布或審閱通過（智能體返回 403 agent_cannot_publish）'), 'contributor', { tag: tk('文檔'), body: { major: 'boolean', note: 'string', affect: 'string[]', bindSubjects: 'string[]' } }),
  E('post', '/docs/{id}/reject', tk('退回待審的文檔'), 'owner', { tag: tk('文檔'), body: { note: 'string' } }),
  E('post', '/docs/{id}/obsolete', tk('廢止：文檔客體下線並級聯；migrate=true 時把依據遷移到替代文檔'), 'owner', { tag: tk('文檔'), body: { reason: 'string', replacedBy: 'string', migrate: 'boolean' } }),
  E('post', '/docs/{id}/review', tk('確認複審（不改版本）'), 'owner', { tag: tk('文檔'), body: { note: 'string' } }),
  E('post', '/docs/{id}/assets', tk('上傳圖片：請求體是圖片本身（PNG、JPEG、GIF、WebP，單張 2 MB）'), 'contributor', { tag: tk('文檔'), query: ['name'] }),
  E('post', '/docs/lint', tk('只體檢、不保存'), 'contributor', { tag: tk('文檔'), body: { id: 'string', template: 'string', title: 'string', summary: 'string', fields: 'object', body: 'string', folder: 'string', phase: 'save|submit|publish' } }),
  E('post', '/docs/bulk', tk('批量整理：移動、加或去標籤、關聯主體、改負責人（一次提交）'), 'contributor', { tag: tk('文檔'), body: { ids: 'string[]', folder: 'string', addTags: 'string[]', removeTags: 'string[]', addSubjects: 'string[]', owner: 'string' } }),
  E('get', '/doc-folders', tk('文件夾樹與數量、智能視圖數量'), 'consumer', { tag: tk('文檔') }),
  E('post', '/doc-folders', tk('新建文件夾（限人）'), 'contributor', { tag: tk('文檔'), body: { path: 'string', description: 'string', defaultTemplate: 'string', defaultTags: 'string[]', ownerIds: 'string[]' } }),
  E('patch', '/doc-folders', tk('文件夾設定，或重命名、移動（newPath；裡面的文檔一起移動）'), 'contributor', { tag: tk('文檔'), body: { path: 'string', newPath: 'string', description: 'string', defaultTemplate: 'string', defaultTags: 'string[]', ownerIds: 'string[]' } }),
  E('get', '/doc-tags', tk('標籤字典與使用數'), 'consumer', { tag: tk('文檔') }),
  E('post', '/doc-tags/merge', tk('合併標籤（改寫所有文檔，一次提交）'), 'owner', { tag: tk('文檔'), body: { from: 'string[]', to: 'string' } }),
  E('get', '/doc-templates', tk('文檔模板（欄位、章節、審閱與複審規則）'), 'consumer', { tag: tk('文檔') }),
  E('post', '/doc-templates/{id}/render', tk('按模板生成正文骨架與欄位說明'), 'contributor', { tag: tk('文檔'), body: { fields: 'object' } })
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
      description: e.scope ? tr('所需角色：{role}；或 API 金鑰附加權限 {scope}', { role: e.role, scope: e.scope }) : tr('所需角色：{role}', { role: e.role }),
      'x-role': e.role,
      'x-scopes': e.scope ? [e.scope] : undefined,
      parameters: params.length ? params : undefined,
      requestBody: e.body ? { required: true, content: { 'application/json': { schema: schemaFor(e.body) } } } : undefined,
      responses: { 200: { description: tr('成功：{shape}', { shape: '{ data, commit?, warnings? }' }) }, 202: { description: tr('已受理，異步執行：{shape}', { shape: '{ data: { executionId, state, statusUrl } }' }) }, 400: { description: tr('輸入錯誤') }, 401: { description: tr('未認證') }, 403: { description: tr('權限不足') }, ...(e.scope ? { 409: { description: tr('條目狀態不符或已變更（already_confirmed、invalid_transition、missing_evidence、stale_*）') } } : {}), 422: { description: tr('違反知識規則') } },
      security: e.role === 'public' ? [] : undefined
    };
    (paths[e.path] ||= {})[e.method] = op;
  }
  return {
    openapi: '3.1.0',
    info: { title: tr('供應鏈技術知識體系 API'), version: VERSION, description: tr('生產型 API 供三方智能體生產與管理知識；消費型 API 返回結構化知識與自然語言答案。先 GET /prompt 閱讀教程。'), 'x-locale': currentLocale() },
    servers: [{ url: `${baseUrl.replace(/\/+$/, '')}/api/v1` }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: tr('後台「接入 › API 金鑰」創建') } } },
    security: [{ bearer: [] }],
    paths
  };
}
