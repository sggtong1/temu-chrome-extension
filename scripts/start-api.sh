#!/usr/bin/env bash
# Start PostgREST in a Docker container in front of mini-postgres so the
# Chrome extension can talk to it over HTTP. Idempotent: removes any existing
# `temu-postgrest` container before starting a fresh one.
#
# Usage:
#   bash scripts/start-api.sh           # bind on all LAN interfaces (default, team-share)
#   BIND=127.0.0.1 bash scripts/start-api.sh   # bind localhost-only (personal use)
#
# Prerequisites:
#   - Docker running
#   - mini-postgres container already running on host port 5432
#     (verify: `docker ps | grep mini-postgres`)
#
# After this script finishes:
#   - LAN clients access via http://<server-lan-ip-or-mDNS>:3002
#     e.g. http://yyjrs-Mac-mini.local:3002 or http://192.168.1.6:3002
#   - Localhost on this same machine still works at http://localhost:3002
#
# Security note: PGRST_DB_ANON_ROLE=admin means ANYONE who can reach port
# 3002 has full read/write/delete on every table. With LAN binding (default)
# that's "anyone on your home/office WiFi". OK for trusted small teams.
# If your WiFi has untrusted devices, switch to BIND=127.0.0.1 and use
# Tailscale, or add JWT auth.

set -euo pipefail

CONTAINER=temu-postgrest
HOST_PORT=3002
BIND="${BIND:-0.0.0.0}"   # default: LAN-reachable (override with BIND=127.0.0.1)
PG_USER=admin
PG_PASS_RAW='sGfT+sjmGBgAaydGCDYobwbyPRDRHCalYeV0RiWpga4='
# URL-encode `+` and `=` in the password.
PG_PASS_ENC='sGfT%2BsjmGBgAaydGCDYobwbyPRDRHCalYeV0RiWpga4%3D'
PG_DB=ecommerce
PG_HOST=host.docker.internal
PG_PORT=5432

echo "→ stopping/removing any existing ${CONTAINER}..."
docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true

echo "→ starting ${CONTAINER} (bind ${BIND}:${HOST_PORT})..."
docker run -d \
  --name "${CONTAINER}" \
  --add-host=host.docker.internal:host-gateway \
  -e "PGRST_DB_URI=postgres://${PG_USER}:${PG_PASS_ENC}@${PG_HOST}:${PG_PORT}/${PG_DB}" \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE="${PG_USER}" \
  -e PGRST_LOG_LEVEL=info \
  -p "${BIND}:${HOST_PORT}:3000" \
  postgrest/postgrest:v12.0.2 >/dev/null

echo "→ waiting for PostgREST to come up..."
for i in {1..15}; do
  sleep 1
  code=$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:${HOST_PORT}/" || true)
  if [ "${code}" = "200" ]; then
    echo "✓ PostgREST ready at http://localhost:${HOST_PORT}"
    if [ "${BIND}" = "0.0.0.0" ]; then
      lan_ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "<your-lan-ip>")
      mdns=$(scutil --get LocalHostName 2>/dev/null || echo "<your-host>")
      echo ""
      echo "  Team-share URLs (other devices on same LAN):"
      echo "    by mDNS: http://${mdns}.local:${HOST_PORT}"
      echo "    by IP:   http://${lan_ip}:${HOST_PORT}"
      echo "  Tell each teammate to set this as 'API URL' in extension options."
    fi
    exit 0
  fi
done

echo "✗ PostgREST did not become ready in 15s. Logs:" >&2
docker logs "${CONTAINER}" 2>&1 | tail -30 >&2
exit 1
