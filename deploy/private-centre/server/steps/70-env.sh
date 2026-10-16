#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
need_root
umask 077

if [[ ! -s /etc/coflux/derp-admission.token ]]; then
  openssl rand -hex 32 > /etc/coflux/derp-admission.token
  chmod 600 /etc/coflux/derp-admission.token
fi
# lib.sh was sourced before the token file existed on a first run.
ADMISSION_TOKEN=$(tr -d ' \n' < /etc/coflux/derp-admission.token)
DB_PASSWORD=$(tr -d ' \n' < /etc/coflux/pg-coflux.pass)
DERP_PIN=$(tr -d ' \n' < /etc/coflux/tls/pin.txt)
[[ "$DERP_PIN" =~ ^[0-9a-f]{64}$ ]] || die "pin.txt 不是 64 位十六进制"
[[ "$ADMISSION_TOKEN" =~ ^[0-9a-f]{64}$ ]] || die "准入 token 不是 64 位十六进制"

render "$BUNDLE/templates/server.env.tmpl" /etc/coflux/server.env
render "$BUNDLE/templates/derp.env.tmpl" /etc/coflux/derp.env
chmod 600 /etc/coflux/server.env /etc/coflux/derp.env
chown root:root /etc/coflux/server.env /etc/coflux/derp.env

set -a
# shellcheck disable=SC1091
source /etc/coflux/server.env
set +a
"$NODE_BIN" -e 'JSON.parse(process.env.COFLUX_DERP_REGIONS)'
stat -c %a /etc/coflux/server.env | grep -qx 600
printf '环境文件已写入 /etc/coflux/server.env 和 derp.env\n'
