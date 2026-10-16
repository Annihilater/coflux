#!/usr/bin/env bash
# Install the private CA into the macOS System keychain. This covers Safari, Chrome, and the desktop renderer. It does not cover the device runtime or the Rust coflux CLI.
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/mac/lib.sh"
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain "$PKI_DIR/ca.crt"
printf '已装入系统钥匙串。重启浏览器和 Coflux。\nmacOS 自带的 curl 不一定读这把钥匙串，检查网页时用浏览器，或 curl --cacert %s\n' "$PKI_DIR/ca.crt"
