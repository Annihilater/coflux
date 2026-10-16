#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
need_root

install -d -m 0755 /opt/coflux-derp /usr/local/sbin /var/backups/coflux
install -m 0755 "$BUNDLE/bin/derper" /opt/coflux-derp/derper
install -m 0755 "$BUNDLE/server/pg-backup.sh" /usr/local/sbin/coflux-pg-backup
install -m 0755 "$BUNDLE/server/healthcheck.sh" /usr/local/sbin/coflux-healthcheck
install -m 0755 "$BUNDLE/server/create-user.sh" /usr/local/sbin/coflux-create-user
install -m 0755 "$BUNDLE/server/rotate-leaf.sh" /usr/local/sbin/coflux-rotate-leaf
printf '%s\n' "$BUNDLE" > /etc/coflux/bundle-path
chmod 644 /etc/coflux/bundle-path

render "$BUNDLE/templates/coflux-server.service.tmpl" /etc/systemd/system/coflux-server.service
render "$BUNDLE/templates/coflux-derp.service.tmpl" /etc/systemd/system/coflux-derp.service
install -m 0644 "$BUNDLE/templates/coflux-pg-backup.service" /etc/systemd/system/coflux-pg-backup.service
install -m 0644 "$BUNDLE/templates/coflux-pg-backup.timer" /etc/systemd/system/coflux-pg-backup.timer

systemctl daemon-reload
systemctl enable coflux-server coflux-derp coflux-pg-backup.timer
systemctl restart coflux-server

ready=0
for _ in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:8787/health >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || die "coflux-server 没有在 40 秒内通过 /health，看 journalctl -u coflux-server"

systemctl restart coflux-derp
systemctl restart caddy
systemctl start coflux-pg-backup.timer
printf '服务已启动\n'
