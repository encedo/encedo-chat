// Encedo Chat desktop shell (Tauri 2). The frontend is the SAME webpack bundle the
// web app serves (../web/dist) — this only wraps it in a native WebKitGTK window.
// No app logic lives here: identity (HEM/software), EH-2 + ratchet, rendezvous and
// the WebRTC/relay transport all run in the webview, exactly as on the web.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Encedo Chat");
}
