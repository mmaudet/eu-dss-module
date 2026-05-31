#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
JAR="$HERE/eu-dss-agent-0.1.0-SNAPSHOT.jar"

if [[ ! -f "$JAR" ]]; then
  echo "Jar not found: $JAR"
  exit 1
fi

# DSS 6.4 still uses the SunPKCS11(InputStream) constructor which is removed in JDK 24+.
# Force JDK 21 LTS if available.
JAVA_BIN="java"
if command -v /usr/libexec/java_home >/dev/null 2>&1; then
  if JH=$(/usr/libexec/java_home -v 21 2>/dev/null); then
    JAVA_BIN="$JH/bin/java"
  fi
fi

JAVA_VERSION_MAJOR=$("$JAVA_BIN" -version 2>&1 | awk -F\" '/version/ {print $2}' | cut -d. -f1)
if [[ -n "$JAVA_VERSION_MAJOR" && "$JAVA_VERSION_MAJOR" -ge 22 ]]; then
  echo "WARNING: using Java $JAVA_VERSION_MAJOR — DSS 6.4 PKCS#11 init only works up to JDK 21." >&2
  echo "         Install JDK 21 :  brew install --cask temurin@21" >&2
fi

: "${EUDSS_PKCS11_DRIVER:=/Library/SCMiddleware/libidop11.dylib}"
: "${EUDSS_PKCS11_SLOT:=0}"
: "${EUDSS_AGENT_PORT:=9795}"
: "${EUDSS_CORS_HOSTS:=http://localhost:5173,http://localhost:8080,http://localhost:4173}"

export EUDSS_PKCS11_DRIVER EUDSS_PKCS11_SLOT EUDSS_AGENT_PORT EUDSS_CORS_HOSTS

echo "eu-dss agent (macOS)"
echo "  java           : $JAVA_BIN"
echo "  PKCS#11 driver : $EUDSS_PKCS11_DRIVER"
echo "  slot index     : $EUDSS_PKCS11_SLOT   (slot 0 = ChamberSign qualified signing cert, 4-digit PIN)"
echo "  port           : $EUDSS_AGENT_PORT"
echo "  CORS allowed   : $EUDSS_CORS_HOSTS"
echo
echo "Enter your 4-digit Card PIN when prompted (unlocks the slot-0 qualified signing cert)."
echo

exec "$JAVA_BIN" -jar "$JAR" "$@"
