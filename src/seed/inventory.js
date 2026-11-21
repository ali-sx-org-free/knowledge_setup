// 庫存域示例資料：設計文件「示例：可售庫存」的完整演示。系統名、表名、接口名與數值均為示意。
// 走真實流程：先以人身份提交（寫入上限 L1/L2），再由 Action 校驗（→ L0 自動）與負責人確認（→ L0 人工）晉升。
import { RuleError } from '../store/validity.js';
import { docMessages } from '../store/docs.js';

const SUBJECTS = [
  ['inv-center', '庫存中心', '系統', 'INV', '管理全渠道庫存數量與預佔的權威系統；不負責倉內作業'],
  ['alloc-svc', '分倉服務', '系統', 'INV', '為訂單選擇發貨倉的服務；不直接修改庫存'],
  ['sku', 'SKU', '業務對象', 'INV', '最小庫存管理單元，一個 SKU 對應一個可售規格'],
  ['stock', '庫存', '業務對象', 'INV', '某 SKU 在某倉庫的庫存記錄'],
  ['transfer', '調撥單', '業務對象', 'INV', '在倉庫之間移動庫存的單據'],
  ['stock-doc', '庫存單據', '業務對象', 'INV', '所有引起庫存變化的單據的統稱'],
  ['physical', '實物庫存', '指標', 'INV', '倉庫中實際存在的庫存數量，含已預佔和凍結部分'],
  ['reserved', '已預佔庫存', '指標', 'INV', '已被訂單佔用、尚未出庫的庫存數量'],
  ['frozen', '凍結庫存', '指標', 'INV', '因質檢、盤點等原因暫不可用的庫存數量'],
  ['safety', '安全庫存', '指標', 'INV', '為應對波動保留、不對外售賣的庫存數量'],
  ['reserve-rule', '庫存預佔規則', '規則', 'INV', '下單時佔用可售庫存、超時釋放的規則'],
  ['atp', '可售庫存', '指標', 'INV', '當前可被下單佔用的庫存數量，不含已預佔和凍結部分'],
  ['phys-avail', '實物可用庫存', '指標', 'INV', '倉內可立即揀貨的實物數量，不含凍結部分；不扣減訂單預佔'],
  ['alloc-rule', '分倉規則', '規則', 'INV', '決定訂單由哪個倉庫發貨的策略'],
  ['oos-rate', '缺貨率', '指標', 'INV', '可售庫存為 0 的 SKU 佔在售 SKU 的比例'],
  ['order-center', '訂單中心', '系統', 'ORD', '接收並管理銷售訂單生命週期的系統'],
  ['sales-order', '銷售訂單', '業務對象', 'ORD', '客戶下單後生成的訂單'],
  ['fulfil', '訂單履約', '流程', 'ORD', '從訂單確認到妥投的跨系統過程'],
  ['alloc', '分倉', '流程', 'ORD', '為訂單選定發貨倉的步驟'],
  ['wms', 'WMS', '系統', 'WMS', '倉庫管理系統，負責倉內作業'],
  ['outbound', '出庫流程', '流程', 'WMS', '從接收出庫指令到貨物離倉的倉內流程'],
  ['pick', '揀貨', '流程', 'WMS', '按出庫指令從庫位取出貨品的步驟'],
  ['outbound-cmd', '出庫指令', '業務對象', 'WMS', '下發給倉庫的出庫作業指令'],
  ['putaway', '入庫上架', '流程', 'WMS', '貨品到倉後驗收並放入庫位的步驟']
];

