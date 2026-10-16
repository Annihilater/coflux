#!/usr/bin/env bash
# Replace the leaf on a centre that keeps the same public IP. Afterwards, do not re-run install from an older bundle.
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { printf '错误: 用 root 运行\n' >&2; exit 1; }
src=${1:?用法: coflux-rotate-leaf <含 server.crt server.key pin.txt 的目录>}
[[ -f "$src/server.crt" && -f "$src/server.key" && -f "$src/pin.txt" ]] || { printf '错误: 目录里要有 server.crt、server.key、pin.txt\n' >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/coflux/site.conf
openssl x509 -in "$src/server.crt" -noout -ext subjectAltName | grep -q "IP Address:${PUBLIC_IP}" || {
  printf '错误: 新证书的 SAN 不是 %s。地址变了要重新 prepare，再跑 install.sh。\n' "$PUBLIC_IP" >&2
  exit 1
}
old=$(tr -d ' \n' < /etc/coflux/tls/pin.txt)
new=$(tr -d ' \n' < "$src/pin.txt")
[[ "$new" =~ ^[0-9a-f]{64}$ ]] || { printf '错误: pin.txt 不是 64 位十六进制\n' >&2; exit 1; }
install -m 0644 -o root -g coflux-tls "$src/server.crt" /etc/coflux/tls/server.crt
install -m 0640 -o root -g coflux-tls "$src/server.key" /etc/coflux/tls/server.key
install -m 0644 "$src/pin.txt" /etc/coflux/tls/pin.txt
if [[ -f "$src/ca.crt" ]]; then
  install -m 0644 "$src/ca.crt" /etc/coflux/tls/ca.crt
fi
if [[ "$old" != "$new" ]]; then
  grep -q "$old" /etc/coflux/server.env || { printf '错误: server.env 里找不到旧指纹\n' >&2; exit 1; }
  sed -i "s/${old}/${new}/g" /etc/coflux/server.env
fi
systemctl restart coflux-derp caddy coflux-server
printf '叶子已换上。指纹 %s\n' "$new"
