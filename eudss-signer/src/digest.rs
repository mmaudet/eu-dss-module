//! Digest algorithms and PKCS#1 v1.5 DigestInfo construction.

/// Hash algorithms the agent contract accepts (agentApi.ts: 'SHA256' | 'SHA384' | 'SHA512').
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DigestAlgorithm {
    Sha256,
    Sha384,
    Sha512,
}

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
                0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02,
                0x01, 0x05, 0x00, 0x04, 0x20,
            ],
            DigestAlgorithm::Sha384 => &[
                0x30, 0x41, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02,
                0x02, 0x05, 0x00, 0x04, 0x30,
            ],
            DigestAlgorithm::Sha512 => &[
                0x30, 0x51, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02,
                0x03, 0x05, 0x00, 0x04, 0x40,
            ],
        }
    }

    /// Build the DigestInfo (prefix || digest) signed by CKM_RSA_PKCS.
    pub fn digest_info(self, digest: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.der_prefix().len() + digest.len());
        out.extend_from_slice(self.der_prefix());
        out.extend_from_slice(digest);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agent_strings() {
        assert_eq!(
            DigestAlgorithm::from_name("SHA256"),
            Some(DigestAlgorithm::Sha256)
        );
        assert_eq!(
            DigestAlgorithm::from_name("SHA384"),
            Some(DigestAlgorithm::Sha384)
        );
        assert_eq!(
            DigestAlgorithm::from_name("SHA512"),
            Some(DigestAlgorithm::Sha512)
        );
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
    fn digest_info_sha384_prefix() {
        let digest = [0u8; 48];
        let di = DigestAlgorithm::Sha384.digest_info(&digest);
        let expected_prefix: [u8; 19] = [
            0x30, 0x41, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02,
            0x02, 0x05, 0x00, 0x04, 0x30,
        ];
        assert_eq!(&di[..19], &expected_prefix);
        assert_eq!(di.len(), 19 + 48);
    }

    #[test]
    fn digest_len_matches_algorithm() {
        assert_eq!(DigestAlgorithm::Sha256.digest_len(), 32);
        assert_eq!(DigestAlgorithm::Sha384.digest_len(), 48);
        assert_eq!(DigestAlgorithm::Sha512.digest_len(), 64);
    }
}
