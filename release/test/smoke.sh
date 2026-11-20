#!/usr/bin/env bash
# 一鍵安裝冒煙測試（Linux / macOS）：在本機模擬 4 個下載來源，驗證 install.sh 的測速選源、SHA-256 校驗與回退、
# 安裝、後台啟動、登入、重複執行（已是最新）、強制重裝（資料保留）與停止。
#   bash release/build.sh && bash release/test/smoke.sh
# 來源（列表順序 = install.sh 的優先順序，第一個視為官方來源）：
#   good     正常，限速 4 MB/s
#   dead     無法連接
#   slow     代理形式網址，限速 64 KB/s
#   corrupt  不限速但發佈包被篡改 → 測速最快、會被選中，校驗失敗後必須回退到 good
# SMOKE_REAL_NODE=1 時另外強制從 nodejs.org（另加一個不可達鏡像）下載獨立的 Node.js，驗證下載、校驗、解壓。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST="${1:-$ROOT/dist}"
[ -f "$DIST/SHA256SUMS" ] || { echo "找不到 $DIST/SHA256SUMS，請先執行 bash release/build.sh" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/knowledge-smoke.XXXXXX")"
PREFIX="$WORK/home with space"
# 不動真實的家目錄：knowledge 命令會連結到這個臨時 HOME 的 ~/.local/bin
export HOME="$WORK/user"
export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME"
PIDS=()
cleanup() {
  "$PREFIX/bin/knowledge" stop >/dev/null 2>&1 || true
  for p in "${PIDS[@]+"${PIDS[@]}"}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; [ -f "$WORK/install.log" ] && tail -n 60 "$WORK/install.log" >&2; exit 1; }

# start_mirror <名稱> [mirror-server 參數]：啟動模擬來源，端口寫入 MIRROR_PORT
start_mirror() {
  local name="$1"; shift
  node "$ROOT/release/test/mirror-server.js" --dir "$DIST" "$@" > "$WORK/$name.port" &
  PIDS+=("$!")
  for _ in $(seq 1 50); do
    if grep -q listening "$WORK/$name.port" 2>/dev/null; then MIRROR_PORT="$(awk '{print $2}' "$WORK/$name.port")"; return 0; fi
    sleep 0.1
  done
  fail "模擬來源 $name 沒有啟動"
}

start_mirror good --throttle 4194304; GOOD="$MIRROR_PORT"
start_mirror slow --throttle 65536; SLOW="$MIRROR_PORT"
start_mirror corrupt --corrupt; CORRUPT="$MIRROR_PORT"
APP_PORT=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')

export KNOWLEDGE_GITHUB_MIRRORS="http://127.0.0.1:$GOOD http://127.0.0.1:1 http://127.0.0.1:$SLOW/https://github.com http://127.0.0.1:$CORRUPT"
export KNOWLEDGE_PROBE_TIME=3 KNOWLEDGE_CONNECT_TIMEOUT=2 KNOWLEDGE_SUMS_TIME=5
EXTRA=()
if [ -n "${SMOKE_REAL_NODE:-}" ]; then
  export KNOWLEDGE_NODE_MIRRORS="https://nodejs.org/dist http://127.0.0.1:1"
  EXTRA+=(--force-node)
fi
VERSION="$(sed -n 's/.*  knowledge_setup-\(v[^ ]*\)\.tar\.gz$/\1/p' "$DIST/SHA256SUMS")"

echo "== 1. 首次安裝（期望：選中 corrupt → 校驗失敗 → 回退 good）"
bash "$DIST/install.sh" --prefix "$PREFIX" --port "$APP_PORT" "${EXTRA[@]+"${EXTRA[@]}"}" 2>&1 | tee "$WORK/install.log"
[ "${PIPESTATUS[0]}" = 0 ] || fail "install.sh 失敗"
grep -q "SHA-256 校驗失敗（來源 127.0.0.1:$CORRUPT" "$WORK/install.log" || fail "沒有拒絕被篡改的發佈包"
grep -q "下載發佈包 $VERSION（來源 127.0.0.1:$GOOD）" "$WORK/install.log" || fail "沒有回退到正常來源"
if grep -q "127.0.0.1:1 .*無法連接" "$WORK/install.log"; then fail "不可達來源不應進入測速（取 SHA256SUMS 時已排除）"; fi
grep -q "已啟動" "$WORK/install.log" || fail "服務沒有啟動"
grep -q "不可用（已跳過）：127.0.0.1:1$" "$WORK/install.log" || fail "沒有報告不可達的來源"
[ "$(command -v knowledge)" = "$HOME/.local/bin/knowledge" ] || fail "knowledge 命令沒有連結到 ~/.local/bin"
if [ -n "${SMOKE_REAL_NODE:-}" ]; then
  [ -x "$PREFIX/runtime/node/bin/node" ] || fail "沒有安裝獨立的 Node.js"
  grep -q "Node.js v.* 已安裝到" "$WORK/install.log" || fail "沒有下載 Node.js"
fi

echo "== 2. 服務可用、管理員可用初始密碼登入"
curl -fsS "http://127.0.0.1:$APP_PORT/api/v1/prompt" -o /dev/null || fail "/api/v1/prompt 不可用"
PW="$("$PREFIX/bin/knowledge" password)"
[ -n "$PW" ] || fail "沒有初始密碼"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d "{\"password\":\"$PW\"}" "http://127.0.0.1:$APP_PORT/admin/api/login")
[ "$code" = 200 ] || fail "初始密碼登入失敗（HTTP $code）"
knowledge status | tee "$WORK/status.log"
grep -q "運行中" "$WORK/status.log" || fail "status 不是運行中"
if [ -n "${SMOKE_REAL_NODE:-}" ]; then grep -q "runtime/node/bin/node" "$WORK/status.log" || fail "沒有使用獨立的 Node.js"; fi
[ "$("$PREFIX/bin/knowledge" version)" = "$VERSION" ] || fail "版本不符"

echo "== 3. 再次執行：已是最新版本，服務保持運行"
PID_BEFORE="$(cat "$PREFIX/run/knowledge.pid")"
bash "$DIST/install.sh" --prefix "$PREFIX" 2>&1 | tee "$WORK/install2.log"
grep -q "已是最新版本 $VERSION" "$WORK/install2.log" || fail "沒有識別已是最新版本"
[ "$(cat "$PREFIX/run/knowledge.pid")" = "$PID_BEFORE" ] || fail "不應重啟服務"

echo "== 4. --force 重裝：停止 → 替換程式 → 啟動，資料與設定保留"
echo "# smoke-marker" >> "$PREFIX/config.env"
bash "$DIST/install.sh" --prefix "$PREFIX" --force --mirror "http://127.0.0.1:$GOOD" 2>&1 | tee "$WORK/install3.log"
grep -q "停止正在運行的舊版本" "$WORK/install3.log" || fail "沒有先停止舊版本"
grep -q "smoke-marker" "$PREFIX/config.env" || fail "config.env 被覆蓋"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d "{\"password\":\"$PW\"}" "http://127.0.0.1:$APP_PORT/admin/api/login")
[ "$code" = 200 ] || fail "重裝後原密碼登入失敗（資料沒有保留？HTTP $code）"

echo "== 5. 從本地發佈包安裝（離線）"
"$PREFIX/bin/knowledge" stop
bash "$DIST/install.sh" --prefix "$WORK/offline" --package "$DIST/knowledge_setup-$VERSION.tar.gz" --no-start 2>&1 | tee "$WORK/install4.log"
grep -q "SHA-256 校驗通過" "$WORK/install4.log" || fail "本地發佈包沒有校驗"
[ -f "$WORK/offline/app/src/server.js" ] || fail "本地發佈包沒有安裝"

echo "== 6. 停止"
if "$PREFIX/bin/knowledge" status >/dev/null; then fail "stop 後仍在運行"; fi
if curl -fsS -m 2 "http://127.0.0.1:$APP_PORT/api/v1/prompt" -o /dev/null 2>/dev/null; then fail "stop 後端口仍可訪問"; fi

echo "PASS"
