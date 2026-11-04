#!/bin/bash
set -euo pipefail
export PGDATA=/data/postgres
export PGHOST=/tmp/cleo-pg
export PGUSER=node
export PGDATABASE=postgres
if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
  initdb --username=node --auth-local=peer --auth-host=reject --encoding=UTF8 --locale=C --data-checksums
fi
postgres -c listen_addresses='' -c unix_socket_directories="$PGHOST" -c unix_socket_permissions=0700 -c log_min_error_statement=panic &
database_pid=$!
application_pid=''
cleanup() {
  trap - EXIT TERM INT
  if [[ -n "$application_pid" ]]; then kill -TERM "$application_pid" 2>/dev/null || true; wait "$application_pid" 2>/dev/null || true; fi
  kill -INT "$database_pid" 2>/dev/null || true
  wait "$database_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
for attempt in {1..30}; do
  if pg_isready -q; then break; fi
  kill -0 "$database_pid"
  sleep 1
done
pg_isready -q
export DATABASE_URL='postgresql:///postgres?host=/tmp/cleo-pg&user=node'
node /app/scripts/start.ts &
application_pid=$!
# Stop the whole unit if either process exits. PostgreSQL is never network-exposed.
wait -n "$database_pid" "$application_pid"
