#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
need_root

[[ -x "$BUNDLE/bin/caddy" ]] || die "物料包里没有 caddy"
install -d -m 0755 /opt/coflux-caddy /etc/caddy
install -m 0755 "$BUNDLE/bin/caddy" /opt/coflux-caddy/caddy
id caddy >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin caddy
usermod -aG coflux-tls caddy

sed \
  -e "s|{{PUBLIC_IP}}|${PUBLIC_IP}|g" \
  -e "s|{{CENTRE_PORT}}|${CENTRE_PORT}|g" \
  "$BUNDLE/templates/Caddyfile.tmpl" > /etc/caddy/Caddyfile
/opt/coflux-caddy/caddy validate --config /etc/caddy/Caddyfile

install -m 0644 "$BUNDLE/templates/coflux-caddy.service" /etc/systemd/system/coflux-caddy.service
systemctl daemon-reload
systemctl enable coflux-caddy
systemctl restart coflux-caddy
printf 'Caddy 已用包里的二进制启动\n'
