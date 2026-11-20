# 知識庫接入 RPA：把可運行場景註冊為管道與 Action

設計稿 v1 · 2026-11-20 · **狀態：已確認，第一期已實作**（2026-11-20 使用者選擇「開工，RPA 也加版本參數」；實作與本文的差異見 §17）

本文分兩部分：第一部分評審《知識庫-RPA 管道與 Action 接入方案》草稿（以下稱「草稿」），逐條對照兩個倉庫的程式碼；第二部分是修訂後的設計，可直接作為實作依據。首個用例沿用草稿：在客體 `O-0001`（`adb_wdk_scm_dpartner.replenish_order`）上，從主體 `S-PLN-0001` 的綁定 `B-0001` 發起「校驗生產表是否存在」。

核對所依據的版本：

| 倉庫 | 版本 |
| --- | --- |
| 知識庫 `ali-sx-org-free/knowledge_setup` | `main` @ `abf1531` |
| RPA `ali-sx-org-free/web_browser_robotic_process_automation` | `main` @ `dd7aa43`（v0.10.0） |

開發環境連不到內網的知識庫（`:28080`）與 RPA 伺服器（`:8081`），以下結論全部來自程式碼與倉庫內的設計文件，沒有對真實伺服器做過調用。

---

## 第一部分：草稿評審

### 1. 結論

草稿的主幹可以用，大部分保留：

- 三層配置（管道、Action、客體與綁定）。
- 校驗異步化：受理後返回 202，後台輪詢 RPA，服務重啟後能接著等。
- 一次知識庫執行對應一個穩定的 RPA 冪等鍵。
- 「執行狀態」與「業務結論」分開記錄。
- 首期只做正向確認，不從失敗推斷「表不存在」。
- 單次 HTTP 超時與整次作業期限分開配置。
- 先打通存在性校驗，取值、內容比對、定期複驗放第二期。

需要改的有十處，最重要的五處：

1. **授權邊界以 RPA 的 API 用戶端為準。** 允許的場景範圍、Worker、排隊上限都已經是 RPA API 用戶端的設定。知識庫的管道不應再保存一份，否則兩邊會不一致。
2. **補一份「可註冊場景規範」。** 註冊要做到便捷和規範，前提是場景的出參有約定。有了規範，知識庫才能從場景自動生成 Action 草稿，而不是每接一個場景都手工配置。
3. **版本鎖定可以做得比草稿更實。** RPA 在排入運行時就定下版本，202 回應裡的 `revision` 就是這次實際要跑的版本，結束後的 `scenarioHash` 可以和版本的 `contentHash` 比對。另外建議 RPA 加一個約 10 行的 `expectedRevision` 參數，讓「只跑審過的版本」在 RPA 端原子成立。
4. **執行記錄不進 Git。** 知識庫沒有資料庫，每次寫入都是一次 Git 提交。執行過程放在 `DATA_DIR`，只有最終的有效性寫回和證據摘要進知識倉庫。
5. **先修知識庫現有的兩個漏洞。** 一是指定 Action 校驗時，不檢查 Action 是否掛在該客體上、也不檢查 Action 的調用權限。二是定期校驗會把 RPA Action 自動帶進同步循環。

### 2. 逐條核對

#### 2.1 RPA 側

