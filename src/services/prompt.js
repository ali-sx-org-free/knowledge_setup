// 教程 Prompt：三方智能體拉取後即可學會如何使用本系統生產或消費知識。
// 教程與 Schema 的說明文字按請求語言返回（見 ../i18n/index.js）；枚舉值是 API 的值，表格中保留繁體原文並附譯名。
import { SUBJECT_TYPES, RELATION_TYPES, ASSERTION_TYPES, OBJECT_CATEGORIES, LEVEL_INFO, ACTION_KINDS } from '../store/model.js';
import { tr, currentLocale } from '../i18n/index.js';

function table(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
}

/** 枚舉值在教程中的寫法：原文（API 的值）＋ 譯名；繁體或沒有譯名時只寫原文。 */
function enumCell(value, key = value) {
  const label = tr(key);
  return label === value ? value : tr('{value}（{label}）', { value, label });
}
const list = items => items.join(tr('、'));

export function buildPrompt({ store, baseUrl, role = 'producer' }) {
  const api = `${baseUrl.replace(/\/+$/, '')}/api/v1`;
  const domains = list(store.config.domains.map(d => tr('{value}（{label}）', { value: d.code, label: tr(d.name) })));
  const h = store.health();
  const exp = store.config.expiryDays;
  const enumNote = currentLocale() === 'zh-TW' ? '' : `\n${tr('**注意**：主體類型、客體類別與種類、斷言類型、關係類型、Action 種類、客體狀態等枚舉值是 API 的值，請求中一律使用表格裡的原文（例如 `"type": "指標"`），不要翻譯；知識內容本身可以使用任何語言。')}\n`;

  const concepts = `## ${tr('1. 知識模型：六個概念')}
${enumNote}
${tr('一句話模型：**主體是概念，通過客體在真實世界中得到證明，有效性說明證明到了什麼程度。** 主體之間的關係構成圖譜，斷言記錄主體的具體內容，Action 是客體與真實世界交互的接口。')}

${table([tr('概念'), tr('定義'), tr('在本系統中的位置')], [
  [tr('主體 Subject'), tr('一個概念的存在，例如「可售庫存」「庫存中心」'), tr('圖譜節點；ID 形如 {example}', { example: 'S-INV-0012' })],
  [tr('客體 Object'), tr('主體在真實世界中的對應物：數字 / 制度 / 物理'), tr('通過「綁定 B-」掛在主體下；ID 形如 {example}', { example: 'O-0001' })],
  [tr('有效性 Validity'), tr('知識被客體印證的程度：L0 / L1 / L2 / E1'), tr('附在綁定、斷言、關係三處')],
  [tr('關係 Relation'), tr('主體之間有類型的連接（10 種閉集）'), tr('圖譜的邊；ID 形如 {example}', { example: 'R-0001' })],
  [tr('斷言 Assertion'), tr('關於某個主體的一條具體陳述，一條只說一件事'), tr('主體的二級模型；ID 形如 {example}', { example: 'A-0001' })],
  ['Action', tr('對某類客體的一次只讀管道交互：校驗 / 取值'), tr('動力層接口；ID 形如 {example}', { example: 'ACT-0001' })]
])}

### ${tr('主體類型')}
${table([tr('類型'), tr('含義'), tr('示例')], Object.entries(SUBJECT_TYPES).map(([k, v]) => [enumCell(k), tr(v.desc), tr(v.example)]))}

${tr('別名規則：別名主體只通過「別名」關係指向規範主體，自身不掛客體、斷言或其他關係；一個別名可指向多個規範主體（一詞多義）；檢索時先把別名解析為規範主體。')}

### ${tr('客體類別')}
${table([tr('類別'), tr('典型種類')], Object.entries(OBJECT_CATEGORIES).map(([k, v]) => [enumCell(k), list(v.kinds.map(x => enumCell(x)))]))}

### ${tr('斷言類型')}
${table([tr('類型'), tr('用途')], Object.entries(ASSERTION_TYPES).map(([k, v]) => [enumCell(k), tr(v)]))}

${tr('**約束類斷言**記錄否定性知識和邊界情況，是最容易被行業常識補錯的部分，請優先收集。')}

### ${tr('關係類型（閉集，不可自創）')}
${table([tr('關係'), tr('方向'), tr('示例')], Object.entries(RELATION_TYPES).map(([k, v]) => [enumCell(k, `rel|${k}`), tr(v.direction), tr(v.example)]))}

${tr('每個業務對象或指標原則上只有一條 L0 的「擁有」關係，用來回答「這個數據以哪個系統為準」。')}

### ${tr('有效性層級')}
${table([tr('層級'), tr('條件'), tr('智能體用法')], Object.entries(LEVEL_INFO).map(([k, v]) => [`${k} ${tr(v.name)}`, tr(v.condition), tr(v.usage)]))}
`;

  const producerRules = `## ${tr('2. 你作為貢獻者必須遵守的寫入規則')}

1. ${tr('**寫入上限**：你提交的知識附客體證據（`evidence.objectIds` 或明確來源 `evidence.sourceRef`）最高 L1，無證據只能 L2。**你不能寫入 L0**，也不能晉升自己或其他智能體提交的知識；請求 L0 會被自動降為 L1 並返回 warning。')}
2. ${tr('L0 只能通過 **Action 校驗**（`POST /validate/{id}`，結果由管道決定）或**負責人確認**得到。綁定用「客體存在」校驗；斷言必須用「比對內容」校驗，所以可自動驗證的斷言請帶 `structured: {key, value}`（如 `reserve.ttl = 30m`）。')}
3. ${tr('**先登記客體，再引用證據**：證據必須是已登記的客體 ID。斷言的證據通常是主體已綁定的客體。')}
4. ${tr('**一條斷言只說一件事**，便於單獨驗證、單獨失效。')}
5. ${tr('**動態值不存儲**：庫存數量、訂單狀態、在途量等隨時變化的值，只記錄「它是什麼、以哪個系統為準、怎麼取（取值 Action）」。')}
6. ${tr('**不要重複**：提交前先 `GET /subjects?q=` 或 `GET /resolve?text=` 檢查主體是否已存在；同名會返回 409。')}
7. ${tr('**E1 不刪除**：發現知識過時或錯誤時，提交反饋（`POST /feedback`）或登記衝突（`POST /conflicts`），由負責人裁決；記錄歷史舊知識可直接提交 E1，但必須帶 `invalidReason`，並可用 `replacedBy` 指向替代者。')}
8. ${tr('**關係類型是閉集**，方向必須符合上表；別名只用「別名」關係。')}
9. ${tr('領域代碼（決定主體 ID 前綴）：{domains}。', { domains })}

${tr('有效期初值：定義類斷言 {definition} 天，屬性/規則/約束類 {rule} 天；依賴、產出、消費、擁有、後續關係 {dependency} 天；是一種、組成、計算自、別名關係 {isA} 天。到期 L0 自動降為 L1 並排入重驗。', { definition: exp.assertion.定義, rule: exp.assertion.規則, dependency: exp.relation.依賴, isA: exp.relation.是一種 })}
`;

  const producerApi = `## ${tr('3. 生產型 API')}

${tr('所有請求帶 `Authorization: Bearer <你的 API 金鑰>`，請求與回應均為 JSON。每次寫入都會成為知識 Git 倉庫中的一次提交，作者記為你的身份。回應中的 `warnings` 請認真處理。')}

### ${tr('推薦流程（冷啟動）')}
1. ${tr('`GET {api}/prompt` 讀本教程；`GET {api}/schema` 取得機器可讀的類型定義。', { api })}
2. ${tr('掃描設計文檔、表結構、接口定義和配置。')}
3. ${tr('用一次 `POST {api}/batch` 提交：先客體，再主體（含綁定與斷言），最後關係。批內可用 `ref` 給新條目起臨時名，後續用 `"$ref:名字"` 引用。', { api })}
4. ${tr('檢查回應中的 ID、層級與 warnings；對可自動校驗的知識調用 `POST {api}/validate/{id}`。', { api })}
5. ${tr('提交後由負責人確認高頻、高風險知識晉升為 L0。')}

### ${tr('端點')}
${table([tr('方法'), tr('路徑'), tr('用途')], [
  ['GET', '/schema', tr('類型、關係方向、層級、領域代碼')],
  ['GET', '/resolve?text=', tr('術語解析：別名 → 規範主體（多義會列出候選）')],
  ['GET', '/subjects?q=&type=&domain=&level=', tr('搜索主體')],
  ['GET', '/subjects/{id}', tr('主體知識卡（含綁定、斷言、關係、Action）')],
  ['POST', '/subjects', tr('新建主體；別名類型可帶 aliasOf: [規範主體ID]')],
  ['PATCH', '/subjects/{id}', tr('修改定義、負責人等')],
  ['POST', '/objects', tr('登記客體')],
  ['PATCH', '/objects/{id}', tr('修改客體；status=下線 會觸發相關綁定轉 E1、證據降 L1')],
  ['POST', '/subjects/{id}/bindings', tr('綁定客體 {objectId}')],
  ['POST', '/subjects/{id}/assertions', tr('新增斷言 {type, content, structured?, evidence?}')],
  ['PATCH', '/assertions/{id}', tr('修改斷言（內容變化會降級並需重新驗證）')],
  ['POST', '/relations', tr('新增關係 {from, type, to, evidence?}')],
  ['POST', '/batch', tr('批量提交（單次提交，推薦）')],
  ['POST', '/items/{id}/evidence', tr('補充證據 L2 → L1')],
  ['POST', '/validate/{id}', tr('用校驗 Action 驗證（通過 → L0，不符 → L1，客體不存在 → 下線）')],
  ['GET', '/action-executions/{id}', tr('RPA 校驗是異步的：POST /validate 返回 202 和 executionId，輪詢這裡到 terminal 為 true；只有 verdict 為 pass 才寫回，「無法判定」不改有效性')],
  ['POST', '/conflicts', tr('登記衝突 {a, b, note}：雙方降為 L1 並通知負責人')],
  ['POST', '/feedback', tr('反饋知識有誤 {targetId, comment}')],
  ['GET', '/gaps', tr('知識缺口（智能體回答「未收錄」的問題），可據此補充知識')],
  ['GET', '/queue', tr('重驗隊列')]
])}

### ${tr('示例：批量提交')}
\`\`\`json
POST ${api}/batch
{
  "message": "冷啟動：庫存域可售庫存",
  "items": [
    {"op": "object.create", "ref": "doc", "data": {"name": "《庫存口徑定義 v3》", "category": "制度", "kind": "口徑定義", "locator": "https://wiki.example/inventory/metrics-v3"}},
    {"op": "object.create", "ref": "field", "data": {"name": "表字段 sku_stock.available_qty", "category": "數字", "kind": "表字段", "locator": "inventory.sku_stock.available_qty"}},
    {"op": "subject.create", "ref": "atp", "data": {"name": "可售庫存", "type": "指標", "domain": "INV", "definition": "當前可被下單佔用的庫存數量，不含已預佔和凍結部分", "owner": "庫存域架構師"}},
    {"op": "binding.create", "data": {"subjectId": "$ref:atp", "objectId": "$ref:doc"}},
    {"op": "binding.create", "data": {"subjectId": "$ref:atp", "objectId": "$ref:field"}},
    {"op": "assertion.create", "data": {"subjectId": "$ref:atp", "type": "定義", "content": "可售庫存 = 實物庫存 − 已預佔 − 凍結 − 安全庫存", "evidence": {"objectIds": ["$ref:doc"]}}},
    {"op": "assertion.create", "data": {"subjectId": "$ref:atp", "type": "約束", "content": "計算結果為負時，對外按 0 展示", "evidence": {"sourceRef": "https://wiki.example/inventory/edge-cases"}}},
    {"op": "subject.create", "data": {"name": "ATP", "type": "別名", "domain": "INV", "aliasOf": ["$ref:atp"]}},
    {"op": "subject.create", "ref": "center", "data": {"name": "庫存中心", "type": "系統", "domain": "INV", "definition": "庫存數據的權威系統"}},
    {"op": "relation.create", "data": {"from": "$ref:center", "type": "擁有", "to": "$ref:atp", "evidence": {"objectIds": ["$ref:field"]}}}
  ]
}
\`\`\`
${tr('支持的 op：{ops}。整批在一個事務中執行：任何一條違反規則，整批回滾並返回出錯的序號。', { ops: list(BATCH_OPS.map(op => `\`${op}\``)) })}

