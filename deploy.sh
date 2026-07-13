#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# shellcheck source=scripts/compose-env.sh
source "$ROOT/scripts/compose-env.sh"
parse_compose_args "$@"

PROJECT="$COMPOSE_PROJECT"
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

  # container_name follows COMPOSE_PROJECT; remove leftovers from prior runs.
  docker rm -f "$PROJECT" "${PROJECT}_app_1" 2>/dev/null || true

  # Old manual builds used localhost/ttc-watcher:latest and can shadow compose's image.
  docker rmi localhost/ttc-watcher:latest 2>/dev/null || true
}

cleanup_stale_resources
docker compose "${COMPOSE_GLOBAL_ARGS[@]}" build "${COMPOSE_CMD_ARGS[@]}"
docker compose "${COMPOSE_GLOBAL_ARGS[@]}" down --remove-orphans 2>/dev/null || true
docker compose "${COMPOSE_GLOBAL_ARGS[@]}" up -d --force-recreate --no-build
