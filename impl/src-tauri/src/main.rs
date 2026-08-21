// Desktop entry point — a shim over the shared `run()` in lib.rs, so desktop and
// mobile start the app exactly the same way. See lib.rs for why a library exists.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    onchato_lib::run()
}
