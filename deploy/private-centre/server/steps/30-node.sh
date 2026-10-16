#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
need_root
install -d -m 0755 /etc/coflux

install_tarball() {
  [[ -f "$BUNDLE/bin/node.tar.xz" ]] || die "物料包里没有 bin/node.tar.xz"
  tar -xJf "$BUNDLE/bin/node.tar.xz" -C /opt
  local extracted="/opt/node-v${NODE_VERSION}-linux-${NODE_ARCH}"
  [[ -d "$extracted" ]] || die "解出来的目录不是 $extracted，检查 NODE_VERSION 和 ARCH"
  ln -sfn "$extracted" /opt/node
  ln -sfn /opt/node/bin/node /usr/local/bin/node
  ln -sfn /opt/node/bin/npm /usr/local/bin/npm
  ln -sfn /opt/node/bin/npx /usr/local/bin/npx
  ln -sfn /opt/node/bin/corepack /usr/local/bin/corepack
  printf '%s\n' /usr/local/bin/node > /etc/coflux/node-bin
}

install_nodesource() {
  install -d -m 0755 /etc/apt/keyrings
  rm -f /etc/apt/keyrings/nodesource.gpg
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main\n' > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
  printf '%s\n' /usr/bin/node > /etc/coflux/node-bin
}

case "$NODE_MODE" in
  tarball) install_tarball ;;
  nodesource) install_nodesource ;;
  *) die "NODE_MODE 只能是 tarball 或 nodesource" ;;
esac
chmod 644 /etc/coflux/node-bin

NODE_BIN=$(tr -d ' \n' < /etc/coflux/node-bin)
"$NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error(process.versions.node); process.exit(1); }'
printf 'Node %s (%s)\n' "$("$NODE_BIN" -v)" "$NODE_BIN"
