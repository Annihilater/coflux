#!/usr/bin/env bash
# Shared helpers for the Mac-side preparation scripts.
set -euo pipefail

MAC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
KIT_DIR=$(cd "$MAC_DIR/.." && pwd)
REPO_DIR=$(cd "$KIT_DIR/../.." && pwd)

if [[ ! -f "$KIT_DIR/site.conf" ]]; then
  printf '错误: 没有 %s\n先执行: cp %s %s\n' "$KIT_DIR/site.conf" "$KIT_DIR/site.conf.example" "$KIT_DIR/site.conf" >&2
  exit 1
fi
# shellcheck disable=SC1091
source "$KIT_DIR/site.conf"

die() { printf '错误: %s\n' "$*" >&2; exit 1; }

: "${PUBLIC_IP:?site.conf 里要填写 PUBLIC_IP}"
[[ "$PUBLIC_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "PUBLIC_IP 必须是 IPv4: $PUBLIC_IP"
[[ "$PUBLIC_IP" != "203.0.113.10" ]] || die "PUBLIC_IP 还是示例地址，换成云主机的公网地址"

CENTRE_PORT=${CENTRE_PORT:-40443}
DERP_PORT=${DERP_PORT:-40444}
STUN_PORT=${STUN_PORT:-40478}
REGION_ID=${REGION_ID:-901}
ARCH=${ARCH:-amd64}
NODE_MODE=${NODE_MODE:-tarball}
NODE_VERSION=${NODE_VERSION:-22.23.3}
NODE_MIRROR=${NODE_MIRROR:-https://npmmirror.com/mirrors/node}
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}
GOPROXY=${GOPROXY:-https://goproxy.cn,direct}
SRC_REV=${SRC_REV:-HEAD}
SSH_PORT=${SSH_PORT:-22}
PKI_DIR=${PKI_DIR:-$HOME/.coflux-private-ca}

case "$ARCH" in
  amd64) NODE_ARCH=x64 ;;
  arm64) NODE_ARCH=arm64 ;;
  *) die "ARCH 只能是 amd64 或 arm64" ;;
esac

if [[ -x /opt/homebrew/opt/openssl@3/bin/openssl ]]; then
  OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl
elif [[ -x /usr/local/opt/openssl@3/bin/openssl ]]; then
  OPENSSL=/usr/local/opt/openssl@3/bin/openssl
else
  OPENSSL=$(command -v openssl)
fi
[[ -n "$OPENSSL" ]] || die "找不到 openssl"

mkdir -p "$PKI_DIR"
chmod 700 "$PKI_DIR"

pin_of() {
  "$OPENSSL" x509 -in "$1" -outform DER | "$OPENSSL" dgst -sha256 -r | awk '{print $1}'
}
