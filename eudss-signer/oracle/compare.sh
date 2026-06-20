#!/usr/bin/env bash
# Compare the Rust core's signature with the Java agent's signature for the same digest,
# on the SAME real card. RSA PKCS#1 v1.5 is deterministic => the base64 values must be EQUAL.
#
# Prereqs:
#   - The Java agent running on https://localhost:9795, unlocked is NOT required here because
#     we call /rest/unlock then /rest/sign with the same PIN.
#   - The Rust CLI built: cargo build --bin eudss-signer-cli
#   - The real middleware module path in EUDSS_PKCS11_MODULE (e.g. macOS:
#     /Library/SCMiddleware/libidop11.dylib ; Linux: /usr/lib/SCMiddleware/libidop11.so ;
#     Windows uses idoPKCS.dll, run this under WSL/git-bash with the correct path).
set -euo pipefail

: "${EUDSS_PKCS11_MODULE:?set EUDSS_PKCS11_MODULE to the real middleware path}"
read -r -s -p "Card PIN: " PIN; echo
read -r -p "keyId (hex CKA_ID of the signing cert, from 'list'): " KEY_ID

MESSAGE="eudss oracle $(date -u +%s)"
DIGEST=$(printf '%s' "$MESSAGE" | openssl dgst -sha256 -binary | base64)

echo "== Rust =="
RUST=$(echo "$PIN" | ./target/debug/eudss-signer-cli sign \
  --module "$EUDSS_PKCS11_MODULE" --key-id "$KEY_ID" --digest-b64 "$DIGEST" --algo SHA256 \
  | sed -E 's/.*"signatureValueBase64":"([^"]+)".*/\1/')
echo "$RUST"

echo "== Java agent =="
curl -sk -X POST https://localhost:9795/rest/unlock \
  -H 'Content-Type: application/json' --data "{\"pin\":\"$PIN\"}" >/dev/null
JAVA=$(curl -sk -X POST https://localhost:9795/rest/sign \
  -H 'Content-Type: application/json' \
  --data "{\"keyId\":\"$KEY_ID\",\"digestBase64\":\"$DIGEST\",\"digestAlgorithm\":\"SHA256\"}" \
  | sed -E 's/.*"signatureValueBase64":"([^"]+)".*/\1/')
echo "$JAVA"

if [ "$RUST" = "$JAVA" ]; then
  echo "ORACLE PASS: byte-for-byte equal"
else
  echo "ORACLE FAIL: signatures differ" >&2
  exit 1
fi
