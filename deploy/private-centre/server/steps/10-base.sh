#!/usr/bin/env bash
# The centre needs PostgreSQL. Everything else in the bundle is a binary.
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
need_root
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y postgresql xz-utils
