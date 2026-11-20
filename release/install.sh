#!/usr/bin/env bash
# knowledge_setup 一鍵安裝與啟動（Linux / macOS）
#
#   curl -fsSL https://github.com/ali-sx-org-free/knowledge_setup/releases/latest/download/install.sh | bash
#   # GitHub 慢時經代理取得腳本（腳本本身也會測速選源）：
#   curl -fsSL https://ghfast.top/https://github.com/ali-sx-org-free/knowledge_setup/releases/latest/download/install.sh | bash
#   # 帶參數：... | bash -s -- --port 9090
#
# 做的事：
#   1. 並行向 GitHub 與多個國內代理取得 SHA256SUMS，逐個測速，從最快的來源下載發佈包並校驗 SHA-256（校驗失敗自動換下一個）；
#   2. 沒有 Node.js 20+ 時，從 nodejs.org 與國內鏡像（npmmirror、清華、中科大、華為雲、騰訊雲、阿里雲）中測速選最快的下載；
#   3. 安裝到 ~/.knowledge_setup（資料、設定、日誌都在這裡，升級時保留），建立 knowledge 命令並在後台啟動服務。
# 再次執行即升級；已是最新版本時只確保服務在運行。
#
# 這個檔案要能在 macOS 自帶的 bash 3.2 上執行：不用關聯陣列、mapfile、${var,,} 等 bash 4 語法。
set -euo pipefail

REPO="${KNOWLEDGE_REPO:-ali-sx-org-free/knowledge_setup}"
PREFIX="${KNOWLEDGE_HOME:-$HOME/.knowledge_setup}"
VERSION="${KNOWLEDGE_VERSION:-latest}"
REF="${KNOWLEDGE_REF:-}"
PORT="${KNOWLEDGE_PORT:-}"
NODE_MAJOR="${KNOWLEDGE_NODE_MAJOR:-22}"
FORCE_NODE="${KNOWLEDGE_FORCE_NODE:-}"
LOCAL_PACKAGE=""
START=1
FORCE=""

# 下載來源（空格或換行分隔）。第一個是官方來源：可達時以它的校驗清單為準。
GITHUB_MIRRORS="${KNOWLEDGE_GITHUB_MIRRORS:-https://github.com https://ghfast.top/https://github.com https://gh-proxy.com/https://github.com https://ghproxy.net/https://github.com https://gh.llkk.cc/https://github.com}"
NODE_MIRRORS="${KNOWLEDGE_NODE_MIRRORS:-https://nodejs.org/dist https://registry.npmmirror.com/-/binary/node https://mirrors.tuna.tsinghua.edu.cn/nodejs-release https://mirrors.ustc.edu.cn/node https://repo.huaweicloud.com/nodejs https://mirrors.cloud.tencent.com/nodejs-release https://mirrors.aliyun.com/nodejs-release}"
NPM_REGISTRIES="${KNOWLEDGE_NPM_REGISTRIES:-https://registry.npmjs.org https://registry.npmmirror.com https://mirrors.cloud.tencent.com/npm https://repo.huaweicloud.com/repository/npm}"

# 測速參數：每個來源下載前 PROBE_BYTES 字節，最多 PROBE_TIME 秒。
PROBE_BYTES="${KNOWLEDGE_PROBE_BYTES:-524288}"
PROBE_TIME="${KNOWLEDGE_PROBE_TIME:-6}"
CONNECT_TIMEOUT="${KNOWLEDGE_CONNECT_TIMEOUT:-5}"
SUMS_TIME="${KNOWLEDGE_SUMS_TIME:-10}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die() { printf '\033[1;31m錯誤：\033[0m%s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
knowledge_setup 一鍵安裝與啟動

用法：install.sh [選項]

  --prefix DIR        安裝目錄（預設 ~/.knowledge_setup，環境變數 KNOWLEDGE_HOME）
  --version vX.Y.Z    安裝指定版本（預設最新版本）
  --ref BRANCH|TAG    從源碼安裝某個分支或標籤（尚未發佈的版本；依賴從最快的 npm 鏡像安裝）
  --package FILE      從本地發佈包安裝（離線；同目錄有 SHA256SUMS 時會校驗）
  --port PORT         服務端口（寫入 config.env，預設 8080）
  --mirror URL        只用這個 GitHub 來源，例如 https://ghfast.top/https://github.com
  --node-mirror URL   只用這個 Node.js 鏡像，例如 https://registry.npmmirror.com/-/binary/node
  --registry URL      只用這個 npm 鏡像（僅 --ref 時用到）
  --force-node        即使系統已有 Node.js 20+，也下載獨立的 Node.js 到安裝目錄
  --force             版本相同也重新安裝
  --no-start          只安裝，不啟動
  -h, --help          顯示說明

