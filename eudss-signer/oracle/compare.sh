#!/usr/bin/env bash
# Compare the Rust core's signature with the Java agent's signature for the SAME digest,
# on the SAME real card. RSA PKCS#1 v1.5 is deterministic => the base64 values must be EQUAL.
#
# PIN SAFETY (read this): the card has a limited number of PIN tries (typically 3). This
# script asks for the PIN ONCE and signs with BOTH tools. It runs the Rust tool FIRST and
# ABORTS before touching the Java agent if the Rust login fails, so a mistyped PIN costs
# AT MOST ONE try, never two. A CORRECT PIN costs zero tries (PKCS#11 resets the counter on
# a successful login). Never edit this to retry a failed PIN automatically.
#
# Prereqs:
#   - The Java agent running on https://localhost:9795.
#   - The Rust CLI built: cargo build --bin eudss-signer-cli (run this script from eudss-signer/).
#   - EUDSS_PKCS11_MODULE = the real middleware path (macOS:
#     /Library/SCMiddleware/libidop11.dylib ; Linux: /usr/lib/SCMiddleware/libidop11.so).
set -euo pipefail

: "${EUDSS_PKCS11_MODULE:?set EUDSS_PKCS11_MODULE to the real middleware path}"
read -r -s -p "Card PIN: " PIN; echo
read -r -p "keyId (hex CKA_ID of the signing cert, from 'list'): " KEY_ID

MESSAGE="eudss oracle $(date -u +%s)"
DIGEST=$(printf '%s' "$MESSAGE" | openssl dgst -sha256 -binary | base64)

echo "== Rust (runs first; the script aborts here if the PIN is wrong) =="
# Capture raw output without aborting, so we can inspect it and give a clear message.
RUST_OUT=$(echo "$PIN" | ./target/debug/eudss-signer-cli sign \
  --module "$EUDSS_PKCS11_MODULE" --key-id "$KEY_ID" --digest-b64 "$DIGEST" --algo SHA256) || true
RUST=$(printf '%s' "$RUST_OUT" | sed -nE 's/.*"signatureValueBase64":"([^"]+)".*/\1/p')
if [ -z "$RUST" ]; then
  echo "Rust sign returned no signature. Output was:" >&2
  echo "  $RUST_OUT" >&2
  echo "ABORTED before contacting the Java agent (protects your remaining PIN tries)." >&2
  exit 1
fi
echo "$RUST"

# We only get here when the PIN was correct (Rust logged in), so the Java login below
# will also succeed and costs zero tries.
echo "== Java agent =="
UNLOCK=$(curl -sk -X POST https://localhost:9795/rest/unlock \
  -H 'Content-Type: application/json' --data "{\"pin\":\"$PIN\"}")
if printf '%s' "$UNLOCK" | grep -q '"error"'; then
  echo "Java agent unlock failed: $UNLOCK" >&2
  exit 1
fi
JAVA=$(curl -sk -X POST https://localhost:9795/rest/sign \
  -H 'Content-Type: application/json' \
  --data "{\"keyId\":\"$KEY_ID\",\"digestBase64\":\"$DIGEST\",\"digestAlgorithm\":\"SHA256\"}" \
  | sed -nE 's/.*"signatureValueBase64":"([^"]+)".*/\1/p')
echo "$JAVA"

if [ -n "$JAVA" ] && [ "$RUST" = "$JAVA" ]; then
  echo "ORACLE PASS: byte-for-byte equal"
else
  echo "ORACLE FAIL: signatures differ (or the Java agent returned none)" >&2
  exit 1
fi
