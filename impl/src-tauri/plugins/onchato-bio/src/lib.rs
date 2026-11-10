//! onchato-bio: the unlock key of a software profile, in the device's own store.
//!
//! Android: everything happens in Kotlin (`android/src/main/java/BioPlugin.kt`);
//! the webview calls `plugin:onchato-bio|<command>` and Tauri routes it there.
//! Windows: the same four commands in Rust over Windows Hello (`hello.rs`).
//! Anywhere else the plugin is not linked (iOS: linked, no native side), the
//! commands do not exist, and the page offers no unlock (web/src/passkey.ts).

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(windows)]
mod hello;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.encedo.onchato.bio";

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let b = Builder::new("onchato-bio");
    // Desktop only: on a phone a Rust handler would shadow the Kotlin plugin.
    #[cfg(windows)]
    let b = b.invoke_handler(tauri::generate_handler![
        hello::status,
        hello::enroll,
        hello::unlock,
        hello::remove
    ]);
    b.setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin(PLUGIN_IDENTIFIER, "BioPlugin")?;
            Ok(())
        })
        .build()
}
