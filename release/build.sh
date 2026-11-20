#!/usr/bin/env bash
# 打包發佈包：在 dist/ 產出通用發佈包（已含生產依賴，Linux / macOS / Windows 通用）、安裝腳本與 SHA256SUMS。
#   bash release/build.sh            版本取 package.json
#   bash release/build.sh v0.2.0     指定版本（Release 流水綫傳入標籤名）
# 產物：
#   dist/knowledge_setup-vX.Y.Z.tar.gz   Linux / macOS
#   dist/knowledge_setup-vX.Y.Z.zip      Windows
#   dist/install.sh  dist/install.ps1    一鍵安裝腳本
#   dist/SHA256SUMS                      上述檔案的 SHA-256，安裝腳本據此校驗
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PKG_VERSION="$(node -p "require('./package.json').version")"
VERSION="${1:-v$PKG_VERSION}"
VERSION="v${VERSION#v}"
NAME="knowledge_setup-$VERSION"
DIST="$ROOT/dist"
STAGE="$DIST/stage/$NAME"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

echo "==> 打包 $NAME"
rm -rf "$DIST"
mkdir -p "$STAGE"

cp -R src web scripts package.json package-lock.json README.md .env.example "$STAGE/"
cp -R release/bin "$STAGE/bin"
cp release/install.sh release/install.ps1 "$STAGE/"
chmod +x "$STAGE/bin/knowledge" "$STAGE/install.sh"
printf '%s\n' "$VERSION" > "$STAGE/VERSION"

echo "==> 安裝生產依賴（只含純 JS 套件，各平台通用）"
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

echo "==> 產生壓縮包"
TAR_OPTS=()
if tar --version 2>/dev/null | grep -q 'GNU tar'; then TAR_OPTS=(--owner=0 --group=0 --numeric-owner --sort=name); fi
tar "${TAR_OPTS[@]+"${TAR_OPTS[@]}"}" -czf "$DIST/$NAME.tar.gz" -C "$DIST/stage" "$NAME"
(cd "$DIST/stage" && zip -qr -X "$DIST/$NAME.zip" "$NAME")
cp release/install.sh release/install.ps1 "$DIST/"
rm -rf "$DIST/stage"

(cd "$DIST" && sha256 "$NAME.tar.gz" "$NAME.zip" install.sh install.ps1 > SHA256SUMS)

echo "==> 完成：$DIST"
(cd "$DIST" && ls -l && cat SHA256SUMS)