### ${tr('示例：單條斷言')}
\`\`\`bash
curl -X POST ${api}/subjects/S-INV-0012/assertions \\
  -H "Authorization: Bearer $KNOWLEDGE_API_KEY" -H "Content-Type: application/json" \\
  -d '{"type":"規則","content":"預佔 30 分鐘未支付，自動釋放","structured":{"key":"reserve.ttl","value":"30m"},"evidence":{"objectIds":["O-0004"]}}'
\`\`\`
${tr('回應：{example}', { example: '`{"data": {"id": "A-0005", "validity": {"level": "L1", ...}}, "commit": "a1b2c3d", "warnings": []}`' })}

### ${tr('錯誤')}
${tr('錯誤回應為 {format}。常見 code：{codes}。按 message 修正後重試，不要繞過規則。', { format: '`{"error": {"code": "...", "message": "..."}}`', codes: list(['duplicate_name', 'relation_direction', 'alias_rule', 'unknown_object', 'agent_cannot_promote', 'single_owner'].map(c => `\`${c}\``)) })}
${tr('錯誤訊息按請求語言返回：`?lang=zh-TW|zh-CN|en` 或 `Accept-Language` 標頭。')}
`;

  const consumerApi = `## ${tr('{n}. 消費型 API（獲取知識）', { n: role === 'consumer' ? 2 : 4 })}

