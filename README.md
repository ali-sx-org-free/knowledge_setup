# 供應鏈技術知識體系 MVP

按《供應鏈技術知識體系 MVP 建模設計 v0.1》實作的私有領域知識庫：智能體能可靠引用，人機能共同維護，知識能自動保鮮。

| 交付項 | 實作 |
| --- | --- |
| 知識持久化 | 使用你指定的 **Git 倉庫**（SSH 部署金鑰或 HTTPS 權杖）：知識以 YAML 檔案存放，每次寫入是一次提交，作者記為提交知識的人、智能體或管道；定期拉取他人直接在 Git 中做的修改 |
| 管理後台 | `/`：知識管理與可視化（主體、斷言、客體、關係、知識圖譜、層級分佈、重驗隊列、衝突、反饋、缺口、動力層、API 金鑰、設定），視覺沿用 `agent_subscribe_plan` 的 Portal 樣式包 |
| 生產型 API | `/api/v1`：三方智能體提交與管理主體、客體、綁定、斷言、關係，支持批量提交、補證據、校驗、衝突、反饋 |
| 教程 prompt API | `GET /api/v1/prompt`（公開）：三方智能體拉取後即可學會如何生產知識；`?role=consumer` 為消費教程 |
| 消費型 API | `POST /api/v1/ask` 返回結構化知識卡 + 自然語言答案（經 **OpenRouter** 組織，未配置時用規則模板）；另有知識卡、圖譜、術語解析、取值 Action 等 |

## 一鍵安裝（不需要 clone）

**Linux / macOS**

```bash
curl -fsSL https://github.com/ali-sx-org-free/knowledge_setup/releases/latest/download/install.sh | bash
# GitHub 慢或打不開時，經代理取得腳本（之後的下載仍會測速選源）：
curl -fsSL https://ghfast.top/https://github.com/ali-sx-org-free/knowledge_setup/releases/latest/download/install.sh | bash
```

**Windows**（PowerShell，Windows 10 / 11）

```powershell
$f="$env:TEMP\knowledge-install.ps1"; curl.exe -fsSL -o $f https://github.com/ali-sx-org-free/knowledge_setup/releases/latest/download/install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File $f
```

GitHub 慢時把網址換成 `https://ghfast.top/https://github.com/ali-sx-org-free/...`。結束時終端會顯示後台地址（預設 <http://localhost:8080>）和自動生成的管理員密碼。

安裝腳本做的事：

1. **測速選源**：並行向下表各來源取 `SHA256SUMS`（取不到的直接跳過），再逐個下載發佈包的前 512 KB 測速，從最快的下載；下載後按 `SHA256SUMS` 校驗 SHA-256，不符就換下一個來源。`github.com` 可達時以它的校驗值為準，代理只負責加速。
2. **Node.js**：系統已有 Node.js 20+ 就直接用；沒有或太舊時，同樣測速後從最快的鏡像下載獨立的 Node.js 22 到安裝目錄（不改動系統）。Windows 沒有 git 時另外下載 MinGit（固定版本，SHA-256 寫在腳本裡）。
3. **安裝並啟動**：程式放在 `~/.knowledge_setup/app`（Windows：`%LOCALAPPDATA%\knowledge_setup\app`），建立 `knowledge` 命令，在後台啟動服務。發佈包已含依賴，不需要 `npm install`。

| 下載內容 | 測速的來源（第一個為官方） |
| --- | --- |
| 發佈包、MinGit | `github.com`、`ghfast.top`、`gh-proxy.com`、`ghproxy.net`、`gh.llkk.cc`；MinGit 另有 npmmirror、華為雲 |
| Node.js | `nodejs.org`、npmmirror、清華、中科大、華為雲、騰訊雲、阿里雲 |
| npm 依賴（僅 `--ref` 源碼安裝） | `registry.npmjs.org`、npmmirror、騰訊雲、華為雲 |

