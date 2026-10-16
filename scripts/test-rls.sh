#!/usr/bin/env bash
# Database security tests: applies supabase/schema.sql and every migration to
# a fresh database on a plain Postgres 16 (with tests/rls/supabase-stub.sql
# standing in for Supabase), then runs tests/rls/rls.test.sql, which tries
# what a visitor can do with the public anon key and fails on any leak.
#
# Uses the usual libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD) for a
# superuser connection. Creates and drops the databases $RLS_DB_fresh and $RLS_DB_upgrade
# (RLS_DB defaults to pdfwizard_rls_test).
#
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres scripts/test-rls.sh
set -euo pipefail

cd "$(dirname "$0")/.."
PSQL="${PSQL:-psql}"
DB="${RLS_DB:-pdfwizard_rls_test}"
run() { "$PSQL" -X -q -v ON_ERROR_STOP=1 "$@"; }

export PGOPTIONS="-c client_min_messages=warning"
trap 'for d in "$DB"_fresh "$DB"_upgrade; do run -d postgres -c "drop database if exists $d" >/dev/null 2>&1 || true; done' EXIT

# fresh: a new project, schema.sql run twice to prove it can be re-run.
# upgrade: an existing project that then runs every migration in order (so a
# migration can't silently undo a protection from schema.sql).
for variant in fresh upgrade; do
  db="${DB}_${variant}"
  echo "== RLS tests: $variant =="
  run -d postgres -c "drop database if exists $db" -c "create database $db"
  run -d "$db" -f tests/rls/supabase-stub.sql
  run -d "$db" -f supabase/schema.sql
  if [ "$variant" = fresh ]; then
    run -d "$db" -f supabase/schema.sql
  else
    for f in supabase/migrations/*.sql; do run -d "$db" -f "$f"; done
  fi
  PGOPTIONS="-c client_min_messages=notice" run -d "$db" -f tests/rls/rls.test.sql
done
