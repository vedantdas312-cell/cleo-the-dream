#!/bin/bash
set -euo pipefail
# Micro-VM launchers may not retain the image's PATH or working directory.
export PATH=/usr/lib/postgresql/15/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
cd /app
# The configured context store lives on the persistent volume, owned by the app.
mkdir -p /data/cleo
chown node:node /data/cleo
chmod 700 /data/cleo
# Maritime mounts /data at runtime; only our database subdirectory is owned by node.
if [[ -n "${DATABASE_URL:-}" ]]; then
  exec gosu node node /app/scripts/start.ts
fi
mkdir -p /data/postgres /tmp/cleo-pg
chown node:node /data/postgres /tmp/cleo-pg
chmod 700 /data/postgres /tmp/cleo-pg
exec gosu node /app/scripts/container-run.sh
