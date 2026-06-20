//! Thin cryptoki wrapper: open the module/slot, enumerate certs, login, sign.

use crate::cert;
use crate::digest::DigestAlgorithm;
use crate::error::SignerError;
use crate::keyid::{cka_id_from_key_id, key_id_from_cka_id};
use crate::mechanism::{signing_input, KeyKind, SigAlg};
use crate::signer::CertEntry;
use base64::{engine::general_purpose::STANDARD, Engine};
use cryptoki::context::{CInitializeArgs, Pkcs11};
use cryptoki::mechanism::Mechanism;
use cryptoki::object::{Attribute, AttributeType, KeyType, ObjectClass};
use cryptoki::session::{Session, UserType};
use cryptoki::slot::Slot;
use cryptoki::types::AuthPin;
use zeroize::Zeroize;

pub struct Token {
    pkcs11: Pkcs11,
    slot: Slot,
}

impl Token {
    pub fn open(module_path: &str, slot_index: usize) -> Result<Self, SignerError> {
        let pkcs11 = Pkcs11::new(module_path).map_err(SignerError::from_pkcs11)?;
        // CKR_CRYPTOKI_ALREADY_INITIALIZED is benign when multiple Signer instances
        // share a process (e.g. integration tests). Treat it as success per PKCS#11 spec.
        match pkcs11.initialize(CInitializeArgs::OsThreads) {
            Ok(()) => {}
            Err(cryptoki::error::Error::AlreadyInitialized) => {}
            Err(e) => return Err(SignerError::from_pkcs11(e)),
        }
        let slots = pkcs11
            .get_slots_with_token()
            .map_err(SignerError::from_pkcs11)?;
        let slot = *slots.get(slot_index).ok_or(SignerError::TokenUnavailable)?;
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

    /// Open an RW session and log in ONCE. Never retries; a wrong PIN returns PinIncorrect.
    pub fn login(&self, pin: &str) -> Result<Session, SignerError> {
        let session = self
            .pkcs11
            .open_rw_session(self.slot)
            .map_err(SignerError::from_pkcs11)?;
        let mut secret = pin.to_owned();
        let auth_pin = AuthPin::new(secret.clone());
        secret.zeroize();
        session
            .login(UserType::User, Some(&auth_pin))
            .map_err(SignerError::from_pkcs11)?;
        Ok(session)
    }

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
