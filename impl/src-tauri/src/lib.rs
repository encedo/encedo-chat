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
        /// The session bus, held open for the life of the process. See
        /// `deliver` — this field IS the fix for the vanishing banners.
        #[cfg(target_os = "linux")]
        bus: Mutex<Option<zbus::Connection>>,
        /// Is there anything on this desktop that can DISPLAY a tray icon?
        /// Kept current by `watch_tray_host`. See `CloseRequested`.
        #[cfg(target_os = "linux")]
        tray_ok: std::sync::atomic::AtomicBool,
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
                #[cfg(target_os = "linux")]
                bus: Mutex::new(None),
                // Assumed absent until proven present: the failure of hiding a
                // window into a tray that cannot show it is unrecoverable
                // without a terminal, and the failure of quitting is a relaunch.
                #[cfg(target_os = "linux")]
                tray_ok: std::sync::atomic::AtomicBool::new(false),
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

    /// Deliver one banner on Linux, over a connection we keep open.
    ///
    /// ## Why this does not use the plugin
    ///
    /// Reported as "the notification appears for a tenth of a second and
    /// vanishes", which is a mechanism and not a mood. The plugin's desktop
    /// path is:
    ///
    /// ```ignore
    /// tauri::async_runtime::spawn(async move { let _ = notification.show(); });
    /// ```
    ///
    /// `show()` returns a handle that OWNS the zbus connection it sent on, and
    /// `let _ =` drops it on the spot. The session-bus connection closes a
    /// moment after the Notify call — and a notification daemon withdraws the
    /// notifications of a sender that has left the bus, precisely so that a
    /// crashed app does not leave banners behind. Ours had not crashed; it had
    /// hung up. The banner is drawn and pulled, every time, for everyone.
    ///
    /// So the connection is opened once, kept in `Shell` for the life of the
    /// process, and every notification goes over it. Nothing else changes:
    /// `lib/notify.ts` still decides whether a banner happens and how much it
    /// may say, and it still never carries message text.
    ///
    /// Two hints are worth the four lines they cost. `desktop-entry` points at
    /// the installed `onchato.desktop`, so the banner carries the app's real
    /// name and icon instead of a generic one; `urgency` normal keeps it out of
    /// the "critical" class, which on GNOME does not time out at all.
    /// The session bus, opened once and kept.
    #[cfg(target_os = "linux")]
    async fn bus(app: &AppHandle) -> Result<zbus::Connection, String> {
        // Taken in its own statement so no lock is held across an await.
        let held = app.state::<Shell>().bus.lock().unwrap().clone();
        if let Some(c) = held { return Ok(c) }
        let c = zbus::Connection::session().await.map_err(|e| e.to_string())?;
        *app.state::<Shell>().bus.lock().unwrap() = Some(c.clone());
        Ok(c)
    }

    /// The name an app registers its tray icon WITH — and the thing that has to
    /// exist for the icon to be seen by anyone.
    #[cfg(target_os = "linux")]
    const TRAY_WATCHER: &str = "org.kde.StatusNotifierWatcher";

    /// Is there a tray to hide into?
    ///
    /// This is not a detail. GNOME has no built-in tray: the icon is drawn by an
    /// extension, and when that extension is not running, `TrayIconBuilder`
    /// still succeeds, the icon still "exists", and it is visible to nobody. A
    /// window hidden into that is a window with no way back — you have to kill
    /// the process from a terminal to get your messenger open again. Shipped
    /// exactly that way, and found by the person it happened to.
    ///
    /// So the close-to-tray behaviour asks first, and the answer is kept live:
    /// an extension can come and go while the app runs, and a stale yes is the
    /// dangerous direction.
    #[cfg(target_os = "linux")]
    async fn watch_tray_host(app: AppHandle) {
        use futures_util::StreamExt;
        let Ok(conn) = bus(&app).await else { return };
        let Ok(dbus) = zbus::fdo::DBusProxy::new(&conn).await else { return };
        let set = |on: bool| {
            app.state::<Shell>()
                .tray_ok
                .store(on, std::sync::atomic::Ordering::Relaxed);
            eprintln!("onchato: tray host {}", if on { "present" } else { "ABSENT — closing the window will quit" });
        };
        if let Ok(name) = TRAY_WATCHER.try_into() {
            set(dbus.name_has_owner(name).await.unwrap_or(false));
        }
        let Ok(mut changes) = dbus.receive_name_owner_changed().await else { return };
        while let Some(sig) = changes.next().await {
            let Ok(args) = sig.args() else { continue };
            if args.name.as_str() == TRAY_WATCHER {
                set(args.new_owner.is_some());
            }
        }
    }

    #[cfg(target_os = "linux")]
    async fn deliver(app: AppHandle, title: String, body: String, id: i32) -> Result<(), String> {
        use std::collections::HashMap;
        use zbus::zvariant::Value;

        let conn = bus(&app).await?;

        let hints: HashMap<&str, Value> = HashMap::from([
            ("desktop-entry", Value::from("onchato")),
            ("urgency", Value::from(1u8)),
        ]);
        let reply = conn.call_method(
            Some("org.freedesktop.Notifications"),
            "/org/freedesktop/Notifications",
            Some("org.freedesktop.Notifications"),
            "Notify",
            // app_name, replaces_id, app_icon, summary, body, actions, hints, timeout
            &(
                "onchato",
                id.unsigned_abs(),
                "onchato",
                title.as_str(),
                body.as_str(),
                Vec::<&str>::new(),
                hints,
                -1i32, // the server's own default; we are not the ones to decide
            ),
        )
        .await
        .map_err(|e| e.to_string())?;

        // What the server did with it, in the app's own log.
        //
        // "It appears for a tenth of a second and vanishes" is a report nobody
        // can act on, because every cause looks the same from the outside: the
        // banner was never drawn, or it expired, or the desktop dismissed it,
        // or a person swiped it away. The protocol answers this exactly —
        // `NotificationClosed` carries a REASON — and until now we threw that
        // answer away. Now it lands in `journalctl --user -t onchato`, with the
        // milliseconds it survived.
        //
        // Bounded: one watcher per notification, and it gives up after ten
        // seconds. A banner still on screen after that was not the complaint.
        let id_sent: u32 = reply.body().deserialize::<u32>().unwrap_or(0);
        tauri::async_runtime::spawn(async move {
            let _ = watch_closed(conn, id_sent).await;
        });
        Ok(())
    }

    /// Wait for this notification's obituary and print it.
    #[cfg(target_os = "linux")]
    async fn watch_closed(conn: zbus::Connection, id: u32) -> Result<(), String> {
        use futures_util::StreamExt;
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface("org.freedesktop.Notifications")
            .map_err(|e| e.to_string())?
            .member("NotificationClosed")
            .map_err(|e| e.to_string())?
            .build();
        let mut stream = zbus::MessageStream::for_match_rule(rule, &conn, Some(8))
            .await
            .map_err(|e| e.to_string())?;
        let started = std::time::Instant::now();
        let deadline = std::time::Duration::from_secs(10);
        while let Some(Ok(msg)) = stream.next().await {
            let Ok((closed, reason)) = msg.body().deserialize::<(u32, u32)>() else { continue };
            if closed != id {
                if started.elapsed() > deadline { break }
                continue
            }
            // 1 expired · 2 dismissed by the person · 3 closed by an app · 4 unspecified
            let why = match reason {
                1 => "expired",
                2 => "dismissed by the user",
                3 => "closed by a CloseNotification call",
                _ => "unspecified",
            };
            eprintln!(
                "onchato: notification {id} closed after {} ms — reason {reason} ({why})",
                started.elapsed().as_millis()
            );
            return Ok(());
        }
        Ok(())
    }

    /// Everywhere else the plugin is fine: the fault above is specific to the
    /// D-Bus notification protocol, where the sender's presence on the bus is
    /// what keeps a banner alive.
    #[cfg(not(target_os = "linux"))]
    async fn deliver(app: AppHandle, title: String, body: String, id: i32) -> Result<(), String> {
        app.notification()
            .builder()
            .id(id)
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
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
    async fn desk_notify(app: AppHandle, title: String, body: String, id: i32) -> Result<(), String> {
        deliver(app, title, body, id).await
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

    /// Can this desktop show a tray icon at all? The web side hides the
    /// close-to-tray option where the answer is no, rather than offering a
    /// switch whose only effect would be to lose the window.
    #[tauri::command]
    fn desk_tray_ok(_shell: State<Shell>) -> bool {
        #[cfg(target_os = "linux")]
        { _shell.tray_ok.load(std::sync::atomic::Ordering::Relaxed) }
        #[cfg(not(target_os = "linux"))]
        { true }
    }

    /// The webview asking to be brought forward (a notification was clicked in
    /// a build where the platform can tell us, or the app wants attention).
    #[tauri::command]
    fn desk_show(app: AppHandle) {
        reveal(&app);
    }

    /**
     * Turn WebRTC on in WebKitGTK.
     *
     * ⚠️ **Measured: this does not help on WebKitGTK 2.5x / Ubuntu aarch64.**
     * The setting is real — `enable-webrtc` is a WebKitSettings property that
     * defaults to off, the library ships the `RTCPeerConnection` symbol and
     * GStreamer ships the DTLS plugins — so it looked like the whole answer.
     * It is not: with the property on, the packaged app still reports
     * `RTCPeerConnection nie istnieje w tym webview`. That build simply does
     * not expose the API to JavaScript, and desktop content stays on the relay.
     *
     * The call stays, for two reasons. It is correct — a WebKitGTK that CAN do
     * WebRTC needs exactly this and would otherwise be held back by a default
     * nobody chose — and it costs one call at startup on a webview we already
     * hold. `enable-media-stream` goes with it: getUserMedia is a separate
     * switch, and a connection with nothing to put in it is not worth opening.
     *
     * Whether it worked is not a matter of belief: Ustawienia → Diagnostyka →
     * Sprawdź WebRTC answers it on the machine in front of you.
     */
    #[cfg(target_os = "linux")]
    fn enable_webrtc(app: &tauri::App) {
        use webkit2gtk::{SettingsExt, WebViewExt};
        let Some(win) = app.get_webview_window("main") else { return };
        let _ = win.with_webview(|wv| {
            let settings = WebViewExt::settings(&wv.inner());
            if let Some(s) = settings {
                s.set_enable_webrtc(true);
                s.set_enable_media_stream(true);
            }
        });
    }

    pub fn wire(b: Builder<Wry>) -> Builder<Wry> {
        // ONE running copy, and this one has to be registered before anything
        // else so a second launch is turned away before it builds a window, a
        // tray icon or a transport.
        //
        // It is not tidiness. A second copy of onchato is a second window of the
        // same IDENTITY, and §9.1's answer to that is deliberate and harsh:
        // BOTH sessions stand down, because nothing in a client can tell which
        // window the user meant and letting the newcomer win by arriving second
        // is the wrong default. So the price of a stray double-click was two
        // dead sessions and a reload — and it was paid for real today, when a
        // window hidden into an invisible tray made relaunching the app the
        // obvious thing to do.
        //
        // The second launch now does what the person meant by it: it brings the
        // running window back and exits.
        b.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            reveal(app);
        }))
        .plugin(tauri_plugin_notification::init())
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
                desk_tray_ok,
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

                #[cfg(target_os = "linux")]
                enable_webrtc(app);
                #[cfg(target_os = "linux")]
                {
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(watch_tray_host(handle));
                }

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
                // Nowhere to hide: let the window close rather than making the
                // app unreachable. GNOME draws tray icons through an extension,
                // and when it is not running the icon exists and is seen by
                // nobody.
                #[cfg(target_os = "linux")]
                if !shell.tray_ok.load(std::sync::atomic::Ordering::Relaxed) {
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
                    // The same path every other banner takes — including the
                    // connection that has to outlive it. This one is the first
                    // notification most people will see, so it is the worst one
                    // to deliver through the broken route.
                    let app2 = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = deliver(app2, title, body, 1).await;
                    });
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
