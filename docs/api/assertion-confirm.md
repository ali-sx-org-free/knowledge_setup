# 授權確認：API 金鑰把斷言確認為 L0（`assertions:confirm`）

狀態：已實作。本文中的金鑰、編號和請求內容都是虛構示例。

## 1. 要解決的問題

升級前，確認端點有兩道只讓負責人（人）通過的檢查：

| 層 | 檢查 | 智能體金鑰收到的錯誤 |
| --- | --- | --- |
| 路由 `requireRole('owner')` | 角色必須是 `owner` | 403 `forbidden`「此操作需要 owner 權限」 |
| 存儲 `assertOwner` | 智能體不能晉升（「僅限人」）；管道不能晉升；有指定負責人時只限他們 | 403 `agent_cannot_promote` |

而 `owner` 角色只能發給人（`kind: human`），所以智能體無論如何都確認不了。後台登入的管理員（會話身份 `admin`）和人類負責人金鑰不受影響。

## 2. 設計

不新增金鑰類型或角色，只在現有的「智能體 + 貢獻者（生產 + 消費）」金鑰上**疊加**一項附加權限（scope）`assertions:confirm`，由管理員逐把授予：

- 只能疊加在 `kind: agent`、`role: contributor` 的金鑰上；其他組合（只讀智能體、人類金鑰、管道）返回 400 `invalid_scope`。人類負責人本來就能確認，不需要它。
- 貢獻者角色不會自動得到它；疊加後金鑰仍是「智能體 + 貢獻者」，不會變成負責人或管理員。
- 授予、收回立即生效，不需要重啟。

持有它的金鑰（下稱「授權金鑰」）在三個確認端點上走一條受控的路徑，負責人的路徑不變：

| | 負責人（人）、管理員 | 授權金鑰 |
| --- | --- | --- |
| 能確認的條目 | 斷言、綁定、關係 | **只限斷言**；綁定、關係返回 403 `scope_mismatch` |
| 指定負責人（主體 `ownerIds`） | 只限名單中的人 | 同樣受限：金鑰 ID 不在名單中返回 403 |
| 審閱版本 `version` | 批量必須附；單條可不附（保持原行為） | **單條與批量都必須附**，不附返回 400 `version_required` |
| 層級 | L1、L2 → L0；單條不附版本時可對 L0 續期 | L1、L2 → L0（不續期） |
| 證據 | L0 必須有客體證據或來源；沒有時可在確認請求的 `evidence` 中一併提供 | 同左 |
| 有效期 | 可用 `expiryDays` 自訂 | 按規則參數計算，`expiryDays` 被忽略並返回 warning |
| 記錄的確認方式 `validity.method` | `manual` | `delegated` |

其他負責人操作（判定失效、裁決衝突、`validate-all`、動力層配置、規則參數）不受這項權限影響，授權金鑰調用照舊返回 403。

**說明（note）只是審計資料。** 系統只根據金鑰本身的權限判斷能否確認，`note` 裡寫什麼都不影響判斷。系統也無法驗證「用戶真的審閱過」：授予這項權限，就是管理員決定信任這把金鑰轉達的用戶確認。

### 保留的業務規則

- L1 和 L2 都可以確認為 L0。L0 的定義是「有客體證據，已驗證」，所以證據要求保留：沒有客體證據或來源時返回 409 `missing_evidence`。L2 通常就是因為沒有證據才是 L2，確認時在該條的 `evidence`（`objectIds` 或 `sourceRef`）中附上用戶審閱所依據的來源即可一步到 L0；層級歷史會先記一條 L2 → L1「補充客體證據」，再記 L1 → L0。提交時就帶了來源的 L2 直接 L2 → L0。
- E1 不能晉升（409 `invalid_transition`）；已是 L0 返回 409 `already_confirmed`。
- 審閱版本 `reviewVersion` 是條目當前內容（含有效性與歷史）的 SHA-256，按寫入倉庫時的形態計算，服務重新載入（例如回滾或拉取遠端）後不會變。內容在審閱後變了，返回 409 `stale_assertion`（`/assertions/confirm-batch`）或 `stale_item`（其餘兩個端點），需要重新讀取、重新審閱。審閱版本在併入 `evidence` 之前核對。
- 批量在一個事務、一次 Git 提交中完成：任何一條不符（版本、層級、證據、權限），整批回滾，不會部分成功。
- 有效期、層級歷史、健康指標（`/metrics` 的層級分佈、L0 覆蓋率）沿用原有的更新邏輯；確認同時關閉指向這條斷言的未處理反饋。

### 審計

每次授權確認都留下兩處記錄，都不含金鑰原文（服務端只存金鑰的 SHA-256）：

- **層級歷史**（`validity.history` 的最後一條）：`by`（金鑰 ID，例如 `agent-3f9a1c2d`）、`at`、`from: L1`（或 `L2`）、`to: L0`、`reason: 授權確認（API 金鑰 assertions:confirm）`、`version`（審閱版本）、`scope`、`note`。`validity.verifiedBy` 也是金鑰 ID。
- **Git 提交**：作者是金鑰名稱，郵箱 `<金鑰 ID>@agent.knowledge`；提交說明帶「授權金鑰 名稱（金鑰 ID，assertions:confirm）」。

負責人帶版本確認時，層級歷史也會記下 `version`。

## 3. 為金鑰授予權限

**後台**：用管理員密碼登入 › 接入 › API 金鑰。發放新金鑰時選「智能體」「貢獻者」，勾選「附加權限：允許確認斷言為 L0」（其他組合不顯示這個勾選框）；已有的「智能體 + 貢獻者」金鑰在操作欄點「授予確認權限」或「收回確認權限」。列表的「附加權限」欄顯示目前的權限和授予時間。

