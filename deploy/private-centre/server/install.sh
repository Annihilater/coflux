#!/usr/bin/env bash
# Install or re-apply a private-centre bundle. Idempotent: database password and admission token are kept.
set -euo pipefail
BUNDLE=$(cd "$(dirname "$0")/.." && pwd)
export BUNDLE

if [[ ! -f "$BUNDLE/src.tar.gz" || ! -f "$BUNDLE/site.conf" || ! -f "$BUNDLE/bin/derper" ]]; then
  printf '错误: 这不是打好的物料包。\n在准备机上运行 deploy/private-centre/mac/prepare.sh，把生成的 tar 拷到这台 Debian 上再解包。\n' >&2
  exit 1
fi

# shellcheck disable=SC1091
source "$BUNDLE/server/lib.sh"
need_root
[[ -f /etc/os-release ]] && . /etc/os-release
[[ "${ID:-}" == "debian" ]] || die "这套脚本只在 Debian 上运行（当前 ID=${ID:-未知}）"

printf '物料包 %s\n公网地址 %s\n' "$BUNDLE" "$PUBLIC_IP"
for step in "$BUNDLE"/server/steps/*.sh; do
  printf '\n==> %s\n' "$(basename "$step")"
  bash "$step"
done
printf '\n==> healthcheck\n'
bash "$BUNDLE/server/healthcheck.sh"
printf '\n安装完成。建号: COFLUX_USER_EMAIL=you@example.com /usr/local/sbin/coflux-create-user\n'