也可以用環境變數覆蓋來源列表：KNOWLEDGE_GITHUB_MIRRORS、KNOWLEDGE_NODE_MIRRORS、KNOWLEDGE_NPM_REGISTRIES（空格分隔）。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:?--prefix 需要目錄}"; shift 2 ;;
    --version) VERSION="${2:?--version 需要版本號}"; shift 2 ;;
    --ref) REF="${2:?--ref 需要分支或標籤}"; shift 2 ;;
    --package) LOCAL_PACKAGE="${2:?--package 需要檔案路徑}"; shift 2 ;;
    --port) PORT="${2:?--port 需要端口}"; shift 2 ;;
    --mirror) GITHUB_MIRRORS="${2:?--mirror 需要地址}"; shift 2 ;;
    --node-mirror) NODE_MIRRORS="${2:?--node-mirror 需要地址}"; shift 2 ;;
    --registry) NPM_REGISTRIES="${2:?--registry 需要地址}"; shift 2 ;;
    --force-node) FORCE_NODE=1; shift ;;
    --force) FORCE=1; shift ;;
    --no-start) START=""; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知選項：${1}（--help 查看用法）" ;;
  esac
done

case "$VERSION" in latest) ;; v*) ;; *) VERSION="v$VERSION" ;; esac
if [ -n "$PORT" ]; then case "$PORT" in *[!0-9]*) die "--port 必須是數字：$PORT" ;; esac; fi
case "$PREFIX" in /*) ;; *) PREFIX="$(pwd)/$PREFIX" ;; esac
PREFIX="${PREFIX%/}"

command -v curl >/dev/null 2>&1 || die "需要 curl，請先安裝（Debian/Ubuntu：sudo apt-get install -y curl）"
command -v tar >/dev/null 2>&1 || die "需要 tar"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/knowledge-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

if [ -t 2 ]; then PROGRESS="-#"; else PROGRESS="-sS"; fi

# ---------- 工具函數 ----------

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

# 來源的顯示名：https://ghfast.top/https://github.com/... → ghfast.top
label_of() { printf '%s' "$1" | sed -E 's#^[A-Za-z]+://##; s#/.*##'; }

fmt_speed() {
  awk -v s="$1" 'BEGIN { if (s >= 1048576) printf "%.1f MB/s", s / 1048576; else if (s >= 1024) printf "%.0f KB/s", s / 1024; else printf "%d B/s", s }'
}

# 校驗清單中的檔名與雜湊（兼容 "hash  name" 與 "hash *name"）
sums_names() { tr -d '\r' < "$1" | awk '{ f = $2; sub(/^\*/, "", f); print f }'; }
sums_hash() { tr -d '\r' < "$1" | awk -v n="$2" '{ f = $2; sub(/^\*/, "", f); if (f == n) { print $1; exit } }'; }

# fetch_sums <標記> <有效行正則> <url>...
# 並行從每個來源取得校驗清單。設定：
#   SUMS_ALIVE  取得成功的來源序號（空格分隔）
#   SUMS_REF    列表中第一個成功的序號（官方來源可達時就是官方）
#   SUMS_FILE   SUMS_REF 對應的清單檔
fetch_sums() {
  local tag="$1" re="$2" i=0 u
  shift 2
  for u in "$@"; do
    ( curl -fsSL --connect-timeout "$CONNECT_TIMEOUT" -m "$SUMS_TIME" -o "$TMP/$tag.sums.$i" "$u" 2>/dev/null || rm -f "$TMP/$tag.sums.$i" ) &
    i=$((i + 1))
  done
  wait
  SUMS_ALIVE=""
  SUMS_REF=""
  SUMS_FILE=""
  local down=""
  i=0
  for u in "$@"; do
    if [ -s "$TMP/$tag.sums.$i" ] && tr -d '\r' < "$TMP/$tag.sums.$i" | grep -Eq "$re"; then
      SUMS_ALIVE="$SUMS_ALIVE $i"
      if [ -z "$SUMS_REF" ]; then SUMS_REF=$i; SUMS_FILE="$TMP/$tag.sums.$i"; fi
    else
      down="$down${down:+、}$(label_of "$u")"
    fi
    i=$((i + 1))
  done
  [ -z "$down" ] || info "不可用（已跳過）：$down"
  [ -n "$SUMS_REF" ]
}

