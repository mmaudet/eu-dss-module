//! Integration tests against a SoftHSM2 token. Skipped unless EUDSS_TEST_PKCS11_MODULE is set
//! (run `eval "$(tests/setup_softhsm.sh)"` first).
//!
//! Tests run under a global Mutex to prevent concurrent PKCS#11 C_Initialize calls
//! (SoftHSM2 is not safe to initialize from multiple threads simultaneously).

use eudss_signer::Signer;
use std::sync::Mutex;
use std::time::Duration;

static TOKEN_LOCK: Mutex<()> = Mutex::new(());

fn test_signer() -> Option<Signer> {
    let module = std::env::var("EUDSS_TEST_PKCS11_MODULE").ok()?;
    Some(Signer::new(&module, 0, Duration::from_secs(300)).expect("open module"))
}

#[test]
fn lists_the_imported_certificate() {
    let _guard = TOKEN_LOCK.lock().unwrap();
    let Some(signer) = test_signer() else {
        eprintln!("SKIP: EUDSS_TEST_PKCS11_MODULE not set");
        return;
    };
    let certs = signer.list_certificates().expect("list");
    assert_eq!(certs.len(), 1, "expected exactly the imported cert");
    assert_eq!(certs[0].key_id, "01");
    assert!(certs[0].subject_dn.contains("EUDSS SoftHSM"));
}

#[test]
fn unlock_with_correct_pin_succeeds() {
    let _guard = TOKEN_LOCK.lock().unwrap();
    let Some(mut signer) = test_signer() else {
        return;
    };
    let pin = std::env::var("EUDSS_TEST_PKCS11_PIN").unwrap();
    let status = signer.unlock(&pin).expect("unlock");
    assert!(status.unlocked);
    // Allow for sub-second elapsed since unlock; expires_in should be near 300.
    let secs = status.expires_in_seconds.expect("must have expiry");
    assert!(
        (298..=300).contains(&secs),
        "expected ~300 seconds remaining, got {secs}"
    );
}

#[test]
fn unlock_with_wrong_pin_is_pin_incorrect() {
    let _guard = TOKEN_LOCK.lock().unwrap();
    let Some(mut signer) = test_signer() else {
        return;
    };
    let err = signer.unlock("0000").expect_err("must fail");
    assert_eq!(err.code(), "pin_incorrect");
    // After a failed unlock the session is still locked.
    assert!(!signer.status().unlocked);
}

use base64::{engine::general_purpose::STANDARD, Engine};
use rsa::pkcs1v15::{Signature, VerifyingKey};
use rsa::pkcs8::DecodePublicKey;
use rsa::signature::Verifier;
use rsa::RsaPublicKey;
use sha2::{Digest, Sha256};
use x509_parser::prelude::*;

#[test]
fn sign_rsa_digest_verifies_against_cert_public_key() {
    let _guard = TOKEN_LOCK.lock().unwrap();
    let Some(mut signer) = test_signer() else {
        return;
    };
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
    let spki_der = cert.public_key().raw;
    let rsa_pub = RsaPublicKey::from_public_key_der(spki_der).unwrap();

    let vk = VerifyingKey::<Sha256>::new(rsa_pub);
    let sig = Signature::try_from(sig_bytes.as_slice()).unwrap();
    vk.verify(message, &sig)
        .expect("signature must verify against the cert key");
}

#[test]
fn sign_while_locked_returns_locked() {
    let _guard = TOKEN_LOCK.lock().unwrap();
    let Some(mut signer) = test_signer() else {
        return;
    };
    // never unlocked
    let digest_b64 = STANDARD.encode([0u8; 32]);
    let err = signer
        .sign("01", &digest_b64, "SHA256")
        .expect_err("must be locked");
    assert_eq!(err.code(), "locked");
}

#[test]
fn relocks_after_ttl() {
    let _guard = TOKEN_LOCK.lock().unwrap();
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
    assert_eq!(
        signer.sign("01", &digest_b64, "SHA256").unwrap_err().code(),
        "locked"
    );
}
