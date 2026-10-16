#!/usr/bin/env bash
# Build stock derper for the Debian host, and stunc for this Mac. Both come from the pinned Tailscale module.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

command -v go >/dev/null 2>&1 || die "准备机需要 Go。1.21 及以上即可，脚本会通过 GOTOOLCHAIN 使用 1.27.1。下载工具链失败时，自行安装 Go 1.27.1 后执行 GOTOOLCHAIN=local mac/30-build-derper.sh"

case "$(uname -m)" in
  arm64|aarch64) HOST_ARCH=arm64 ;;
  x86_64) HOST_ARCH=amd64 ;;
  *) die "不认识的本机架构: $(uname -m)" ;;
esac

mkdir -p "$PKI_DIR/bin"
export GOPROXY
export GOTOOLCHAIN="${GOTOOLCHAIN:-go1.27.1}"
export CGO_ENABLED=0

printf '编译 linux/%s derper …\n' "$ARCH"
(
  cd "$REPO_DIR/transport/tailcat"
  GOOS=linux GOARCH="$ARCH" go build -mod=readonly -trimpath -ldflags='-s -w' \
    -o "$PKI_DIR/bin/derper" tailscale.com/cmd/derper
  printf '编译 darwin/%s stunc …\n' "$HOST_ARCH"
  GOOS=darwin GOARCH="$HOST_ARCH" go build -mod=readonly -trimpath \
    -o "$PKI_DIR/bin/stunc" tailscale.com/cmd/stunc
)
chmod 755 "$PKI_DIR/bin/derper" "$PKI_DIR/bin/stunc"
file "$PKI_DIR/bin/derper"
printf 'derper 和 stunc 在 %s\n' "$PKI_DIR/bin"
