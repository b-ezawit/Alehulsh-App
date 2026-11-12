#!/usr/bin/env bash
# Local Postgres/PostGIS harness. SYNTHETIC DATA ONLY.
#
# Deliberately refuses to run against anything but the local container: it
# takes no connection string, so it cannot be pointed at a hosted database
# by accident.
set -euo pipefail
CONTAINER="${ALEHULSH_PG_CONTAINER:-alehulsh-pg}"
DB="${ALEHULSH_PG_DB:-alehulsh_test}"
IMAGE="postgis/postgis:16-3.4"
PORT="${ALEHULSH_PG_PORT:-55432}"
# Throwaway credential for a loopback-only container holding synthetic rows.
# It is NOT a secret and must never be reused anywhere real; hosted
# environments take their password from secret storage via PGPASSWORD.
#
# The binding below is the half that makes this defensible. Docker's default
# `-p 55432:5432` publishes on 0.0.0.0, so a container started that way is
# reachable from anything that can route to this host - on a shared office
# network or a café, with a password written in a tracked file. BIND makes the
# host explicit. (The audit found the comment claiming loopback while the
# command published broadly; this is both halves fixed.)
PASSWORD="synthetic_local_only"
BIND="${ALEHULSH_PG_BIND:-127.0.0.1}"

psqlc() { docker exec -i "$CONTAINER" psql -U postgres -d "$DB" "$@"; }

case "${1:-}" in
  up)
    docker inspect "$CONTAINER" >/dev/null 2>&1 || \
      docker run -d --name "$CONTAINER" \
        -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB="$DB" \
        -p "$BIND":"$PORT":5432 "$IMAGE" >/dev/null
    docker start "$CONTAINER" >/dev/null 2>&1 || true
    until docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
    echo "postgres ready on $BIND:$PORT (synthetic/local only)"
    ;;
  migrate)
    # Minimal Auth replica for synthetic local tests, never hosted migrations.
    psqlc -v ON_ERROR_STOP=1 -q < "$(dirname "$0")/fixtures/supabase-auth.sql"
    for f in "$(dirname "$0")"/migrations/*.sql; do
      echo "-- applying $(basename "$f")"
      psqlc -v ON_ERROR_STOP=1 -q < "$f"
    done
    echo "migrations applied"
    ;;
  reset)
    psqlc -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" \
      -c "GRANT ALL ON SCHEMA public TO postgres;"
    "$0" migrate
    ;;
  test)
    rc=0
    for f in "$(dirname "$0")"/tests/*.sql; do
      echo "== $(basename "$f")"
      # ONE run per file: fixtures are not re-entrant across runs, and a
      # second pass would fail on its own leftovers rather than on a defect.
      out="$(psqlc < "$f" 2>&1)" || rc=1
      echo "$out" | grep -E "^NOTICE:  ok|ALL .* PASSED|^ERROR" || true
      echo "$out" | grep -q "^ERROR" && rc=1
    done
    exit $rc
    ;;
  env)
    # Emit the connection for `eval`, so the integration tests and this script
    # cannot drift apart. One definition, local container only.
    echo "export PGHOST=127.0.0.1 PGPORT=$PORT PGDATABASE=$DB PGUSER=postgres PGPASSWORD=$PASSWORD"
    ;;
  down) docker rm -f "$CONTAINER" >/dev/null 2>&1 && echo "container removed" ;;
  *) echo "usage: $0 {up|migrate|reset|test|down|env}"; exit 2 ;;
esac