# rank_urls <說明> <url>...：逐個測速（順序測，避免互相搶頻寬），按速度從快到慢設定 RANKED（序號，空格分隔）。
rank_urls() {
  local what="$1" i=0 u out code size speed lines=""
  shift
  RANKED=""
  if [ $# -eq 1 ]; then RANKED=0; return 0; fi
  say "測試下載速度：$what"
  for u in "$@"; do
    out="$(curl -sL -o /dev/null -r "0-$((PROBE_BYTES - 1))" --connect-timeout "$CONNECT_TIMEOUT" -m "$PROBE_TIME" \
      -w '%{http_code} %{size_download} %{speed_download}' "$u" 2>/dev/null || true)"
    read -r code size speed <<EOF
$out
EOF
    code="${code:-000}"; size="${size%%.*}"; size="${size:-0}"; speed="${speed%%.*}"; speed="${speed:-0}"
    if { [ "$code" = 200 ] || [ "$code" = 206 ]; } && [ "$size" -gt 0 ]; then
      info "$(printf '%-28s %s' "$(label_of "$u")" "$(fmt_speed "$speed")")"
      lines="$lines$speed $i
"
    elif [ "$code" = 000 ]; then
      info "$(printf '%-28s %s' "$(label_of "$u")" "無法連接")"
    else
      info "$(printf '%-28s %s' "$(label_of "$u")" "不可用（HTTP ${code}）")"
    fi
    i=$((i + 1))
  done
  RANKED="$(printf '%s' "$lines" | sort -rn | awk '{ printf "%s ", $2 }')"
  [ -n "$RANKED" ]
}

# fastest_download <說明> <目標檔> <sha256|空> <url>...
# 測速後從最快的來源下載；給了 sha256 就校驗，失敗換下一個來源。
fastest_download() {
  local what="$1" dest="$2" sha="$3" i u got
  shift 3
  local urls=("$@")
  rank_urls "$what" "$@" || return 1
  for i in $RANKED; do
    u="${urls[$i]}"
    say "下載${what}（來源 $(label_of "$u")）"
    rm -f "$dest"
    if ! curl -fL $PROGRESS --connect-timeout "$CONNECT_TIMEOUT" --speed-limit 2048 --speed-time 30 --retry 2 -o "$dest" "$u"; then
      warn "從 $(label_of "$u") 下載失敗，換下一個來源"
      continue
    fi
    if [ -n "$sha" ]; then
      got="$(sha256_of "$dest")"
      if [ "$got" != "$sha" ]; then
        warn "SHA-256 校驗失敗（來源 $(label_of "$u")：期望 ${sha}，實際 ${got}），換下一個來源"
        continue
      fi
      info "SHA-256 校驗通過"
    elif ! tar -tzf "$dest" >/dev/null 2>&1; then
      warn "從 $(label_of "$u") 下載的壓縮包不完整，換下一個來源"
      continue
    fi
    return 0
  done
  return 1
}

# 把空格 / 換行分隔的列表拆成陣列 WORDS（關閉通配，網址中的 * ? 不會被展開）
# shellcheck disable=SC2206
split_words() { set -f; WORDS=($1); set +f; }

node_ok() { "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; }

# ---------- Node.js ----------

NODE_BIN=""
ensure_node() {
  local rt="$PREFIX/runtime/node/bin/node"
  if [ -x "$rt" ] && node_ok "$rt"; then
    NODE_BIN="$rt"
    info "Node.js $("$rt" -v)（安裝目錄內的獨立版本）"
    return 0
  fi
  if [ -z "$FORCE_NODE" ] && command -v node >/dev/null 2>&1 && node_ok node; then
    NODE_BIN="$(command -v node)"
    info "Node.js $(node -v)（系統已安裝：${NODE_BIN}）"
    return 0
  fi
  if command -v node >/dev/null 2>&1 && [ -z "$FORCE_NODE" ]; then
    info "系統的 Node.js $(node -v) 低於 20，下載獨立的 Node.js $NODE_MAJOR 到安裝目錄（不影響系統）"
  else
    info "下載獨立的 Node.js $NODE_MAJOR 到安裝目錄（不影響系統）"
  fi

  local os arch file ver sha i
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "不支持的系統 $(uname -s)；Windows 請用 install.ps1" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    ppc64le) arch=ppc64le ;;
    s390x) arch=s390x ;;
    *) die "不支持的 CPU 架構 $(uname -m)，請自行安裝 Node.js 20+ 後重試" ;;
  esac
  if [ "$os" = linux ] && { [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; }; then
    die "musl 系統（如 Alpine）沒有官方 Node.js 二進位，請先用套件管理器安裝 Node.js 20+（apk add nodejs npm）後重試"
  fi

  split_words "$NODE_MIRRORS"
  local mirrors=("${WORDS[@]}") urls=()
  for i in "${mirrors[@]}"; do urls+=("${i%/}/latest-v$NODE_MAJOR.x/SHASUMS256.txt"); done
  say "取得 Node.js $NODE_MAJOR 版本資訊"
  fetch_sums node "^[0-9a-f]{64} [ *]node-v[0-9.]+-$os-$arch\\.tar\\.gz\$" "${urls[@]}" \
    || die "所有 Node.js 鏡像都無法訪問；請檢查網絡，或自行安裝 Node.js 20+ 後重試"
  [ "$SUMS_REF" = 0 ] || warn "無法訪問 $(label_of "${mirrors[0]}")，Node.js 校驗值取自 $(label_of "${mirrors[$SUMS_REF]}")"
  file="$(sums_names "$SUMS_FILE" | grep -E "^node-v[0-9.]+-$os-$arch\\.tar\\.gz\$" | head -n 1)"
  ver="${file#node-}"; ver="${ver%%-*}"
  sha="$(sums_hash "$SUMS_FILE" "$file")"
  urls=()
  for i in $SUMS_ALIVE; do urls+=("${mirrors[$i]%/}/$ver/$file"); done
  fastest_download " Node.js $ver" "$TMP/$file" "$sha" "${urls[@]}" || die "Node.js 下載失敗"

  mkdir -p "$TMP/node" "$PREFIX/runtime"
  tar -xzf "$TMP/$file" -C "$TMP/node"
  rm -rf "$PREFIX/runtime/node"
  mv "$TMP/node/${file%.tar.gz}" "$PREFIX/runtime/node"
  NODE_BIN="$rt"
  info "Node.js $("$rt" -v) 已安裝到 $PREFIX/runtime/node"
}