來源列表可以用環境變數 `KNOWLEDGE_GITHUB_MIRRORS`、`KNOWLEDGE_NODE_MIRRORS`、`KNOWLEDGE_NPM_REGISTRIES` 覆蓋（空格分隔），或用 `--mirror` / `--node-mirror` / `--registry` 只用指定的一個。

**常用命令**

| 命令 | 作用 |
| --- | --- |
| `knowledge status` | 運行狀態、訪問地址、初始管理員密碼 |
| `knowledge stop` / `start` / `restart` | 停止 / 啟動 / 重啟（修改設定後） |
| `knowledge logs [-f]` | 查看日誌 |
| `knowledge upgrade` | 升級到最新版本（資料與設定保留）；再次執行安裝命令效果相同 |
| `knowledge run` | 前台運行，給 systemd 等進程管理器用 |

設定寫在安裝目錄的 `config.env`（格式同 [.env.example](.env.example)，例如 `PORT`、`ADMIN_PASSWORD`、`KNOWLEDGE_GIT_URL`），修改後 `knowledge restart`。資料在安裝目錄的 `data/`，升級不會動它。

**安裝選項**（Linux / macOS 用 `curl ... | bash -s -- --port 9090` 的形式傳入；Windows 用 `-Port 9090` 這種寫法）

| 選項 | 作用 |
| --- | --- |
| `--port 9090` | 服務端口 |
| `--version v0.2.0` | 安裝指定版本 |
| `--prefix DIR` | 安裝目錄 |
| `--package FILE` | 離線安裝：先在能上網的機器下載發佈包和 `SHA256SUMS`，放在同一目錄 |
| `--ref main` | 從源碼安裝尚未發佈的分支或標籤（依賴從測速最快的 npm 鏡像安裝） |
| `--no-start` | 只安裝不啟動 |
| `--force-node` | 即使系統有 Node.js 也使用獨立的 Node.js |

還沒有發佈版本時，可以從 main 分支安裝：

```bash
curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/ali-sx-org-free/knowledge_setup/main/release/install.sh | bash -s -- --ref main
```

想卸載：`knowledge stop`，再刪除安裝目錄（裡面的 `data/` 是你的資料，需要時先備份）。

## 從源碼運行

需要 Node.js 20+ 與 git。

```bash
npm install
ADMIN_PASSWORD='請換成你的密碼' npm start
# 打開 http://localhost:8080 ，用上面的密碼登入
```