| 草稿說法 | 核對結果 | 依據 |
| --- | --- | --- |
| 正式執行用 `POST /scenes/{scene_id}/runs`，返回 202 和運行 ID；用 `GET /runs/{run_id}` 查詢終態與輸出 | **屬實**。實際路徑前綴是 `/agent-api/v1`，在伺服器的對外埠（預設 8081）。202 回應就是完整的運行 JSON（含 `id`、`revision`、`status`）。`GET /runs/{id}` 結束後另帶 `result`（含 `stages`、`checks`、`output`） | `apps/server/src/rpa_server/agent_api.py:1021`、`:1158` |
| 正式運行端點跑當前發布版本，`RunBody` 只有 `inputs`、`workerId`、`idempotencyKey`，沒有版本參數 | **屬實，但不完整**。`RunBody` 還有 `engine`、`baseUrl`、`headless`、`target`。其中 `baseUrl` 能覆寫場景要訪問的目標系統地址，知識庫**絕不能**把它開放給調用者 | `agent_api.py:153` |
| 不能鎖定版本，啟動前後比對只能防止錯誤回寫 | **方向正確，可以更強**。版本在排隊時就確定了（`number = scene.published_number`），202 回應的 `revision` 即本次要跑的版本，發現不符可以立刻取消（排隊中的運行會直接取消）。結束後的 `scenarioHash` 可與該版本的 `contentHash` 比對。要做到「未審版本根本不會被執行」，需要 RPA 加 `expectedRevision`（見第二部分 §11） | `services.py:1629-1632`、`domain.py:365,375`、`services.py:2049` |
| 「實際版本/哈希（如平台返回）」 | 平台**一定返回**：運行 JSON 有 `revision` 與 `scenarioHash`，版本 JSON 有 `contentHash` | `domain.py:263,365,375` |
| 冪等鍵；提交結果不明時先查已有運行，再決定是否以原鍵重試 | **屬實，且可簡化**。冪等鍵按 API 用戶端加鹽，資料庫有唯一約束，併發衝突時返回已有運行。同一個鍵不論舊運行是否已結束，都返回原運行。所以提交結果不明時**直接用原鍵重試**即可，不必先查。反過來，「重新校驗」必須換新鍵，否則拿回的是舊運行 | `agent_api.py:481,496`、`services.py:1619-1623,1680-1687`、`models.py:167` |
| 終態為 `passed` 且獨立斷言通過 | `passed` **已經包含**獨立斷言和出參校驗通過（ADR 0009：入參校驗 → 自動化 → 獨立斷言 → 出參校驗，全部通過才產生出參）。不需要另判斷言，`result.checks` 可以作為證據摘要保存 | `docs/adr/0009-scenario-contract.html` |
| 場景目錄能顯示需要的登入角色、入參、出參 | **部分屬實**。`GET /scenes/{id}` 的 `needs`（登入角色、Secrets）算的是**最新版**，不是發布版。入參、出參沒有結構化端點，要讀 `GET /scenes/{id}/revisions/{n}` 的 `scenario.yaml`，或讀 `GET /scenes/{id}/sections/{inputs\|outputs}?revision=n` 的 YAML 片段。知識庫應解析**已發布版本**的 `scenario.yaml` | `agent_api.py:720-740,768-778` |
| 管道保存允許的場景和設備範圍 | **重複**。RPA 的 API 用戶端已有權限範圍、可用領域、執行位置、可指定的 Worker、排隊上限、回傳頁面內容開關、到期時間和來源 IP，在 RPA 端強制執行。知識庫只需讀 `GET /meta` 展示和體檢 | ADR 0017、`agent_api.py:562-584` |
| 登入失效時提示角色 | **屬實，且有前置條件草稿沒提到**。運行停在 `needs_login`，`result.role` 是角色。派發前可以用 `GET /roles` 先查登入狀態。M8.1 起，登入角色必須**綁定給 API 用戶端**才能用，否則 403 `login_role_forbidden`。上線前要在 RPA 把 `dev4dms` 綁定給知識庫的用戶端 | ADR 0026、`agent_api.py:611-631` |
| 只開放已審閱的只讀場景 | **RPA 無法自動判定**。DSL 的副作用標記把 `click`、`fill`、`select`、`check`、`press`、`call` 都算作副作用，而查詢場景同樣要填 SQL、點執行。「只讀」只能靠人審閱，再加上 RPA 領域隔離 | `apps/server/src/rpa_server/debugging.py:67` |
| Worker 離線 | 排隊中的運行**沒有排隊期限**，沒有 Worker 時會一直停在 `queued`，只有執行中的運行有租約。知識庫的整體期限到了以後，要取消仍在排隊的運行，否則它會一直佔用 API 用戶端的排隊名額（預設上限 20） | `dispatch.py:807`、`services.py:2041-2053` |
| 等待運行結束 | Webhook 和事件長輪詢是 RPA 的第二期，**尚未實作**，首期只能輪詢。草稿的輪詢設計是對的 | `docs/design/agent-api.html`「運行過程」 |
| 報告、截圖按運行權限限制訪問 | RPA 的「回傳頁面內容」預設關閉，關閉時報告、截圖、錄影回 403，但 `result`（含 `output`、`checks`）照樣可讀。建議知識庫**不代理**報告，只保存 `portalPath` 連結，讓人到 RPA Portal 看，權限由 RPA 管 | `agent_api.py:467-479,1186-1193` |

#### 2.2 知識庫側

| 草稿說法 | 核對結果 | 依據 |
| --- | --- | --- |
| 管道有 HTTP 地址、認證、超時；Action 有校驗、取值兩種；客體可關聯多個 Action | **屬實**。管道類型目前只有 `http`、`mock`，憑證以 `${env:變數}` 引用，寫明文會被拒絕 | `src/store/model.js:61-64`、`src/store/store.js:1077-1110` |
| 管道及 Action 的註冊要求 `owner` | **屬實** | `src/api/v1.js:242-257` |
| 操作者能否執行還要滿足 Action 和客體權限 | **不屬實**。知識庫沒有客體級權限（README「MVP 不做細粒度權限」）。`POST /validate/:id` 只要求 `contributor`，**不檢查** Action 的 `permission`（`canInvoke` 只用在取值）。指定 `actionId` 時只檢查校驗模式，**不檢查** Action 是否掛在該客體上、`objectKinds` 是否匹配。接入 RPA 後，這意味著任何 contributor 都能拿任意一個 exists 型 Action 去校驗任意綁定，本次一併修正 | `src/services/actions.js:91-96,127-136`、`src/api/v1.js:207` |
| 持久化一次執行 | 草稿沒說存哪裡。知識庫沒有資料庫，`store.tx` 的每次寫入都是一次 Git 提交。如果每次狀態變化都提交，Git 歷史會被輪詢刷滿 | `src/store/store.js:229-262` |
| 寫回前核對「Action 配置版本」 | Action 目前沒有版本號，只有 `updatedAt`。改用配置內容的雜湊 | `src/store/store.js:1090-1110` |
| 校驗不存在時按現行失效/下線規則處理 | 現行規則很重：HTTP 404/410 判為 `missing`，客體直接下線，**所有主體**綁定這個客體的綁定都轉 E1，以它為證據的斷言和關係降 L1。由自動化結論觸發這麼大範圍的級聯，風險偏高。RPA 的陰性結論首期不啟用，第二期預設為「降 L1 並等負責人確認下線」 | `src/services/actions.js:144`、`src/store/store.js:939-944,748-770` |
| 定期複驗放第二期 | **現有排程會自動帶上 RPA Action**。`server.js` 每隔 `validationIntervalHours` 對所有可校驗的條目逐條同步 `await validateItem`，只要客體掛了 RPA Action，`findValidateAction` 就會選中它。每次排程都會串行派發 N 個分鐘級的 RPA 運行。首期必須把 RPA Action 排除在 `validateAll` 之外 | `src/server.js:89-96`、`src/services/actions.js:162-175`、`src/store/store.js:1176-1193` |
| 取值複用同一派發與等待流程 | 方向對，但 `/ask` 是在問答請求裡同步 `await` 取值的。分鐘級的 RPA 運行不能放進這條路徑，第二期要讓問答返回「取值進行中」 | `src/services/ask.js:276-282` |

### 3. 改動匯總