# ---------- 發佈包 ----------

NEW_APP=""
NEW_VERSION=""

unpack_app() {
  local archive="$1" top
  rm -rf "$TMP/app"
  mkdir -p "$TMP/app"
  tar -xzf "$archive" -C "$TMP/app"
  top="$(find "$TMP/app" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -n "$top" ] && [ -f "$top/src/server.js" ] && [ -f "$top/package.json" ] || die "壓縮包內容不是 knowledge_setup"
  NEW_APP="$top"
}

installed_version() { cat "$PREFIX/app/VERSION" 2>/dev/null || true; }

fetch_release() {
  split_words "$GITHUB_MIRRORS"
  local mirrors=("${WORDS[@]}") urls=() m i file sha path
  if [ "$VERSION" = latest ]; then path="/$REPO/releases/latest/download/SHA256SUMS"; else path="/$REPO/releases/download/$VERSION/SHA256SUMS"; fi
  for m in "${mirrors[@]}"; do urls+=("${m%/}$path"); done
  say "取得發佈資訊（$REPO · ${VERSION}）"
  fetch_sums gh '^[0-9a-f]{64} [ *]knowledge_setup-v[^ ]+\.tar\.gz$' "${urls[@]}" \
    || die "所有來源都取不到 $VERSION 的發佈資訊。可能還沒有發佈版本（可用 --ref main 從源碼安裝），或網絡不通（可用 --mirror 指定可用的 GitHub 代理）"
  [ "$SUMS_REF" = 0 ] || warn "無法直接訪問 $(label_of "${mirrors[0]}")，校驗值取自 $(label_of "${mirrors[$SUMS_REF]}")"
  file="$(sums_names "$SUMS_FILE" | grep -E '^knowledge_setup-v[^ ]+\.tar\.gz$' | head -n 1)"
  NEW_VERSION="${file#knowledge_setup-}"; NEW_VERSION="${NEW_VERSION%.tar.gz}"
  sha="$(sums_hash "$SUMS_FILE" "$file")"
  info "版本 $NEW_VERSION"
  if [ -z "$FORCE" ] && [ "$(installed_version)" = "$NEW_VERSION" ]; then
    info "已是最新版本 ${NEW_VERSION}（重新安裝請加 --force）"
    return 0
  fi
  urls=()
  for i in $SUMS_ALIVE; do urls+=("${mirrors[$i]%/}/$REPO/releases/download/$NEW_VERSION/$file"); done
  fastest_download "發佈包 $NEW_VERSION" "$TMP/$file" "$sha" "${urls[@]}" || die "發佈包下載失敗；可稍後重試，或用 --mirror 指定其他 GitHub 代理"
  unpack_app "$TMP/$file"
}