export async function seedInventory(ctx, principal) {
  const store = ctx.store;
  if ([...store.subjects.values()].some(s => s.name === '可售庫存')) throw new RuleError('示例資料已存在（主體「可售庫存」已登記）', 409, 'already_seeded');
  const ids = {};

  // 1. 動力層：管道與 Action（示意管道，不連真實系統）
  const { result: dyn } = await store.tx(principal, '[示例] 動力層：示意管道與 Action', t => {
    const gw = store.upsertPipeline(t, {
      name: 'API 網關（示意）', type: 'mock', description: '示意管道：模擬庫存查詢接口。接入真實 API 網關時改為 http 類型並配置 baseUrl。',
      routes: [{ method: 'GET', path: '/inventory/v1/availability', status: 200, body: { sku: '{query.sku}', warehouse: '{query.warehouse}', available_qty: '{rand:0:500}', unit: '件', source: 'mock' } }]
    }, principal);
    const meta = store.upsertPipeline(t, {
      name: '業務數據庫元數據（示意）', type: 'mock', description: '示意管道：模擬讀取表結構，校驗字段是否存在。',
      routes: [{ method: 'GET', path: '/schema/inventory.sku_stock.available_qty', status: 200, body: { exists: true, type: 'decimal(18,2)' } }]
    }, principal);
    const cfg = store.upsertPipeline(t, {
      name: '配置中心（示意）', type: 'mock', description: '示意管道：模擬讀取配置項當前值。',
      routes: [{ method: 'GET', path: '/config/reserve.ttl', status: 200, body: { key: 'reserve.ttl', value: '30m' } }]
    }, principal);
    const vField = store.upsertAction(t, { name: '校驗表字段存在', kind: '校驗', pipelineId: meta.id, objectKinds: ['表字段'], request: { method: 'GET', path: '/schema/{object.locator}' }, check: { mode: 'exists' }, description: '讀取表結構，確認字段仍存在' }, principal);
    const vApi = store.upsertAction(t, { name: '校驗接口可調用', kind: '校驗', pipelineId: gw.id, objectKinds: ['API'], request: { method: 'GET', path: '{object.locator}', query: { sku: 'SKU-PROBE', warehouse: 'PROBE' } }, check: { mode: 'exists' }, description: '探測接口可正常返回' }, principal);
    const vCfg = store.upsertAction(t, { name: '校驗配置項取值', kind: '校驗', pipelineId: cfg.id, objectKinds: ['配置項'], request: { method: 'GET', path: '/config/{object.locator}' }, output: { path: 'value' }, check: { mode: 'equals' }, description: '讀取配置項，確認與斷言的結構化值一致' }, principal);
    const fAtp = store.upsertAction(t, {
      name: '查詢可售庫存（SKU，倉庫）', kind: '取值', pipelineId: gw.id, objectKinds: ['API'],
      request: { method: 'GET', path: '/inventory/v1/availability', query: { sku: '{input.sku}', warehouse: '{input.warehouse}' } },
      inputs: [{ name: 'sku', label: 'SKU', required: true, pattern: 'SKU-\\d+' }, { name: 'warehouse', label: '倉庫', required: true, fromObjects: '物理' }],
      output: { path: 'available_qty', unit: '件', label: '可售庫存' }, permission: 'consumer', description: '經 API 網關實時查詢某 SKU 在某倉的可售庫存'
    }, principal);
    return { vField: vField.id, vApi: vApi.id, vCfg: vCfg.id, fAtp: fAtp.id };
  });

  // 2. 客體、主體、綁定、斷言、關係（以人身份提交：有證據 L1，無證據 L2）
  const { result: made } = await store.tx(principal, '[示例] 庫存域：主體、客體、斷言與關係', t => {
    const o = {};
    o.doc = store.createObject(t, { name: '《庫存口徑定義 v3》', category: '制度', kind: '口徑定義', locator: 'wiki://inventory/metrics/v3', description: '庫存相關指標的統一口徑' }, principal).id;
    o.field = store.createObject(t, { name: '表字段 inventory.sku_stock.available_qty', category: '數字', kind: '表字段', locator: 'inventory.sku_stock.available_qty', actionIds: [dyn.vField] }, principal).id;
    o.api = store.createObject(t, { name: '接口 GET /inventory/v1/availability', category: '數字', kind: 'API', locator: '/inventory/v1/availability', actionIds: [dyn.vApi, dyn.fAtp] }, principal).id;
    o.ttl = store.createObject(t, { name: '配置項 reserve.ttl', category: '數字', kind: '配置項', locator: 'reserve.ttl', actionIds: [dyn.vCfg] }, principal).id;
    o.sh01 = store.createObject(t, { name: '上海一號倉', category: '物理', kind: '倉庫', locator: 'SH01' }, principal).id;
    o.bj01 = store.createObject(t, { name: '北京一號倉', category: '物理', kind: '倉庫', locator: 'BJ01' }, principal).id;
    o.repo = store.createObject(t, { name: '代碼模塊 inventory-center', category: '數字', kind: '代碼模塊', locator: 'git://inventory/inventory-center' }, principal).id;
    o.trace = store.createObject(t, { name: '調用鏈追蹤：allocation → inventory', category: '數字', kind: '監控指標', locator: 'apm://trace/allocation-service/inventory-center' }, principal).id;

    for (const [key, name, type, domain, definition] of SUBJECTS) ids[key] = store.createSubject(t, { name, type, domain, definition, owner: domain === 'INV' ? '庫存域架構師' : domain === 'ORD' ? '訂單域架構師' : '倉儲域架構師', errorCost: key === 'atp' ? 5 : 3 }, principal).id;
    ids.aliasAtp = store.createSubject(t, { name: 'ATP', type: '別名', domain: 'INV', aliasOf: [ids.atp], evidence: { objectIds: [o.doc] } }, principal).id;
    ids.aliasAvail = store.createSubject(t, { name: '可用庫存', type: '別名', domain: 'INV', aliasOf: [ids.atp, ids['phys-avail']], evidence: { objectIds: [o.doc] } }, principal).id;

    const b = {};
    b.doc = store.createBinding(t, ids.atp, { objectId: o.doc }, principal).id;
    b.field = store.createBinding(t, ids.atp, { objectId: o.field }, principal).id;
    b.api = store.createBinding(t, ids.atp, { objectId: o.api }, principal).id;
    store.createBinding(t, ids['inv-center'], { objectId: o.repo }, principal);
    store.createBinding(t, ids.physical, { objectId: o.doc }, principal);
    store.createBinding(t, ids['reserve-rule'], { objectId: o.ttl }, principal);

    const a = {};
    a.def = store.createAssertion(t, ids.atp, { type: '定義', content: '可售庫存 = 實物庫存 − 已預佔 − 凍結 − 安全庫存', evidence: { objectIds: [o.doc] } }, principal).id;
    a.ttl = store.createAssertion(t, ids.atp, { type: '規則', content: '預佔 30 分鐘未支付，自動釋放', structured: { key: 'reserve.ttl', value: '30m' }, evidence: { objectIds: [o.ttl] } }, principal).id;
    a.neg = store.createAssertion(t, ids.atp, { type: '約束', content: '計算結果為負時，對外按 0 展示', evidence: { sourceRef: 'wiki://inventory/edge-cases#negative' } }, principal).id;
    a.old = store.createAssertion(t, ids.atp, { type: '定義', content: '可售庫存 = 實物庫存 − 已預佔 − 凍結，不扣安全庫存', level: 'E1', invalidReason: '《庫存口徑定義 v3》起扣減安全庫存，舊口徑作廢', replacedBy: a.def, evidence: { objectIds: [o.doc] } }, principal).id;
    a.refresh = store.createAssertion(t, ids.atp, { type: '屬性', content: '刷新方式：事件驅動，準實時', evidence: { objectIds: [o.api] } }, principal).id;
    store.createAssertion(t, ids['reserve-rule'], { type: '規則', content: '下單時按 SKU + 倉庫預佔可售庫存', evidence: { objectIds: [o.ttl] } }, principal);
    store.createAssertion(t, ids.physical, { type: '定義', content: '實物庫存 = 倉庫中實際存在的庫存數量，含已預佔和凍結部分', evidence: { objectIds: [o.doc] } }, principal);
    store.createAssertion(t, ids.safety, { type: '約束', content: '安全庫存不參與對外售賣', evidence: { objectIds: [o.doc] } }, principal);
    store.createAssertion(t, ids['alloc-rule'], { type: '規則', content: '優先選擇距離收貨地址最近且可售庫存充足的倉庫' }, principal);

    const rel = (from, type, to, evidence) => store.createRelation(t, { from: ids[from], type, to: ids[to], evidence }, principal).id;
    const r = {};
    r.own = rel('inv-center', '擁有', 'atp', { objectIds: [o.api] });
    r.calc = rel('atp', '計算自', 'physical', { objectIds: [o.doc] });
    r.constrain = rel('reserve-rule', '約束', 'atp', { objectIds: [o.ttl] });
    rel('alloc-svc', '依賴', 'inv-center', { objectIds: [o.trace] });
    rel('inv-center', '擁有', 'physical', { objectIds: [o.repo] });
    rel('atp', '計算自', 'reserved', { objectIds: [o.doc] });
    rel('atp', '計算自', 'frozen', { objectIds: [o.doc] });
    rel('atp', '計算自', 'safety', { objectIds: [o.doc] });
    rel('transfer', '是一種', 'stock-doc', { sourceRef: 'wiki://inventory/documents' });
    rel('pick', '組成', 'outbound', { sourceRef: 'wiki://wms/outbound-sop' });
    rel('alloc', '後續', 'outbound', { sourceRef: 'wiki://ord/fulfilment' });
    rel('alloc', '組成', 'fulfil', { sourceRef: 'wiki://ord/fulfilment' });
    rel('order-center', '產出', 'sales-order', { sourceRef: 'wiki://ord/order-center' });
    rel('wms', '消費', 'outbound-cmd', { sourceRef: 'wiki://wms/outbound-sop' });
    rel('fulfil', '消費', 'sales-order', undefined);
    rel('alloc-rule', '約束', 'fulfil', undefined);
    rel('oos-rate', '計算自', 'atp', undefined);
    rel('alloc-svc', '依賴', 'order-center', undefined);
    return { o, b, a, r };
  });

  // 3. Action 校驗（→ L0 自動）
  for (const id of [made.b.field, made.b.api, made.a.ttl]) await ctx.actions.validateItem(id, principal);

  // 4. 負責人確認（→ L0 人工）
  await store.tx(principal, '[示例] 負責人確認高頻、高風險知識', t => {
    for (const id of [made.b.doc, made.a.def, made.r.own, made.r.calc, made.r.constrain]) store.confirm(t, id, { note: '示例資料：負責人確認' }, principal);
    for (const rid of [...store.relations.values()].filter(x => x.type === '別名').map(x => x.id)) store.confirm(t, rid, { note: '示例資料：別名確認' }, principal);
  });

  // 5. 文檔庫：初始文件夾與標籤；DOC-0001 接管 O-0001（從 v3 起算，v4 小修）；SOP 草稿 DOC-0002；《知識庫寫作指南》DOC-0003
  const docs = await seedDocuments(store, principal, ids, made);

  return { subjects: Object.keys(ids).length, focus: ids.atp, ids, docs };
}