| # | 草稿 | 修訂 |
| --- | --- | --- |
| 1 | 管道保存允許的場景和設備範圍 | 以 RPA API 用戶端為準。一條管道對應「一個 RPA 部署上的一個 API 用戶端」，知識庫讀 `/meta` 展示並做最小權限體檢 |
| 2 | 每個 Action 手工配置入參、判定和回傳欄位 | 增加「可註冊場景規範」（§5）。符合規範的場景由知識庫讀出入參、出參，自動生成 Action 草稿，負責人只審閱和確認 |
| 3 | 「庫名.表名」專用解析器 | 通用的定位解析：Action 上寫一個帶命名分組的正則，參數模板用 `{locator.分組名}` 引用。表、接口、配置項都能用 |
| 4 | 啟動前後比對版本 | 派發前預檢發布版本；202 回應的 `revision` 不符就立即取消；結束後比對 `scenarioHash`；建議 RPA 加 `expectedRevision` 做到原子鎖定 |
| 5 | 提交結果不明時先查已有運行再重試 | 直接以原鍵重試；「重新校驗」生成新的執行和新鍵 |
| 6 | 持久化一次執行（未說明位置） | 執行記錄存 `DATA_DIR/executions/`；Git 只存最終寫回和證據摘要 |
| 7 | 同一執行最多寫回一次 | 冪等錨點放進知識本身：`validity.lastCheck.executionId`，寫回前比對，崩潰後重放也不會重複寫 |
| 8 | 成功判定逐項精確相等 | 保留，寫成宣告式的 `expect` 列表。守衛不通過（錯誤環境、相似前綴庫名）判為「無法判定」，**不**作為綁定錯誤的證據 |
| 9 | 證據含 RPA 證據引用 | 不代理報告與截圖，存 RPA Portal 連結。大欄位（例如建表語句）只存雜湊與長度，不把生產表結構全文寫進 Git |
| 10 | （未涉及） | 修正知識庫校驗入口的適用性和權限檢查；RPA Action 不進 `validateAll` 的同步循環 |

---

## 第二部分：修訂後的設計

### 4. 職責劃分

| 誰 | 負責 | 不負責 |
| --- | --- | --- |
| RPA | 場景的編寫、驗證、發布與版本；執行與 Worker 調度；登入角色與登入狀態；API 用戶端的權限、可用領域、Worker、限額；報告、截圖、錄影的訪問控制 | 知識的有效性、層級、證據 |
| 知識庫 | 管道與 Action 的登記；審閱並鎖定場景版本；從客體定位生成入參；執行記錄、輪詢與恢復；判定業務結論；寫回有效性與證據；後台展示 | 場景內容、RPA 權限、執行細節 |

一條**管道** = 一個 RPA 部署上的一個 API 用戶端（一把金鑰）。同一套 RPA 如果要分「生產只讀」和「測試」兩種授權，就登記兩個 API 用戶端、兩條管道。

一個 **Action** = 一個業務能力 = 一個場景的一個已審版本，加上參數映射和判定規則。同一個場景可以支撐多個 Action（例如「表是否存在」和「讀取建表語句」）。

### 5. 可註冊場景規範

這是「規範、便捷」的基礎。符合規範的場景，知識庫可以自動生成 Action 草稿；不符合的仍然能接，只是要手工補映射。

| 編號 | 規則 | 為什麼 |
| --- | --- | --- |
| R1 | 場景放在只給知識庫用的 RPA 領域（例如「知識校驗（只讀）」），或至少放在知識庫 API 用戶端的「可用領域」內，並由該領域的管理員審過沒有業務副作用 | 只讀只能靠人審（見 §2.1），領域隔離讓 RPA 端強制執行「知識庫只能看到、只能跑這些場景」 |
| R2 | 場景已發布 | RPA 的發布門檻保證發布版本就是驗證通過、雜湊相符的版本 |
| R3 | 有 `outputs` 與 `verify`，出參要**回顯定位用的關鍵欄位**（例如 `environment`、完整的 `databaseName`、`tableName`），不能只回一個「成功」 | 知識庫要逐項精確比對，確認場景查的就是這個客體，不是相似前綴的另一個庫 |
| R4 | 宣告 `deadline`（整次執行期限） | 知識庫據此設定等待期限 |
| R5 | 需要登入時用 `login.role` 宣告角色，並在 RPA 把這個角色綁定給知識庫的 API 用戶端 | ADR 0026 要求綁定，否則 403 |
| R6 | 入參只有業務參數（庫、表、環境等），不含目標系統地址、帳號等 | 這些由場景和 RPA 管理，知識庫調用者不能改 |
| R7（第二期） | 要支持陰性結論（「查不到」）的場景，「查到」和「查不到」都要以 `passed` 結束，用布林出參 `exists` 表達，並在 `verify` 中證明查詢確實在正確的環境、正確的庫執行過 | 否則「表不存在」「沒權限」「網絡錯誤」都是 `failed`，知識庫無法區分。只在查到時才 `passed` 的場景，只能用於正向確認 |
| R8（第二期） | 取值場景的出參為 `value`，可選 `unit`、`observedAt` | 對應知識庫取值的返回格式 |

首個場景 `tech-dms-sql-show-create-table` 已經滿足 R2、R3（出參有 `environment`、`databaseName`、`tableName`、`createTable`）、R5（`dev4dms`）。R1、R4 要在 RPA 端確認，R7 首期不需要。

### 6. 數據模型

#### 6.1 管道 `knowledge/pipelines/P-0003.yaml`

