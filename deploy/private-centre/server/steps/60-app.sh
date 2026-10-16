#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
need_root

if systemctl list-unit-files coflux-server.service >/dev/null 2>&1; then
  systemctl stop coflux-server || true
fi

[[ -f "$BUNDLE/centre/coflux-server.mjs" && -f "$BUNDLE/centre/create-user.mjs" ]] || die "物料包里没有编译好的中心程序"

rm -rf /opt/coflux
mkdir -p /opt/coflux
install -m 0644 "$BUNDLE/centre/coflux-server.mjs" /opt/coflux/coflux-server.mjs
install -m 0644 "$BUNDLE/centre/create-user.mjs" /opt/coflux/create-user.mjs
printf '中心程序已放到 /opt/coflux\n'
