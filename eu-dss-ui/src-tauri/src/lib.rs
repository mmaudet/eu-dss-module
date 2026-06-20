mod commands;
mod signer_state;

use signer_state::SignerState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(SignerState::default())
        .invoke_handler(tauri::generate_handler![
            commands::status,
            commands::is_available,
            commands::unlock,
            commands::lock,
            commands::list_certificates,
            commands::sign,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