```yaml
id: P-0003
name: 生產元數據 RPA
type: rpa                         # 新增類型
description: 經 DMS 查詢生產庫表結構，只讀
baseUrl: http://rpa.internal:8081/agent-api/v1
headers:
  authorization: Bearer ${env:RPA_META_KEY}   # 沿用現有的憑證引用和明文檢查
timeoutMs: 10000                  # 單次 HTTP 請求
rpa:
  portalUrl: http://rpa.internal:8080         # 給人點開運行報告
  target: remote                  # 選填；不填時用 API 用戶端的設定
  workerId: null                  # 選填；必須在 API 用戶端允許的 Worker 內
  pollIntervalMs: 3000            # 起始輪詢間隔，退避到上限
  maxPollIntervalMs: 15000
  queueTimeoutSec: 300            # 一直排隊（例如沒有 Worker 在線）多久後放棄並取消
  deadlineSec: 900                # 整次作業期限；不填時取場景 deadline + queueTimeoutSec
  maxConcurrent: 2                # 本管道同時在途的運行數，應小於 API 用戶端的排隊上限
```

場景範圍、Worker 清單、權限範圍都**不**存在這裡，以 RPA 的 API 用戶端為準。

#### 6.2 Action `knowledge/actions/ACT-0007.yaml`

```yaml
id: ACT-0007
name: 校驗生產表是否存在
kind: 校驗
pipelineId: P-0003
description: 經 DMS 讀取建表語句，確認生產庫表存在
objectKinds: [數據表]
permission: contributor           # 會真實派發 RPA 運行，預設不給 consumer
enabled: true
rpa:
  sceneId: tech-dms-sql-show-create-table
  revision: 2                     # 審閱過的發布版本
  contentHash: "…"                # 審閱時該版本的雜湊
  loginRole: dev4dms              # 從版本讀出，展示用
  inputs:                         # 場景入參 ← 來源
    databasePrefix: "{locator.database}"
    tableName: "{locator.table}"
    environment: 生產             # 固定值，調用者不可覆蓋
review:
  readOnly: true                  # 負責人聲明：審閱過，沒有業務副作用
  by: owner-xxx
  at: 2026-11-20T…
locator:
  pattern: '^(?<database>[a-z][a-z0-9_]*)\.(?<table>[a-z][a-z0-9_]*)$'
  example: adb_wdk_scm_dpartner.replenish_order
check:
  mode: exists
  expect:                         # 守衛：全部滿足才算 pass
    - { output: environment, equals: 生產 }
    - { output: databaseName, equals: "{locator.database}" }
    - { output: tableName, equals: "{locator.table}" }
    - { output: createTable, nonEmpty: true }
evidence:
  keep: [environment, databaseName, tableName]   # 原值寫入證據
  digest: [createTable]                          # 只存 sha256 與長度
schedule: manual                  # manual；periodic 在第二期開放
```

說明：

- 現有的 `request`、`output` 欄位只給 `http`、`mock` 管道用，`rpa` 管道用 `rpa` 區塊。現有的 `inputs[]`（調用者入參）只給取值 Action 用，模板裡以 `{input.x}` 引用。**校驗 Action 不接受調用者入參**，參數全部來自客體定位和固定值，避免被引導去查別的表。
- 模板可用 `{locator.分組名}`、`{object.locator}`、`{input.x}`、`{item.structured.value}`。整個值只有一個 `{…}` 時保留原型別，再按場景入參宣告的型別轉換。
- `locator.pattern` 在保存時檢查能否編譯、是否至少有一個命名分組、`example` 能否匹配。
- Action 的「配置雜湊」是去掉 `updatedAt`、`review` 後的規範化 JSON 的 sha256，用來在寫回時判斷配置是否改過。
- 「版本待審」「登入角色需登入」「管道不可達」這類狀態是動態計算的，不寫進 Git。

#### 6.3 執行記錄 `DATA_DIR/executions/EX-….json`

本地營運數據，不進 Git，寫入時先寫臨時檔再改名。

```json
{
  "id": "EX-20261120-3f9a1c",
  "kind": "validate",
  "actionId": "ACT-0007",
  "actionHash": "…",
  "pipelineId": "P-0003",
  "target": {
    "itemId": "B-0001",
    "subjectId": "S-PLN-0001",
    "objectId": "O-0001",
    "locator": "adb_wdk_scm_dpartner.replenish_order"
  },
  "requestedBy": { "kind": "human", "id": "…", "name": "…" },
  "inputs": { "databasePrefix": "adb_wdk_scm_dpartner", "environment": "生產", "tableName": "replenish_order" },
  "rpa": {
    "sceneId": "tech-dms-sql-show-create-table",
    "expectedRevision": 2,
    "idempotencyKey": "kb:EX-20261120-3f9a1c",
    "runId": "tech-dms-sql-show-create-table-20261120-112950-40ce85",
    "revision": 2,
    "scenarioHash": "…",
    "status": "passed",
    "stage": null,
    "workerId": "…",
    "portalUrl": "http://rpa.internal:8080/runs/…"
  },
  "state": "done",
  "verdict": "pass",
  "reason": null,
  "detail": "環境、庫名、表名與定位一致；建表語句 2,184 字元",
  "effect": "promoted_L0",
  "commit": "a1b2c3d",
  "createdAt": "…", "submittedAt": "…", "finishedAt": "…", "deadlineAt": "…"
}
```

| `state` | 含義 | 終態 |
| --- | --- | --- |
| `accepted` | 已受理，還沒提交到 RPA（含遇到 429 等待重試） | 否 |
| `submitted` | RPA 已受理，有運行 ID，排隊中 | 否 |
| `running` | RPA 執行中 | 否 |
| `needs_login` | RPA 停在需要登入；人登入後可「登入後重試」，生成新的執行 | 是 |
| `rejected` | 提交前或被 RPA 拒絕（參數、權限、版本不符、場景未發布等），沒有產生有效運行 | 是 |
| `expired` | 超過期限，結果未知；保留運行 ID，可以「重新讀取原運行」 | 是 |
| `done` | RPA 已結束，知識庫已判定 | 是 |

`verdict`（業務結論，只在 `done` 時有）：`pass`、`mismatch`（第二期，斷言比對不符）、`absent`（第二期，符合 R7 的陰性結論）、`inconclusive`。