**命令列**（管理員介面只接受管理員密碼登入的會話）：

```bash
BASE=http://localhost:8080
# 1. 用管理員密碼登入，保存會話 cookie
curl -s -c /tmp/kb.cookie -H 'Content-Type: application/json' \
  -d '{"password":"<管理員密碼>"}' "$BASE/admin/api/login" >/dev/null
# 2. 查金鑰 ID 與目前權限
curl -s -b /tmp/kb.cookie "$BASE/admin/api/keys"
# 3a. 授予已有金鑰（scopes 是完整列表）
curl -s -b /tmp/kb.cookie -X PATCH -H 'Content-Type: application/json' \
  -d '{"scopes":["assertions:confirm"]}' "$BASE/admin/api/keys/agent-3f9a1c2d"
# 3b. 或者發放一把新金鑰時一起授予（secret 只返回這一次）
curl -s -b /tmp/kb.cookie -H 'Content-Type: application/json' \
  -d '{"name":"審核助手","kind":"agent","role":"contributor","scopes":["assertions:confirm"]}' "$BASE/admin/api/keys"
# 收回：-d '{"scopes":[]}'
rm -f /tmp/kb.cookie
```

`PATCH /admin/api/keys/{id}` 只修改傳入的欄位：只傳 `scopes` 不會改動停用狀態，只傳 `disabled` 不會改動權限。

## 4. 調用

先讀取，拿到每條的 `reviewVersion`，交給用戶審閱：

```bash
curl -s -H "Authorization: Bearer $KEY" "$BASE/api/v1/assertions?subjectId=S-INV-0901&level=L1"
# L2 用 level=L2；或單條：GET /api/v1/items/A-0901（回應同樣帶 reviewVersion）
```

用戶明確同意後確認（批量）：

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  "$BASE/api/v1/assertions/confirm-batch" -d '{
    "items": [
      {"id": "A-0901", "version": "<reviewVersion>"},
      {"id": "A-0902", "version": "<reviewVersion>", "evidence": {"sourceRef": "https://wiki.example/inventory/rules-v2"}}
    ],
    "note": "用戶已審核並明確確認上述斷言晉升為 L0"
  }'
```

A-0901 是 L1（已有證據）；A-0902 是沒有證據的 L2，所以附上用戶審閱所依據的來源（`sourceRef`，或已登記客體的 `objectIds`）。

單條：`POST /api/v1/items/A-0901/confirm`，body `{"version": "<reviewVersion>", "note": "…", "evidence": {…}}`（`evidence` 選填）。`POST /api/v1/items/confirm-batch` 也可以用，但授權金鑰的批量裡只能有斷言。

成功回應：

```json
{
  "data": [
    { "id": "A-0901", "level": "L0", "expiresAt": "2027-02-24T03:00:00.000Z", "method": "delegated", "verifiedBy": "agent-3f9a1c2d" },
    { "id": "A-0902", "level": "L0", "expiresAt": "2027-02-24T03:00:00.000Z", "method": "delegated", "verifiedBy": "agent-3f9a1c2d" }
  ],
  "commit": "a1b2c3d",
  "warnings": []
}
```

### 錯誤

| 情況 | 狀態 | `error.code` |
| --- | --- | --- |
| 沒有憑證、金鑰無效或已停用 | 401 | `unauthorized` |
| 金鑰沒有 `assertions:confirm`，也不是負責人 | 403 | `forbidden` |
| 授權金鑰確認綁定或關係 | 403 | `scope_mismatch` |
| 主體有指定負責人，金鑰不在名單中 | 403 | `forbidden` |
| 沒附 `version`（授權金鑰） | 400 | `version_required` |
| 批量參數不完整（缺 `id` / `version`、重複 ID、`evidence` 不是物件） | 400 | `invalid_input` |
| 對只讀智能體、人類金鑰或管道授予這項權限 | 400 | `invalid_scope` |
| `evidence.objectIds` 中的客體不存在 | 422 | `unknown_object` |
| 審閱後內容已變 | 409 | `stale_assertion` / `stale_item` |
| 已是 L0 | 409 | `already_confirmed` |
| E1 | 409 | `invalid_transition` |
| L1 / L2 沒有證據，請求中也沒有附 `evidence` | 409 | `missing_evidence` |

## 5. 相容性

- 現有負責人、管理員的確認流程和請求格式不變，負責人也能確認 L2（有證據或在請求中附 `evidence` 時）。原先「L2 不能直接晉升 L0」返回 409 `invalid_transition`，現在 L2 有證據就晉升、沒有證據返回 409 `missing_evidence`。批量裡已是 L0 或 E1 的條目原先一律返回 409 `stale_*`，現在仍是 409，但 `code` 更具體（`already_confirmed`、`invalid_transition`）。`/assertions/confirm-batch` 裡混入非斷言時，原先返回 409 `stale_assertion`，現在返回 400 `not_assertion`。
- 審閱版本改為按寫入倉庫時的形態計算，升級後所有條目的 `reviewVersion` 會變一次：升級前讀到、升級後才提交的確認會返回 409，重新讀取即可。
- 舊的金鑰記錄沒有 `scopes` 欄位，按「沒有附加權限」處理，不需要遷移；升級不修改任何知識。
- `GET /items/{id}` 多返回 `reviewVersion`；確認的回應多返回 `method`、`verifiedBy`。

實作：`src/store/model.js`（權限常量）、`src/api/auth.js`（`requireConfirm`）、`src/store/store.js`（`confirmMode`、`assertReviewed`、`confirm`）、`src/store/validity.js`（`delegated` 方式與審計欄位）、`src/config.js`（金鑰權限的存取）。測試：`test/confirm-scope.test.js`。
