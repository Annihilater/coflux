#!/usr/bin/env bash
# Checks that can be run on the server after install. Uses the loopback path so cloud NAT hairpin is not required.
set -euo pipefail
die() { printf '错误: %s\n' "$*" >&2; exit 1; }
[[ -f /etc/coflux/site.conf && -f /etc/coflux/server.env ]] || die "还没有 /etc/coflux/site.conf，先完成安装"
# shellcheck disable=SC1091
source /etc/coflux/site.conf
set -a
# shellcheck disable=SC1091
source /etc/coflux/server.env
set +a

for unit in coflux-server coflux-derp caddy; do
  systemctl is-active --quiet "$unit" || die "$unit 没有在运行"
done

curl -fsS http://127.0.0.1:8787/health >/dev/null || die "127.0.0.1:8787/health 失败"
curl -fsS --cacert /etc/coflux/tls/ca.crt \
  --connect-to "${PUBLIC_IP}:${CENTRE_PORT}:127.0.0.1:${CENTRE_PORT}" \
  "https://${PUBLIC_IP}:${CENTRE_PORT}/health" >/dev/null || die "经 Caddy 的 /health 失败"

upgrade=$(curl -sS -D - -o /dev/null --http1.1 --max-time 5 \
  --cacert /etc/coflux/tls/ca.crt \
  --connect-to "${PUBLIC_IP}:${CENTRE_PORT}:127.0.0.1:${CENTRE_PORT}" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "https://${PUBLIC_IP}:${CENTRE_PORT}/client" | awk 'NR==1 { print }')
printf '%s\n' "$upgrade" | grep -q ' 101 ' || die " /client 没有返回 101: $upgrade"

curl -fsS --cacert /etc/coflux/tls/ca.crt \
  --connect-to "${PUBLIC_IP}:${DERP_PORT}:127.0.0.1:${DERP_PORT}" \
  "https://${PUBLIC_IP}:${DERP_PORT}/derp/probe" >/dev/null || die "DERP /derp/probe 失败"

code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8793/derp-verify -d '{}')
[[ "$code" == "403" ]] || die "不带 token 的准入应返回 403，实际 $code"
unknown=$(printf 'a%.0s' $(seq 1 64))
body=$(curl -sS -u "derp:${COFLUX_DERP_ADMISSION_TOKEN}" -H 'Content-Type: application/json' \
  -X POST http://127.0.0.1:8793/derp-verify -d "{\"NodePublic\":\"nodekey:${unknown}\"}")
printf '%s\n' "$body" | grep -q '"Allow":false' || die "未知节点应被拒绝: $body"

while read -r addr; do
  case "$addr" in
    "" ) ;;
    127.0.0.1:5432|[::1]:5432|127.0.0.1:8787|[::1]:8787|127.0.0.1:8793|[::1]:8793) ;;
    *:80|*:443|*:5432|*:8787|*:8793) die "不该公开的监听: $addr" ;;
  esac
done < <(ss -ltn | awk '{ print $4 }')

ss -ltn | awk -v p=":${CENTRE_PORT}$" '$4 ~ p { found=1 } END { exit !found }' || die "Caddy 没有监听 ${CENTRE_PORT}"
ss -ltn | awk -v p=":${DERP_PORT}$" '$4 ~ p { found=1 } END { exit !found }' || die "derper 没有监听 ${DERP_PORT}"
ss -lun | awk -v p=":${STUN_PORT}$" '$4 ~ p { found=1 } END { exit !found }' || die "没有 UDP ${STUN_PORT}。derper 的 STUN 绑定失败是静默的，看 journalctl -u coflux-derp"

pin=$(tr -d ' \n' < /etc/coflux/tls/pin.txt)
printf '%s\n' "$COFLUX_DERP_REGIONS" | grep -q "sha256-raw:${pin}" || die "server.env 里的指纹和 pin.txt 不一致"
printf '服务器侧检查通过\n'
