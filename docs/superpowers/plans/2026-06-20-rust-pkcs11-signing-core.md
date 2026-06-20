# Rust PKCS#11 Signing Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Rust crate (`eudss-signer`) that reproduces the Java agent's PKCS#11 signing operations (list certificates, unlock/login, sign a digest), validated byte-for-byte against the Java agent on a real card.

**Architecture:** A focused library crate with pure-logic modules (DigestInfo construction, mechanism selection, error mapping, certificate parsing, session state) that are unit-TDD'd without hardware, plus a `token` integration layer over the `cryptoki` PKCS#11 binding that is tested in CI against SoftHSM2 (a software token) and finally validated against a real ChamberSign card via an oracle comparison with the existing Java agent. A thin CLI binary exposes the operations for the oracle harness and manual testing. This crate becomes a path dependency of the Tauri app in a later plan.

**Tech Stack:** Rust, `cryptoki` (PKCS#11), `base64`, `zeroize`, `x509-parser`, `thiserror`, `hex`; dev: `rsa` + `sha2` (signature crypto-verification); SoftHSM2 + `pkcs11-tool` + `openssl` for the test token; GitHub Actions for CI.

This is Plan 1 of 5 (see `docs/superpowers/specs/2026-06-20-option-a-tauri-signing-client-design.md`). It produces a testable signing core on its own. It does NOT build the Tauri app, the UI, the backend jobs API, or packaging.

---

## Conventions used in this plan

- All paths are relative to the repo root `/Users/mmaudet/work/eu-dss`.
- The crate lives in a new top-level directory `eudss-signer/` (a sibling of `eu-dss-agent/`).
- Run `cargo` commands from inside `eudss-signer/`.
- Commit messages use the repo's conventional style with scope `signer`.
- The public API surface mirrors the Java agent (`agentApi.ts`): `status`, `unlock`, `lock`, `list_certificates`, `sign`.

### Public API contract (locked here, built across tasks)

```rust
// SessionStatus mirrors agentApi.ts AgentSessionStatus
pub struct SessionStatus { pub unlocked: bool, pub expires_in_seconds: Option<u64>, pub mode: &'static str }

// CertEntry mirrors agentApi.ts AgentCertificate (chain is leaf-only in Plan 1, refined later)
pub struct CertEntry {
    pub key_id: String,
    pub certificate_b64: String,
    pub certificate_chain_b64: Vec<String>,
    pub subject_dn: String,
    pub issuer_dn: String,
    pub serial_number: String,
    pub not_before: String,
    pub not_after: String,
}

pub struct Signer { /* private */ }
impl Signer {
    pub fn new(module_path: &str, slot_index: usize, ttl: std::time::Duration) -> Result<Self, SignerError>;
    pub fn status(&self) -> SessionStatus;
    pub fn unlock(&mut self, pin: &str) -> Result<SessionStatus, SignerError>;
    pub fn lock(&mut self) -> Result<(), SignerError>;
    pub fn list_certificates(&self) -> Result<Vec<CertEntry>, SignerError>;
    pub fn sign(&mut self, key_id: &str, digest_b64: &str, digest_alg: &str) -> Result<String, SignerError>;
}
```

---

## Task 0: Scaffold the crate

**Files:**
- Create: `eudss-signer/Cargo.toml`
- Create: `eudss-signer/src/lib.rs`
- Create: `eudss-signer/.gitignore`

- [ ] **Step 1: Create `eudss-signer/.gitignore`**

```gitignore
/target
/.softhsm
```

- [ ] **Step 2: Create `eudss-signer/Cargo.toml`**

```toml
[package]
name = "eudss-signer"
version = "0.1.0"
edition = "2021"
description = "PKCS#11 signing core for the EU-DSS native client"

[dependencies]
cryptoki = "0.7"
base64 = "0.22"
zeroize = "1"
x509-parser = "0.16"
thiserror = "1"
hex = "0.4"

[dev-dependencies]
rsa = "0.9"
sha2 = "0.10"

[[bin]]
name = "eudss-signer-cli"
path = "src/bin/eudss-signer-cli.rs"
```

- [ ] **Step 3: Create a placeholder `eudss-signer/src/lib.rs` with one trivial test**

```rust
//! PKCS#11 signing core for the EU-DSS native client.

#[cfg(test)]
mod smoke {
    #[test]
    fn crate_builds() {
        assert_eq!(2 + 2, 4);
    }
}
```

- [ ] **Step 4: Verify the crate builds and the test runs**

Run: `cd eudss-signer && cargo test`
Expected: compiles, `crate_builds` passes. (The `[[bin]]` will fail to build until Task 12 creates the file, so for now remove the `[[bin]]` block OR create an empty `src/bin/eudss-signer-cli.rs` with `fn main() {}`.)

- [ ] **Step 5: Create a stub bin so the manifest is valid**

Create `eudss-signer/src/bin/eudss-signer-cli.rs`:

```rust
fn main() {
    eprintln!("eudss-signer-cli: not yet implemented");
}
```

Run: `cd eudss-signer && cargo build`
Expected: builds cleanly.

- [ ] **Step 6: Commit**

```bash
git add eudss-signer/Cargo.toml eudss-signer/src/lib.rs eudss-signer/src/bin/eudss-signer-cli.rs eudss-signer/.gitignore
git commit -m "feat(signer): scaffold eudss-signer Rust crate"
```

---

## Task 1: DigestAlgorithm and DigestInfo construction

The RSA PKCS#1 v1.5 signature is computed over a DigestInfo (the digest wrapped in a fixed DER prefix). Getting these prefixes exactly right is what makes the Rust signature byte-equal to DSS.

**Files:**
- Create: `eudss-signer/src/digest.rs`
- Modify: `eudss-signer/src/lib.rs`

- [ ] **Step 1: Write the failing test in `eudss-signer/src/digest.rs`**

```rust
//! Digest algorithms and PKCS#1 v1.5 DigestInfo construction.

/// Hash algorithms the agent contract accepts (agentApi.ts: 'SHA256' | 'SHA384' | 'SHA512').
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DigestAlgorithm {
    Sha256,
    Sha384,
    Sha512,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agent_strings() {
        assert_eq!(DigestAlgorithm::from_name("SHA256"), Some(DigestAlgorithm::Sha256));
        assert_eq!(DigestAlgorithm::from_name("SHA384"), Some(DigestAlgorithm::Sha384));
        assert_eq!(DigestAlgorithm::from_name("SHA512"), Some(DigestAlgorithm::Sha512));
        assert_eq!(DigestAlgorithm::from_name("md5"), None);
    }

    #[test]
    fn digest_info_sha256_has_correct_prefix_and_length() {
        // RFC 8017 EMSA-PKCS1-v1_5 SHA-256 DigestInfo prefix (19 bytes) + 32-byte digest.
        let digest = [0u8; 32];
        let di = DigestAlgorithm::Sha256.digest_info(&digest);
        let expected_prefix: [u8; 19] = [
            0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02,
            0x01, 0x05, 0x00, 0x04, 0x20,
        ];
        assert_eq!(&di[..19], &expected_prefix);
        assert_eq!(&di[19..], &digest);
        assert_eq!(di.len(), 19 + 32);
    }

    #[test]
    fn digest_info_sha512_prefix() {
        let digest = [0u8; 64];
        let di = DigestAlgorithm::Sha512.digest_info(&digest);
        let expected_prefix: [u8; 19] = [
            0x30, 0x51, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02,
            0x03, 0x05, 0x00, 0x04, 0x40,
        ];
        assert_eq!(&di[..19], &expected_prefix);
        assert_eq!(di.len(), 19 + 64);
    }

    #[test]
    fn digest_len_matches_algorithm() {
        assert_eq!(DigestAlgorithm::Sha256.digest_len(), 32);
        assert_eq!(DigestAlgorithm::Sha384.digest_len(), 48);
        assert_eq!(DigestAlgorithm::Sha512.digest_len(), 64);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd eudss-signer && cargo test digest::`
Expected: FAIL to compile (`from_name`, `digest_info`, `digest_len` not defined).

- [ ] **Step 3: Implement the methods in `eudss-signer/src/digest.rs` (above the `#[cfg(test)]` block)**

```rust
impl DigestAlgorithm {
    /// Parse the agent's algorithm name. Case-insensitive on the SHA family.
    pub fn from_name(name: &str) -> Option<DigestAlgorithm> {
        match name.to_ascii_uppercase().as_str() {
            "SHA256" => Some(DigestAlgorithm::Sha256),
            "SHA384" => Some(DigestAlgorithm::Sha384),
            "SHA512" => Some(DigestAlgorithm::Sha512),
            _ => None,
        }
    }

    /// Expected raw digest length in bytes.
    pub fn digest_len(self) -> usize {
        match self {
            DigestAlgorithm::Sha256 => 32,
            DigestAlgorithm::Sha384 => 48,
            DigestAlgorithm::Sha512 => 64,
        }
    }

    /// The fixed DER DigestInfo prefix (RFC 8017, EMSA-PKCS1-v1_5).
    fn der_prefix(self) -> &'static [u8] {
        match self {
            DigestAlgorithm::Sha256 => &[
                0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04,
                0x02, 0x01, 0x05, 0x00, 0x04, 0x20,
            ],
            DigestAlgorithm::Sha384 => &[
                0x30, 0x41, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04,
                0x02, 0x02, 0x05, 0x00, 0x04, 0x30,
            ],
            DigestAlgorithm::Sha512 => &[
                0x30, 0x51, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04,
                0x02, 0x03, 0x05, 0x00, 0x04, 0x40,
            ],
        }
    }

    /// Build the DigestInfo (prefix || digest) signed by CKM_RSA_PKCS.
    pub fn digest_info(self, digest: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(19 + digest.len());
        out.extend_from_slice(self.der_prefix());
        out.extend_from_slice(digest);
        out
    }
}
```

- [ ] **Step 4: Register the module in `eudss-signer/src/lib.rs`**

Add at the top of `src/lib.rs` (replacing the `smoke` module):

```rust
//! PKCS#11 signing core for the EU-DSS native client.

pub mod digest;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd eudss-signer && cargo test digest::`
Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add eudss-signer/src/digest.rs eudss-signer/src/lib.rs
git commit -m "feat(signer): DigestAlgorithm + PKCS#1 v1.5 DigestInfo"
```

---

## Task 2: Signature mechanism selection

Maps (key type, digest algorithm) to the signature algorithm and the exact bytes to feed `C_Sign`. RSA signs a DigestInfo; ECDSA signs the raw digest. Kept pure (no `cryptoki` types) so it is unit-testable; the `token` layer maps `SigAlg` to a `cryptoki::Mechanism`.

**Files:**
- Create: `eudss-signer/src/mechanism.rs`
- Modify: `eudss-signer/src/lib.rs`

- [ ] **Step 1: Write the failing test in `eudss-signer/src/mechanism.rs`**

```rust
//! Maps key type + digest algorithm to a signature algorithm and the bytes to sign.

use crate::digest::DigestAlgorithm;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    Rsa,
    Ec,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigAlg {
    /// CKM_RSA_PKCS over a DigestInfo.
    RsaPkcs1v15,
    /// CKM_ECDSA over the raw digest.
    Ecdsa,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rsa_signs_digestinfo() {
        let digest = [0xABu8; 32];
        let (alg, input) = signing_input(KeyKind::Rsa, DigestAlgorithm::Sha256, &digest);
        assert_eq!(alg, SigAlg::RsaPkcs1v15);
        // RSA input is the DigestInfo (prefix + digest), longer than the raw digest.
        assert_eq!(input, DigestAlgorithm::Sha256.digest_info(&digest));
    }

    #[test]
    fn ec_signs_raw_digest() {
        let digest = [0xABu8; 32];
        let (alg, input) = signing_input(KeyKind::Ec, DigestAlgorithm::Sha256, &digest);
        assert_eq!(alg, SigAlg::Ecdsa);
        assert_eq!(input, digest.to_vec());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd eudss-signer && cargo test mechanism::`
Expected: FAIL to compile (`signing_input` not defined).

- [ ] **Step 3: Implement `signing_input` in `eudss-signer/src/mechanism.rs`**

```rust
/// Returns the signature algorithm and the exact bytes to pass to C_Sign.
pub fn signing_input(key: KeyKind, algo: DigestAlgorithm, digest: &[u8]) -> (SigAlg, Vec<u8>) {
    match key {
        KeyKind::Rsa => (SigAlg::RsaPkcs1v15, algo.digest_info(digest)),
        KeyKind::Ec => (SigAlg::Ecdsa, digest.to_vec()),
    }
}
```

- [ ] **Step 4: Register the module in `eudss-signer/src/lib.rs`**

Add: `pub mod mechanism;`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd eudss-signer && cargo test mechanism::`
Expected: 2 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add eudss-signer/src/mechanism.rs eudss-signer/src/lib.rs
git commit -m "feat(signer): signature mechanism selection (RSA/ECDSA)"
```

---

## Task 3: Structured errors and codes

Mirrors the agent's structured error codes (`pin_incorrect`, `pin_locked`, `token_unavailable`, `locked`) so the UI reacts identically. The mapping from `cryptoki` errors is the safety-critical part: a wrong PIN must surface as `pin_incorrect` with NO retry.

**Files:**
- Create: `eudss-signer/src/error.rs`
- Modify: `eudss-signer/src/lib.rs`

- [ ] **Step 1: Write the failing test in `eudss-signer/src/error.rs`**

```rust
//! Structured signer errors, with agent-compatible string codes.

use cryptoki::error::{Error as CkError, RvError};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SignerError {
    #[error("PIN incorrect")]
    PinIncorrect,
    #[error("PIN locked")]
    PinLocked,
    #[error("token unavailable")]
    TokenUnavailable,
    #[error("session locked")]
    Locked,
    #[error("unknown key id: {0}")]
    UnknownKeyId(String),
    #[error("unsupported digest algorithm: {0}")]
    UnsupportedDigest(String),
    #[error("mechanism not available on token: {0}")]
    MechanismUnavailable(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("certificate parse error: {0}")]
    CertParse(String),
    #[error("pkcs11 error: {0}")]
    Pkcs11(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use cryptoki::error::{Error as CkError, RvError};

    #[test]
    fn codes_match_agent_contract() {
        assert_eq!(SignerError::PinIncorrect.code(), "pin_incorrect");
        assert_eq!(SignerError::PinLocked.code(), "pin_locked");
        assert_eq!(SignerError::TokenUnavailable.code(), "token_unavailable");
        assert_eq!(SignerError::Locked.code(), "locked");
        assert_eq!(SignerError::UnknownKeyId("x".into()).code(), "unknown_key_id");
    }

    #[test]
    fn maps_pin_incorrect_from_pkcs11() {
        let mapped = SignerError::from_pkcs11(CkError::Pkcs11(RvError::PinIncorrect, "C_Login".into()));
        assert!(matches!(mapped, SignerError::PinIncorrect));
    }

    #[test]
    fn maps_pin_locked_from_pkcs11() {
        let mapped = SignerError::from_pkcs11(CkError::Pkcs11(RvError::PinLocked, "C_Login".into()));
        assert!(matches!(mapped, SignerError::PinLocked));
    }

    #[test]
    fn maps_token_not_present_to_unavailable() {
        let mapped = SignerError::from_pkcs11(CkError::Pkcs11(RvError::TokenNotPresent, "x".into()));
        assert!(matches!(mapped, SignerError::TokenUnavailable));
    }
}
```

> Note: the exact `RvError` variant constructor shape (`CkError::Pkcs11(RvError::PinIncorrect, ctx)`) must be checked against the pinned `cryptoki` 0.7 docs; adjust the test constructors and the match arms together if the crate uses a different shape.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd eudss-signer && cargo test error::`
Expected: FAIL to compile (`code`, `from_pkcs11` not defined).

- [ ] **Step 3: Implement `code()` and `from_pkcs11()` in `eudss-signer/src/error.rs`**

```rust
impl SignerError {
    /// Agent-compatible string code for the UI.
    pub fn code(&self) -> &'static str {
        match self {
            SignerError::PinIncorrect => "pin_incorrect",
            SignerError::PinLocked => "pin_locked",
            SignerError::TokenUnavailable => "token_unavailable",
            SignerError::Locked => "locked",
            SignerError::UnknownKeyId(_) => "unknown_key_id",
            SignerError::UnsupportedDigest(_) => "unsupported_digest",
            SignerError::MechanismUnavailable(_) => "mechanism_unavailable",
            SignerError::InvalidInput(_) => "invalid_input",
            SignerError::CertParse(_) => "cert_parse_error",
            SignerError::Pkcs11(_) => "pkcs11_error",
        }
    }

    /// Map a cryptoki error to a structured signer error. Wrong/locked PIN map to the
    /// dedicated codes; the caller must NEVER auto-retry a wrong PIN (card-lock safety).
    pub fn from_pkcs11(e: CkError) -> SignerError {
        match e {
            CkError::Pkcs11(RvError::PinIncorrect, _) => SignerError::PinIncorrect,
            CkError::Pkcs11(RvError::PinLocked, _) => SignerError::PinLocked,
            CkError::Pkcs11(RvError::TokenNotPresent, _)
            | CkError::Pkcs11(RvError::TokenNotRecognized, _)
            | CkError::Pkcs11(RvError::SlotIdInvalid, _)
            | CkError::Pkcs11(RvError::DeviceRemoved, _) => SignerError::TokenUnavailable,
            CkError::Pkcs11(RvError::MechanismInvalid, ctx) => {
                SignerError::MechanismUnavailable(ctx)
            }
            other => SignerError::Pkcs11(other.to_string()),
        }
    }
}
```

- [ ] **Step 4: Register the module in `eudss-signer/src/lib.rs`**

Add: `pub mod error;`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd eudss-signer && cargo test error::`
Expected: tests PASS (after reconciling the `RvError` constructor shape with the pinned crate, per the Step 1 note).

- [ ] **Step 6: Commit**

```bash
git add eudss-signer/src/error.rs eudss-signer/src/lib.rs
git commit -m "feat(signer): structured errors with agent-compatible codes"
```

---

## Task 4: keyId derivation

The `keyId` ties a `list_certificates` entry to a private key for `sign`. It is the uppercase hex of the PKCS#11 object `CKA_ID` shared by the cert and its key.

**Files:**
- Create: `eudss-signer/src/keyid.rs`
- Modify: `eudss-signer/src/lib.rs`

- [ ] **Step 1: Write the failing test in `eudss-signer/src/keyid.rs`**

```rust
//! keyId = uppercase hex of the PKCS#11 CKA_ID.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_uppercase_of_cka_id() {
        assert_eq!(key_id_from_cka_id(&[0x01]), "01");
        assert_eq!(key_id_from_cka_id(&[0xab, 0xcd, 0xef]), "ABCDEF");
    }

    #[test]
    fn round_trips_back_to_bytes() {
        let id = key_id_from_cka_id(&[0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(cka_id_from_key_id(&id).unwrap(), vec![0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn rejects_non_hex() {
        assert!(cka_id_from_key_id("zz").is_none());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd eudss-signer && cargo test keyid::`
Expected: FAIL to compile.

- [ ] **Step 3: Implement in `eudss-signer/src/keyid.rs`**

```rust
pub fn key_id_from_cka_id(cka_id: &[u8]) -> String {
    hex::encode_upper(cka_id)
}

pub fn cka_id_from_key_id(key_id: &str) -> Option<Vec<u8>> {
    hex::decode(key_id).ok()
}
```

- [ ] **Step 4: Register the module in `eudss-signer/src/lib.rs`**

Add: `pub mod keyid;`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd eudss-signer && cargo test keyid::`
Expected: 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add eudss-signer/src/keyid.rs eudss-signer/src/lib.rs
git commit -m "feat(signer): keyId derivation from CKA_ID"
```

---

## Task 5: Certificate parsing

Parses a DER certificate read from the token into the fields `list_certificates` returns.

**Files:**
- Create: `eudss-signer/src/cert.rs`
- Create: `eudss-signer/tests/fixtures/test-cert.der` (generated)
- Modify: `eudss-signer/src/lib.rs`

- [ ] **Step 1: Generate the fixture certificate**

```bash
mkdir -p eudss-signer/tests/fixtures
openssl req -x509 -newkey rsa:2048 -keyout /tmp/eudss-fixture-key.pem -nodes \
  -out /tmp/eudss-fixture-cert.pem -days 3650 -subj "/CN=EUDSS Test/O=Linagora"
openssl x509 -in /tmp/eudss-fixture-cert.pem -outform DER -out eudss-signer/tests/fixtures/test-cert.der
```

Expected: `eudss-signer/tests/fixtures/test-cert.der` exists (a DER file ~900 bytes).

- [ ] **Step 2: Write the failing test in `eudss-signer/src/cert.rs`**

```rust
//! Parse a DER certificate into the fields list_certificates returns.

use crate::error::SignerError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertInfo {
    pub subject_dn: String,
    pub issuer_dn: String,
    pub serial_number: String,
    pub not_before: String,
    pub not_after: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_subject_and_issuer() {
        let der = include_bytes!("../tests/fixtures/test-cert.der");
        let info = parse(der).expect("fixture must parse");
        assert!(info.subject_dn.contains("EUDSS Test"), "subject was {}", info.subject_dn);
        assert!(info.subject_dn.contains("Linagora"));
        // self-signed: issuer == subject
        assert_eq!(info.issuer_dn, info.subject_dn);
        assert!(!info.serial_number.is_empty());
        assert!(!info.not_before.is_empty());
        assert!(!info.not_after.is_empty());
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse(&[0x00, 0x01, 0x02]).is_err());
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd eudss-signer && cargo test cert::`
Expected: FAIL to compile (`parse` not defined).

- [ ] **Step 4: Implement `parse` in `eudss-signer/src/cert.rs`**

```rust
use x509_parser::prelude::*;

pub fn parse(der: &[u8]) -> Result<CertInfo, SignerError> {
    let (_, cert) =
        X509Certificate::from_der(der).map_err(|e| SignerError::CertParse(e.to_string()))?;
    Ok(CertInfo {
        subject_dn: cert.subject().to_string(),
        issuer_dn: cert.issuer().to_string(),
        serial_number: cert.raw_serial_as_string(),
        not_before: cert.validity().not_before.to_string(),
        not_after: cert.validity().not_after.to_string(),
    })
}
```

> Note: `ASN1Time::to_string()` yields a stable human-readable form; the contract only requires non-empty strings here. Plan 2 may reformat to RFC 3339 if the UI needs it.

- [ ] **Step 5: Register the module in `eudss-signer/src/lib.rs`**

Add: `pub mod cert;`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd eudss-signer && cargo test cert::`
Expected: 2 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add eudss-signer/src/cert.rs eudss-signer/tests/fixtures/test-cert.der eudss-signer/src/lib.rs
git commit -m "feat(signer): DER certificate parsing"
```

---

## Task 6: Session state with idle TTL

A pure state machine for the unlock session: locked by default, unlocks on `unlock`, re-locks after an idle TTL. The clock is injected (`now: Instant`) so it is testable without sleeping.

**Files:**
- Create: `eudss-signer/src/session.rs`
- Modify: `eudss-signer/src/lib.rs`

- [ ] **Step 1: Write the failing test in `eudss-signer/src/session.rs`**

```rust
//! Unlock-session state machine with an idle TTL. Clock is injected for testing.

use std::time::{Duration, Instant};

pub struct SessionState {
    ttl: Duration,
    /// Some(last_activity) when unlocked, None when locked.
    unlocked_since_activity: Option<Instant>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locked_by_default() {
        let s = SessionState::new(Duration::from_secs(300));
        let now = Instant::now();
        assert!(!s.is_unlocked(now));
        assert_eq!(s.expires_in_seconds(now), None);
    }

    #[test]
    fn unlocked_then_expires_after_ttl() {
        let mut s = SessionState::new(Duration::from_secs(300));
        let t0 = Instant::now();
        s.unlock(t0);
        assert!(s.is_unlocked(t0));
        assert_eq!(s.expires_in_seconds(t0), Some(300));

        let t_mid = t0 + Duration::from_secs(100);
        assert!(s.is_unlocked(t_mid));
        assert_eq!(s.expires_in_seconds(t_mid), Some(200));

        let t_after = t0 + Duration::from_secs(301);
        assert!(!s.is_unlocked(t_after));
        assert_eq!(s.expires_in_seconds(t_after), None);
    }

    #[test]
    fn touch_extends_the_window() {
        let mut s = SessionState::new(Duration::from_secs(300));
        let t0 = Instant::now();
        s.unlock(t0);
        let t_use = t0 + Duration::from_secs(200);
        s.touch(t_use);
        // 250s after t0 is only 50s after the touch, still unlocked.
        assert!(s.is_unlocked(t0 + Duration::from_secs(250)));
    }

    #[test]
    fn explicit_lock_locks() {
        let mut s = SessionState::new(Duration::from_secs(300));
        let t0 = Instant::now();
        s.unlock(t0);
        s.lock();
        assert!(!s.is_unlocked(t0));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd eudss-signer && cargo test session::`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `SessionState` in `eudss-signer/src/session.rs`**

```rust
impl SessionState {
    pub fn new(ttl: Duration) -> Self {
        SessionState { ttl, unlocked_since_activity: None }
    }

    pub fn unlock(&mut self, now: Instant) {
        self.unlocked_since_activity = Some(now);
    }

    pub fn lock(&mut self) {
        self.unlocked_since_activity = None;
    }

    /// Record activity, resetting the idle timer (no-op if already locked/expired).
    pub fn touch(&mut self, now: Instant) {
        if self.is_unlocked(now) {
            self.unlocked_since_activity = Some(now);
        }
    }

    pub fn is_unlocked(&self, now: Instant) -> bool {
        match self.unlocked_since_activity {
            Some(last) => now.duration_since(last) <= self.ttl,
            None => false,
        }
    }

    pub fn expires_in_seconds(&self, now: Instant) -> Option<u64> {
        match self.unlocked_since_activity {
            Some(last) if now.duration_since(last) <= self.ttl => {
                Some((self.ttl - now.duration_since(last)).as_secs())
            }
            _ => None,
        }
    }
}
```

- [ ] **Step 4: Register the module in `eudss-signer/src/lib.rs`**

Add: `pub mod session;`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd eudss-signer && cargo test session::`
Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add eudss-signer/src/session.rs eudss-signer/src/lib.rs
git commit -m "feat(signer): unlock-session state machine with idle TTL"
```

---

## Task 7: SoftHSM2 test token setup

A reproducible software token (SoftHSM2) holding an RSA-2048 key + matching certificate sharing `CKA_ID=01`, so the `token` integration layer can be tested in CI without a real card. Integration tests skip when the module env var is unset, so plain `cargo test` stays green locally.

**Files:**
- Create: `eudss-signer/tests/setup_softhsm.sh`
- Create: `eudss-signer/tests/softhsm_integration.rs`

- [ ] **Step 1: Create `eudss-signer/tests/setup_softhsm.sh`**

```bash
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
softhsm2-util --init-token --free --label eudss-test --pin "$PIN" --so-pin "$SOPIN"

# Build a key + self-signed cert outside, bundle to PKCS#12, import the key, then the cert.
TMP="$(mktemp -d)"
openssl req -x509 -newkey rsa:2048 -keyout "$TMP/key.pem" -nodes \
  -out "$TMP/cert.pem" -days 3650 -subj "/CN=EUDSS SoftHSM/O=Linagora"
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -out "$TMP/bundle.p12" -passout pass:
softhsm2-util --import "$TMP/bundle.p12" --token eudss-test \
  --label eudss-key --id 01 --pin "$PIN" --file-pin ""
openssl x509 -in "$TMP/cert.pem" -outform DER -out "$TMP/cert.der"
pkcs11-tool --module "$MODULE" --login --pin "$PIN" \
  --write-object "$TMP/cert.der" --type cert --id 01 --label eudss-cert
rm -rf "$TMP"

echo "export SOFTHSM2_CONF=$SOFTHSM2_CONF"
echo "export EUDSS_TEST_PKCS11_MODULE=$MODULE"
echo "export EUDSS_TEST_PKCS11_PIN=$PIN"
```

Make it executable:

```bash
chmod +x eudss-signer/tests/setup_softhsm.sh
```

- [ ] **Step 2: Run the setup script locally to confirm it works**

```bash
# Requires: softhsm2-util, pkcs11-tool (opensc), openssl on PATH.
# macOS: brew install softhsm opensc openssl
# Ubuntu: sudo apt-get install -y softhsm2 opensc
eval "$(eudss-signer/tests/setup_softhsm.sh)"
echo "$EUDSS_TEST_PKCS11_MODULE"
```

Expected: prints export lines and a module path. (If tools are missing, install them; CI installs them in Task 14.)

- [ ] **Step 3: Create the integration test harness `eudss-signer/tests/softhsm_integration.rs`**

```rust
//! Integration tests against a SoftHSM2 token. Skipped unless EUDSS_TEST_PKCS11_MODULE is set
//! (run `eval "$(tests/setup_softhsm.sh)"` first).

use eudss_signer::Signer;
use std::time::Duration;

fn test_signer() -> Option<Signer> {
    let module = std::env::var("EUDSS_TEST_PKCS11_MODULE").ok()?;
    Some(Signer::new(&module, 0, Duration::from_secs(300)).expect("open module"))
}

#[test]
fn lists_the_imported_certificate() {
    let Some(signer) = test_signer() else {
        eprintln!("SKIP: EUDSS_TEST_PKCS11_MODULE not set");
        return;
    };
    let certs = signer.list_certificates().expect("list");
    assert_eq!(certs.len(), 1, "expected exactly the imported cert");
    assert_eq!(certs[0].key_id, "01");
    assert!(certs[0].subject_dn.contains("EUDSS SoftHSM"));
}
```

- [ ] **Step 4: Run it to verify it fails to compile (Signer not built yet)**

Run: `cd eudss-signer && cargo test --test softhsm_integration`
Expected: FAIL to compile (`eudss_signer::Signer` does not exist yet). This is expected; Tasks 8 to 11 build it.

- [ ] **Step 5: Commit the test scaffolding**

```bash
git add eudss-signer/tests/setup_softhsm.sh eudss-signer/tests/softhsm_integration.rs
git commit -m "test(signer): SoftHSM2 token setup + integration harness"
```

---

## Task 8: token layer: open module and list certificates

The first real `cryptoki` code. `Signer::new` opens the module and selects the slot; `list_certificates` enumerates `CKO_CERTIFICATE` objects, reads `CKA_VALUE` + `CKA_ID`, and parses each via `cert.rs`.

**Files:**
- Create: `eudss-signer/src/token.rs`
- Create: `eudss-signer/src/signer.rs`
- Modify: `eudss-signer/src/lib.rs`

- [ ] **Step 1: Define the public types in `eudss-signer/src/signer.rs`**

```rust
//! Public Signer facade: ties the module, session state, and operations together.

use crate::error::SignerError;
use crate::session::SessionState;
use crate::token::Token;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionStatus {
    pub unlocked: bool,
    pub expires_in_seconds: Option<u64>,
    pub mode: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertEntry {
    pub key_id: String,
    pub certificate_b64: String,
    pub certificate_chain_b64: Vec<String>,
    pub subject_dn: String,
    pub issuer_dn: String,
    pub serial_number: String,
    pub not_before: String,
    pub not_after: String,
}

pub struct Signer {
    token: Token,
    session: SessionState,
}

impl Signer {
    pub fn new(module_path: &str, slot_index: usize, ttl: Duration) -> Result<Self, SignerError> {
        let token = Token::open(module_path, slot_index)?;
        Ok(Signer { token, session: SessionState::new(ttl) })
    }

    pub fn status(&self) -> SessionStatus {
        let now = Instant::now();
        SessionStatus {
            unlocked: self.session.is_unlocked(now),
            expires_in_seconds: self.session.expires_in_seconds(now),
            mode: "interactive",
        }
    }

    pub fn list_certificates(&self) -> Result<Vec<CertEntry>, SignerError> {
        self.token.list_certificates()
    }
}
```

- [ ] **Step 2: Implement `Token::open` and `Token::list_certificates` in `eudss-signer/src/token.rs`**

```rust
//! Thin cryptoki wrapper: open the module/slot, enumerate certs, login, sign.

use crate::cert;
use crate::error::SignerError;
use crate::keyid::key_id_from_cka_id;
use crate::signer::CertEntry;
use base64::{engine::general_purpose::STANDARD, Engine};
use cryptoki::context::{CInitializeArgs, Pkcs11};
use cryptoki::object::{Attribute, AttributeType, ObjectClass};
use cryptoki::slot::Slot;

pub struct Token {
    pkcs11: Pkcs11,
    slot: Slot,
}

impl Token {
    pub fn open(module_path: &str, slot_index: usize) -> Result<Self, SignerError> {
        let pkcs11 = Pkcs11::new(module_path).map_err(SignerError::from_pkcs11)?;
        pkcs11
            .initialize(CInitializeArgs::OsThreads)
            .map_err(SignerError::from_pkcs11)?;
        let slots = pkcs11
            .get_slots_with_token()
            .map_err(SignerError::from_pkcs11)?;
        let slot = *slots
            .get(slot_index)
            .ok_or(SignerError::TokenUnavailable)?;
        Ok(Token { pkcs11, slot })
    }

    pub fn list_certificates(&self) -> Result<Vec<CertEntry>, SignerError> {
        let session = self
            .pkcs11
            .open_ro_session(self.slot)
            .map_err(SignerError::from_pkcs11)?;
        let handles = session
            .find_objects(&[Attribute::Class(ObjectClass::CERTIFICATE)])
            .map_err(SignerError::from_pkcs11)?;

        let mut out = Vec::new();
        for handle in handles {
            let attrs = session
                .get_attributes(handle, &[AttributeType::Value, AttributeType::Id])
                .map_err(SignerError::from_pkcs11)?;
            let mut der: Option<Vec<u8>> = None;
            let mut id: Vec<u8> = Vec::new();
            for a in attrs {
                match a {
                    Attribute::Value(v) => der = Some(v),
                    Attribute::Id(v) => id = v,
                    _ => {}
                }
            }
            let Some(der) = der else { continue };
            let info = cert::parse(&der)?;
            let b64 = STANDARD.encode(&der);
            out.push(CertEntry {
                key_id: key_id_from_cka_id(&id),
                certificate_b64: b64.clone(),
                certificate_chain_b64: vec![b64], // leaf-only in Plan 1; chain refined in Plan 2
                subject_dn: info.subject_dn,
                issuer_dn: info.issuer_dn,
                serial_number: info.serial_number,
                not_before: info.not_before,
                not_after: info.not_after,
            });
        }
        Ok(out)
    }
}
```

> Note: `cryptoki` 0.7 attribute enum/getter shapes (`Attribute::Value(Vec<u8>)`, `get_attributes`) must be checked against the pinned crate docs; adjust the destructuring to match. The intent (read CKA_VALUE + CKA_ID per certificate object) is the contract.

- [ ] **Step 3: Register modules in `eudss-signer/src/lib.rs` and re-export the public API**

Add to `src/lib.rs`:

```rust
pub mod signer;
pub mod token;

pub use error::SignerError;
pub use signer::{CertEntry, SessionStatus, Signer};
```

- [ ] **Step 4: Build, then run the integration list test against SoftHSM2**

```bash
cd eudss-signer && cargo build
eval "$(tests/setup_softhsm.sh)"
cargo test --test softhsm_integration lists_the_imported_certificate -- --nocapture
```

Expected: `lists_the_imported_certificate` PASS (key_id "01", subject contains "EUDSS SoftHSM").

- [ ] **Step 5: Commit**

```bash
git add eudss-signer/src/token.rs eudss-signer/src/signer.rs eudss-signer/src/lib.rs
git commit -m "feat(signer): open module + list certificates (cryptoki)"
```

---

## Task 9: token layer: unlock/login with no-retry PIN safety

`unlock` opens an RW session, logs in once with the PIN, and zeroizes its copy of the PIN. A wrong PIN returns `pin_incorrect` and the core makes exactly ONE login attempt per call (no loop), so a caller cannot accidentally drive the card toward a lockout.

**Files:**
- Modify: `eudss-signer/src/token.rs`
- Modify: `eudss-signer/src/signer.rs`
- Modify: `eudss-signer/tests/softhsm_integration.rs`

- [ ] **Step 1: Write the failing integration tests (append to `eudss-signer/tests/softhsm_integration.rs`)**

```rust
#[test]
fn unlock_with_correct_pin_succeeds() {
    let Some(mut signer) = test_signer() else { return };
    let pin = std::env::var("EUDSS_TEST_PKCS11_PIN").unwrap();
    let status = signer.unlock(&pin).expect("unlock");
    assert!(status.unlocked);
    assert_eq!(status.expires_in_seconds, Some(300));
}

#[test]
fn unlock_with_wrong_pin_is_pin_incorrect() {
    let Some(mut signer) = test_signer() else { return };
    let err = signer.unlock("0000").expect_err("must fail");
    assert_eq!(err.code(), "pin_incorrect");
    // After a failed unlock the session is still locked.
    assert!(!signer.status().unlocked);
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd eudss-signer && cargo test --test softhsm_integration unlock_`
Expected: FAIL to compile (`unlock` not defined on `Signer`).

- [ ] **Step 3: Add login to `eudss-signer/src/token.rs`**

```rust
// add to imports:
use cryptoki::session::{Session, UserType};
use cryptoki::types::AuthPin;
use zeroize::Zeroize;

impl Token {
    /// Open an RW session and log in ONCE. Never retries; a wrong PIN returns PinIncorrect.
    pub fn login(&self, pin: &str) -> Result<Session, SignerError> {
        let session = self
            .pkcs11
            .open_rw_session(self.slot)
            .map_err(SignerError::from_pkcs11)?;
        let mut secret = pin.to_owned();
        let result = session.login(UserType::User, Some(&AuthPin::new(secret.clone())));
        secret.zeroize();
        result.map_err(SignerError::from_pkcs11)?;
        Ok(session)
    }
}
```

> Note: `AuthPin` and `login` signatures are `cryptoki` 0.7 specifics; reconcile with the pinned crate. The invariant: one login attempt, PIN copy zeroized after.

- [ ] **Step 4: Wire `unlock`/`lock` into `eudss-signer/src/signer.rs`**

Add a held session to `Signer` and the methods:

```rust
// change the struct to hold an optional live session:
pub struct Signer {
    token: Token,
    session: SessionState,
    live: Option<cryptoki::session::Session>,
}

// in Signer::new, initialise `live: None`.

impl Signer {
    pub fn unlock(&mut self, pin: &str) -> Result<SessionStatus, SignerError> {
        let live = self.token.login(pin)?; // one attempt, no retry
        self.live = Some(live);
        self.session.unlock(Instant::now());
        Ok(self.status())
    }

    pub fn lock(&mut self) -> Result<(), SignerError> {
        self.live = None; // dropping the Session logs out / closes it
        self.session.lock();
        Ok(())
    }
}
```

Update `Signer::new` to set `live: None`.

- [ ] **Step 5: Run the integration tests to verify they pass**

```bash
cd eudss-signer && eval "$(tests/setup_softhsm.sh)"
cargo test --test softhsm_integration unlock_ -- --nocapture
```

Expected: both `unlock_*` tests PASS.

- [ ] **Step 6: Commit**

```bash
git add eudss-signer/src/token.rs eudss-signer/src/signer.rs eudss-signer/tests/softhsm_integration.rs
git commit -m "feat(signer): unlock/login with one-attempt no-retry PIN safety"
```

---

## Task 10: token layer: sign a digest (RSA), verified against the public key

`sign` finds the private key by `keyId`, determines the key kind, builds the signing input via `mechanism.rs`, and calls `C_Sign`. The integration test verifies the produced signature against the imported cert's public key (a crypto-verify oracle, independent of any byte expectation).

**Files:**
- Modify: `eudss-signer/src/token.rs`
- Modify: `eudss-signer/src/signer.rs`
- Modify: `eudss-signer/tests/softhsm_integration.rs`

- [ ] **Step 1: Write the failing integration test (append to `eudss-signer/tests/softhsm_integration.rs`)**

```rust
use base64::{engine::general_purpose::STANDARD, Engine};
use rsa::pkcs1v15::{Signature, VerifyingKey};
use rsa::signature::Verifier;
use rsa::RsaPublicKey;
use sha2::{Digest, Sha256};
use x509_parser::prelude::*;

#[test]
fn sign_rsa_digest_verifies_against_cert_public_key() {
    let Some(mut signer) = test_signer() else { return };
    let pin = std::env::var("EUDSS_TEST_PKCS11_PIN").unwrap();
    signer.unlock(&pin).expect("unlock");

    let message = b"eudss oracle test message";
    let digest = Sha256::digest(message);
    let digest_b64 = STANDARD.encode(digest);

    let sig_b64 = signer.sign("01", &digest_b64, "SHA256").expect("sign");
    let sig_bytes = STANDARD.decode(sig_b64).unwrap();

    // Extract the public key from the cert the token returned.
    let certs = signer.list_certificates().unwrap();
    let der = STANDARD.decode(&certs[0].certificate_b64).unwrap();
    let (_, cert) = X509Certificate::from_der(&der).unwrap();
    let pub_der = cert.public_key().raw;
    let rsa_pub = RsaPublicKey::try_from(
        rsa::pkcs8::SubjectPublicKeyInfoRef::try_from(pub_der).unwrap(),
    )
    .unwrap();

    let vk = VerifyingKey::<Sha256>::new(rsa_pub);
    let sig = Signature::try_from(sig_bytes.as_slice()).unwrap();
    vk.verify(message, &sig).expect("signature must verify against the cert key");
}
```

> Note: the exact `rsa`/`x509-parser` import paths for building an `RsaPublicKey` from a SubjectPublicKeyInfo can differ by version; the contract is "verify the CKM_RSA_PKCS signature of the SHA-256 DigestInfo against the cert's RSA public key." Adjust imports to the pinned crates.

- [ ] **Step 2: Run to verify it fails**

Run: `cd eudss-signer && cargo test --test softhsm_integration sign_rsa`
Expected: FAIL to compile (`sign` not defined on `Signer`).

- [ ] **Step 3: Implement `Token::sign` in `eudss-signer/src/token.rs`**

```rust
// add to imports:
use cryptoki::mechanism::Mechanism;
use cryptoki::object::KeyType;
use crate::digest::DigestAlgorithm;
use crate::keyid::cka_id_from_key_id;
use crate::mechanism::{signing_input, KeyKind, SigAlg};

impl Token {
    pub fn sign(
        &self,
        session: &Session,
        key_id: &str,
        digest: &[u8],
        algo: DigestAlgorithm,
    ) -> Result<Vec<u8>, SignerError> {
        let cka_id = cka_id_from_key_id(key_id)
            .ok_or_else(|| SignerError::UnknownKeyId(key_id.to_string()))?;

        // Find the private key sharing this CKA_ID.
        let keys = session
            .find_objects(&[
                Attribute::Class(ObjectClass::PRIVATE_KEY),
                Attribute::Id(cka_id),
            ])
            .map_err(SignerError::from_pkcs11)?;
        let key = *keys
            .first()
            .ok_or_else(|| SignerError::UnknownKeyId(key_id.to_string()))?;

        // Determine key kind from CKA_KEY_TYPE.
        let kt = session
            .get_attributes(key, &[AttributeType::KeyType])
            .map_err(SignerError::from_pkcs11)?;
        let kind = match kt.into_iter().next() {
            Some(Attribute::KeyType(KeyType::EC)) => KeyKind::Ec,
            _ => KeyKind::Rsa,
        };

        let (alg, input) = signing_input(kind, algo, digest);
        let mechanism = match alg {
            SigAlg::RsaPkcs1v15 => Mechanism::RsaPkcs,
            SigAlg::Ecdsa => Mechanism::Ecdsa,
        };
        session
            .sign(&mechanism, key, &input)
            .map_err(SignerError::from_pkcs11)
    }
}
```

- [ ] **Step 4: Wire `sign` into `eudss-signer/src/signer.rs`**

```rust
use crate::digest::DigestAlgorithm;
use base64::{engine::general_purpose::STANDARD, Engine};

impl Signer {
    pub fn sign(
        &mut self,
        key_id: &str,
        digest_b64: &str,
        digest_alg: &str,
    ) -> Result<String, SignerError> {
        let now = Instant::now();
        if !self.session.is_unlocked(now) {
            self.live = None;
            return Err(SignerError::Locked);
        }
        let algo = DigestAlgorithm::from_name(digest_alg)
            .ok_or_else(|| SignerError::UnsupportedDigest(digest_alg.to_string()))?;
        let digest = STANDARD
            .decode(digest_b64)
            .map_err(|e| SignerError::InvalidInput(e.to_string()))?;
        if digest.len() != algo.digest_len() {
            return Err(SignerError::InvalidInput(format!(
                "digest length {} does not match {:?}",
                digest.len(),
                algo
            )));
        }
        let live = self.live.as_ref().ok_or(SignerError::Locked)?;
        let sig = self.token.sign(live, key_id, &digest, algo)?;
        self.session.touch(now);
        Ok(STANDARD.encode(sig))
    }
}
```

- [ ] **Step 5: Run the integration test to verify it passes**

```bash
cd eudss-signer && eval "$(tests/setup_softhsm.sh)"
cargo test --test softhsm_integration sign_rsa -- --nocapture
```

Expected: `sign_rsa_digest_verifies_against_cert_public_key` PASS.

- [ ] **Step 6: Commit**

```bash
git add eudss-signer/src/token.rs eudss-signer/src/signer.rs eudss-signer/tests/softhsm_integration.rs
git commit -m "feat(signer): sign a digest via PKCS#11, crypto-verified"
```

---

## Task 11: Locked-by-default and idle-lock integration behavior

Confirms the safety contract end-to-end: signing while locked returns `locked`, and the session re-locks after the TTL.

**Files:**
- Modify: `eudss-signer/tests/softhsm_integration.rs`

- [ ] **Step 1: Write the failing tests (append to `eudss-signer/tests/softhsm_integration.rs`)**

```rust
#[test]
fn sign_while_locked_returns_locked() {
    let Some(mut signer) = test_signer() else { return };
    // never unlocked
    let digest_b64 = STANDARD.encode([0u8; 32]);
    let err = signer.sign("01", &digest_b64, "SHA256").expect_err("must be locked");
    assert_eq!(err.code(), "locked");
}

#[test]
fn relocks_after_ttl() {
    let module = match std::env::var("EUDSS_TEST_PKCS11_MODULE") {
        Ok(m) => m,
        Err(_) => return,
    };
    let pin = std::env::var("EUDSS_TEST_PKCS11_PIN").unwrap();
    // 1-second TTL to observe idle re-lock quickly.
    let mut signer = Signer::new(&module, 0, Duration::from_secs(1)).unwrap();
    signer.unlock(&pin).unwrap();
    assert!(signer.status().unlocked);
    std::thread::sleep(Duration::from_millis(1200));
    assert!(!signer.status().unlocked);
    let digest_b64 = STANDARD.encode([0u8; 32]);
    assert_eq!(signer.sign("01", &digest_b64, "SHA256").unwrap_err().code(), "locked");
}
```

- [ ] **Step 2: Run to verify behavior**

```bash
cd eudss-signer && eval "$(tests/setup_softhsm.sh)"
cargo test --test softhsm_integration -- --nocapture
```

Expected: all integration tests PASS (these two plus the earlier ones).

- [ ] **Step 3: Run the full suite (unit + integration) clean**

```bash
cd eudss-signer && eval "$(tests/setup_softhsm.sh)" && cargo test
```

Expected: all unit tests + all integration tests PASS.

- [ ] **Step 4: Commit**

```bash
git add eudss-signer/tests/softhsm_integration.rs
git commit -m "test(signer): locked-by-default and idle re-lock behavior"
```

---

## Task 12: CLI binary for the oracle harness

A thin CLI exposing `list` and `sign` so the oracle harness (Task 13) and humans can drive the core against a real card. PIN comes from stdin (never argv).

**Files:**
- Modify: `eudss-signer/src/bin/eudss-signer-cli.rs`

- [ ] **Step 1: Implement the CLI in `eudss-signer/src/bin/eudss-signer-cli.rs`**

```rust
//! Minimal CLI over eudss-signer for the oracle harness and manual testing.
//!
//! Usage:
//!   eudss-signer-cli list   --module <path> [--slot N]
//!   eudss-signer-cli sign   --module <path> [--slot N] --key-id <hex> \
//!                           --digest-b64 <b64> --algo SHA256
//! PIN is read from stdin (one line). Output is JSON on stdout.

use eudss_signer::Signer;
use std::io::Read;
use std::time::Duration;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn read_pin() -> String {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).ok();
    s.trim_end_matches(['\n', '\r']).to_string()
}

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    let module = arg("--module").expect("--module required");
    let slot: usize = arg("--slot").and_then(|s| s.parse().ok()).unwrap_or(0);

    let mut signer = match Signer::new(&module, slot, Duration::from_secs(300)) {
        Ok(s) => s,
        Err(e) => {
            println!("{{\"error\":\"{}\",\"message\":\"{}\"}}", e.code(), e);
            std::process::exit(1);
        }
    };

    let result: Result<String, eudss_signer::SignerError> = match cmd.as_str() {
        "list" => signer.list_certificates().map(|c| {
            let items: Vec<String> = c
                .iter()
                .map(|e| format!("{{\"keyId\":\"{}\",\"subjectDn\":{:?}}}", e.key_id, e.subject_dn))
                .collect();
            format!("{{\"certificates\":[{}]}}", items.join(","))
        }),
        "sign" => {
            let key_id = arg("--key-id").expect("--key-id required");
            let digest_b64 = arg("--digest-b64").expect("--digest-b64 required");
            let algo = arg("--algo").unwrap_or_else(|| "SHA256".into());
            let pin = read_pin();
            signer.unlock(&pin).and_then(|_| signer.sign(&key_id, &digest_b64, &algo))
                .map(|sig| format!("{{\"signatureValueBase64\":\"{}\"}}", sig))
        }
        other => {
            eprintln!("unknown command: {other}");
            std::process::exit(2);
        }
    };

    match result {
        Ok(json) => println!("{json}"),
        Err(e) => {
            println!("{{\"error\":\"{}\",\"message\":\"{}\"}}", e.code(), e);
            std::process::exit(1);
        }
    }
}
```

- [ ] **Step 2: Build and smoke-test against SoftHSM2**

```bash
cd eudss-signer && cargo build --bin eudss-signer-cli
eval "$(tests/setup_softhsm.sh)"
./target/debug/eudss-signer-cli list --module "$EUDSS_TEST_PKCS11_MODULE"
```

Expected: prints `{"certificates":[{"keyId":"01","subjectDn":"...EUDSS SoftHSM..."}]}`.

- [ ] **Step 3: Smoke-test sign via the CLI**

```bash
DIGEST=$(printf 'eudss oracle test message' | openssl dgst -sha256 -binary | base64)
echo "$EUDSS_TEST_PKCS11_PIN" | ./target/debug/eudss-signer-cli sign \
  --module "$EUDSS_TEST_PKCS11_MODULE" --key-id 01 --digest-b64 "$DIGEST" --algo SHA256
```

Expected: prints `{"signatureValueBase64":"..."}`.

- [ ] **Step 4: Commit**

```bash
git add eudss-signer/src/bin/eudss-signer-cli.rs
git commit -m "feat(signer): CLI for oracle harness and manual testing"
```

---

## Task 13: Real-card oracle comparison

The eIDAS-critical check: on a real ChamberSign card, the Rust signature must equal the Java agent's signature for the same digest (RSA PKCS#1 v1.5 is deterministic, so the bytes must match exactly). This is a documented manual procedure plus a comparison script. It is NOT run in CI (it needs the physical token).

**Files:**
- Create: `eudss-signer/oracle/compare.sh`
- Create: `eudss-signer/oracle/README.md`

- [ ] **Step 1: Create `eudss-signer/oracle/compare.sh`**

```bash
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
```

- [ ] **Step 2: Create `eudss-signer/oracle/README.md`**

```markdown
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
```

- [ ] **Step 3: Make the script executable and commit**

```bash
chmod +x eudss-signer/oracle/compare.sh
git add eudss-signer/oracle/compare.sh eudss-signer/oracle/README.md
git commit -m "test(signer): real-card oracle comparison with the Java agent"
```

- [ ] **Step 4: Run the oracle on at least one real OS (manual, hardware)**

Run the procedure in `oracle/README.md` on a machine with the real card.
Expected: `ORACLE PASS: byte-for-byte equal` for the ChamberSign RSA-2048 key.
(Record OS + result here. This step gates retiring the Java agent in a later plan.)

---

## Task 14: CI for the Rust crate

Runs unit tests, the SoftHSM2 integration tests, clippy, and fmt on every push touching the crate.

**Files:**
- Create: `.github/workflows/rust-signer.yml`

- [ ] **Step 1: Create `.github/workflows/rust-signer.yml`**

```yaml
name: Rust signer

on:
  push:
    paths:
      - 'eudss-signer/**'
      - '.github/workflows/rust-signer.yml'
  pull_request:
    paths:
      - 'eudss-signer/**'

jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: eudss-signer
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt
      - name: Install SoftHSM2 + OpenSC
        run: sudo apt-get update && sudo apt-get install -y softhsm2 opensc openssl
      - name: cargo fmt
        run: cargo fmt --check
      - name: cargo clippy
        run: cargo clippy --all-targets -- -D warnings
      - name: Set up SoftHSM2 token and run tests
        run: |
          eval "$(tests/setup_softhsm.sh)"
          cargo test --all-targets
```

- [ ] **Step 2: Validate the workflow locally as far as possible**

```bash
cd eudss-signer && cargo fmt --check && cargo clippy --all-targets -- -D warnings
eval "$(tests/setup_softhsm.sh)" && cargo test --all-targets
```

Expected: fmt clean, clippy clean (fix warnings if any), all tests pass.

- [ ] **Step 3: Commit and push to trigger CI**

```bash
git add .github/workflows/rust-signer.yml
git commit -m "ci(signer): SoftHSM2 integration tests, clippy, fmt"
git push origin eu-dss
```

- [ ] **Step 4: Confirm CI is green**

Run: `gh run list --workflow "Rust signer" --limit 1`
Expected: the latest run concludes `success`. (Fix and re-push until green.)

---

## Done criteria for Plan 1

- `cargo test` (unit + SoftHSM2 integration) is green in CI.
- The oracle procedure (`oracle/README.md`) yields `ORACLE PASS` (byte-for-byte) for the real ChamberSign RSA-2048 key on at least one OS.
- The public `Signer` API (`status`, `unlock`, `lock`, `list_certificates`, `sign`) matches the agent contract, ready for the Tauri app (Plan 2) to call over IPC.

> Mechanism availability (spec point "C_GetMechanismList"): the core handles an unavailable mechanism reactively, mapping `C_Sign`'s `MechanismInvalid` to the `mechanism_unavailable` code (Task 3). A proactive `C_GetMechanismList` probe that fails earlier with the list of supported mechanisms is an OPTIONAL hardening follow-up within this crate, not required for the done criteria.

## What comes next (not in this plan)

- Plan 2: Tauri app shell + webview + IPC bridge calling this crate; swap `agentApi.ts` to IPC.
- Plan 3: backend jobs API + `eudss://` deep-link web-triggered signing.
- Plan 4: backend detached XAdES signer + explicit format selector.
- Plan 5: packaging, code-signing, auto-updater, `eudss://` scheme registration.
