#!/usr/bin/env bash
# Database security tests: applies supabase/schema.sql and every migration to
# a fresh database on a plain Postgres 16 (with tests/rls/supabase-stub.sql
# standing in for Supabase), then runs tests/rls/rls.test.sql, which tries
# what a visitor can do with the public anon key and fails on any leak.
#
# Uses the usual libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD) for a
# superuser connection. Creates and drops the databases $RLS_DB_fresh,
# $RLS_DB_upgrade and $RLS_DB_rerunN (RLS_DB defaults to pdfwizard_rls_test).
#
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres scripts/test-rls.sh
set -euo pipefail

cd "$(dirname "$0")/.."
PSQL="${PSQL:-psql}"
DB="${RLS_DB:-pdfwizard_rls_test}"
run() { "$PSQL" -X -q -v ON_ERROR_STOP=1 "$@"; }

export PGOPTIONS="-c client_min_messages=warning"
migrations=(supabase/migrations/*.sql)
dbs=("$DB"_fresh "$DB"_upgrade)
for i in "${!migrations[@]}"; do dbs+=("${DB}_rerun$i"); done
trap 'for d in "${dbs[@]}"; do run -d postgres -c "drop database if exists $d" >/dev/null 2>&1 || true; done' EXIT

# fresh: a new project, schema.sql run twice to prove it can be re-run.
# upgrade: an existing project that then runs every migration in order (so a
# migration can't silently undo a protection from schema.sql).
# rerunN: an up-to-date project that runs migration N again on its own, so a
# migration that still holds an older version of a function or policy fails.
setup() {
  run -d postgres -c "drop database if exists $1" -c "create database $1"
  run -d "$1" -f tests/rls/supabase-stub.sql
  run -d "$1" -f supabase/schema.sql
}
check() {
  PGOPTIONS="-c client_min_messages=notice" run -d "$1" -f tests/rls/rls.test.sql
}

echo "== RLS tests: fresh =="
setup "${DB}_fresh"
run -d "${DB}_fresh" -f supabase/schema.sql
check "${DB}_fresh"

echo "== RLS tests: upgrade =="
setup "${DB}_upgrade"
for f in "${migrations[@]}"; do run -d "${DB}_upgrade" -f "$f"; done
check "${DB}_upgrade"

for i in "${!migrations[@]}"; do
  f="${migrations[$i]}"
  echo "== RLS tests: rerun $(basename "$f") =="
  setup "${DB}_rerun$i"
  run -d "${DB}_rerun$i" -f "$f"
  check "${DB}_rerun$i"
done