`effect`（寫回效果）：`promoted_L0`、`renewed_L0`、`demoted_L1`、`stale`（目標在執行期間變了，不寫回）、`skipped_e1`、`none`。

保留期：預設 180 天，終態記錄超過 5,000 條時刪最舊的。

### 7. 註冊流程（後台）

1. **新建 RPA 管道。** 填地址和環境變數名，點「測試連接」。知識庫調用 `GET /meta` 和 `GET /workers`，顯示 API 用戶端名稱、權限範圍、可用領域、排隊上限、在線 Worker 和到期時間，並做最小權限體檢：
   - 缺 `scenes:read`、`runs:execute`、`runs:read` 任何一項：報錯。
   - 多了 `scenes:write`、`debug`、`runs:validate`、`scenes:publish`、`files:write`、`projects:write`、`projects:publish`：警告「知識庫不需要這些權限」。
   - 「回傳頁面內容」開著：警告。
   - `maxConcurrent` 不小於排隊上限：警告。
2. **瀏覽場景目錄。** 列出 `GET /scenes` 中已發布、未歸檔的場景：場景 ID、名稱、領域、發布版本、登入角色及其登入狀態，以及是否已登記為 Action。打開一個場景時，讀發布版本的 `scenario.yaml`，展示入參（型別、枚舉、格式）、出參、`verify` 條數、`deadline`，並標出不符合 §5 的地方。
3. **從場景生成 Action 草稿。** 選擇種類（校驗或取值）和適用的客體種類，知識庫預填：
   - 場景入參與 `{locator.x}` 按名稱自動對應（例如 `tableName` ↔ `table`），對不上的留給負責人選「客體定位分組」「固定值」或「調用者入參」（只限取值）。
   - 出參裡與入參或定位同名、同義的欄位，自動生成 `expect` 守衛。
   - 鎖定當前發布版本號和 `contentHash`。
4. **預覽。** 選一個示例客體（例如 `O-0001`），顯示解析出的定位分組和最終要提交的 RPA 入參，不派發運行。定位格式不符時就地提示。
5. **審閱並啟用。** 負責人勾選「已審閱，無業務副作用」，保存（一次 Git 提交）。可選「試運行一次」，走完整執行流程，但不寫回有效性。
6. **掛到客體。** 在客體頁的「可用 Action」裡勾選。第二張數據表客體只要掛上同一個 Action，用它自己的定位取參。

### 8. 執行協議

#### 8.1 受理：`POST /api/v1/validate/B-0001`，body `{ "actionId": "ACT-0007" }`

同步完成以下檢查，任何一項不通過都直接返回 4xx，不建立執行：

1. 調用者至少是 `contributor`，並滿足 Action 的 `permission`。
2. 條目存在且不是 E1；綁定的客體在用。
3. Action 已啟用、掛在該客體的 `actionIds` 上，客體的 `kind` 在 Action 的 `objectKinds` 內（未填則不限），校驗模式適用於該條目（現有 `actionSuits`）。
4. 定位能被 `locator.pattern` 解析，否則 400 `locator_invalid`，提示具體格式。
5. 入參渲染後，按場景入參的宣告做型別、枚舉、格式的本地檢查。
6. 防雙擊：同一個（條目, Action）已有未結束的執行時，返回那個執行。

通過後寫執行記錄（`accepted`），返回 **202**：

```json
{ "data": { "executionId": "EX-…", "state": "accepted", "statusUrl": "/api/v1/action-executions/EX-…" } }
```

`http`、`mock` 管道保持現有的同步行為和返回格式。

#### 8.2 派發（後台）

1. **版本預檢。** `GET /scenes/{sceneId}`。`publishedRevision` 不等於 Action 鎖定的版本時，記為 `rejected`、原因 `revision_changed`，Action 顯示「版本待審」。
2. **角色預檢。** 場景有登入角色時查 `GET /roles`。狀態是 `needs_login` 時直接記為 `needs_login`，不消耗運行。`unknown` 照常派發。
3. **提交。** `POST /scenes/{sceneId}/runs`，body 只含 `inputs`、`idempotencyKey: "kb:<執行 ID>"`、管道設定的 `target`、`workerId`。不傳 `baseUrl`、`engine`、`headless`。
   - 網絡錯誤或 5xx：用**同一個鍵**按退避重試，RPA 保證只產生一個運行。
   - 429 `limit_reached`：留在 `accepted`，稍後再試，不算失敗。
   - 其他 4xx：記為 `rejected`，原因用 RPA 的錯誤碼（`not_published`、`scene_archived`、`inputs_invalid`、`login_role_forbidden`、`domain_forbidden`、`scope_missing` 等），`inputs_invalid` 帶上 `problems`。
4. **確認版本。** 收到 202 後比對回應的 `revision`。不符時立刻 `POST /runs/{id}/cancel`，記為 `rejected`、原因 `revision_changed`。RPA 實作 `expectedRevision` 後，這一步由 RPA 原子完成，返回 409。
5. 保存運行 ID，狀態轉為 `submitted`。

每條管道有一個派發隊列，同時在途的運行不超過 `maxConcurrent`。

#### 8.3 等待（後台）

- 輪詢 `GET /runs/{runId}`，從 `pollIntervalMs` 開始，退避到 `maxPollIntervalMs`。
- 一直 `queued` 超過 `queueTimeoutSec`：取消運行，記為 `expired`、原因 `queue_timeout`（沒有可用的 Worker）。
- 超過 `deadlineAt`：記為 `expired`、原因 `deadline`，保留運行 ID。運行仍在排隊時取消它。
- 服務重啟：啟動時掃描未到終態的執行，繼續輪詢。還在 `accepted` 的用原鍵重新提交，冪等鍵保證不會重複派發。
- 前端刷新或關閉都不影響後台，前端只讀執行記錄。
- `expired` 的執行可以手動「重新讀取原運行」：再查一次原運行 ID，已結束就照常判定和寫回（仍受 §8.5 的過期檢查約束）。

