#!/usr/bin/env bash
# Rebuild + redeploy do mcpfin com preços frescos da Oracle.
# Roda no host onde está o docker-compose.yml. Chamado pelo cron mensal.
set -euo pipefail
cd "$(dirname "$0")/.."
CACHEBUST=$(date +%s) docker compose up -d --build
# healthcheck: espera ficar ok (máx ~30s)
for i in $(seq 1 15); do
  curl -fs localhost:8080/healthz >/dev/null && { echo "ok: mcpfin no ar com preços de $(date -u +%F)"; exit 0; }
  sleep 2
done
echo "FALHA: healthz não respondeu — container antigo pode ter sido mantido" >&2
exit 1
