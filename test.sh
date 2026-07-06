#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -x node_modules/.bin/tsx ]]; then
  npm ci --include=dev
fi

npm test
