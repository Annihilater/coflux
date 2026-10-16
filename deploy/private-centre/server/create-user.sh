#!/usr/bin/env bash
# Create a password account. The password is read from the terminal; create-user.mjs still receives it as an argument.
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { printf '错误: 用 root 运行\n' >&2; exit 1; }
[[ -n "${COFLUX_USER_EMAIL:-}" ]] || { printf '错误: 先 export COFLUX_USER_EMAIL=you@example.com\n' >&2; exit 1; }
read -r -s -p "密码: " password
printf '\n'
[[ -n "$password" ]] || { printf '错误: 密码是空的\n' >&2; exit 1; }
node=$(tr -d ' \n' < /etc/coflux/node-bin)
set -a
# shellcheck disable=SC1091
source /etc/coflux/server.env
set +a
"$node" /opt/coflux/create-user.mjs --email "$COFLUX_USER_EMAIL" --password "$password"
