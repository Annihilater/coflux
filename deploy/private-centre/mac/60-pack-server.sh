#!/usr/bin/env bash
# Pack a server bundle that issues its certificate on the Debian host. No CA private key is included.
set -euo pipefail
MAC_DIR=$(cd "$(dirname "$0")" && pwd)
KIT_DIR=$(cd "$MAC_DIR/.." && pwd)
REPO_DIR=$(cd "$KIT_DIR/../.." && pwd)
VERSION=${VERSION:-2.19.1-private.2}
BIN_DIR=${BIN_DIR:-$HOME/.coflux-private-ca/bin}
CACHE_DIR=${CACHE_DIR:-$HOME/.coflux-private-ca/cache}

die() { printf '错误: %s\n' "$*" >&2; exit 1; }
for arch in amd64 arm64; do
  [[ -f "$BIN_DIR/derper-$arch" ]] || die "缺少 $BIN_DIR/derper-$arch"
done
[[ -f "$CACHE_DIR/node-v22.23.3-linux-x64.tar.xz" ]] || die "缺少 Node x64 包"
[[ -f "$CACHE_DIR/node-v22.23.3-linux-arm64.tar.xz" ]] || die "缺少 Node arm64 包"
centre=$(mktemp -d)
node "$REPO_DIR/scripts/bundle-private-server.mjs" "$centre"

stage=$(mktemp -d)
trap 'rm -rf "$stage" "$centre"' EXIT
root="$stage/coflux-private-centre"
mkdir -p "$root/bin" "$root/server" "$root/templates" "$root/tls" "$root/centre"
cp "$centre/coflux-server.mjs" "$centre/create-user.mjs" "$root/centre/"
cp "$KIT_DIR/site.conf.example" "$root/site.conf"
cp "$KIT_DIR/README.md" "$root/README.md"
cp "$KIT_DIR/INSTALL.txt" "$root/INSTALL.txt"
cp "$BIN_DIR/derper-amd64" "$BIN_DIR/derper-arm64" "$root/bin/"
chmod 755 "$root/bin/derper-amd64" "$root/bin/derper-arm64"
cp "$CACHE_DIR/node-v22.23.3-linux-x64.tar.xz" "$root/bin/node-x64.tar.xz"
cp "$CACHE_DIR/node-v22.23.3-linux-arm64.tar.xz" "$root/bin/node-arm64.tar.xz"
cp -R "$KIT_DIR/server/." "$root/server/"
cp -R "$KIT_DIR/templates/." "$root/templates/"
find "$root/server" -name '*.sh' -exec chmod 755 {} +
if find "$root" \( -name 'ca.key' -o -name 'server.key' -o -name '*.crt' \) | grep -q .; then
  die "物料包里出现了证书或私钥"
fi

rev=$(git -C "$REPO_DIR" rev-parse --verify HEAD^{commit})
cat > "$root/MANIFEST" <<EOF
version=$VERSION
src_rev=$rev
node_version=22.23.3
centre=bundled
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

STAGE="$root" python3 - <<'PY' > "$root/SHA256SUMS"
import hashlib, os
root = os.environ["STAGE"]
paths = []
for dirpath, _, files in os.walk(root):
    for name in files:
        if name == "SHA256SUMS":
            continue
        paths.append(os.path.join(dirpath, name))
for path in sorted(paths):
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    rel = os.path.relpath(path, root)
    print(f"{digest}  ./{rel}")
PY

out="$KIT_DIR/out"
mkdir -p "$out"
name="coflux-private-centre-${VERSION}.tar.gz"
tar -C "$stage" -czf "$out/$name" coflux-private-centre
openssl dgst -sha256 -r "$out/$name" | awk -v f="$name" '{ print $1 "  " f }' > "$out/${name}.sha256"
printf '物料包 %s\n中心程序来自 %s\n' "$out/$name" "$rev"
cat "$out/${name}.sha256"
