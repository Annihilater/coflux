#!/usr/bin/env bash
# Download the Node 22 linux tarball and check it against SHASUMS256.txt.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

[[ "$NODE_MODE" == "tarball" ]] || die "NODE_MODE=$NODE_MODE，不需要下载 Node 包"

name="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
base="${NODE_MIRROR%/}/v${NODE_VERSION}"
mkdir -p "$PKI_DIR/cache"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

printf '下载 %s\n' "$base/SHASUMS256.txt"
curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
printf '下载 %s\n' "$base/$name"
curl -fsSL --retry 3 -o "$tmp/$name" "$base/$name"

expected=$(awk -v f="$name" '$2 == f { print $1 }' "$tmp/SHASUMS256.txt")
[[ -n "$expected" ]] || die "SHASUMS256.txt 里没有 $name。到 ${NODE_MIRROR} 换一个存在的 NODE_VERSION（至少 22.13）。"
actual=$("$OPENSSL" dgst -sha256 -r "$tmp/$name" | awk '{print $1}')
[[ "$expected" == "$actual" ]] || die "Node 包校验失败"

mv "$tmp/$name" "$PKI_DIR/cache/node.tar.xz"
chmod 644 "$PKI_DIR/cache/node.tar.xz"
printf 'Node 包已保存 %s\n' "$PKI_DIR/cache/node.tar.xz"
