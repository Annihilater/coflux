#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
need_root
export DEBIAN_FRONTEND=noninteractive

keyring=/usr/share/keyrings/caddy-stable-archive-keyring.gpg
list=/etc/apt/sources.list.d/caddy-stable.list
tmp=$(mktemp)
if curl -fsSL --max-time 30 -o "$tmp" https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  && curl -fsSL --max-time 30 -o "$list" https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt; then
  rm -f "$keyring"
  gpg --batch --yes --dearmor -o "$keyring" "$tmp"
  chmod o+r "$keyring" "$list"
  apt-get update
else
  printf 'Cloudsmith 不可达，改用 Debian 仓库里的 caddy\n' >&2
  rm -f "$list"
fi
rm -f "$tmp"
apt-get install -y caddy
systemctl stop caddy || true

id caddy >/dev/null 2>&1 || die "caddy 用户不存在"
usermod -aG coflux-tls caddy

sed \
  -e "s|{{PUBLIC_IP}}|${PUBLIC_IP}|g" \
  -e "s|{{CENTRE_PORT}}|${CENTRE_PORT}|g" \
  "$BUNDLE/templates/Caddyfile.tmpl" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy
printf 'Caddy 已用新的组成员身份启动\n'
