//! core-ipc - the native host core (src/core_native.rs) behind Tauri's MOCK
//! runtime, one invoke per stdin line, for impl/test/native-ipc.test.ts.
//!
//! What this exercises that no other test does: the webview's eh2/native.ts
//! talking to the host's commands THROUGH Tauri's own command dispatch - the
//! argument names and their camelCase mapping, the JSON shapes, the error
//! strings - with the very same source file the shells compile. What it does
//! not: the platform webview's postMessage transport (the base64-text rule in
//! core_native.rs exists for that, and is a fact of the payloads, not of this).
//!
//!   in   {"id": 1, "cmd": "core_initiate", "args": {...}}
//!   out  {"id": 1, "ok": <value>}  or  {"id": 1, "err": <value>}

#[path = "../src/core_native.rs"]
#[allow(dead_code)]
mod core_native;

use std::io::{BufRead, Write};

fn main() {
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![
            core_native::core_version,
            core_native::core_initiate,
            core_native::core_peer_ek,
            core_native::core_initiator_complete,
            core_native::core_respond,
            core_native::core_responder_complete,
            core_native::core_responder_finish,
            core_native::core_session,
            core_native::core_encrypt,
            core_native::core_decrypt,
            core_native::core_drop,
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("mock webview");
    let url: tauri::Url = if cfg!(any(windows, target_os = "android")) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap();

    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue }
        let req: serde_json::Value = match serde_json::from_str(&line) { Ok(v) => v, Err(e) => { eprintln!("bad request line: {e}"); continue } };
        let id = req["id"].clone();
        let res = tauri::test::get_ipc_response(&webview, tauri::webview::InvokeRequest {
            cmd: req["cmd"].as_str().unwrap_or_default().to_string(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: url.clone(),
            body: tauri::ipc::InvokeBody::Json(req["args"].clone()),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        });
        let reply = match res {
            Ok(body) => serde_json::json!({ "id": id, "ok": body.deserialize::<serde_json::Value>().unwrap_or(serde_json::Value::Null) }),
            Err(e) => serde_json::json!({ "id": id, "err": e }),
        };
        writeln!(out, "{reply}").unwrap();
        out.flush().unwrap();
    }
}
