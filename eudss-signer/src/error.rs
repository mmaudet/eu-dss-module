//! Structured signer errors, with agent-compatible string codes.

use cryptoki::error::{Error as CkError, RvError};
use serde::Serialize;
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
                SignerError::MechanismUnavailable(ctx.to_string())
            }
            other => SignerError::Pkcs11(other.to_string()),
        }
    }
}

/// Wire-form of an error for the IPC boundary: the agent-compatible code + a message.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
    pub message: String,
}

impl From<&SignerError> for ErrorBody {
    fn from(e: &SignerError) -> Self {
        ErrorBody {
            error: e.code().to_string(),
            message: e.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cryptoki::context::Function;

    #[test]
    fn codes_match_agent_contract() {
        assert_eq!(SignerError::PinIncorrect.code(), "pin_incorrect");
        assert_eq!(SignerError::PinLocked.code(), "pin_locked");
        assert_eq!(SignerError::TokenUnavailable.code(), "token_unavailable");
        assert_eq!(SignerError::Locked.code(), "locked");
        assert_eq!(
            SignerError::UnknownKeyId("x".into()).code(),
            "unknown_key_id"
        );
    }

    #[test]
    fn maps_pin_incorrect_from_pkcs11() {
        let mapped =
            SignerError::from_pkcs11(CkError::Pkcs11(RvError::PinIncorrect, Function::Login));
        assert!(matches!(mapped, SignerError::PinIncorrect));
    }

    #[test]
    fn maps_pin_locked_from_pkcs11() {
        let mapped = SignerError::from_pkcs11(CkError::Pkcs11(RvError::PinLocked, Function::Login));
        assert!(matches!(mapped, SignerError::PinLocked));
    }

    #[test]
    fn maps_token_not_present_to_unavailable() {
        let mapped = SignerError::from_pkcs11(CkError::Pkcs11(
            RvError::TokenNotPresent,
            Function::GetSlotList,
        ));
        assert!(matches!(mapped, SignerError::TokenUnavailable));
    }
}