${tr('所有請求帶 `Authorization: Bearer <API 金鑰>`（consumer、contributor、owner 角色均可）。')}

${table([tr('方法'), tr('路徑'), tr('用途')], [
  ['POST', '/ask', tr('問答：{question, subjectIds?, inputs?, compose?: auto|llm|template}。返回自然語言答案 + 引用 + 結構化知識卡')],
  ['GET', '/resolve?text=', tr('術語解析')],
  ['GET', '/subjects/{id}', tr('結構化知識卡')],
  ['GET', '/subjects/{id}/context', tr('知識卡 + 一跳鄰居主體摘要（供 RAG 使用）')],
  ['GET', '/graph?focus=&depth=', tr('圖譜子圖')],
  ['POST', '/actions/{id}/invoke', tr('調用取值 Action 獲取實時動態值 {inputs}')],
  ['POST', '/feedback', tr('用戶指出回答有誤時提交反饋 {targetId, comment, question?}')]
])}

${tr('`/ask` 的 `status`：`answered`（已回答，見 citations 中每條依據的層級）、`ambiguous`（別名多義，必須先向用戶確認，再帶 subjectIds 重問）、`need_inputs`（動態值缺少參數）、`uncovered`（知識庫未收錄，已記為知識缺口）。')}

### ${tr('智能體使用規約（回答時必須遵守）')}
1. ${tr('解析術語：把問題中的詞通過別名解析為規範主體；遇到多義別名先消歧或向用戶確認。')}
2. ${tr('判斷是否動態值：庫存數量、訂單狀態等動態值調用取值 Action，不使用任何存儲值。')}
3. ${tr('按層級作答：L0 直接作為依據；L1 必須標註未驗證；L2 只用於拓展思路，不作結論；E1 不得作為依據，命中時說明已失效並給出替代者。')}
4. ${tr('引用：在回答中標註所依據的主體 ID、斷言 ID 和層級。')}
5. ${tr('未收錄就說未收錄：知識庫沒有相關知識時回答「知識庫未收錄」，不得用行業通用知識補全。')}
6. ${tr('接收反饋：用戶指出回答有誤時，調用 `POST /feedback`，觸發降級和重驗。')}
`;

  const header = `# ${role === 'consumer' ? tr('供應鏈技術知識庫：智能體消費教程') : tr('供應鏈技術知識庫：智能體知識生產教程')}

