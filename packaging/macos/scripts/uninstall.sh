#!/bin/bash
# Reverses the EU-DSS Agent install. Run with sudo: macOS has no native .pkg uninstaller.
# Copied into /Library/Application Support/eudss-agent/uninstall.sh by the postinstall.
set -uo pipefail

APP="/Applications/EU-DSS Agent.app"
DATA="/Library/Application Support/eudss-agent"
PLIST_DST="/Library/LaunchAgents/com.linagora.eudss.agent.plist"
KEYCHAIN="/Library/Keychains/System.keychain"

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo." >&2; exit 1; fi

# 1. Stop + remove the LaunchAgent (best-effort).
CONSOLE_USER="$(stat -f%Su /dev/console 2>/dev/null || true)"
if [ -n "$CONSOLE_USER" ] && [ "$CONSOLE_USER" != "root" ] && [ "$CONSOLE_USER" != "loginwindow" ]; then
  UID_N="$(id -u "$CONSOLE_USER")"
  launchctl bootout "gui/$UID_N/com.linagora.eudss.agent" 2>/dev/null || true
fi
rm -f "$PLIST_DST"

# 2. Untrust + remove the cert from the System keychain (targeted by SHA-1).
if [ -f "$DATA/trusted-sha.txt" ]; then
  SHA="$(cat "$DATA/trusted-sha.txt")"
  security delete-certificate -Z "$SHA" "$KEYCHAIN" 2>/dev/null || true
fi

# 3. Remove the app + data dir.
rm -rf "$APP" "$DATA"
echo "EU-DSS Agent uninstalled (cert untrusted, LaunchAgent removed, app + data deleted)."
exit 0
