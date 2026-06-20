//! Public Signer facade: ties the module, session state, and operations together.

use crate::digest::DigestAlgorithm;
use crate::error::SignerError;
use crate::module;
use crate::session::SessionState;
use crate::token::Token;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub unlocked: bool,
    pub expires_in_seconds: Option<u64>,
    pub mode: &'static str, // Plan 1: only "interactive" exists; "headless" is a future variant
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertEntry {
    pub key_id: String,
    pub certificate_base64: String,
    pub certificate_chain_base64: Vec<String>,
    pub subject_dn: String,
    pub issuer_dn: String,
    pub serial_number: String,
    pub not_before: String,
    pub not_after: String,
}

pub struct Signer {
    token: Token,
    session: SessionState,
    live: Option<cryptoki::session::Session>,
}

impl Signer {
    /// Open a signer with an explicit PKCS#11 module path.
    ///
    /// The module path must be an absolute path to a `.so` / `.dylib` / `.dll` file.
    /// Use [`Signer::open`] instead if you want automatic module resolution.
    pub fn new(module_path: &str, slot_index: usize, ttl: Duration) -> Result<Self, SignerError> {
        let token = Token::open(module_path, slot_index)?;
        Ok(Signer {
            token,
            session: SessionState::new(ttl),
            live: None,
        })
    }

    /// Open a signer using the vendor-neutral module resolution strategy:
    ///
    /// 1. `EUDSS_PKCS11_MODULE` env var (absolute path to a `.so`/`.dylib`/`.dll`).
    ///    If set and the file exists, that module is used.
    /// 2. Per-OS well-known candidate paths (IDOPTE/IDPrime, OpenSC, p11-kit-proxy,
    ///    SafeNet, Gemalto …). The first candidate that exists on disk is used.
    /// 3. If no module is found, returns [`SignerError::ModuleNotFound`] with a clear
    ///    message telling the user to install their token middleware or set the env var.
    ///
    /// `slot_index` selects which token slot to use (0-based; typically 0 or 1).
    /// `ttl` is the idle session timeout after which the PIN must be re-entered.
    pub fn open(slot_index: usize, ttl: Duration) -> Result<Self, SignerError> {
        let module_path = module::resolve().map_err(SignerError::from)?;
        let module_str = module_path.to_string_lossy();
        let token = Token::open(&module_str, slot_index)?;
        Ok(Signer {
            token,
            session: SessionState::new(ttl),
            live: None,
        })
    }

    pub fn status(&self) -> SessionStatus {
        let now = Instant::now();
        SessionStatus {
            unlocked: self.session.is_unlocked(now),
            expires_in_seconds: self.session.expires_in_seconds(now),
            mode: "interactive",
        }
    }

    pub fn unlock(&mut self, pin: &str) -> Result<SessionStatus, SignerError> {
        self.live = None; // explicitly close/logout any prior session before a new login
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

    pub fn list_certificates(&self) -> Result<Vec<CertEntry>, SignerError> {
        self.token.list_certificates()
    }

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

#[cfg(test)]
mod serde_tests {
    use super::*;

    #[test]
    fn session_status_serializes_camelcase() {
        let s = SessionStatus {
            unlocked: true,
            expires_in_seconds: Some(300),
            mode: "interactive",
        };
        let j = serde_json::to_string(&s).unwrap();
        assert!(j.contains("\"unlocked\":true"));
        assert!(j.contains("\"expiresInSeconds\":300"));
        assert!(j.contains("\"mode\":\"interactive\""));
    }

    #[test]
    fn cert_entry_serializes_agent_keys() {
        let c = CertEntry {
            key_id: "AB".into(),
            certificate_base64: "Zm9v".into(),
            certificate_chain_base64: vec!["Zm9v".into()],
            subject_dn: "CN=x".into(),
            issuer_dn: "CN=y".into(),
            serial_number: "01".into(),
            not_before: "a".into(),
            not_after: "b".into(),
        };
        let j = serde_json::to_string(&c).unwrap();
        for k in [
            "keyId",
            "certificateBase64",
            "certificateChainBase64",
            "subjectDn",
            "issuerDn",
            "serialNumber",
            "notBefore",
            "notAfter",
        ] {
            assert!(j.contains(&format!("\"{k}\"")), "missing key {k} in {j}");
        }
    }
}
