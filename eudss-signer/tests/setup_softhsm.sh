#!/usr/bin/env bash
# Initialise a SoftHSM2 token with an RSA-2048 key + matching cert (CKA_ID=01).
# Prints the env vars the integration tests need. Idempotent within a fresh .softhsm dir.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOFT_DIR="$CRATE_DIR/.softhsm"
export SOFTHSM2_CONF="$SOFT_DIR/softhsm2.conf"
rm -rf "$SOFT_DIR"
mkdir -p "$SOFT_DIR/tokens"
cat > "$SOFTHSM2_CONF" <<EOF
directories.tokendir = $SOFT_DIR/tokens
objectstore.backend = file
log.level = ERROR
EOF

# Locate the SoftHSM2 PKCS#11 module across common install paths.
MODULE=""
for c in \
  /usr/lib/softhsm/libsofthsm2.so \
  /usr/lib/x86_64-linux-gnu/softhsm/libsofthsm2.so \
  /usr/local/lib/softhsm/libsofthsm2.so \
  /opt/homebrew/lib/softhsm/libsofthsm2.so \
  /usr/lib/aarch64-linux-gnu/softhsm/libsofthsm2.so ; do
  [ -f "$c" ] && MODULE="$c" && break
done
[ -n "$MODULE" ] || { echo "libsofthsm2.so not found" >&2; exit 1; }

PIN=1234
SOPIN=5678
softhsm2-util --init-token --free --label eudss-test --pin "$PIN" --so-pin "$SOPIN" >&2

# Build a key + self-signed cert, then import via pkcs11-tool (works with OpenSSL 3+).
TMP="$(mktemp -d)"
openssl req -x509 -newkey rsa:2048 -keyout "$TMP/key.pem" -nodes \
  -out "$TMP/cert.pem" -days 3650 -subj "/CN=EUDSS SoftHSM/O=Linagora" >/dev/null 2>&1
# Convert key to PKCS#8 DER (compatible with pkcs11-tool --write-object --type privkey)
openssl pkcs8 -topk8 -inform PEM -outform DER -in "$TMP/key.pem" -nocrypt -out "$TMP/key.p8"
openssl x509 -in "$TMP/cert.pem" -outform DER -out "$TMP/cert.der"
# Import private key first
pkcs11-tool --module "$MODULE" --login --pin "$PIN" \
  --write-object "$TMP/key.p8" --type privkey --id 01 --label eudss-key >&2
# Import certificate
pkcs11-tool --module "$MODULE" --login --pin "$PIN" \
  --write-object "$TMP/cert.der" --type cert --id 01 --label eudss-cert >&2
rm -rf "$TMP"

echo "export SOFTHSM2_CONF=$SOFTHSM2_CONF"
echo "export EUDSS_TEST_PKCS11_MODULE=$MODULE"
echo "export EUDSS_TEST_PKCS11_PIN=$PIN"
