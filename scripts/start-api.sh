#!/usr/bin/env bash
# Start PostgREST in a Docker container in front of mini-postgres so the
# Chrome extension can talk to it over HTTP. Idempotent: removes any existing
# `temu-postgrest` container before starting a fresh one.
#
# Usage:
#   bash scripts/start-api.sh
#
# Prerequisites:
#   - Docker running
#   - mini-postgres container already running on host port 5432
#     (verify: `docker ps | grep mini-postgres`)
#
# After this script finishes, the extension's "API URL" should be set to
# http://localhost:3002 in the options page.

set -euo pipefail

CONTAINER=temu-postgrest
HOST_PORT=3002
PG_USER=admin
PG_PASS_RAW='sGfT+sjmGBgAaydGCDYobwbyPRDRHCalYeV0RiWpga4='
# URL-encode `+` and `=` in the password.
PG_PASS_ENC='sGfT%2BsjmGBgAaydGCDYobwbyPRDRHCalYeV0RiWpga4%3D'
PG_DB=ecommerce
PG_HOST=host.docker.internal
PG_PORT=5432

echo "→ stopping/removing any existing ${CONTAINER}..."
docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true

echo "→ starting ${CONTAINER}..."
docker run -d \
  --name "${CONTAINER}" \
  --add-host=host.docker.internal:host-gateway \
  -e "PGRST_DB_URI=postgres://${PG_USER}:${PG_PASS_ENC}@${PG_HOST}:${PG_PORT}/${PG_DB}" \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE="${PG_USER}" \
  -e PGRST_LOG_LEVEL=info \
  -p "127.0.0.1:${HOST_PORT}:3000" \
  postgrest/postgrest:v12.0.2 >/dev/null

echo "→ waiting for PostgREST to come up..."
for i in {1..15}; do
  sleep 1
  code=$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:${HOST_PORT}/" || true)
  if [ "${code}" = "200" ]; then
    echo "✓ PostgREST ready at http://localhost:${HOST_PORT}"
    echo "  Set extension's API URL to: http://localhost:${HOST_PORT}"
    exit 0
  fi
done

echo "✗ PostgREST did not become ready in 15s. Logs:" >&2
docker logs "${CONTAINER}" 2>&1 | tail -30 >&2
exit 1
