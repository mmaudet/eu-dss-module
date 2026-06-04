#!/usr/bin/env bash
# Build the EU-DSS Agent Debian package: jpackage app-image (bundled JRE) -> hand-assembled .deb.
# Run on Linux with JDK 21 + dpkg-deb. Output: dist/eu-dss-agent_<version>_<arch>.deb (unsigned).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="0.1.0"
# jpackage requires the app-image version first component to be >= 1 (same as the macOS pkg);
# the user-facing .deb Version is the real 0.1.0 set in DEBIAN/control.
APP_VERSION="1.0.0"
ARCH="$(dpkg --print-architecture)"   # amd64 on ubuntu-latest; arm64 on the ARM test VM
JAR_DIR="$ROOT/eu-dss-agent/target"
JAR="eu-dss-agent-${VERSION}-SNAPSHOT.jar"
if [ ! -f "$JAR_DIR/$JAR" ]; then
  echo "Build the agent jar first:  mvn -pl eu-dss-agent -am -DskipTests package" >&2
  exit 1
fi

JPACKAGE="${JAVA_HOME:+$JAVA_HOME/bin/}jpackage"
"$JPACKAGE" --version >/dev/null || { echo "jpackage not found (need JDK 21)" >&2; exit 1; }

# Temp work dirs (staging input + package root), cleaned up on exit (success or failure).
STAGING_BASE="$(mktemp -d)"
PKGROOT_BASE="$(mktemp -d)"
trap 'rm -rf "$STAGING_BASE" "$PKGROOT_BASE"' EXIT

# 1. Build the app-image (bundled JRE + launcher bin/eu-dss-agent).
STAGING="$STAGING_BASE/input"; mkdir -p "$STAGING"
cp "$JAR_DIR/$JAR" "$STAGING/"
APPDIR="$ROOT/build/linux-appimage"
rm -rf "$APPDIR"; mkdir -p "$APPDIR"
"$JPACKAGE" --type app-image \
  --name eu-dss-agent \
  --app-version "$APP_VERSION" \
  --vendor "LINAGORA" \
  --input "$STAGING" \
  --main-jar "$JAR" \
  --main-class com.linagora.eudss.agent.AgentMain \
  --dest "$APPDIR"

# 2. Assemble the .deb tree.
PKGROOT="$PKGROOT_BASE/pkgroot"
mkdir -p "$PKGROOT/opt/eu-dss-agent" "$PKGROOT/etc/xdg/autostart"
cp -a "$APPDIR/eu-dss-agent/." "$PKGROOT/opt/eu-dss-agent/"
cp -a "$ROOT/packaging/linux/deb/DEBIAN" "$PKGROOT/"
cp -a "$ROOT/packaging/linux/deb/etc/xdg/autostart/eu-dss-agent.desktop" \
      "$PKGROOT/etc/xdg/autostart/"

# 3. Fill in control (version + arch + installed size) and enforce maintainer-script perms.
# Installed-Size = KiB of installed files, excluding the DEBIAN control dir; computed after the
# tree is assembled. Substituted before Description so Description remains the last control field.
ISIZE="$(du -k -s --exclude=DEBIAN "$PKGROOT" | cut -f1)"
sed -e "s/@VERSION@/$VERSION/" -e "s/@ARCH@/$ARCH/" -e "s/@INSTALLED_SIZE@/$ISIZE/" \
  "$ROOT/packaging/linux/deb/DEBIAN/control" > "$PKGROOT/DEBIAN/control"
chmod 755 "$PKGROOT/DEBIAN/postinst" "$PKGROOT/DEBIAN/prerm" "$PKGROOT/DEBIAN/postrm"

# The agent runs as a non-root user (started via XDG autostart in the GUI session), so the
# installed payload MUST be world-readable. Enforce it here rather than trusting the building
# user's umask (a restrictive umask would otherwise ship a root-only jar -> ClassNotFoundException
# at launch). u+rwX,go+rX keeps the launcher + JRE binaries executable and jars/.desktop readable.
chmod -R u+rwX,go+rX "$PKGROOT/opt" "$PKGROOT/etc"

# 4. Build the package.
OUT="$ROOT/dist"; mkdir -p "$OUT"
DEB="$OUT/eu-dss-agent_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$PKGROOT" "$DEB"
echo "DEB written to $DEB"