const FOLDERS = [
  { path: '庫存', domain: 'INV', description: '庫存域：可售庫存、預佔、調撥等' },
  { path: '庫存/口徑', defaultTemplate: 'TPL-0004', defaultTags: ['口徑'], description: '庫存指標的計算口徑' },
  { path: '庫存/SOP', defaultTemplate: 'TPL-0003', defaultTags: ['SOP'], description: '庫存相關的標準作業程序' },
  { path: '訂單', domain: 'ORD', description: '訂單域：訂單、履約、分倉' },
  { path: '倉儲', domain: 'WMS', description: '倉儲域：倉內作業' },
  { path: '運輸', domain: 'TMS', description: '運輸域：承運與配送' },
  { path: '計劃補貨', domain: 'PLN', description: '計劃與補貨' }
];
const TAGS = { 口徑: { group: '主題', color: 'blue', description: '指標的計算口徑' }, 對外: { group: '受眾', color: 'green', description: '可以給業務方和外部系統看的文檔' }, SOP: { group: '類型', color: 'amber', description: '標準作業程序' }, 指南: { group: '類型', color: 'purple', description: '寫作與使用指南' } };

async function seedDocuments(store, principal, ids, made) {
  const lib = store.docs;
  await store.tx(principal, '[示例] 文檔庫：初始文件夾與標籤', t => {
    for (const f of FOLDERS) if (!lib.findFolder(f.path)) lib.createFolder(t, f, principal);
    for (const [name, info] of Object.entries(TAGS)) lib.updateTag(t, name, info, principal);
  });

  // DOC-0001：接管原來登記在 wiki 上的《庫存口徑定義 v3》（O-0001），版本從 v3 起算
  const S = ids;
  const v3 = `## 定義

[[${S.atp}]] 指可被下單佔用的庫存數量：不含已預佔和凍結部分，也不含 [[${S.safety}]]。它是對外承諾能賣多少的唯一依據。

## 計算公式

本口徑下，可售庫存（ATP）按 SKU + 倉庫計算：

\`\`\`
可售庫存 = 實物庫存 − 已預佔 − 凍結 − 安全庫存
\`\`\`

- [[${S.physical}]]：倉庫中實際存在的數量，含已預佔和凍結部分
- [[${S.reserved}]]：已被訂單佔用、尚未出庫的數量
- [[${S.frozen}]]：因質檢、盤點等原因暫不可用的數量
- [[${S.safety}]]：為應對波動保留、不對外售賣的數量

## 數據來源

| 項目 | 權威來源 | 說明 |
| --- | --- | --- |
| 實物庫存 | [[${made.o.field}]] | [[${S['inv-center']}]] 按 SKU + 倉庫維護 |
| 可售庫存 | [[${made.o.api}]] | 動態值：經取值 Action 實時讀取，文檔中不寫具體數字 |

## 邊界情況

- 計算結果為負時，對外按 0 展示（見 [[${made.a.neg}]]）。
- 在途調撥的數量不計入任何一倉的可售庫存。

## 示例

SKU-123 在上海一號倉：實物 120、已預佔 30、凍結 5、安全庫存 10，可售庫存為 75。數字僅為示意。

## 變更說明

v3 起扣減安全庫存，舊口徑 [[${made.a.old}]] 作廢。
`;
  const v4 = v3.replace('SKU-123 在上海一號倉：實物 120、已預佔 30、凍結 5、安全庫存 10，可售庫存為 75。數字僅為示意。', `SKU-123 在上海一號倉：實物 120、已預佔 30、凍結 5、安全庫存 10，可售庫存為 75。數字僅為示意。

跨倉調撥：上海一號倉調往北京一號倉的 20 件，出庫後到上架前為在途，兩個倉都不計入；在北京一號倉上架後才計入北京一號倉的可售庫存。`).replace('v3 起扣減安全庫存，舊口徑', 'v4 補充跨倉調撥示例。v3 起扣減安全庫存，舊口徑');
  const { result: d1 } = await store.tx(principal, docMessages.create, t => lib.create(t, {
    template: 'TPL-0004', title: '庫存口徑定義', folder: '庫存/口徑', owner: '庫存域架構師',
    summary: '可售庫存、實物庫存、安全庫存等庫存指標的統一計算口徑；自 v3 起可售庫存扣減安全庫存。',
    tags: ['口徑', '對外'], subjects: [S.atp, S.physical, S.safety, S.reserved, S.frozen],
    fields: { metric: S.atp, ownerSystem: S['inv-center'], effectiveFrom: '2026-06-01', scope: '全渠道' },
    takeOverObjectId: made.o.doc, startVersion: 3, body: v3
  }, principal));
  await store.tx(principal, docMessages.publish, t => lib.publish(t, d1.id, { note: `從 wiki 接管《庫存口徑定義 v3》（${made.o.doc}）` }, principal));
  await store.tx(principal, docMessages.save, t => lib.saveDraft(t, d1.id, { etag: lib.get(d1.id).pub.etag, body: v4 }, principal));
  await store.tx(principal, docMessages.publish, t => lib.publish(t, d1.id, { major: false, note: '補充跨倉調撥示例' }, principal));

  // DOC-0002：SOP 草稿，還差異常處理（體檢會提示）
  const { result: d2 } = await store.tx(principal, docMessages.create, t => lib.create(t, {
    template: 'TPL-0003', title: '跨倉調撥作業 SOP', folder: '庫存/SOP', owner: '倉儲域架構師',
    summary: '庫存在倉庫之間調撥時，從建單、出庫、在途到入庫上架的作業步驟與異常處理。',
    tags: ['SOP'], subjects: [S.transfer],
    fields: { process: S.outbound, roles: '庫存計劃員、倉庫主管、揀貨員', effectiveFrom: '2026-12-01' },
    body: `## 目的

保證調撥期間 [[${S.atp}]] 準確：在途數量不被重複售賣，到倉後及時可售。

## 適用範圍

全部自營倉之間的 [[${S.transfer}]]。不適用於供應商直送和退貨入庫。

## 角色與職責

- 庫存計劃員：建調撥單，確認調出倉的可售庫存足夠
- 倉庫主管：審核調撥單，安排出庫和收貨
- 揀貨員：按出庫指令揀貨

## 操作步驟

1. 庫存計劃員在庫存中心建調撥單，選擇調出倉、調入倉和 SKU 數量。
2. 倉庫主管審核；審核通過後系統下發 [[${S['outbound-cmd']}]]。
3. 調出倉按 [[${S.outbound}]] 揀貨出庫；出庫後數量轉為在途。
4. 調入倉收貨驗收後按 [[${S.putaway}]] 上架；上架完成後計入調入倉可售庫存。

## 異常處理

<!-- 提示：常見異常、處理方式和升級對象 -->

`
  }, principal));

  // DOC-0003：《知識庫寫作指南》，知識條目，貢獻者可直接發布
  const { result: d3 } = await store.tx(principal, docMessages.create, t => lib.create(t, {
    template: 'TPL-0001', title: '知識庫寫作指南', folder: '通用', owner: '知識庫管理員',
    summary: '什麼時候寫斷言、什麼時候寫文檔，以及怎樣寫出智能體和人都能準確引用的文檔。',
    tags: ['指南'],
    body: `## 概述

一句話能說清、要單獨驗證的知識寫成斷言；需要背景、步驟和上下文的寫成文檔。文檔發布後登記為制度客體，可以作為主體的依據和斷言的證據。

## 詳細說明

- **分章節**：用 \`##\` 和 \`###\` 分章節。檢索和智能體按章節切分、按章節引用，例如 〔${d1.id}§計算公式·v4〕。
- **用引用代替複述**：講到已登記的主體、知識或其他文檔時寫 \`[[ID]]\`，例如 [[${S.atp}]]、[[${d1.id}#計算公式]]。被引用的知識失效時，體檢會提醒你更新。
- **動態值不寫數字**：庫存數量、單據狀態這類會變的值，寫明以哪個系統為準、怎麼取，不寫具體數字。
- **寫明日期**：不寫「最近」「目前」，寫成具體日期，日後才讀得懂。
- **不放機密**：金鑰、密碼、權杖不進知識倉庫；疑似機密的內容會被拒絕保存。

## 示例

口徑定義的寫法可以參考 [[${d1.id}]]：定義、計算公式、數據來源分節，涉及的指標都用 [[S-…]] 引用。

## 常見問題

**修訂已發布的文檔會影響知識嗎？** 小修不影響；重大修訂時，發布者勾選的知識降為 L1 並排入重驗。

**智能體能發布文檔嗎？** 不能。智能體可以建草稿、按體檢結果修改、提交審閱，由人發布。

## 相關知識

- [[${d1.id}]]
`
  }, principal));
  await store.tx(principal, docMessages.publish, t => lib.publish(t, d3.id, { note: '第一版' }, principal));
  return { [d1.id]: '庫存口徑定義', [d2.id]: '跨倉調撥作業 SOP', [d3.id]: '知識庫寫作指南' };
}
