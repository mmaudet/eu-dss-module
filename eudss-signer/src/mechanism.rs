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

/// Returns the signature algorithm and the exact bytes to pass to C_Sign.
pub fn signing_input(key: KeyKind, algo: DigestAlgorithm, digest: &[u8]) -> (SigAlg, Vec<u8>) {
    match key {
        KeyKind::Rsa => (SigAlg::RsaPkcs1v15, algo.digest_info(digest)),
        KeyKind::Ec => (SigAlg::Ecdsa, digest.to_vec()),
    }
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
