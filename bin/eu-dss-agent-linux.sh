#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
JAR="$ROOT/eu-dss-agent/target/eu-dss-agent-0.1.0-SNAPSHOT.jar"

if [[ ! -f "$JAR" ]]; then
  echo "Jar not found: $JAR"
  echo "Build first:  mvn -DskipTests package"
  exit 1
fi

: "${EUDSS_PKCS11_DRIVER:=/usr/lib/SCMiddleware/libidop11.so}"
: "${EUDSS_PKCS11_SLOT:=0}"
: "${EUDSS_AGENT_PORT:=9795}"
: "${EUDSS_CORS_HOSTS:=http://localhost:5173,http://localhost:8080,http://localhost:4173}"

export EUDSS_PKCS11_DRIVER EUDSS_PKCS11_SLOT EUDSS_AGENT_PORT EUDSS_CORS_HOSTS

echo "eu-dss agent (Linux)"
echo "  PKCS#11 driver : $EUDSS_PKCS11_DRIVER"
echo "  slot index     : $EUDSS_PKCS11_SLOT"
echo "  port           : $EUDSS_AGENT_PORT"

exec java -jar "$JAR" "$@"
