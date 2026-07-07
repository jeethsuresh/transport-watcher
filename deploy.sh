#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export COMPOSE_BAKE=false

PROJECT=ttc-watcher
NETWORK="${PROJECT}_default"

cleanup_stale_resources() {
  # Legacy podman-compose containers can block the compose-managed network.
  docker ps -aq --filter "network=${NETWORK}" | xargs -r docker rm -f

  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    local net_label
    net_label="$(docker network inspect "$NETWORK" --format '{{index .Labels "com.docker.compose.network"}}' 2>/dev/null || true)"
    if [ "$net_label" != "default" ]; then
      docker network rm "$NETWORK"
    fi
  fi

  # container_name is fixed in compose; remove leftovers from prior manual runs.
  docker rm -f "$PROJECT" "${PROJECT}_app_1" 2>/dev/null || true
}

./build.sh "$@"

cleanup_stale_resources
docker compose down --remove-orphans 2>/dev/null || true
docker compose up -d --force-recreate
