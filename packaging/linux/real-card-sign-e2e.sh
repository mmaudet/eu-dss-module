#!/usr/bin/env bash
# Real-card signing end-to-end check for the EU-DSS agent on Linux amd64.
#
# Proves the agent signs a digest with the REAL ChamberSign/IDOPTE token through the vendor
# PKCS#11 module /usr/lib/SCMiddleware/libidop11.so. This is the agent's OS/token-specific path;
# full PAdES document signing is done by the backend+UI (platform-independent Java/DSS).
#
# Prerequisites (amd64 Ubuntu/Debian; the token plugged into a NATIVE USB port):
#   - the ChamberSign middleware package  : scmiddleware-user_*_amd64.deb
#   - the agent package                   : eu-dss-agent_0.1.0_amd64.deb  (CI artifact or local build)
#
# Usage:
#   sudo ./real-card-sign-e2e.sh /path/scmiddleware-user_*_amd64.deb /path/eu-dss-agent_0.1.0_amd64.deb
#
# Notes:
#   - Runs a throwaway agent instance on port 9799 (TLS off) so it does not disturb the installed
#     autostarted agent on 9795. Prompts for the card PIN (never stored).
set -euo pipefail

MIDDLEWARE_DEB="${1:?usage: sudo $0 <scmiddleware_*_amd64.deb> <eu-dss-agent_*_amd64.deb>}"
AGENT_DEB="${2:?usage: sudo $0 <scmiddleware_*_amd64.deb> <eu-dss-agent_*_amd64.deb>}"
PORT="${EUDSS_AGENT_PORT:-9799}"
SLOT="${EUDSS_PKCS11_SLOT:-0}"
DRIVER=/usr/lib/SCMiddleware/libidop11.so
BASE="http://localhost:$PORT"
LOG=/tmp/eudss-realcard-agent.log

[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
[ "$(dpkg --print-architecture)" = amd64 ] || { echo "Must run on amd64 (got $(dpkg --print-architecture))."; exit 1; }

echo "== 1. install middleware + agent + tools =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y "$MIDDLEWARE_DEB" "$AGENT_DEB" opensc openssl python3 python3-cryptography
[ -f "$DRIVER" ] || { echo "FATAL: $DRIVER not present after middleware install"; exit 1; }

echo "== 2. card visible to PKCS#11? (informational) =="
systemctl start pcscd.socket 2>/dev/null || true
opensc-tool --atr 2>&1 | tail -2 || true
pkcs11-tool --module "$DRIVER" --list-token-slots 2>&1 | grep -iE "Slot|token label|present" | head || true

echo "== 3. start a throwaway agent against the real token (TLS off, port $PORT, slot $SLOT) =="
fuser -k "${PORT}/tcp" 2>/dev/null || true
EUDSS_PKCS11_DRIVER="$DRIVER" EUDSS_PKCS11_SLOT="$SLOT" EUDSS_AGENT_PORT="$PORT" EUDSS_AGENT_TLS=false \
  nohup /opt/eu-dss-agent/bin/eu-dss-agent >"$LOG" 2>&1 &
for i in $(seq 1 30); do curl -s --max-time 2 "$BASE/rest/health" >/dev/null 2>&1 && break; sleep 1; done
echo -n "  health: "; curl -s "$BASE/rest/health"; echo

echo "== 4. unlock with the REAL card PIN (not stored) =="
read -r -s -p "  Enter card PIN: " PIN; echo
UNLOCK=$(curl -s -X POST "$BASE/rest/unlock" -H 'Content-Type: application/json' -d "{\"pin\":\"$PIN\"}")
PIN=; echo "  $UNLOCK"
echo "$UNLOCK" | grep -q '"unlocked":true' || { echo "  Unlock failed (PIN/slot). Agent log:"; tail -20 "$LOG"; fuser -k "${PORT}/tcp" 2>/dev/null||true; exit 1; }

echo "== 5. the REAL qualified certificate on the card =="
CERTS=$(curl -s "$BASE/rest/certificates")
KEYID=$(echo "$CERTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["certificates"][0]["keyId"])')
echo "$CERTS" | python3 -c 'import sys,json;c=json.load(sys.stdin)["certificates"][0];[print(f"  {k}: {c[k]}") for k in ("subjectDn","issuerDn","serialNumber","notAfter")]'
echo "$CERTS" | python3 -c 'import sys,json,base64;open("/tmp/eudss-realcard.crt.der","wb").write(base64.b64decode(json.load(sys.stdin)["certificates"][0]["certificateBase64"]))'

echo "== 6. sign a SHA-256 digest with the card =="
echo -n "EU-DSS real-card Linux signing proof $(date -u +%FT%TZ)" > /tmp/eudss-msg.bin
DIGEST_B64=$(openssl dgst -sha256 -binary /tmp/eudss-msg.bin | base64 -w0)
SIGRESP=$(curl -s -X POST "$BASE/rest/sign" -H 'Content-Type: application/json' \
  -d "{\"keyId\":\"$KEYID\",\"digestBase64\":\"$DIGEST_B64\",\"digestAlgorithm\":\"SHA256\"}")
echo "$SIGRESP" | python3 -c 'import sys,json,base64;open("/tmp/eudss-sig.bin","wb").write(base64.b64decode(json.load(sys.stdin)["signatureValueBase64"]))' \
  || { echo "  sign failed: $SIGRESP"; tail -20 "$LOG"; fuser -k "${PORT}/tcp" 2>/dev/null||true; exit 1; }

echo "== 7. verify the signature against the card's certificate =="
python3 - <<'PY'
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding
from cryptography.x509 import load_der_x509_certificate
pub = load_der_x509_certificate(open("/tmp/eudss-realcard.crt.der","rb").read()).public_key()
msg = open("/tmp/eudss-msg.bin","rb").read(); sig = open("/tmp/eudss-sig.bin","rb").read()
if isinstance(pub, ec.EllipticCurvePublicKey):
    pub.verify(sig, msg, ec.ECDSA(hashes.SHA256()))
else:
    pub.verify(sig, msg, padding.PKCS1v15(), hashes.SHA256())
print("*** REAL-CARD SIGNATURE VALID on Linux amd64 -- end-to-end OK ***")
PY

fuser -k "${PORT}/tcp" 2>/dev/null || true
echo "== DONE =="
