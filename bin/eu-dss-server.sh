#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
JAR="$ROOT/eu-dss-server/target/eu-dss-server-0.1.0-SNAPSHOT.jar"

if [[ ! -f "$JAR" ]]; then
  echo "Jar not found: $JAR"
  echo "Build first:  mvn -DskipTests package"
  exit 1
fi

exec java -jar "$JAR" "$@"
