#!/usr/bin/env bash
# Device channel grants allow 5 s of clock skew. When the datacenter drops outbound NTP,
# keep the clock from an HTTPS Date header instead.
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
need_root

install -m 0755 "$BUNDLE/templates/coflux-httpdate.sh" /usr/local/sbin/coflux-httpdate
install -m 0644 "$BUNDLE/templates/coflux-httpdate.service" /etc/systemd/system/coflux-httpdate.service
install -m 0644 "$BUNDLE/templates/coflux-httpdate.timer" /etc/systemd/system/coflux-httpdate.timer
systemctl daemon-reload
systemctl enable --now coflux-httpdate.timer
systemctl start coflux-httpdate.service || printf '警告: 校时失败，检查服务器能否访问 HTTPS 外网\n' >&2
printf '时钟校准定时任务已启用（每 10 分钟）\n'
