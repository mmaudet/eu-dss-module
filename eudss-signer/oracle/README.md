# Oracle validation (real card)

Proves the Rust signing core matches the Java agent on a real ChamberSign card.

## Steps

1. Plug in the token. Confirm the middleware is installed (macOS `/Library/SCMiddleware/libidop11.dylib`,
   Linux `/usr/lib/SCMiddleware/libidop11.so`, Windows `C:\Program Files\Smart Card Middleware\bin\idoPKCS.dll`).
2. Build the CLI: `cargo build --bin eudss-signer-cli`.
3. Find the signing keyId:
   `./target/debug/eudss-signer-cli list --module "$EUDSS_PKCS11_MODULE"`
4. Start the Java agent (`bin/eu-dss-agent-macos.sh` or the platform script).
5. Run `EUDSS_PKCS11_MODULE=<path> ./oracle/compare.sh`.

## Acceptance

- RSA (PKCS#1 v1.5): the two base64 signatures are EQUAL (`ORACLE PASS`).
- For PSS or ECDSA keys (non-deterministic): equality will not hold; instead verify both
  signatures validate against the cert public key, and that a full DSS round-trip
  (`/api/sign/prepare` -> Rust sign -> `/api/sign/assemble` -> `/api/validate`) returns TOTAL_PASSED.

Record the result (OS, card, PASS/FAIL) in the plan's task checkbox notes.
