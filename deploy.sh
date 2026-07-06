#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

./build.sh
docker compose up -d --force-recreate
