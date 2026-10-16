#!/usr/bin/env bash
# Create the coflux role. The password is reused on later runs so the role is not locked out of an existing database.
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
need_root
umask 077
install -d -m 0755 /etc/coflux

if [[ ! -s /etc/coflux/pg-coflux.pass ]]; then
  openssl rand -hex 24 > /etc/coflux/pg-coflux.pass
  chmod 600 /etc/coflux/pg-coflux.pass
fi
DB_PASSWORD=$(tr -d ' \n' < /etc/coflux/pg-coflux.pass)
[[ "$DB_PASSWORD" =~ ^[0-9a-f]+$ ]] || die "数据库密码文件里有非十六进制字符"

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coflux') THEN
    CREATE ROLE coflux LOGIN PASSWORD '${DB_PASSWORD}';
  ELSE
    ALTER ROLE coflux WITH LOGIN PASSWORD '${DB_PASSWORD}';
  END IF;
END
\$\$;
SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'coflux'" | grep -q 1; then
  sudo -u postgres createdb -O coflux coflux
fi

bad=$(ss -ltn | awk '/:5432$/ { print $4 }' | awk '!/^(127\.0\.0\.1:5432|\[::1\]:5432)$/')
[[ -z "$bad" ]] || die "Postgres 监听在环回以外: $bad"
PGPASSWORD="$DB_PASSWORD" psql -h 127.0.0.1 -U coflux -d coflux -c 'select 1' >/dev/null
printf 'Postgres 角色 coflux 可以经 127.0.0.1 登录\n'
