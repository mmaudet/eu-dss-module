#!/bin/bash
# Build the EU-DSS Agent macOS .pkg: jpackage app-image (bundled JRE) -> pkgbuild -> productbuild.
# Run on macOS with JDK 21. Output: dist/EU-DSS-Agent-<version>.pkg (unsigned).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="0.1.0"
# jpackage requires the first component to be >= 1; map 0.x.y -> 1.x.y for CFBundleVersion only
APP_VERSION="1.0.0"
JAR_DIR="$ROOT/eu-dss-agent/target"
JAR="eu-dss-agent-${VERSION}-SNAPSHOT.jar"
if [ ! -f "$JAR_DIR/$JAR" ]; then
  echo "Build the agent jar first:  mvn -pl eu-dss-agent -am -DskipTests package" >&2
  exit 1
fi

JPACKAGE="${JAVA_HOME:-$(/usr/libexec/java_home -v 21)}/bin/jpackage"
"$JPACKAGE" --version >/dev/null || { echo "jpackage not found (need JDK 21)" >&2; exit 1; }

STAGING="$(mktemp -d)/input"; mkdir -p "$STAGING"
cp "$JAR_DIR/$JAR" "$STAGING/"

APPDIR="$ROOT/build/macos-appimage"
rm -rf "$APPDIR"; mkdir -p "$APPDIR"
"$JPACKAGE" --type app-image \
  --name "EU-DSS Agent" \
  --app-version "$APP_VERSION" \
  --vendor "LINAGORA" \
  --input "$STAGING" \
  --main-jar "$JAR" \
  --main-class com.linagora.eudss.agent.AgentMain \
  --dest "$APPDIR"

OUT="$ROOT/dist"; mkdir -p "$OUT"
COMPONENT="$(mktemp -d)/component.pkg"
pkgbuild --component "$APPDIR/EU-DSS Agent.app" \
  --install-location /Applications \
  --scripts "$ROOT/packaging/macos/scripts" \
  --identifier com.linagora.eudss.agent \
  --version "$VERSION" \
  "$COMPONENT"

productbuild --package "$COMPONENT" "$OUT/EU-DSS-Agent-${VERSION}.pkg"
echo "PKG written to $OUT/EU-DSS-Agent-${VERSION}.pkg"
