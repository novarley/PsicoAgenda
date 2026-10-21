#!/usr/bin/env bash
# Aplica las migraciones 0001–0003 y 0005–0007 (las que no dependen de pg_cron/Vault/Storage) en un Postgres 17 desechable y corre las pruebas.
# Requiere solo Docker. Uso: bash supabase/tests/plain-postgres/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
name="psicoagenda-sqltest-$$"

docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=test postgres:17-alpine >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
until docker exec "$name" pg_isready -U postgres -q; do sleep 1; done
sleep 1

run() { docker exec -i "$name" psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres "$@"; }

run < "$here/00_supabase_stub.sql"
for f in "$root"/migrations/2026102100000{1,2,3,5,6,7}_*.sql; do
  echo "→ $(basename "$f")"
  run < "$f"
done
run < "$here/10_booking_rls_test.sql"
run < "$here/20_inbox_test.sql"
run < "$here/30_panel_test.sql"
run < "$here/40_clinical_test.sql"