${tr('你正在連接一個**私有供應鏈技術系統**的知識庫（訂單、庫存、倉儲、運輸、計劃補貨等自有系統的規則、口徑、數據與依賴）。這些知識**不同於公開的行業做法**，不要用行業常識推測自有系統的行為。')}

- ${tr('API 根地址：{url}', { url: `\`${api}\`` })}
- ${tr('機器可讀定義：{links}', { links: `\`GET ${api}/schema\`${tr('、')}\`GET ${api}/openapi.json\`` })}
- ${tr('當前規模：{subjects} 個主體、{assertions} 條斷言、{relations} 條關係、{objects} 個客體', h.totals)}
- ${tr('待補充的知識缺口：{n} 個（{link}）', { n: h.uncoveredQueries.openGaps, link: `\`GET ${api}/gaps\`` })}
`;

  const body = role === 'consumer' ? [header, concepts, consumerApi] : [header, concepts, producerRules, producerApi, consumerApi];
  return body.join('\n');
}

const BATCH_OPS = ['subject.create', 'subject.update', 'object.create', 'object.update', 'binding.create', 'assertion.create', 'assertion.update', 'relation.create', 'evidence.add', 'conflict.create', 'feedback.create'];

/** 機器可讀的類型定義。結構與枚舉值不隨語言變化；desc、example、direction 等說明文字按請求語言返回，label 是枚舉值的譯名。 */
export function buildSchema(store) {
  const map = (obj, fn) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v, k)]));
  return {
    locale: currentLocale(),
    note: tr('枚舉值（各類型的鍵、kinds、from/to）是 API 的值，任何語言下都原樣使用；label 只用於顯示。'),
    subjectTypes: map(SUBJECT_TYPES, (v, k) => ({ ...v, label: tr(k), desc: tr(v.desc), example: tr(v.example) })),
    objectCategories: map(OBJECT_CATEGORIES, (v, k) => ({ ...v, label: tr(k), desc: tr(v.desc), kindLabels: Object.fromEntries(v.kinds.map(x => [x, tr(x)])) })),
    assertionTypes: map(ASSERTION_TYPES, v => tr(v)),
    relationTypes: map(RELATION_TYPES, (v, k) => ({ ...v, label: tr(`rel|${k}`), direction: tr(v.direction), example: tr(v.example) })),
    levels: map(LEVEL_INFO, v => ({ name: tr(v.name), condition: tr(v.condition), usage: tr(v.usage) })),
    actionKinds: map(ACTION_KINDS, v => tr(v)),
    domains: store.config.domains.map(d => ({ ...d, label: tr(d.name) })),
    expiryDays: store.config.expiryDays,
    writeCaps: {
      humanOrAgentWithEvidence: 'L1',
      humanOrAgentWithoutEvidence: 'L2',
      directL0: tr('禁止；只能 Action 校驗或負責人確認'),
      registeredPipeline: tr('按管道校驗結果直接定級'),
      e1Submission: tr('允許，必須提供 invalidReason')
    },
    batchOps: BATCH_OPS
  };
}
