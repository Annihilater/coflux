#!/usr/bin/env bash
# Shared helpers for scripts that run on the Debian host, from an unpacked bundle.
set -euo pipefail

export PATH="/usr/local/sbin:/usr/local/bin:${PATH}"
die() { printf '错误: %s\n' "$*" >&2; exit 1; }
need_root() { [[ "$(id -u)" -eq 0 ]] || die "用 root 运行"; }

if [[ -z "${BUNDLE:-}" ]]; then
  die "BUNDLE 未设置。由 server/install.sh 调用这些步骤。"
fi
[[ -f "$BUNDLE/site.conf" ]] || die "物料包里没有 site.conf"

# shellcheck disable=SC1091
source "$BUNDLE/site.conf"

: "${PUBLIC_IP:?site.conf 缺少 PUBLIC_IP}"
[[ "$PUBLIC_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "PUBLIC_IP 必须是 IPv4"
[[ "$PUBLIC_IP" != "203.0.113.10" ]] || die "PUBLIC_IP 还是示例地址"

CENTRE_PORT=${CENTRE_PORT:-40443}
DERP_PORT=${DERP_PORT:-40444}
STUN_PORT=${STUN_PORT:-40478}
REGION_ID=${REGION_ID:-901}
ARCH=${ARCH:-amd64}
NODE_MODE=${NODE_MODE:-tarball}
NODE_VERSION=${NODE_VERSION:-22.23.3}
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}
SSH_PORT=${SSH_PORT:-22}

case "$ARCH" in
  amd64) NODE_ARCH=x64 ;;
  arm64) NODE_ARCH=arm64 ;;
  *) die "ARCH 只能是 amd64 或 arm64" ;;
esac

if [[ -f /etc/coflux/node-bin ]]; then
  NODE_BIN=$(tr -d ' \n' < /etc/coflux/node-bin)
else
  NODE_BIN=/usr/local/bin/node
fi
if [[ -f "$BUNDLE/tls/pin.txt" ]]; then
  DERP_PIN=$(tr -d ' \n' < "$BUNDLE/tls/pin.txt")
else
  DERP_PIN=""
fi
DB_PASSWORD=""
ADMISSION_TOKEN=""
if [[ -f /etc/coflux/pg-coflux.pass ]]; then
  DB_PASSWORD=$(tr -d ' \n' < /etc/coflux/pg-coflux.pass)
fi
if [[ -f /etc/coflux/derp-admission.token ]]; then
  ADMISSION_TOKEN=$(tr -d ' \n' < /etc/coflux/derp-admission.token)
fi

render() {
  local template=$1 dest=$2
  [[ -n "$DB_PASSWORD" && -n "$ADMISSION_TOKEN" && -n "$DERP_PIN" ]] || die "渲染 $dest 时秘密或指纹还没准备好"
  sed \
    -e "s|{{PUBLIC_IP}}|${PUBLIC_IP}|g" \
    -e "s|{{CENTRE_PORT}}|${CENTRE_PORT}|g" \
    -e "s|{{DERP_PORT}}|${DERP_PORT}|g" \
    -e "s|{{STUN_PORT}}|${STUN_PORT}|g" \
    -e "s|{{REGION_ID}}|${REGION_ID}|g" \
    -e "s|{{DB_PASSWORD}}|${DB_PASSWORD}|g" \
    -e "s|{{ADMISSION_TOKEN}}|${ADMISSION_TOKEN}|g" \
    -e "s|{{DERP_PIN}}|${DERP_PIN}|g" \
    -e "s|{{NODE_BIN}}|${NODE_BIN}|g" \
    "$template" > "$dest"
}
