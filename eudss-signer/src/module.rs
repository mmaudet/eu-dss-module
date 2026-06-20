//! PKCS#11 middleware module resolution — vendor-neutral, multi-candidate.
//!
//! Resolution priority:
//! 1. `EUDSS_PKCS11_MODULE` env var (absolute path): if set and the file exists, use it.
//! 2. Per-OS well-known candidate paths: the first path that exists on disk is used.
//! 3. If nothing is found, returns [`ModuleResolutionError`] with a clear message.

use std::path::{Path, PathBuf};

/// Error returned when no usable PKCS#11 middleware module is found.
#[derive(Debug)]
pub struct ModuleResolutionError {
    /// The env-var path that was tried (if the var was set but the file was absent).
    pub env_override: Option<String>,
    /// All well-known candidate paths that were checked.
    pub candidates_tried: Vec<PathBuf>,
}

impl std::fmt::Display for ModuleResolutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "no PKCS#11 middleware module found. \
             Install your token middleware or set the EUDSS_PKCS11_MODULE environment variable \
             to the absolute path of the module library"
        )?;
        if let Some(ref p) = self.env_override {
            write!(f, " (EUDSS_PKCS11_MODULE={p:?} was set but the file does not exist)")?;
        }
        if !self.candidates_tried.is_empty() {
            write!(f, "; tried candidates:")?;
            for c in &self.candidates_tried {
                write!(f, " {c:?}")?;
            }
        }
        Ok(())
    }
}

impl std::error::Error for ModuleResolutionError {}

/// Return the per-OS list of well-known PKCS#11 middleware candidate paths.
///
/// The list is ordered by precedence (first match wins). It includes:
/// - IDOPTE / IDPrime (Thales/formerly SafeNet): `libidop11`
/// - OpenSC (open-source, covers many tokens including Belgian eID, STARCOS, etc.)
/// - p11-kit-proxy (common Linux pass-through)
/// - CardOS (Atos/Siemens)
/// - SafeNet Authentication Client
/// - Gemalto / Thales older deployments
fn well_known_candidates() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        vec![
            // IDOPTE / IDPrime (current Thales branding, used by IDOPRO/IDEMIA installations)
            PathBuf::from("/Library/SCMiddleware/libidop11.dylib"),
            // Thales SafeNet Authentication Client
            PathBuf::from("/Library/Frameworks/eToken.framework/Versions/Current/libeToken.dylib"),
            // OpenSC — most commonly installed via Homebrew or the official pkg
            PathBuf::from("/Library/OpenSC/lib/opensc-pkcs11.so"),
            PathBuf::from("/usr/local/lib/opensc-pkcs11.so"),
            PathBuf::from("/opt/homebrew/lib/opensc-pkcs11.so"),
            // p11-kit-proxy (rarely on macOS but possible via Homebrew)
            PathBuf::from("/usr/local/lib/pkcs11/p11-kit-proxy.dylib"),
            PathBuf::from("/opt/homebrew/lib/pkcs11/p11-kit-proxy.dylib"),
        ]
    }

    #[cfg(target_os = "linux")]
    {
        vec![
            // IDOPTE / IDPrime (Thales/IDEMIA installations: both SCMiddleware and lib paths)
            PathBuf::from("/usr/lib/SCMiddleware/libidop11.so"),
            PathBuf::from("/usr/lib/libidop11.so"),
            PathBuf::from("/usr/local/lib/libidop11.so"),
            // OpenSC (packaged as opensc on Debian/Ubuntu/Fedora)
            PathBuf::from("/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so"),
            PathBuf::from("/usr/lib/aarch64-linux-gnu/opensc-pkcs11.so"),
            PathBuf::from("/usr/lib/opensc-pkcs11.so"),
            PathBuf::from("/usr/local/lib/opensc-pkcs11.so"),
            // p11-kit-proxy (acts as pass-through on most distros)
            PathBuf::from("/usr/lib/x86_64-linux-gnu/pkcs11/p11-kit-proxy.so"),
            PathBuf::from("/usr/lib/pkcs11/p11-kit-proxy.so"),
            // SafeNet Authentication Client (Linux SAC)
            PathBuf::from("/usr/lib/libeToken.so"),
            PathBuf::from("/usr/lib/libeToken.so.10"),
            // Gemalto / Thales IDGo 800
            PathBuf::from("/usr/lib/libIDPrimePKCS11.so"),
            // CardOS (Atos)
            PathBuf::from("/usr/lib/libcardosP11.so"),
        ]
    }

    #[cfg(target_os = "windows")]
    {
        vec![
            // IDOPTE / IDPrime (Thales/IDEMIA)
            PathBuf::from("C:\\Program Files\\Smart Card Middleware\\bin\\idoPKCS.dll"),
            PathBuf::from("C:\\Program Files (x86)\\Smart Card Middleware\\bin\\idoPKCS.dll"),
            // SafeNet Authentication Client
            PathBuf::from(
                "C:\\Program Files\\SafeNet\\Authentication\\SAC\\x64\\IDPrimePKCS1164.dll",
            ),
            PathBuf::from(
                "C:\\Program Files (x86)\\SafeNet\\Authentication\\SAC\\x32\\IDPrimePKCS11.dll",
            ),
            // OpenSC for Windows
            PathBuf::from("C:\\Program Files\\OpenSC Project\\OpenSC\\pkcs11\\opensc-pkcs11.dll"),
            // Gemalto / Thales IDGo 800 / IDPrime
            PathBuf::from("C:\\Program Files\\Gemalto\\IDGo 800 PKCS#11\\IDPrimePKCS1164.dll"),
        ]
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        // No known defaults for this target; rely on EUDSS_PKCS11_MODULE.
        vec![]
    }
}

