#!/usr/bin/env bash
# Open only SSH, the centre, DERP, and STUN. Do this before Caddy is installed: the Caddy package binds port 80.
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
need_root

ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp"
ufw allow "${CENTRE_PORT}/tcp"
ufw allow "${DERP_PORT}/tcp"
ufw allow "${STUN_PORT}/udp"
ufw --force enable
ufw status verbose
printf '云安全组要放行同样的四个端口，不要放行 80、443、5432、8787、8793。\n'
