//! Public Signer facade: ties the module, session state, and operations together.

use crate::digest::DigestAlgorithm;
use crate::error::SignerError;
use crate::session::SessionState;
use crate::token::Token;
use base64::{engine::general_purpose::STANDARD, Engine};
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
    live: Option<cryptoki::session::Session>,
}

impl Signer {
    pub fn new(module_path: &str, slot_index: usize, ttl: Duration) -> Result<Self, SignerError> {
        let token = Token::open(module_path, slot_index)?;
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
