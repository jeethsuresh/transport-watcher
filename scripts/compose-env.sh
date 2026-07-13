#!/usr/bin/env bash

compose_default_project() {
  echo ttc-watcher
}

# Split script args into global `docker compose` flags (-p, -f, …) and subcommand args.
parse_compose_args() {
  COMPOSE_PROJECT="$(compose_default_project)"
  COMPOSE_GLOBAL_ARGS=()
  COMPOSE_CMD_ARGS=()
  HOST_PORT="${HOST_PORT:-3010}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -p | --project-name)
        [[ $# -ge 2 ]] || {
          echo "error: $1 requires a value" >&2
          return 1
        }
        COMPOSE_PROJECT="$2"
        COMPOSE_GLOBAL_ARGS+=(-p "$2")
        shift 2
        ;;
      -f | --file)
        [[ $# -ge 2 ]] || {
          echo "error: $1 requires a value" >&2
          return 1
        }
        COMPOSE_GLOBAL_ARGS+=(-f "$2")
        shift 2
        ;;
      --project-directory)
        [[ $# -ge 2 ]] || {
          echo "error: $1 requires a value" >&2
          return 1
        }
        COMPOSE_GLOBAL_ARGS+=(--project-directory "$2")
        shift 2
        ;;
      --host-port)
        [[ $# -ge 2 ]] || {
          echo "error: $1 requires a value" >&2
          return 1
        }
        HOST_PORT="$2"
        shift 2
        ;;
      --detach)
        shift
        ;;
      *)
        COMPOSE_CMD_ARGS+=("$1")
        shift
        ;;
    esac
  done

  export COMPOSE_PROJECT
  export COMPOSE_CONTAINER_NAME="$COMPOSE_PROJECT"
  export COMPOSE_BAKE=false
  export HOST_PORT
}
