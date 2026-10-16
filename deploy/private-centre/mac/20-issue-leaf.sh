#!/usr/bin/env bash
# Issue or re-issue the IP-SAN leaf. Re-running replaces server.crt, server.key, and pin.txt.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

[[ -f "$PKI_DIR/ca.key" && -f "$PKI_DIR/ca.crt" ]] || die "先运行 10-make-ca.sh"

umask 077
cat > "$PKI_DIR/leaf.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = ${PUBLIC_IP}
[v3_leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = IP:${PUBLIC_IP}
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF

"$OPENSSL" ecparam -name prime256v1 -genkey -noout -out "$PKI_DIR/server.key"
"$OPENSSL" req -new -sha256 -key "$PKI_DIR/server.key" -out "$PKI_DIR/server.csr" \
  -config "$PKI_DIR/leaf.cnf"
"$OPENSSL" x509 -req -sha256 -days 825 \
  -in "$PKI_DIR/server.csr" \
  -CA "$PKI_DIR/ca.crt" -CAkey "$PKI_DIR/ca.key" \
  -set_serial "0x$("$OPENSSL" rand -hex 16)" \
  -extfile "$PKI_DIR/leaf.cnf" -extensions v3_leaf \
  -out "$PKI_DIR/server.crt"
rm -f "$PKI_DIR/server.csr" "$PKI_DIR/leaf.cnf"
chmod 600 "$PKI_DIR/server.key"
chmod 644 "$PKI_DIR/server.crt"

"$OPENSSL" verify -CAfile "$PKI_DIR/ca.crt" "$PKI_DIR/server.crt" | grep -q 'OK' || die "叶子证书校验失败"
"$OPENSSL" x509 -in "$PKI_DIR/server.crt" -noout -text | grep -q "IP Address:${PUBLIC_IP}" || die "SAN 里没有 ${PUBLIC_IP}"

pin_of "$PKI_DIR/server.crt" > "$PKI_DIR/pin.txt"
chmod 644 "$PKI_DIR/pin.txt"
printf '叶子证书 SAN=%s\n指纹 %s\n' "$PUBLIC_IP" "$(cat "$PKI_DIR/pin.txt")"
