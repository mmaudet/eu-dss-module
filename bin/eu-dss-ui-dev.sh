#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT/eu-dss-ui"
if [[ ! -d node_modules ]]; then
  npm install
fi
exec npm run dev
