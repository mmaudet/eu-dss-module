use eudss_signer::{ErrorBody, Signer, SignerError};
use std::sync::Mutex;
use std::time::Duration;

/// Per-OS default PKCS#11 module path (overridable via EUDSS_PKCS11_MODULE).
fn default_module() -> String {
    if let Ok(p) = std::env::var("EUDSS_PKCS11_MODULE") {
        return p;
    }
    #[cfg(target_os = "macos")]
    {
        "/Library/SCMiddleware/libidop11.dylib".into()
    }
    #[cfg(target_os = "linux")]
    {
        "/usr/lib/SCMiddleware/libidop11.so".into()
    }
    #[cfg(target_os = "windows")]
    {
        "C:\\Program Files\\Smart Card Middleware\\bin\\idoPKCS.dll".into()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        // Unsupported target: there is no bundled default; rely on EUDSS_PKCS11_MODULE.
        String::new()
    }
}

fn default_slot() -> usize {
    std::env::var("EUDSS_PKCS11_SLOT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// Lazily-opened Signer. `None` until the first successful open.
#[derive(Default)]
pub struct SignerState(pub Mutex<Option<Signer>>);

impl SignerState {
    /// Run `f` with an open Signer, opening it on first use. Maps errors to ErrorBody.
    pub fn with<T>(
        &self,
        f: impl FnOnce(&mut Signer) -> Result<T, SignerError>,
    ) -> Result<T, ErrorBody> {
        let mut guard = self.0.lock().map_err(|_| ErrorBody {
            error: "internal".into(),
            message: "signer mutex poisoned".into(),
        })?;
        if guard.is_none() {
            let signer = Signer::new(&default_module(), default_slot(), Duration::from_secs(300))
                .map_err(|e| ErrorBody::from(&e))?;
            *guard = Some(signer);
        }
        let signer = guard.as_mut().unwrap();
        match f(signer) {
            Ok(v) => Ok(v),
            Err(e) => {
                // A token-level failure (e.g. the USB token was unplugged) invalidates the
                // cached Signer; drop it so the next call re-opens a fresh one.
                if matches!(e, eudss_signer::SignerError::TokenUnavailable) {
                    *guard = None;
                }
                Err(ErrorBody::from(&e))
            }
        }
    }
}
