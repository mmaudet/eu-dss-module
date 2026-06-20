//! PKCS#11 signing core for the EU-DSS native client.

pub(crate) mod cert;
pub(crate) mod digest;
pub(crate) mod error;
pub(crate) mod keyid;
pub(crate) mod mechanism;
pub(crate) mod session;
pub(crate) mod signer;
pub(crate) mod token;

pub use error::{ErrorBody, SignerError};
pub use signer::{CertEntry, SessionStatus, Signer};
