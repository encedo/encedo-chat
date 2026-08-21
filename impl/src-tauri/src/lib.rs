// onchato shell (Tauri 2). The frontend is the SAME webpack bundle the web
// app serves (../web/dist) — this only wraps it in a native window. No app logic
// lives here: identity (HEM/software), EH-2 + ratchet, rendezvous and the
// WebRTC/relay transport all run in the webview, exactly as on the web.
//
// This is a LIBRARY, not just a binary, because mobile needs it to be. Android
// loads the Rust side as a shared object from Java and calls into it — there is
// no `main` to run — so the app has to exist as a `cdylib` with an entry point
// the platform can find. `main.rs` is now a three-line shim that calls the same
// `run()` on desktop, which keeps the two from drifting: one startup path,
// wrapped differently.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running onchato");
}