#### 8.4 判定

| RPA 觀察到的結果 | 知識庫狀態 · 結論 | 有效性 |
| --- | --- | --- |
| 版本預檢或 202 的 `revision` 不是審閱版本 | `rejected` · `revision_changed`（已取消運行） | 不變 |
| 4xx 拒絕（未發布、已歸檔、入參不符、角色未綁定、領域或權限不足） | `rejected` · 對應錯誤碼 | 不變 |
| 一直排隊（沒有 Worker） | `expired` · `queue_timeout`（已取消） | 不變 |
| 超過整體期限 | `expired` · `deadline` | 不變 |
| `needs_login` | `needs_login` · 帶角色名 | 不變 |
| `failed`、`timed_out`、`cancelled` | `done` · `inconclusive`，記下失敗階段和錯誤 | 不變 |
| `passed`，但 `scenarioHash` 不等於審閱版本的 `contentHash` | `done` · `inconclusive` · `revision_changed` | 不變 |
| `passed`，出參缺欄位，或 `expect` 守衛不符（錯誤環境、相似前綴庫名、表名不同） | `done` · `inconclusive` · `expect_failed`，列出每項的實際值與期望值 | 不變 |
| `passed`，全部守衛通過（`exists` 模式） | `done` · `pass` | L1 → L0（已是 L0 則續期），寫入證據 |
| `passed`，`equals` 比對不符（第二期，用於斷言） | `done` · `mismatch` | 降 L1，排入重驗隊列 |
| `passed`，`exists = false`（第二期，只限符合 R7 的場景） | `done` · `absent` | 降 L1，重驗原因「客體疑似不存在」，等負責人確認下線；Action 可設 `onAbsent: offline` 改為直接下線 |

「無法判定」不寫 Git，原有效性不變，細節在執行記錄裡。這與現有 HTTP 校驗出錯時不寫回的行為一致。

#### 8.5 寫回

只有 `pass`、`mismatch`、`absent` 會寫回，在一個 `store.tx` 裡完成（一次 Git 提交）。寫回前檢查，任何一項不滿足就記 `effect: stale`，不寫：

1. 條目仍存在且不是 E1。
2. 綁定的 `objectId` 沒變，客體的 `locator` 與執行開始時的快照相同。
3. Action 的配置雜湊與快照相同。
4. `validity.lastCheck.executionId` 不等於本執行（**冪等錨點**，進程在提交後、更新執行記錄前崩潰，重放時也不會重複寫）。
5. `validity.lastCheck.startedAt` 不晚於本執行的開始時間（舊作業不覆蓋新結果）。

寫入 `validity.lastCheck`：

```yaml
lastCheck:
  at: 2026-11-20T11:30:43Z
  actionId: ACT-0007
  outcome: pass
  detail: 環境、庫名、表名與定位一致
  executionId: EX-20261120-3f9a1c
  startedAt: 2026-11-20T11:29:50Z
  rpa:
    runId: tech-dms-sql-show-create-table-20261120-112950-40ce85
    sceneId: tech-dms-sql-show-create-table
    revision: 2
    scenarioHash: "…"
    workerId: "…"
    finishedAt: 2026-11-20T11:30:43Z
    portalUrl: http://rpa.internal:8080/runs/…
    outputs: { environment: 生產, databaseName: adb_wdk_scm_dpartner, tableName: replenish_order }
    digests: { createTable: { sha256: "…", length: 2184 } }
```

`promoteToL0` 照現有規則設定有效期（數字客體綁定預設 90 天），`history` 的備註寫上運行 ID。提交訊息：`[校驗] ACT-0007 → B-0001：pass（RPA 運行 …-40ce85，觸發者 …）`。只更新本次的目標綁定，主體的其他斷言不受影響。

### 9. 版本與審閱

- Action 鎖定「發布版本號 + `contentHash`」。
- RPA 發布新版本後，Action 顯示「版本待審」，新的執行在預檢時被拒（`revision_changed`），不會用未審版本的結果寫回。
- 後台給出差異：入參、出參、登入角色、`verify`、`deadline` 的變化（比較兩個版本的 `scenario.yaml`），負責人點「審閱並採用 vN」，更新 Action（一次 Git 提交）。
- 不做「契約沒變就自動採用」：步驟變了也可能帶來副作用，只讀聲明必須由人重新確認。
- 保障強度：預檢 + 202 比對 + 結束後雜湊比對，保證**錯誤版本的結果一定不會寫回**。不改 RPA 時，切換發布的瞬間，未審版本最多被執行一次並立即被取消。加了 `expectedRevision` 之後，未審版本根本不會被執行。

### 10. 權限與安全

**RPA 端，給知識庫建的 API 用戶端：**

| 設定 | 建議值 |
| --- | --- |
| 權限範圍 | 只給 `scenes:read`、`runs:execute`、`runs:read` |
| 可用領域 | 只開 §5 R1 的領域 |
| 執行位置與 Worker | 固定到能訪問 DMS 的 Worker |
| 排隊上限 | 例如 5（知識庫 `maxConcurrent` 設 2） |
| 回傳頁面內容 | 關 |
| 登入角色綁定 | 把 `dev4dms` 綁定給這個用戶端 |
| 來源 IP | 知識庫伺服器的 IP |

**知識庫端：**

