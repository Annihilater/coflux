#!/usr/bin/env bash
# Pack a server bundle. The CA private key is refused if it appears in the staging tree.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

[[ -f "$PKI_DIR/ca.crt" && -f "$PKI_DIR/server.crt" && -f "$PKI_DIR/server.key" && -f "$PKI_DIR/pin.txt" ]] || die "先运行 10-make-ca.sh 和 20-issue-leaf.sh"
[[ -f "$PKI_DIR/bin/derper" ]] || die "先运行 30-build-derper.sh"
if [[ "$NODE_MODE" == "tarball" ]]; then
  [[ -f "$PKI_DIR/cache/node.tar.xz" ]] || die "先运行 40-fetch-node.sh"
fi

rev=$(git -C "$REPO_DIR" rev-parse --verify "$SRC_REV^{commit}") || die "SRC_REV=$SRC_REV 不是已提交的修订"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
root="$stage/coflux-private-centre"
mkdir -p "$root/tls" "$root/bin" "$root/server" "$root/templates"

git -C "$REPO_DIR" archive --format=tar.gz --prefix=coflux/ "$rev" > "$root/src.tar.gz"
cp "$KIT_DIR/site.conf" "$root/site.conf"
cp "$KIT_DIR/README.md" "$root/README.md"
cp "$PKI_DIR/ca.crt" "$PKI_DIR/server.crt" "$PKI_DIR/pin.txt" "$root/tls/"
cp "$PKI_DIR/server.key" "$root/tls/server.key"
chmod 600 "$root/tls/server.key"
chmod 644 "$root/tls/ca.crt" "$root/tls/server.crt" "$root/tls/pin.txt"
cp "$PKI_DIR/bin/derper" "$root/bin/derper"
chmod 755 "$root/bin/derper"
if [[ "$NODE_MODE" == "tarball" ]]; then
  cp "$PKI_DIR/cache/node.tar.xz" "$root/bin/node.tar.xz"
fi
cp -R "$KIT_DIR/server/." "$root/server/"
cp -R "$KIT_DIR/templates/." "$root/templates/"
find "$root/server" -name '*.sh' -exec chmod 755 {} +

if find "$root" \( -name 'ca.key' -o -name 'ca.cnf' \) | grep -q .; then
  die "物料包里出现了 CA 私钥，已停止"
fi

cat > "$root/MANIFEST" <<EOF
src_rev=$rev
public_ip=$PUBLIC_IP
arch=$ARCH
node_mode=$NODE_MODE
node_version=$NODE_VERSION
centre_port=$CENTRE_PORT
derp_port=$DERP_PORT
stun_port=$STUN_PORT
leaf_pin=$(tr -d ' \n' < "$root/tls/pin.txt")
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

out="$PKI_DIR/out"
rm -rf "$out"
mkdir -p "$out"
chmod 700 "$out"
tar -C "$stage" -czf "$out/coflux-private-centre.tar.gz" coflux-private-centre
chmod 600 "$out/coflux-private-centre.tar.gz"
printf '物料包 %s\n源码 %s\n' "$out/coflux-private-centre.tar.gz" "$rev"