/// Resolve the PKCS#11 middleware module path using the documented priority order:
///
/// 1. `EUDSS_PKCS11_MODULE` env var (if set and the file exists).
/// 2. First entry in [`well_known_candidates()`] that exists on disk.
/// 3. [`ModuleResolutionError`] if nothing is found.
///
/// The returned path is the one that **exists on disk** (not merely the first in a
/// list). Loading/initialising the module is the caller's responsibility.
pub fn resolve() -> Result<PathBuf, ModuleResolutionError> {
    // Priority 1: explicit env-var override.
    if let Ok(val) = std::env::var("EUDSS_PKCS11_MODULE") {
        let p = PathBuf::from(&val);
        if p.exists() {
            return Ok(p);
        }
        // Var was set but the file is absent: skip the candidate list and surface the
        // misconfiguration clearly instead of silently falling through.
        return Err(ModuleResolutionError {
            env_override: Some(val),
            candidates_tried: vec![],
        });
    }

    // Priority 2: first well-known candidate that exists.
    let candidates = well_known_candidates();
    for candidate in &candidates {
        if Path::new(candidate).exists() {
            return Ok(candidate.clone());
        }
    }

    // Priority 3: nothing found.
    Err(ModuleResolutionError {
        env_override: None,
        candidates_tried: candidates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_override_missing_file_is_an_error() {
        // Point to a path that certainly doesn't exist.
        std::env::set_var(
            "EUDSS_PKCS11_MODULE",
            "/nonexistent/path/to/pkcs11_module.so",
        );
        let result = resolve();
        std::env::remove_var("EUDSS_PKCS11_MODULE");
        let err = result.unwrap_err();
        assert!(err.env_override.is_some());
        let msg = err.to_string();
        assert!(msg.contains("EUDSS_PKCS11_MODULE"), "message: {msg}");
    }

    #[test]
    fn env_override_existing_file_wins() {
        // Use the test binary itself as a stand-in for "any existing file".
        let exe = std::env::current_exe().unwrap();
        let exe_str = exe.to_str().unwrap();
        std::env::set_var("EUDSS_PKCS11_MODULE", exe_str);
        let result = resolve();
        std::env::remove_var("EUDSS_PKCS11_MODULE");
        assert_eq!(result.unwrap(), exe);
    }

    #[test]
    fn error_message_contains_install_hint() {
        // If no override is set and no candidate exists, the error message should mention
        // what the user should do.  We can't guarantee the candidate list is empty on
        // every CI machine, so only run the message-content check when the list is empty.
        let candidates = well_known_candidates();
        let all_absent = candidates.iter().all(|p| !p.exists());
        if all_absent {
            let err = resolve().unwrap_err();
            let msg = err.to_string();
            assert!(
                msg.contains("EUDSS_PKCS11_MODULE"),
                "hint missing from: {msg}"
            );
        }
        // If some candidate exists the function returns Ok — that's correct behaviour.
    }
}
