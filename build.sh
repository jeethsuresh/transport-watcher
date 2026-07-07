#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# shellcheck source=scripts/compose-env.sh
source "$ROOT/scripts/compose-env.sh"
parse_compose_args "$@"

docker compose "${COMPOSE_GLOBAL_ARGS[@]}" build "${COMPOSE_CMD_ARGS[@]}"
