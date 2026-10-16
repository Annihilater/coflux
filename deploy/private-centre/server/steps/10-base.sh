#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
need_root
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  curl ca-certificates gnupg openssl \
  ufw postgresql xz-utils iproute2 netcat-openbsd \
  debian-keyring debian-archive-keyring apt-transport-https
