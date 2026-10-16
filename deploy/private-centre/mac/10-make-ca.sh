#!/usr/bin/env bash
# Create the private CA once. The key stays in PKI_DIR and never enters the bundle.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

if [[ -f "$PKI_DIR/ca.key" ]]; then
  die "CA 已经存在: $PKI_DIR/ca.key 。不要覆盖。续签叶子运行 20-issue-leaf.sh。"
fi

umask 077
cat > "$PKI_DIR/ca.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = Coflux Private CA
[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
EOF

"$OPENSSL" ecparam -name prime256v1 -genkey -noout -out "$PKI_DIR/ca.key"
"$OPENSSL" req -new -x509 -sha256 -days 3650 \
  -key "$PKI_DIR/ca.key" -out "$PKI_DIR/ca.crt" \
  -config "$PKI_DIR/ca.cnf" -extensions v3_ca
chmod 600 "$PKI_DIR/ca.key"
chmod 644 "$PKI_DIR/ca.crt"
printf 'CA 已写入 %s\n把 ca.crt 装到要用浏览器和桌面的 Mac 上。ca.key 留在这台机器，不要拷到服务器。\n' "$PKI_DIR"
