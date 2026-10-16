#!/usr/bin/env bash
# Run the Mac-side preparation in order.
set -euo pipefail
MAC_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$MAC_DIR/lib.sh"

if [[ ! -f "$PKI_DIR/ca.key" ]]; then
  "$MAC_DIR/10-make-ca.sh"
else
  printf '沿用已有 CA %s\n' "$PKI_DIR/ca.key"
fi
"$MAC_DIR/20-issue-leaf.sh"
"$MAC_DIR/30-build-derper.sh"
if [[ "$NODE_MODE" == "tarball" ]]; then
  "$MAC_DIR/40-fetch-node.sh"
fi
"$MAC_DIR/50-make-bundle.sh"
