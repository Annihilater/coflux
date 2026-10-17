#!/usr/bin/env bash
# Ports are opened on the cloud security group. This host does not install a firewall.
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
need_root
printf '不在这台机器上安装防火墙。请在云安全组放行 tcp/%s、tcp/%s、tcp/%s、udp/%s。\n' \
  "$SSH_PORT" "$CENTRE_PORT" "$DERP_PORT" "$STUN_PORT"
