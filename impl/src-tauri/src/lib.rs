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
//
// The desktop half below is the exception to "no app logic here", and it is
// there because the webview cannot do these three things by itself:
//
//   * **Notifications.** `Notification.requestPermission()` in a packaged app
//     asks the HOST, and a host that does not answer means a permanent `denied`
//     — which is exactly what shipped: the toggle in Settings could not be
//     turned on at all. The web build is untouched; the packaged build routes
//     the same `NotifyPlan` through the host instead.
//   * **A tray icon.** This product has no store-and-forward. A closed window
//     is not "offline later", it is a conversation that cannot happen — so
//     closing hides to the tray and the process stays reachable.
//   * **A login item.** Same reason, one step earlier.
//
// Every string the user reads comes from the WEBVIEW (`desk_strings`), because
// the app's language lives there and a tray menu in the wrong language is the
// kind of seam that gives a packaged build away.

#[cfg(desktop)]
mod desk {
    use std::sync::Mutex;
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        AppHandle, Builder, Manager, Runtime, State, WindowEvent, Wry,
    };
    use tauri_plugin_notification::{NotificationExt, PermissionState};

    /// What the shell remembers between calls. All of it is a MIRROR of state the
    /// webview owns (it lives in `localStorage` there); the Rust side is told on
    /// startup and on every change, and never persists a copy of its own. Two
    /// stores that can disagree about a preference is how a setting starts
    /// lying, and the webview is the one the user actually changes.
    pub struct Shell {
        /// Does closing the window hide it instead of ending the process?
        close_to_tray: Mutex<bool>,
        /// Said "I am still running, in the tray" once. Saying it every time
        /// trains people to dismiss it, and it is only news the first time.
        told: Mutex<bool>,
        /// Quit was chosen from the tray — the close handler must NOT catch that
        /// one and hide the window, or the app becomes impossible to exit.
        quitting: Mutex<bool>,
        /// Tray labels + the one-off "hidden to tray" notice, in the app's
        /// language. English until the webview reports in.
        show_item: Mutex<Option<MenuItem<Wry>>>,
        quit_item: Mutex<Option<MenuItem<Wry>>>,
        hidden_title: Mutex<String>,
        hidden_body: Mutex<String>,
    }

    impl Default for Shell {
        fn default() -> Self {
            Self {
                // Hiding is the default because the alternative default is
                // "quit", and quitting silently makes every contact see you
                // vanish. The setting exists for people who disagree.
                close_to_tray: Mutex::new(true),
                told: Mutex::new(false),
                quitting: Mutex::new(false),
                show_item: Mutex::new(None),
                quit_item: Mutex::new(None),
                hidden_title: Mutex::new("onchato".into()),
                hidden_body: Mutex::new("Still running in the tray.".into()),
            }
        }
    }

    /// Bring the window back from wherever it went — hidden, minimised, or just
    /// behind something. All three happen, and only doing one of them is why
    /// "clicking the tray does nothing" is a common complaint about tray apps.
    fn reveal<R: Runtime>(app: &AppHandle<R>) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }

    /// Show a system notification.
    ///
    /// `title` and `body` are decided by `lib/notify.ts` on the web side and
    /// carry NO message text in any mode — the whole point of that module is
    /// that a notification is the one part of a conversation that leaves the
    /// app. This command does not get to widen that.
    ///
    /// `id` is the web's notification tag, hashed to the integer the platform
    /// uses: the same conversation replaces its own banner instead of stacking
    /// ten of them, which is the `tag` behaviour the browser gives us for free.
    #[tauri::command]
    fn desk_notify(app: AppHandle, title: String, body: String, id: i32) -> Result<(), String> {
        app.notification()
            .builder()
            .id(id)
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
    }

    /// `granted` / `denied` / `default`, in the words the web side already uses.
    #[tauri::command]
    fn desk_notify_permission(app: AppHandle) -> String {
        state_word(app.notification().permission_state().unwrap_or(PermissionState::Prompt))
    }

    /// Ask the platform. On Linux this is a formality; on macOS it is a real
    /// prompt, which is why it is asked from the toggle and not at startup.
    #[tauri::command]
    fn desk_notify_request(app: AppHandle) -> Result<String, String> {
        app.notification()
            .request_permission()
            .map(state_word)
            .map_err(|e| e.to_string())
    }

    fn state_word(s: PermissionState) -> String {
        match s {
            PermissionState::Granted => "granted",
            PermissionState::Denied => "denied",
            _ => "default",
        }
        .into()
    }

    /// Mirror the webview's setting. Called once at startup and on every change.
    #[tauri::command]
    fn desk_close_to_tray(shell: State<Shell>, on: bool) {
        *shell.close_to_tray.lock().unwrap() = on;
    }

    /// Read (`None`) or set (`Some`) the login item. Returns what is true after
    /// the call, so the toggle paints what the SYSTEM says rather than what we
    /// asked for — the two differ on a locked-down desktop.
    #[tauri::command]
    fn desk_autostart(app: AppHandle, on: Option<bool>) -> Result<bool, String> {
        use tauri_plugin_autostart::ManagerExt;
        let m = app.autolaunch();
        if let Some(want) = on {
            let r = if want { m.enable() } else { m.disable() };
            r.map_err(|e| e.to_string())?;
        }
        m.is_enabled().map_err(|e| e.to_string())
    }

    /// Every user-visible string in the shell, from the app's own catalogue.
    #[tauri::command]
    fn desk_strings(
        shell: State<Shell>,
        show: String,
        quit: String,
        hidden_title: String,
        hidden_body: String,
    ) {
        if let Some(i) = shell.show_item.lock().unwrap().as_ref() {
            let _ = i.set_text(&show);
        }
        if let Some(i) = shell.quit_item.lock().unwrap().as_ref() {
            let _ = i.set_text(&quit);
        }
        *shell.hidden_title.lock().unwrap() = hidden_title;
        *shell.hidden_body.lock().unwrap() = hidden_body;
    }

    /// The webview asking to be brought forward (a notification was clicked in
    /// a build where the platform can tell us, or the app wants attention).
    #[tauri::command]
    fn desk_show(app: AppHandle) {
        reveal(&app);
    }

    pub fn wire(b: Builder<Wry>) -> Builder<Wry> {
        b.plugin(tauri_plugin_notification::init())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))
            .manage(Shell::default())
            .invoke_handler(tauri::generate_handler![
                desk_notify,
                desk_notify_permission,
                desk_notify_request,
                desk_close_to_tray,
                desk_autostart,
                desk_strings,
                desk_show,
            ])
            .setup(|app| {
                let show = MenuItem::with_id(app, "show", "Show onchato", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &quit])?;

                TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .tooltip("onchato")
                    .menu(&menu)
                    // The left click belongs to "show me the app", which is what
                    // people expect of it; the menu is the right click.
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, ev| match ev.id.as_ref() {
                        "show" => reveal(app),
                        "quit" => {
                            *app.state::<Shell>().quitting.lock().unwrap() = true;
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, ev| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = ev
                        {
                            reveal(tray.app_handle());
                        }
                    })
                    .build(app)?;

                let shell = app.state::<Shell>();
                *shell.show_item.lock().unwrap() = Some(show);
                *shell.quit_item.lock().unwrap() = Some(quit);
                Ok(())
            })
            .on_window_event(|window, event| {
                let WindowEvent::CloseRequested { api, .. } = event else { return };
                let app = window.app_handle().clone();
                let shell = app.state::<Shell>();
                // Quit from the tray closes the window on its way out. Catching
                // that one would leave the app with no way to exit at all.
                if *shell.quitting.lock().unwrap() || !*shell.close_to_tray.lock().unwrap() {
                    return;
                }
                api.prevent_close();
                let _ = window.hide();
                // A window that vanishes without a word reads as a crash, and
                // the tray icon is small and easy to miss. Said once, through
                // the same channel the app uses for everything else — which
                // also proves the notification path works.
                let mut told = shell.told.lock().unwrap();
                if !*told {
                    *told = true;
                    let title = shell.hidden_title.lock().unwrap().clone();
                    let body = shell.hidden_body.lock().unwrap().clone();
                    let _ = app.notification().builder().title(title).body(body).show();
                }
            })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = desk::wire(builder);
    builder
        .run(tauri::generate_context!())
        .expect("error while running onchato");
}
