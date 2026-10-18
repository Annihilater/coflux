#!/usr/bin/env bash
# Set the clock from an HTTPS Date header. Some datacenters drop outbound NTP (udp/123), and
# device channel grants live 30 s with 5 s of skew allowed, so a drifting centre breaks terminals.
set -euo pipefail
for url in https://www.baidu.com https://www.aliyun.com https://www.qq.com https://www.cloudflare.com; do
  header=$(curl -fsSI -m 8 "$url" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "date:" { $1 = ""; print substr($0, 2); exit }') || continue
  [[ -n "$header" ]] || continue
  remote=$(date -u -d "$header" +%s) || continue
  local_now=$(date -u +%s)
  drift=$((remote - local_now))
  if ((drift > 1 || drift < -1)); then
    date -u -s "@$remote" >/dev/null
    printf 'coflux-httpdate: %s drift %ss, clock set\n' "$url" "$drift"
  else
    printf 'coflux-httpdate: %s drift %ss\n' "$url" "$drift"
  fi
  exit 0
done
printf 'coflux-httpdate: no HTTPS Date header reachable\n' >&2
exit 1
