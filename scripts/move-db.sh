#!/usr/bin/env bash
# Copies every table from one Postgres to another (e.g. Render -> Neon), using Docker so you don't
# need Postgres tools installed. Reads both URLs from environment variables so the passwords never
# end up in your shell history or in this repo.
#
#   export SRC_DATABASE_URL='postgres://...render...'   # Render: database > Connect > External URL
#   export DST_DATABASE_URL='postgres://...neon...'     # Neon: Connection string (with ?sslmode=require)
#   ./scripts/move-db.sh
set -euo pipefail
: "${SRC_DATABASE_URL:?set SRC_DATABASE_URL (the old database)}"
: "${DST_DATABASE_URL:?set DST_DATABASE_URL (the new, empty database)}"

echo "Copying schema + data (this replaces nothing: the new database should be empty)..."
docker run --rm -e SRC="$SRC_DATABASE_URL" -e DST="$DST_DATABASE_URL" postgres:18-alpine sh -c '
  set -e
  pg_dump --no-owner --no-privileges "$SRC" | psql -v ON_ERROR_STOP=1 -q "$DST"
  echo "Row counts in the new database:"
  psql -At "$DST" -c "SELECT '\''shaders: '\'' || count(*) FROM shaders" -c "SELECT '\''migrations applied: '\'' || string_agg(version::text, '\'','\'' ORDER BY version) FROM schema_migrations"
'
echo "Done. Next: set DATABASE_URL on the Render web service to DST_DATABASE_URL (see docs/MOVE_DB.md)."
