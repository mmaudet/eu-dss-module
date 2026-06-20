//! Parse a DER certificate into the fields list_certificates returns.

use crate::error::SignerError;
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