fetch_local_package() {
  [ -f "$LOCAL_PACKAGE" ] || die "找不到發佈包：$LOCAL_PACKAGE"
  local dir name sha
  dir="$(cd "$(dirname "$LOCAL_PACKAGE")" && pwd)"
  name="$(basename "$LOCAL_PACKAGE")"
  if [ -f "$dir/SHA256SUMS" ]; then
    sha="$(sums_hash "$dir/SHA256SUMS" "$name")"
    if [ -n "$sha" ]; then
      [ "$(sha256_of "$LOCAL_PACKAGE")" = "$sha" ] || die "SHA-256 校驗失敗：$LOCAL_PACKAGE"
      info "SHA-256 校驗通過"
    fi
  fi
  say "從本地發佈包安裝：$LOCAL_PACKAGE"
  unpack_app "$LOCAL_PACKAGE"
  NEW_VERSION="$(cat "$NEW_APP/VERSION" 2>/dev/null || echo unknown)"
  if [ -z "$FORCE" ] && [ "$(installed_version)" = "$NEW_VERSION" ]; then
    info "已是版本 ${NEW_VERSION}（重新安裝請加 --force）"
    NEW_APP=""
  fi
}

fetch_source() {
  split_words "$GITHUB_MIRRORS"
  local mirrors=("${WORDS[@]}") urls=() m reg npm_cli
  for m in "${mirrors[@]}"; do urls+=("${m%/}/$REPO/archive/$REF.tar.gz"); done
  fastest_download "源碼 $REF" "$TMP/source.tar.gz" "" "${urls[@]}" || die "源碼下載失敗：$REPO@$REF"
  unpack_app "$TMP/source.tar.gz"
  [ -d "$NEW_APP/release/bin" ] || die "這個版本的源碼還沒有一鍵安裝支持（缺少 release/bin）"
  rm -rf "${NEW_APP:?}/bin"
  cp -R "$NEW_APP/release/bin" "$NEW_APP/bin"
  cp "$NEW_APP/release/install.sh" "$NEW_APP/release/install.ps1" "$NEW_APP/"
  chmod +x "$NEW_APP/bin/knowledge" "$NEW_APP/install.sh"
  NEW_VERSION="source:$REF"
  printf '%s\n' "$NEW_VERSION" > "$NEW_APP/VERSION"

  split_words "$NPM_REGISTRIES"
  local regs=("${WORDS[@]}") probes=()
  for reg in "${regs[@]}"; do probes+=("${reg%/}/express"); done
  rank_urls "npm 鏡像" "${probes[@]}" || die "所有 npm 鏡像都無法訪問"
  npm_cli="$(dirname "$NODE_BIN")/npm"
  [ -x "$npm_cli" ] || npm_cli="$(command -v npm || true)"
  [ -n "$npm_cli" ] || die "找不到 npm"
  for m in $RANKED; do
    reg="${regs[$m]%/}"
    say "安裝依賴（npm 鏡像 $(label_of "$reg")）"
    if (cd "$NEW_APP" && PATH="$(dirname "$NODE_BIN"):$PATH" "$npm_cli" ci --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error --registry "$reg/"); then
      return 0
    fi
    warn "經 $(label_of "$reg") 安裝依賴失敗，換下一個鏡像"
  done
  die "依賴安裝失敗"
}