1. 登入後到 **設定 › 知識倉庫** 關聯你的 Git 倉庫，兩種方式任選，點「測試連接」後「保存並切換」。不填則使用本地倉庫。
   - **SSH 部署金鑰**（推薦）：地址填 `git@github.com:org/repo.git`，在同一頁產生部署金鑰，把公鑰添加到倉庫 Settings › Deploy keys 並勾選 Allow write access。見下方「[用 SSH 部署金鑰關聯倉庫](#用-ssh-部署金鑰關聯倉庫)」。
   - **HTTPS 權杖**：地址填 `https://github.com/org/repo.git`，再填存取權杖（GitHub 細粒度 PAT，需 Contents 讀寫）。
2. 同一頁可點 **載入示例資料**：設計文件中的「可售庫存」示例與庫存域試點主體（系統名、表名、接口名均為示意）。
3. 到 **設定 › 自然語言** 填入 OpenRouter API Key 與模型 ID。
4. 到 **接入 › API 金鑰** 為三方智能體發放金鑰，把 `http://<你的地址>/api/v1/prompt` 交給它。
5. 到 **接入 › 問答測試** 試問設計文件中的 6 個問題。

也可以全部用環境變數配置，見 [.env.example](.env.example)。容器部署：`docker build -t knowledge . && docker run -p 8080:8080 -v knowledge-data:/data -e ADMIN_PASSWORD=... knowledge`。

驗收本工程請按 [驗收教程](docs/acceptance-guide.md) 逐項操作，每一步都附有預期結果和截圖。

## 知識倉庫結構

```
knowledge/
  config.yaml              領域代碼、有效期初值等規則參數
  subjects/S-INV-0012.yaml 主體；其下掛客體綁定 bindings 與斷言 assertions
  objects/O-0001.yaml      客體（數字 / 制度 / 物理）
  relations/R-0001.yaml    主體之間的關係（10 種閉集），帶有效性
  actions/ACT-0001.yaml    Action（校驗 / 取值，只讀；RPA Action 鎖定審閱過的場景版本）
  pipelines/P-0001.yaml    管道（http / mock / rpa；憑證以 ${env:變數} 引用，不入庫）
  governance/              衝突 C-、反饋 F-、知識缺口 G-
  stats/usage.yaml         主體被使用次數（重驗優先級、L0 覆蓋率）
```

機密（Git 權杖、OpenRouter Key、管理員密碼雜湊、API 金鑰雜湊）只存在服務本地的 `DATA_DIR/settings.json`，SSH 部署金鑰的私鑰只存在 `DATA_DIR/ssh/`（0600），都不進入知識倉庫。

## 用 SSH 部署金鑰關聯倉庫

部署金鑰（Deploy key）是只屬於一個倉庫的 SSH 金鑰，不綁定個人帳號，適合服務長期讀寫知識倉庫。

1. **設定 › 知識倉庫**：倉庫地址填 SSH 形式，例如 `git@github.com:ali-sx-org-free/knowledge_site_v01.git`。頁面顯示「認證方式：SSH 部署金鑰」。
2. 在「SSH 部署金鑰」面板點 **產生部署金鑰**（ed25519），再點 **複製公鑰**。已有私鑰（無密碼）也可以點「貼上已有私鑰」。
3. 打開倉庫 **Settings › Deploy keys › Add deploy key**（GitHub 地址時面板上有直達鏈接），貼上公鑰，**勾選 Allow write access**（知識寫入需要推送），保存。
4. 回到後台點 **測試連接**：空倉庫顯示「倉庫為空，首次寫入會建立分支」。再點 **保存並切換**。
5. 首次連接會記下遠端主機指紋（面板「已記下的主機指紋」），之後指紋不符會拒絕連接；可與 [GitHub 公布的指紋](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints) 核對。

說明：

- 私鑰只存在 `DATA_DIR/ssh/deploy_key`（0600），接口只返回公鑰。git 只在連接遠端的那一次子程序中經 `GIT_SSH_COMMAND` 使用這把金鑰和服務自己的 `known_hosts`，不讀 `~/.ssh`、使用者的 ssh 設定和 git 全局設定（因此 `url.insteadOf` 之類的改寫不會把 SSH 地址悄悄換成別的協議）。
- 以環境變數配置時：先執行 `npm run ssh-key`（容器內 `docker run --rm -v knowledge-data:/data knowledge node scripts/ssh-key.js`）產生並顯示公鑰，添加到 Deploy keys 後再設定 `KNOWLEDGE_GIT_URL` 啟動；或用 `KNOWLEDGE_GIT_SSH_KEY_FILE` 指定已有的私鑰檔。
- 網絡只放行 443 時，GitHub 可改用 `ssh://git@ssh.github.com:443/<owner>/<repo>.git`。
- 常見錯誤會附上提示：`Permission denied (publickey)`（公鑰未添加到這個倉庫）、`marked as read only`（沒有勾選 Allow write access）、`Host key verification failed`（主機指紋變了，確認後在面板清除主機指紋）。
- SSH 地址但沒有產生部署金鑰時，沿用舊行為：使用伺服器本機的 ssh 設定。

## 接入瀏覽器 RPA

RPA 中審閱過的只讀場景可以註冊成「RPA 管道 + 校驗 Action」，用來確認數據表等客體真實存在，通過後把綁定從 L1 升為 L0。完整設計見 [docs/design/rpa-integration.md](docs/design/rpa-integration.md)。第一期只支持「校驗 · 客體存在」、手動發起；取值、斷言內容比對和定期複驗在第二期。

**RPA 那邊的準備（只需設定，不需要升級 RPA）：**

1. 在 RPA Portal 為知識庫建一個 API 用戶端，權限範圍只給 `scenes:read`、`runs:execute`、`runs:read`，關閉「回傳頁面內容」，放行場景所在的領域。
2. 場景需要登入時（例如 `dev4dms`），把登入角色綁定給這個用戶端，並在錄製端完成一次人工登入。
3. 把金鑰設成知識庫服務的環境變數，例如 `RPA_KB_TOKEN=…`。金鑰只在環境變數裡，不進知識倉庫。

RPA 支持 `expectedRevision` 時（[RPA PR #32](https://github.com/ali-sx-org-free/web_browser_robotic_process_automation/pull/32)），版本不符由 RPA 原子拒絕；舊版 RPA 回 422 時知識庫自動改為不帶這個參數，改用派發前預檢、202 後比對版本並取消、結束後比對 `scenarioHash` 三道檢查。

**在後台註冊：**

1. **動力層 › 管道 › 新增 RPA 管道**：`baseUrl` 填 `http://主機:8081/agent-api/v1`（只填伺服器根地址也可以），`headers` 填 `{"Authorization": "Bearer ${env:RPA_KB_TOKEN}"}`。保存後點 **測試**：顯示 API 用戶端、權限範圍、排隊上限和在線 Worker；缺必要權限報錯，多餘權限警告。
2. 點 **場景目錄**，打開一個場景的 **查看與註冊**：顯示發布版本的入參、出參、登入角色、期限和可註冊規範（R1–R5）檢查，並預填 Action 草稿。草稿把沒有預設值的入參按順序組成定位格式（例如 `庫名前綴.表名`），出參中回顯入參的欄位生成精確相等的守衛，其餘出參要求非空、只存雜湊。
3. 選擇適用的客體種類、填定位示例，勾選「已審閱，無業務副作用」，保存 Action（一次 Git 提交）。
4. 在客體的「可用 Action」裡掛上這個 Action。在 **Action** 頁點 **預覽** 檢查某個客體會提交什麼入參；**試運行** 走完整流程但不寫回。
5. 在綁定上點 **校驗**：返回 202，後台異步執行；窗口顯示排隊、執行、判定和寫回，關閉窗口不影響執行。**動力層 › 執行記錄** 可以查全部執行。

**判定：** 只有 RPA 運行 `passed`、版本和內容雜湊等於審閱版本、全部守衛通過時才寫回（L1 → L0 或 L0 續期，一次 Git 提交，證據記在 `validity.lastCheck.rpa`）。其餘一律「無法判定」或「已拒絕」，不改有效性：場景發布了新版本（Action 顯示「版本待審」，負責人點 **審閱** 鎖到新版本）、登入角色需要登入、運行失敗或逾時、出參與定位對不上（例如錯誤環境、相似前綴的庫名）等。執行期間客體定位被改、Action 被改或有更晚的結果已寫回時，結果記為「目標已變，未寫回」。

執行記錄存在 `DATA_DIR/executions/<倉庫>/`，不進知識倉庫；服務重啟後未結束的執行會用原冪等鍵繼續，不會重複派發。

## 設計文件到實作的對應

| 設計要求 | 實作位置 |
| --- | --- |
| 6 個概念、6 種主體類型、10 種關係類型（含方向）、2 種 Action、L0/L1/L2/E1 | `src/store/model.js` |
| 有效性字段附在綁定、斷言、關係三處 | `src/store/validity.js` |
| 主體綜合層級 = 有效綁定中的最高層級，無有效綁定為 L2（只讀，不入庫） | `KnowledgeStore.subjectLevel` |
| 寫入上限：人或智能體附證據最高 L1、無證據 L2、不能寫 L0；管道按校驗結果定級 | `capSubmittedLevel` |
| 上行只有 L2→L1（補證據）與 L1→L0（Action 校驗或負責人確認）；智能體不能晉升 | `addEvidence`、`confirm`、`assertOwner` |
| 到期、校驗不符、衝突、反饋錯誤先降回 L1 並排入重驗；E1 不刪除、指向替代者 | `demoteToL1`、`invalidate` |
| 客體下線：綁定轉 E1，以它為證據的斷言和關係降為 L1 | `takeObjectOffline` |
| 衝突不設獨立狀態：雙方降 L1，裁決後一方 L0、另一方 E1 | `reportConflict`、`resolveConflict` |
| 每個業務對象或指標只有一條 L0「擁有」關係 | `assertSingleOwner` |
| 別名三條規則（只經別名關係、可一詞多義、檢索先解析） | `createSubject`、`resolveTerms` |
| 有效期初值 30 / 90 / 180 天，負責人可按主體調整 | `config.yaml`、主體 `expiryDays` |
| 動態值不存儲，經取值 Action 實時獲取；MVP 只讀 | `src/services/actions.js` |
| RPA 管道與校驗 Action：場景契約、草稿、版本鎖定、異步執行與判定、寫回前的過期檢查 | `src/store/rpa.js`、`src/services/rpa.js`、`src/services/executions.js`、`KnowledgeStore.applyExecutionResult` |
| 智能體使用規約 6 步（解析、動態值、按層級、引用、未收錄、反饋） | `src/services/ask.js` |
| 三類保鮮觸發（時間、客體變更、使用反饋）；重驗按「使用頻率 × 出錯代價」排序 | 排程任務、`revalidationQueue` |
| 健康指標：L0 覆蓋率、待重驗數、未收錄查詢數、L0 錯誤反饋數 | `KnowledgeStore.health`、後台「健康指標」 |

## API 概覽

認證：`Authorization: Bearer <API 金鑰>`。角色：`consumer`（讀與問答）、`contributor`（另可提交知識）、`owner`（只能是人；確認晉升、裁決、判定失效、配置動力層）。管道金鑰提交的知識按管道校驗結果直接定級。回應格式 `{ data, commit?, warnings? }`，錯誤 `{ error: { code, message } }`。完整列表見後台「接入 › API 參考」或 `GET /api/v1/openapi.json`。

```bash
# 三方智能體拉取教程（公開）
curl -s http://localhost:8080/api/v1/prompt

# 消費：問答
curl -s -X POST http://localhost:8080/api/v1/ask \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"question":"SKU-123 在上海一號倉還有多少可售？"}'
```

`/ask` 的 `status`：`answered`、`ambiguous`（別名多義，帶 `subjectIds` 重問）、`need_inputs`（動態值缺參數）、`uncovered`（未收錄，已記為知識缺口）。每條引用都帶層級；OpenRouter 返回的引用會與知識範圍比對，範圍外的 ID 被丟棄。

## 多語言（繁體中文 / 簡體中文 / English）

- **管理後台**：按瀏覽器語言自動選擇（`zh-TW`、`zh-HK` 等用繁體，其他中文用簡體，其餘用英文），頂欄、登入頁和「設定 › 帳號」都可以切換，選擇記在瀏覽器裡；網址加 `?lang=en` 可直接指定。
- **API**：錯誤訊息、提示（`warnings`）、`/schema` 與 OpenAPI 的說明、問答的規則模板答案、智能體教程按 `?lang=zh-TW|zh-CN|en` 或 `Accept-Language` 返回，回應帶 `Content-Language`。都沒有時用 `KNOWLEDGE_LANG`（預設繁體中文）。錯誤碼（`error.code`）不隨語言變化。
- **不翻譯的部分**：主體類型、客體類別、斷言類型、關係類型、Action 種類、客體狀態等**枚舉值是 API 的值**，任何語言下都用繁體原文（例如 `"type": "指標"`）；`/schema` 另給出 `label` 譯名供顯示。寫入知識倉庫的內容（提交說明、層級歷史、預設的處理結果）一律保持繁體原文，避免倉庫內容隨提交者的語言變化，後台顯示時再翻譯。知識內容本身（名稱、定義、斷言）按提交時的原文保存，不做翻譯。
- **字典**：繁體原文就是字典鍵。後台字典在 `web/assets/locales/`，服務端字典在 `src/i18n/locales/`。新增或修改介面、訊息文字後執行 `npm run i18n:check`，它會列出缺少、多餘和佔位符不一致的條目（測試中也會檢查）。

```bash
curl -s 'http://localhost:8080/api/v1/prompt?lang=en'               # 英文教程
curl -s -H 'Accept-Language: zh-CN' http://localhost:8080/api/v1/schema  # 簡體說明
```

## CI 與發佈

`.github/workflows/` 下兩條流水綫：

| 流水綫 | 觸發 | 內容 |
| --- | --- | --- |
| `CI` | 每個 PR、推送到 main | 測試（Node 22 / 24，安裝 sshd 跑 SSH 部署金鑰端到端）；構建容器映像並確認能登入；打包發佈包；在 Linux、macOS（系統自帶 bash 3.2）、Windows（PowerShell 5.1）上跑一鍵安裝冒煙測試 |
| `Release` | 推送 `v*` 標籤 | 測試 → 打包 → 冒煙測試 → 建立 GitHub Release，上傳發佈包（`.tar.gz` / `.zip`，已含依賴）、`install.sh`、`install.ps1`、`SHA256SUMS` |

一鍵安裝的冒煙測試在本機模擬 4 個下載來源（正常、不可達、很慢、發佈包被篡改），確認腳本選最快的來源、拒絕被篡改的包並回退、升級時資料保留；同時真實地從 nodejs.org 下載 Node.js（Windows 另從 GitHub 下載 MinGit）。

**發佈新版本**

```bash
npm version 0.2.0 --no-git-tag-version   # 修改 package.json 的版本，提交並合併到 main
git tag v0.2.0 && git push origin v0.2.0  # 標籤必須與 package.json 一致；v0.2.0-rc.1 這類標籤發佈為預發佈版本
```

本地打包與測試：`npm run release:build`（產物在 `dist/`），`npm run release:smoke`。

## 開發

```bash
npm run dev     # 監聽修改自動重啟
npm test        # 37 項：模型規則 + 端到端（含 OpenRouter 模擬、Git 遠端推送與回拉、經本機 sshd 的 SSH 部署金鑰、多語言；沒有 OpenSSH 時相關項跳過）
npm run i18n:check # 檢查簡中、英文字典是否覆蓋全部介面與訊息文字
npm run seed    # 命令列載入示例資料
npm run ssh-key # 顯示 SSH 部署金鑰的公鑰（沒有時產生）
```

技術選型：Node.js + Express 5 + `yaml`，後台為無建置步驟的原生 JS（ES modules），圖譜為自寫的力導向 SVG，無 CDN 依賴。

## MVP 不做（與設計文件一致）

寫型 Action、自動推理生成新知識、多來源衝突的自動裁決、細粒度權限。設計文件中的待決問題（試點子域、負責人名單、存儲選型、有效期細分、引用格式）在本實作中的處理：試點按庫存域示例；負責人為主體上的文本字段，可選綁定負責人金鑰；存儲採用 Git + 記憶體索引（50–150 個主體的規模足夠）；有效期按條目類型細分並可按主體覆蓋；引用格式為 `〔ID·層級〕`，未收錄問題記入 `governance/gaps/`。
