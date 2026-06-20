//! Minimal CLI over eudss-signer for the oracle harness and manual testing.
//!
//! Usage:
//!   eudss-signer-cli list   --module <path> [--slot N]
//!   eudss-signer-cli sign   --module <path> [--slot N] --key-id <hex> \
//!                           --digest-b64 <b64> --algo SHA256
//! PIN is read from stdin (one line). Output is JSON on stdout.

use eudss_signer::Signer;
use std::io::Read;
use std::time::Duration;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn read_pin() -> String {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).ok();
    s.trim_end_matches(['\n', '\r']).to_string()
}

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    let module = arg("--module").expect("--module required");
    let slot: usize = arg("--slot").and_then(|s| s.parse().ok()).unwrap_or(0);

    let mut signer = match Signer::new(&module, slot, Duration::from_secs(300)) {
        Ok(s) => s,
        Err(e) => {
            println!("{{\"error\":\"{}\",\"message\":\"{}\"}}", e.code(), e);
            std::process::exit(1);
        }
    };

    let result: Result<String, eudss_signer::SignerError> = match cmd.as_str() {
        "list" => signer.list_certificates().map(|c| {
            let items: Vec<String> = c
                .iter()
                .map(|e| {
                    format!(
                        "{{\"keyId\":\"{}\",\"subjectDn\":{:?}}}",
                        e.key_id, e.subject_dn
                    )
                })
                .collect();
            format!("{{\"certificates\":[{}]}}", items.join(","))
        }),
        "sign" => {
            let key_id = arg("--key-id").expect("--key-id required");
            let digest_b64 = arg("--digest-b64").expect("--digest-b64 required");
            let algo = arg("--algo").unwrap_or_else(|| "SHA256".into());
            let pin = read_pin();
            signer
                .unlock(&pin)
                .and_then(|_| signer.sign(&key_id, &digest_b64, &algo))
                .map(|sig| format!("{{\"signatureValueBase64\":\"{}\"}}", sig))
        }
        other => {
            eprintln!("unknown command: {other}");
            std::process::exit(2);
        }
    };

    match result {
        Ok(json) => println!("{json}"),
        Err(e) => {
            println!("{{\"error\":\"{}\",\"message\":\"{}\"}}", e.code(), e);
            std::process::exit(1);
        }
    }
}
