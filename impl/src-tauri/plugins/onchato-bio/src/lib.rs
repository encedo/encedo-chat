//! onchato-bio: the unlock key of a software profile in AndroidKeyStore.
//!
//! Everything happens in Kotlin (`android/src/main/java/BioPlugin.kt`); the
//! webview calls `plugin:onchato-bio|<command>` and Tauri routes it there.
//! Android only: on any other platform the plugin registers nothing, the
//! commands do not exist, and the page offers no unlock (web/src/passkey.ts).

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.encedo.onchato.bio";

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("onchato-bio")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin(PLUGIN_IDENTIFIER, "BioPlugin")?;
            Ok(())
        })
        .build()
}
