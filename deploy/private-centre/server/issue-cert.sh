#!/usr/bin/env bash
# Issue a private CA and an IP-SAN leaf on the server. The CA key stays mode 0600 and is not given to Caddy.
set -euo pipefail
ip=${1:?用法: issue-cert.sh <公网 IPv4>}
dest=${2:?用法: issue-cert.sh <公网 IPv4> <输出目录>}
[[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { printf '错误: 不是 IPv4: %s\n' "$ip" >&2; exit 1; }
mkdir -p "$dest"
umask 077
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -days 3650 -nodes \
  -keyout "$dest/ca.key" -out "$dest/ca.crt" \
  -subj "/CN=Coflux Private CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -nodes \
  -keyout "$dest/server.key" -out "$dest/server.csr" \
  -subj "/CN=${ip}" >/dev/null 2>&1
ext=$(mktemp)
cat > "$ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=IP:${ip}
EOF
openssl x509 -req -sha256 -days 825 \
  -in "$dest/server.csr" \
  -CA "$dest/ca.crt" -CAkey "$dest/ca.key" \
  -set_serial "0x$(openssl rand -hex 16)" \
  -extfile "$ext" \
  -out "$dest/server.crt" >/dev/null 2>&1
rm -f "$dest/server.csr" "$ext"
chmod 600 "$dest/ca.key" "$dest/server.key"
chmod 644 "$dest/ca.crt" "$dest/server.crt"
openssl x509 -in "$dest/server.crt" -noout -ext subjectAltName | grep -q "IP Address:${ip}"
openssl x509 -in "$dest/server.crt" -outform DER | openssl dgst -sha256 -r | awk '{print $1}' > "$dest/pin.txt"
chmod 644 "$dest/pin.txt"
printf '已为 %s 签发证书，指纹 %s\n' "$ip" "$(tr -d ' \n' < "$dest/pin.txt")"