- RPA 金鑰只以 `${env:RPA_META_KEY}` 引用，寫進 `config.env`，不進知識倉庫（沿用現有檢查）。
- 註冊、修改管道和 Action：`owner`（現狀）。發起 RPA 校驗：`contributor` 且滿足 Action 的 `permission`（本次修補）。
- 只讀有三道保障：RPA 領域隔離、負責人的只讀聲明、知識庫不接受調用者入參也不傳 `baseUrl`。
- 傳輸：RPA 的 Agent API 是 HTTP，金鑰明文（ADR 0017 決定局域網內不強制 HTTPS）。知識庫與 RPA 不在同一個受信網段時，要在 RPA 前加 HTTPS 反向代理。
- 證據：不代理報告和截圖。建表語句這類大欄位只存雜湊和長度；要看原文就點 RPA Portal 連結，權限由 RPA 判斷。
- 可觀察性：執行記錄有調用人、Action、條目、客體、執行 ID、運行 ID、兩邊的狀態、失敗階段、原因碼和 Portal 連結，能按運行 ID 查。

### 11. RPA 側的配置與建議改動

**上線前要做的配置（不用改程式碼）：**

1. 在 RPA 管理後台建立「知識庫」API 用戶端，按 §10 設定，記下金鑰（只顯示一次）。
2. 把 `dev4dms` 綁定給它。
3. 確認 `tech-dms-sql-show-create-table` 在它的可用領域內、已發布、宣告了 `deadline`。

**建議的小改動（RPA 倉庫的獨立 PR，按該倉庫 `AGENTS.md` 的交接流程走）：**

- `RunBody` 加 `expectedRevision: int | None`。在 `request_run` 的正式執行分支，取到 `scene.published_number` 後，與它不相等就返回 409 `revision_mismatch`（帶目前的發布版本）。判斷和建立運行在同一個資料庫事務裡，沒有競態。約 10 行程式碼，加測試，並更新三語文檔和 OpenAPI。
- 可選：`GET /scenes/{id}/revisions/{n}/contract` 直接返回該版本的入參、出參、登入角色、Secrets、`deadline`（JSON），知識庫就不必自己解析 `scenario.yaml`。不做也不影響首期。

### 12. 知識庫的程式改動清單（第一期）

| 位置 | 改動 |
| --- | --- |
| `src/store/model.js` | `PIPELINE_TYPES` 加 `rpa` |
| `src/store/store.js` | `upsertPipeline` 校驗 `rpa` 欄位；`upsertAction` 校驗 `rpa`、`locator`、`check.expect`、`evidence`、`review`；`applyValidationResult` 接收證據、做 §8.5 的過期與冪等檢查；Action 配置雜湊 |
| `src/services/rpa.js`（新） | RPA Agent API 客戶端：`meta`、`workers`、`roles`、`scenes`、`scene`、`revision`、`createRun`、`getRun`、`cancelRun`，統一錯誤碼和重試 |
| `src/services/executions.js`（新） | 執行記錄存取（原子寫入）、每條管道的派發隊列、輪詢、啟動恢復、保留期清理 |
| `src/services/actions.js` | `validateItem` 加上 Action 掛載、`objectKinds`、`permission` 檢查（對所有管道類型生效）；`rpa` 管道走執行流程；`validateAll` 跳過 `rpa` Action，並在結果裡列出跳過數 |
| `src/api/v1.js` | `POST /validate/:id` 對 RPA 返回 202；新增 `GET /action-executions/:id`、`GET /action-executions?itemId=&actionId=&state=&runId=`、`POST /action-executions/:id/refresh`；`GET /pipelines/:id/scenes`、`GET /pipelines/:id/scenes/:sceneId`（owner）；`POST /actions/:id/preview`；`POST /actions/:id/review` |
| `src/api/openapi.js`、`src/services/prompt.js` | 補齊管道、Action、執行查詢的請求與響應；在智能體教程裡說明校驗可能是異步的，以及 202 之後怎麼查 |
| `web/assets/app.js` | 管道頁支持 RPA 類型和連接體檢；場景目錄與 Action 向導；綁定行上的校驗進度、結果、運行編號；執行記錄面板 |
| `test/` | 用 Express 模擬 RPA Agent API，覆蓋 §14 的用例 |

不動的地方：Git 持久化方式、有效性和層級規則、`http`、`mock` 管道的行為。

### 13. 後台頁面

| 入口 | 使用者看到和做的事 |
| --- | --- |
| 管道管理 | 新建 RPA 管道；測試連接後看到 API 用戶端的權限範圍、可用領域、在線 Worker、排隊上限，以及最小權限體檢結果 |
| 場景目錄（從管道進入） | 已發布場景的列表；每個場景的版本、登入角色和登入狀態、入參、出參、是否符合規範、是否已登記 |
| Action 向導 | 從場景生成草稿 → 調整映射和守衛 → 用示例客體預覽入參 → 審閱只讀並啟用 → 可選試運行 |
| Action 詳情 | 鎖定的版本、狀態標記（就緒、版本待審、角色需登入、管道不可達）、最近的執行；版本待審時顯示差異和「採用新版本」 |
| 客體詳情 `O-0001` | 「可用 Action」裡有 RPA Action；顯示適用範圍和最近一次執行摘要。從客體頁發起校驗時，必須選擇要寫回的綁定 |
| 主體詳情與綁定 `B-0001` | 綁定行上有「校驗」按鈕；之後顯示進度（排隊、執行中、需登入、完成）、結論、層級變化、證據、運行編號，以及到 RPA 報告的連結；失敗時顯示原因碼和說明 |

### 14. 測試與驗收

自動化測試（模擬 RPA）：

