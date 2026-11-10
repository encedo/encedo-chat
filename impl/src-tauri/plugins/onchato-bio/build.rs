const COMMANDS: &[&str] = &["status", "enroll", "unlock", "remove"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
