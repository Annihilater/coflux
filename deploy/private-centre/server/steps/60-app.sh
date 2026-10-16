#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
need_root

if systemctl list-unit-files coflux-server.service >/dev/null 2>&1; then
  systemctl stop coflux-server || true
fi

rm -rf /opt/coflux
mkdir -p /opt/coflux
tar -xzf "$BUNDLE/src.tar.gz" -C /opt/coflux --strip-components=1
chmod -R a+rX /opt/coflux

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_NPM_REGISTRY="$NPM_REGISTRY"
corepack enable
cd /opt/coflux
if ! corepack install; then
  printf 'corepack 安装 pnpm 失败，关闭完整性校验后重试\n' >&2
  if ! COREPACK_INTEGRITY_KEYS=0 corepack install; then
    npm install -g pnpm@11.6.0 --registry="$NPM_REGISTRY"
  fi
fi
pnpm install --frozen-lockfile --registry="$NPM_REGISTRY"
[[ -x /opt/coflux/node_modules/.bin/tsx ]] || die "pnpm 安装后没有 tsx"
printf '源码已放到 /opt/coflux\n'
