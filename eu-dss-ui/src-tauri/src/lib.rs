mod backend;
mod commands;
mod signer_state;

use backend::BackendState;
use signer_state::SignerState;
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(SignerState::default())
        .setup(|app| {
            // Spawn the embedded Java backend sidecar and start its readiness
            // poller. In dev (no staged app-image) this logs a warning and skips
            // spawning so the app still runs.
            backend::init(app.handle())?;

            // Kill the sidecar if the main window is destroyed.
            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::Destroyed = event {
                        if let Some(state) = app_handle.try_state::<BackendState>() {
                            state.kill_child();
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::status,
            commands::is_available,
            commands::unlock,
            commands::lock,
            commands::list_certificates,
            commands::sign,
            backend::backend_base,
            backend::backend_ready,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // Belt-and-suspenders: also kill the sidecar on app exit so no Java
            // process is orphaned (covers paths the window event may miss).
            match event {
                RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                    if let Some(state) = app_handle.try_state::<BackendState>() {
                        state.kill_child();
                    }
                }
                _ => {}
            }
        });
}