# ---------- 安裝與啟動 ----------

set_config() {
  local key="$1" val="$2" cfg="$PREFIX/config.env"
  awk -v k="$key" -v v="$val" 'BEGIN { done = 0 } $0 ~ "^" k "=" { print k "=" v; done = 1; next } { print } END { if (!done) print k "=" v }' "$cfg" > "$cfg.tmp"
  mv "$cfg.tmp" "$cfg"
  chmod 600 "$cfg"
}

write_config() {
  local cfg="$PREFIX/config.env"
  if [ ! -f "$cfg" ]; then
    {
      echo "# knowledge_setup 設定檔（一行一個 鍵=值；值原樣使用，不做 shell 展開）"
      echo "# 修改後執行 knowledge restart 生效；同名環境變數優先於這裡的值。"
      echo "# DATA_DIR 的相對路徑相對於安裝目錄 $PREFIX"
      echo
      cat "$PREFIX/app/.env.example"
    } > "$cfg"
    chmod 600 "$cfg"
    info "已建立設定檔 $cfg"
  fi
  if [ -n "$PORT" ]; then set_config PORT "$PORT"; fi
}

link_command() {
  local wrapper="$PREFIX/bin/knowledge" dir
  mkdir -p "$PREFIX/bin"
  {
    echo '#!/usr/bin/env bash'
    printf 'exec %q "$@"\n' "$PREFIX/app/bin/knowledge"
  } > "$wrapper"
  chmod +x "$wrapper"
  LINKED=""
  for dir in "$HOME/.local/bin" /usr/local/bin; do
    case ":$PATH:" in *":$dir:"*) ;; *) continue ;; esac
    mkdir -p "$dir" 2>/dev/null || continue
    [ -w "$dir" ] || continue
    if [ -e "$dir/knowledge" ] && [ ! -L "$dir/knowledge" ]; then continue; fi
    ln -sf "$wrapper" "$dir/knowledge" && LINKED="$dir/knowledge" && break
  done
}

main() {
  say "安裝 knowledge_setup 到 $PREFIX"
  mkdir -p "$PREFIX"

  ensure_node
  command -v git >/dev/null 2>&1 || warn "沒有找到 git：知識以 Git 倉庫持久化，啟動前請先安裝（Debian/Ubuntu：sudo apt-get install -y git；macOS：xcode-select --install）"
  command -v ssh-keygen >/dev/null 2>&1 || info "提示：沒有 OpenSSH 客戶端，SSH 部署金鑰功能不可用（HTTPS 權杖不受影響）"

  if [ -n "$LOCAL_PACKAGE" ]; then fetch_local_package
  elif [ -n "$REF" ]; then fetch_source
  else fetch_release
  fi

  local was_running=""
  if [ -n "$NEW_APP" ]; then
    if [ -x "$PREFIX/app/bin/knowledge" ] && "$PREFIX/app/bin/knowledge" status >/dev/null 2>&1; then
      was_running=1
      say "停止正在運行的舊版本 $(installed_version)"
      "$PREFIX/app/bin/knowledge" stop || true
    fi
    rm -rf "$PREFIX/app.old"
    if [ -d "$PREFIX/app" ]; then mv "$PREFIX/app" "$PREFIX/app.old"; fi
    mv "$NEW_APP" "$PREFIX/app"
    rm -rf "$PREFIX/app.old"
    say "已安裝 $NEW_VERSION"
  fi
  [ -d "$PREFIX/app" ] || die "安裝目錄中沒有程式"

  write_config
  link_command

  if [ -n "$START" ] || [ -n "$was_running" ]; then
    "$PREFIX/bin/knowledge" start
  else
    say "已安裝，未啟動。啟動：$PREFIX/bin/knowledge start"
  fi

  echo
  if [ -n "$LINKED" ]; then
    info "命令：knowledge start | stop | restart | status | logs | upgrade（已連結到 ${LINKED}）"
  else
    info "命令：$PREFIX/bin/knowledge start | stop | restart | status | logs | upgrade"
    info "想直接輸入 knowledge，把下面這行加入 ~/.bashrc 或 ~/.zshrc："
    info "  export PATH=\"$PREFIX/bin:\$PATH\""
  fi
}

main
