#!/usr/bin/env bash
# Install the leaf where Caddy and derper can both read the key, and nobody else can.
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
need_root

getent group coflux-tls >/dev/null || groupadd --system coflux-tls
id coflux >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin coflux
id coflux-derp >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin --groups coflux-tls coflux-derp
usermod -aG coflux-tls coflux-derp

install -d -m 0755 /etc/coflux
install -d -m 0750 -o root -g coflux-tls /etc/coflux/tls
install -m 0644 -o root -g root "$BUNDLE/tls/ca.crt" /etc/coflux/tls/ca.crt
if [[ -f "$BUNDLE/tls/ca.key" ]]; then
  install -m 0600 -o root -g root "$BUNDLE/tls/ca.key" /etc/coflux/tls/ca.key
fi
install -m 0644 -o root -g coflux-tls "$BUNDLE/tls/server.crt" /etc/coflux/tls/server.crt
install -m 0640 -o root -g coflux-tls "$BUNDLE/tls/server.key" /etc/coflux/tls/server.key
install -m 0644 -o root -g root "$BUNDLE/tls/pin.txt" /etc/coflux/tls/pin.txt
ln -sfn server.crt "/etc/coflux/tls/${PUBLIC_IP}.crt"
ln -sfn server.key "/etc/coflux/tls/${PUBLIC_IP}.key"
install -m 0644 "$BUNDLE/site.conf" /etc/coflux/site.conf

openssl x509 -in /etc/coflux/tls/server.crt -noout -ext subjectAltName | grep -q "IP Address:${PUBLIC_IP}" || die "服务器上的证书 SAN 不是 ${PUBLIC_IP}"
sudo -u coflux-derp cat "/etc/coflux/tls/${PUBLIC_IP}.key" >/dev/null
printf '证书已安装，derper 用户能读私钥\n'
