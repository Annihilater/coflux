#!/usr/bin/env bash
# Install or re-apply a private-centre bundle. Idempotent: database password and admission token are kept.
# The public IP may be passed as PUBLIC_IP, already written in site.conf, or detected from this host.
set -euo pipefail
BUNDLE=$(cd "$(dirname "$0")/.." && pwd)
export BUNDLE
cd "$BUNDLE"

if [[ ! -f "$BUNDLE/centre/coflux-server.mjs" || ! -f "$BUNDLE/site.conf" ]]; then
  printf '错误: 这不是打好的物料包。\n' >&2
  exit 1
fi

set_kv() {
  local key=$1 value=$2 file=$3
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

requested_ip=${PUBLIC_IP:-}
# shellcheck disable=SC1091
source "$BUNDLE/site.conf"
if [[ -n "$requested_ip" ]]; then
  PUBLIC_IP=$requested_ip
fi
if [[ -z "${PUBLIC_IP:-}" ]]; then
  PUBLIC_IP=$(curl -4 -fsS --max-time 15 https://ifconfig.me/ip || curl -4 -fsS --max-time 15 https://api.ipify.org || true)
  PUBLIC_IP=${PUBLIC_IP//$'\r'/}
  PUBLIC_IP=${PUBLIC_IP//$'\n'/}
fi
if [[ ! "$PUBLIC_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || "$PUBLIC_IP" == "203.0.113.10" ]]; then
  printf '错误: 没有可用的公网 IPv4（得到 %q）。\n在命令前写上这台机器的地址: PUBLIC_IP=x.x.x.x bash server/install.sh\n' "${PUBLIC_IP:-}" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64) ARCH=amd64; NODE_ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64; NODE_ARCH=arm64 ;;
  *) printf '错误: 不认识的架构 %s\n' "$(uname -m)" >&2; exit 1 ;;
esac
set_kv PUBLIC_IP "$PUBLIC_IP" "$BUNDLE/site.conf"
set_kv ARCH "$ARCH" "$BUNDLE/site.conf"

if [[ -f "$BUNDLE/bin/derper-$ARCH" ]]; then
  cp "$BUNDLE/bin/derper-$ARCH" "$BUNDLE/bin/derper"
  chmod 755 "$BUNDLE/bin/derper"
fi
[[ -f "$BUNDLE/bin/derper" ]] || { printf '错误: 物料包里没有 linux/%s 的 derper\n' "$ARCH" >&2; exit 1; }

if [[ ! -f "$BUNDLE/bin/node.tar.xz" && -f "$BUNDLE/bin/node-$NODE_ARCH.tar.xz" ]]; then
  cp "$BUNDLE/bin/node-$NODE_ARCH.tar.xz" "$BUNDLE/bin/node.tar.xz"
fi

if [[ ! -f "$BUNDLE/tls/server.crt" || ! -f "$BUNDLE/tls/pin.txt" ]]; then
  bash "$BUNDLE/server/issue-cert.sh" "$PUBLIC_IP" "$BUNDLE/tls"
fi

# shellcheck disable=SC1091
source "$BUNDLE/server/lib.sh"
need_root
[[ -f /etc/os-release ]] && . /etc/os-release
[[ "${ID:-}" == "debian" ]] || die "这套脚本只在 Debian 上运行（当前 ID=${ID:-未知}）"

printf '物料包 %s\n公网地址 %s\n架构 %s\n' "$BUNDLE" "$PUBLIC_IP" "$ARCH"
for step in "$BUNDLE"/server/steps/*.sh; do
  printf '\n==> %s\n' "$(basename "$step")"
  bash "$step"
done
printf '\n==> healthcheck\n'
bash "$BUNDLE/server/healthcheck.sh"
printf '\n安装完成。建号: COFLUX_USER_EMAIL=you@example.com /usr/local/sbin/coflux-create-user\n'
printf '这把 CA 在 %s/ca.crt 。编译客户端时把它当作 COFLUX_BUILD_CA_FILE，地址用 https://%s:%s\n' "$BUNDLE/tls" "$PUBLIC_IP" "${CENTRE_PORT:-8443}"
