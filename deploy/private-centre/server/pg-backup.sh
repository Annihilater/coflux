#!/usr/bin/env bash
# Dump the coflux database. The file is written by root, checked, then kept for 14 generations.
set -euo pipefail
umask 077
dest=/var/backups/coflux
mkdir -p "$dest"
tmp=$(mktemp "$dest/.dump.XXXXXX")
runuser -u postgres -- pg_dump -Fc -d coflux > "$tmp"
pg_restore -l "$tmp" >/dev/null
mv "$tmp" "$dest/coflux-$(date +%Y%m%d-%H%M%S).dump"
# shellcheck disable=SC2012
ls -1t "$dest"/coflux-*.dump | awk 'NR>14' | xargs -r rm -f