| 用例 | 期望 |
| --- | --- |
| 202 → `running` → `passed`，守衛全部通過 | 綁定升 L0，`lastCheck` 帶運行 ID，Git 只有一次提交 |
| 錯誤環境、相似前綴庫名、表名不同、出參缺欄位 | `inconclusive`，有效性不變 |
| `needs_login`、`failed`、`timed_out`、`cancelled` | 有效性不變，原因碼正確 |
| 403、409、422、429 | 前三種 `rejected`；429 稍後重試成功 |
| 202 回應的 `revision` 不是審閱版本 | 調用了取消，`rejected` |
| 結束後 `scenarioHash` 不符 | `inconclusive` |
| 一直 `queued` | 超時後取消，`expired` |
| 提交時網絡中斷 | 原鍵重試，模擬端只建一個運行 |
| 雙擊 | 返回同一個執行 |
| 執行中途重啟服務 | 恢復輪詢，最終只寫回一次 |
| 執行期間客體改了定位，或 Action 改了配置 | `stale`，不寫回；新執行正常 |
| 寫回後、更新執行記錄前崩潰 | 重放時發現 `lastCheck.executionId` 已存在，不重複寫 |
| 用沒掛在客體上的 Action、種類不符、權限不足 | 4xx，不建立執行 |
| `validateAll` | 跳過 RPA Action |

人工驗收（沿用草稿第 8 節，有補充）：

| 用例 | 通過條件 |
| --- | --- |
| 生產補貨申請表正向 | 為 `O-0001` 配置 Action，從 `B-0001` 發起。頁面顯示進行中，終態顯示環境、完整庫名和表名，綁定升 L0，能點到同一個 RPA 運行的報告。只更新 `B-0001`，主體的 9 條既有斷言保持原狀 |
| 防止誤判 | 錯誤環境、相似前綴庫名、登入失效、超時、權限不足、Worker 離線都不會讓綁定升 L0，也不會讓客體下線 |
| 重複提交與恢復 | 雙擊、提交響應丟失、服務重啟：同一操作只有一個 RPA 運行、一次寫回 |
| 版本變化 | RPA 發布新版本後，Action 顯示版本待審並拒絕執行；採用新版本後恢復 |
| 複用 | 第二張數據表客體掛上同一個 Action，以自己的定位取參並校驗成功 |
| 最小權限 | 給 API 用戶端多開 `scenes:write` 時，管道體檢出現警告；用沒有 `runs:execute` 的金鑰時報錯 |

### 15. 分期

| 期 | 內容 |
| --- | --- |
| 第一期 | RPA 管道類型、連接體檢、場景目錄、Action 向導與審閱、異步執行（受理、派發、輪詢、恢復、判定、寫回）、正向存在性校驗、執行查詢 API、後台展示、修正校驗入口的檢查、RPA Action 不進 `validateAll`、測試與文檔 |
| 與第一期並行（RPA 倉庫） | `expectedRevision`（建議）；版本契約端點（可選） |
| 第二期 | 取值（`/ask` 返回「取值進行中」，前端輪詢）、斷言的 `equals` 比對、符合 R7 的陰性結論、定期複驗（進派發隊列，按 Action 開啟）、組合場景作為 Action |

### 16. 決定紀錄（原「需要你確認的事」）

1. 是否按本設計開始第一期實作。
2. 是否同意在 RPA 倉庫加 `expectedRevision`。不加也能上線，代價是發布切換的瞬間，未審版本可能被執行一次並立即取消（結果不會寫回）。
3. RPA 陰性結論（第二期）的預設處理：建議「降 L1 並等負責人確認下線」，而不是像 HTTP 404 那樣直接讓客體下線。

決定：1、2 已確認（開始第一期；RPA 倉庫的 `expectedRevision` 見 RPA PR #32）。3 留到第二期再定。

### 17. 第一期實作說明

- **不依賴 RPA 升級。** 知識庫總是先帶 `expectedRevision` 提交；舊版 RPA（`RunBody` 禁止未知欄位）回 422 `request_invalid`、`problems` 指向 `body.expectedRevision` 時，自動改為不帶並按管道記住，改用 §8.2 的預檢、202 後比對並取消、結束後比對 `scenarioHash`。已對 RPA main（v0.10.0）實測：失敗的請求不消耗冪等鍵，用同一個鍵重送正常排入。
- **校驗入口的檢查。** 指定 `actionId` 時，所有管道都檢查 Action 已啟用、掛在條目的客體上（422 `action_not_attached`）、客體種類適用（422 `object_kind_mismatch`）、調用者滿足 `permission`（403）。E1 拒絕（409 `item_invalid`）只對 RPA 生效，HTTP / mock 管道保持原來的 `skipped_e1` 行為。
- **新增試運行端點** `POST /actions/{id}/trial {objectId}`（owner）：走完整執行流程，執行記錄 `dryRun: true`、`effect: dry_run`，不寫回，也不參與防雙擊。
- **期限。** 受理時先給 `deadlineSec`（管道未設時 900 秒）；提交成功後改為「管道 `deadlineSec`」或「場景 `deadline` + `queueTimeoutSec` + 60 秒」。RPA 一直不可用時，受理狀態的執行在期限到後記為 `expired · deadline`。
- **登入角色預檢**把 `needs_login` 和 `none`（從未登入）都視為需要登入；讀不到角色清單時照常派發，由 RPA 判斷。
- **終態在寫回之後才出現。** 判定通過時先寫回，再把狀態轉為 `done`，讀到 `done` 時 `effect` 和 `commit` 已確定。
- **多語言。** 錯誤、體檢、規範檢查和後台文字按請求語言返回（繁體、簡體、英文）。執行說明以「原文 + 參數」保存，`detail` 是繁體原文，API 另外返回按請求語言翻譯的 `detailText`、`reasonText`、`stateName`；寫進知識倉庫的提交說明、`lastCheck.detail` 和層級歷史備註保持繁體原文，後台顯示時再翻譯。
- **主要程式位置：** `src/store/rpa.js`（規範化、定位解析、入參渲染、守衛、證據）、`src/services/rpa.js`（Agent API 客戶端、場景契約解析、規範檢查、草稿）、`src/services/executions.js`（執行服務）、`KnowledgeStore.applyExecutionResult`（寫回前的過期檢查）、`test/rpa.test.js`（模擬 RPA 的端到端測試）。
