//! backend.rs — embedded Java backend (jpackage app-image) lifecycle.
//!
//! On app startup we:
//!   1. pick a free TCP port on 127.0.0.1,
//!   2. resolve the bundled `eu-dss-server` launcher under the Tauri resource dir,
//!   3. spawn it as a local sidecar (`--server.port=<port> --server.address=127.0.0.1`),
//!   4. poll `GET /api/health` until it returns 200, flipping `ready` to true,
//!   5. kill the child on window-Destroyed / app-Exit (no orphan Java process).
//!
//! In `tauri dev` the app-image is usually not staged yet: if the launcher is
//! missing we LOG a warning and skip spawning, so the dev shell still runs and
//! the frontend gracefully shows the backend prerequisite as "waiting".
//!
//! The readiness probe uses a tiny `TcpStream`-based HTTP/1.1 GET to stay
//! dependency-light (no extra crate, no async runtime) and runs on a plain
//! `std::thread`.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};

/// Managed state for the embedded backend.
pub struct BackendState {
    /// Port the sidecar was told to listen on (127.0.0.1).
    pub port: u16,
    /// The spawned child process, if any (None in dev when the app-image is absent).
    pub child: Mutex<Option<Child>>,
    /// Flipped to true once `GET /api/health` returns 200.
    pub ready: AtomicBool,
}

impl BackendState {
    fn new(port: u16) -> Self {
        Self {
            port,
            child: Mutex::new(None),
            ready: AtomicBool::new(false),
        }
    }

    /// Kill the child process if one is running. Idempotent.
    pub fn kill_child(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                // Best-effort: ignore errors (already exited, etc.).
                let _ = child.kill();
                let _ = child.wait();
                log::info!("eu-dss-server sidecar terminated");
            }
        }
    }
}

/// Pick a free TCP port by binding to 127.0.0.1:0 and reading the OS-assigned
/// port, then dropping the listener so the backend can claim it.
fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|addr| addr.port())
        // Extremely unlikely; fall back to a fixed high port if the bind fails.
        .unwrap_or(58080)
}

/// Per-OS subpath of the launcher executable inside the bundled app-image dir.
///   macOS:   eu-dss-server/Contents/MacOS/eu-dss-server  (jpackage app-image layout)
///   Linux:   eu-dss-server/bin/eu-dss-server
///   Windows: eu-dss-server/eu-dss-server.exe
fn launcher_subpath() -> PathBuf {
    if cfg!(target_os = "windows") {
        PathBuf::from("eu-dss-server").join("eu-dss-server.exe")
    } else if cfg!(target_os = "macos") {
        PathBuf::from("eu-dss-server")
            .join("Contents")
            .join("MacOS")
            .join("eu-dss-server")
    } else {
        PathBuf::from("eu-dss-server")
            .join("bin")
            .join("eu-dss-server")
    }
}

/// Resolve the launcher path under the Tauri resource directory.
fn launcher_path(app: &AppHandle) -> Option<PathBuf> {
    match app.path().resource_dir() {
        Ok(dir) => Some(dir.join(launcher_subpath())),
        Err(e) => {
            log::warn!("could not resolve resource_dir: {e}");
            None
        }
    }
}

/// Initialize the backend: pick a port, register state, spawn the sidecar (if
/// the app-image is present), and start the readiness poller.
///
/// Called from the Tauri `.setup(...)` hook. Returns Ok even when the app-image
/// is missing (dev mode) — the app must still run.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let port = pick_free_port();
    app.manage(BackendState::new(port));

    let launcher = launcher_path(app);
    let spawn = match &launcher {
        Some(p) if p.exists() => Some(p.clone()),
        Some(p) => {
            log::warn!(
                "eu-dss-server launcher not found at {} — skipping backend spawn \
                 (expected in `tauri dev` before the app-image is staged). \
                 The signing service prerequisite will show as waiting.",
                p.display()
            );
            None
        }
        None => None,
    };

    if let Some(launcher) = spawn {
        log::info!(
            "starting embedded eu-dss-server: {} --server.port={}",
            launcher.display(),
            port
        );
        let mut cmd = Command::new(&launcher);
        cmd.arg(format!("--server.port={port}"))
            .arg("--server.address=127.0.0.1");
        // Detach from any console on Windows so no stray window pops up.
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        match cmd.spawn() {
            Ok(child) => {
                let state: State<BackendState> = app.state();
                if let Ok(mut guard) = state.child.lock() {
                    *guard = Some(child);
                }
                // Drop the borrowed State before the arm ends so the lock's
                // temporary Result does not outlive the `state` binding.
                drop(state);
            }
            Err(e) => {
                log::error!("failed to spawn eu-dss-server: {e}");
            }
        }
    }

    // Always start the readiness poller: if the sidecar is up (spawned here OR
    // already running from a previous launch) it will flip ready=true; otherwise
    // it simply times out and ready stays false.
    let app_handle = app.clone();
    std::thread::spawn(move || poll_until_ready(app_handle, port));

    Ok(())
}

/// Poll `GET http://127.0.0.1:<port>/api/health` every 500ms until it returns
/// HTTP 200, then set `ready=true`. Gives up after ~60s.
fn poll_until_ready(app: AppHandle, port: u16) {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if health_ok(port) {
            if let Some(state) = app.try_state::<BackendState>() {
                state.ready.store(true, Ordering::SeqCst);
            }
            log::info!("eu-dss-server is ready on 127.0.0.1:{port}");
            return;
        }
        if Instant::now() >= deadline {
            log::warn!(
                "eu-dss-server did not become ready within 60s on 127.0.0.1:{port}"
            );
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Minimal blocking HTTP/1.1 GET of `/api/health`; returns true on a `200`
/// status line. Dependency-free (raw TcpStream) so we don't need reqwest's
/// async runtime here.
fn health_ok(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let stream = match TcpStream::connect_timeout(
        &match addr.parse() {
            Ok(a) => a,
            Err(_) => return false,
        },
        Duration::from_millis(800),
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let mut stream = stream;

    let req = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: */*\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }

    // Read only enough to see the status line.
    let mut buf = [0u8; 256];
    let n = match stream.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    if n == 0 {
        return false;
    }
    let head = String::from_utf8_lossy(&buf[..n]);
    // Status line looks like: "HTTP/1.1 200 OK\r\n"
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

/* ── Tauri commands ─────────────────────────────────────────────────────────── */

/// Base URL the frontend should use for all backend API calls.
#[tauri::command]
pub fn backend_base(state: State<BackendState>) -> String {
    format!("http://127.0.0.1:{}/api", state.port)
}

/// Whether the embedded backend has answered `GET /api/health` with 200.
#[tauri::command]
pub fn backend_ready(state: State<BackendState>) -> bool {
    state.ready.load(Ordering::SeqCst)
}
