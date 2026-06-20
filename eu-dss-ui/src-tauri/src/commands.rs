use crate::signer_state::SignerState;
use eudss_signer::{CertEntry, ErrorBody, SessionStatus};
use tauri::State;

#[tauri::command]
pub fn status(state: State<SignerState>) -> Result<SessionStatus, ErrorBody> {
    // status must not fail just because no token is open yet: report locked/unavailable.
    state.with(|s| Ok(s.status())).or(Ok(SessionStatus {
        unlocked: false,
        expires_in_seconds: None,
        mode: "interactive",
    }))
}

#[tauri::command]
pub fn is_available(state: State<SignerState>) -> bool {
    // "available" == the module opens and a token is present (list works without a PIN).
    state.with(|s| s.list_certificates().map(|_| ())).is_ok()
}

#[tauri::command]
pub fn unlock(state: State<SignerState>, pin: String) -> Result<SessionStatus, ErrorBody> {
    state.with(|s| s.unlock(&pin))
}

#[tauri::command]
pub fn lock(state: State<SignerState>) -> Result<(), ErrorBody> {
    state.with(|s| s.lock())
}

#[tauri::command]
pub fn list_certificates(state: State<SignerState>) -> Result<Vec<CertEntry>, ErrorBody> {
    state.with(|s| s.list_certificates())
}

#[tauri::command]
pub fn sign(
    state: State<SignerState>,
    key_id: String,
    digest_base64: String,
    digest_algorithm: String,
) -> Result<String, ErrorBody> {
    state.with(|s| s.sign(&key_id, &digest_base64, &digest_algorithm))
}
