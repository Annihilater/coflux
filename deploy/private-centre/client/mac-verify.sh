#!/usr/bin/env bash
# Check the centre from the operator Mac. Turn off Surge or any TUN proxy first; those invent 198.18.x.x addresses.
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/mac/lib.sh"
die() { printf '错误: %s\n' "$*" >&2; exit 1; }

curl -fsS --cacert "$PKI_DIR/ca.crt" "https://${PUBLIC_IP}:${CENTRE_PORT}/health" >/dev/null || die "/health 失败"
if curl -fsS --max-time 10 "https://${PUBLIC_IP}:${CENTRE_PORT}/health" >/dev/null 2>&1; then
  die "没带 CA 也校验通过了。确认连的是这台私有中心，而不是别的站点。"
fi
printf 'TLS: 带 CA 成功，不带 CA 被拒绝\n'

san=$("$OPENSSL" s_client -connect "${PUBLIC_IP}:${CENTRE_PORT}" -servername "$PUBLIC_IP" </dev/null 2>/dev/null | "$OPENSSL" x509 -noout -text || true)
printf '%s\n' "$san" | grep -q "IP Address:${PUBLIC_IP}" || die "证书 SAN 不是 ${PUBLIC_IP}"

closed() {
  local port=$1
  if nc -z -G 3 "$PUBLIC_IP" "$port" 2>/dev/null; then
    die "端口 $port 不该开放"
  fi
  printf '关闭: tcp/%s\n' "$port"
}
closed 80
closed 443
closed 5432
closed 8787
closed 8793

[[ -x "$PKI_DIR/bin/stunc" ]] || die "没有 $PKI_DIR/bin/stunc，先运行 mac/30-build-derper.sh"
"$PKI_DIR/bin/stunc" "$PUBLIC_IP" "$STUN_PORT"
printf '从这台 Mac 能看到的检查通过。浏览器打开 https://%s:%s/health 应不再报警。\n' "$PUBLIC_IP" "$CENTRE_PORT"
