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
        /// Update download progress, read by the webview on a short poll while
        /// the bar is up. Atomics because the download's chunk callback writes
        /// from the updater's task; `upd_total` 0 = length unknown.
        upd_got: std::sync::atomic::AtomicU64,
        upd_total: std::sync::atomic::AtomicU64,
        /// The downloaded-but-not-installed bundle. Held so the person gets to
        /// say WHEN the restart happens — the download is the slow part, the
        /// install is the disruptive one, and they deserve different consents.
        pending_update: Mutex<Option<Vec<u8>>>,
        hidden_title: Mutex<String>,
        hidden_body: Mutex<String>,
        /// The window has been revealed at least once — the webview said
        /// "painted", or a person asked for it. Setup's watchdog checks this
        /// before forcing the hidden-at-start window onto the screen, so it
        /// can never resurrect a window somebody already hid to the tray.
        booted: std::sync::atomic::AtomicBool,
        /// Where the window stood when close-to-tray hid it. An X11 window
        /// manager places a re-mapped window by its own heuristic (glued to a
        /// screen corner, in the live report) unless it asks for its old spot
        /// back — so the spot is saved at hide and spent at reveal.
        hidden_at: Mutex<Option<tauri::PhysicalPosition<i32>>>,
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
                upd_got: std::sync::atomic::AtomicU64::new(0),
                upd_total: std::sync::atomic::AtomicU64::new(0),
                pending_update: Mutex::new(None),
                hidden_title: Mutex::new("onchato".into()),
                hidden_body: Mutex::new("Still running in the tray.".into()),
                booted: std::sync::atomic::AtomicBool::new(false),
                hidden_at: Mutex::new(None),
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

    /// Run under XWayland when a Wayland session offers it.
    ///
    /// Not a prejudice — three window behaviours this shell depends on are
    /// absent from the Wayland protocol BY DESIGN: a client cannot
    /// un-minimize itself, cannot place its own window, and cannot take focus
    /// without an activation token nobody hands to a tray menu. Each absence
    /// was paid for in a live report: "Show onchato" doing nothing, then the
    /// window coming back glued to a corner of the screen instead of where it
    /// was. Under X11 all three are ordinary calls that simply work, which is
    /// why desktop Electron apps shipped on XWayland for years.
    ///
    /// `DISPLAY` present means XWayland is there to catch us; a session
    /// without it (rare) stays on Wayland and keeps the remap fallback in
    /// `reveal`. An explicit `GDK_BACKEND` in the environment is the person's
    /// own decision and is never overridden — which is also the no-rebuild
    /// rollback: `GDK_BACKEND=wayland onchato` brings the native path back.
    ///
    /// The known cost: under fractional scaling (125%/150%) an XWayland
    /// window is scaled as a bitmap and can look slightly soft. At 100% and
    /// at whole factors there is no difference.
    pub fn prefer_x11() {
        #[cfg(target_os = "linux")]
        if std::env::var_os("GDK_BACKEND").is_none() && std::env::var_os("DISPLAY").is_some() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
    }

    /// Are we actually drawing through Wayland — the one case where a
    /// minimized window can only be brought back by remapping it?
    #[cfg(target_os = "linux")]
    fn pure_wayland() -> bool {
        std::env::var_os("WAYLAND_DISPLAY").is_some()
            && std::env::var("GDK_BACKEND").map(|b| b != "x11").unwrap_or(true)
    }

    /// Bring the window back from wherever it went — hidden, minimised, or just
    /// behind something. All three happen, and only doing one of them is why
    /// "clicking the tray does nothing" is a common complaint about tray apps.
    fn reveal<R: Runtime>(app: &AppHandle<R>) {
        let shell = app.state::<Shell>();
        shell
            .booted
            .store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(w) = app.get_webview_window("main") {
            // Wayland has no "unminimize": xdg-shell offers set_minimized and
            // nothing in the other direction, so deiconify() is a no-op there,
            // and present() without an xdg-activation token is refused by
            // GNOME's focus-stealing guard — the user sees an "onchato is
            // ready" notification instead of the window. The one road back is
            // remapping the surface: a hide/show cycle sheds the minimized
            // state and a freshly mapped window is focused normally.
            //
            // Only on PURE Wayland, though (no XWayland — `prefer_x11` was not
            // able to catch us): a remapped window is placed by the compositor
            // as if it were new, so this path trades position for existence.
            // On X11 deiconify() works and the window keeps its place.
            #[cfg(target_os = "linux")]
            if pure_wayland() && w.is_minimized().unwrap_or(false) {
                let _ = w.hide();
            }
            // Put the window back where close-to-tray took it from — asked
            // BEFORE the map so the wish rides the initial hints, and again
            // after, for window managers that only honour a move once the
            // window is mapped. Without this the WM places the re-mapped
            // window itself, glued to a corner. On pure Wayland both calls
            // are no-ops, which is the protocol's answer, not ours.
            let back = shell.hidden_at.lock().unwrap().take();
            if let Some(p) = back {
                let _ = w.set_position(p);
            }
            let _ = w.show();
            if let Some(p) = back {
                let _ = w.set_position(p);
            }
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }

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

    /// Measure how long the UI thread is unavailable, and say so.
    ///
    /// Reported as "the window sometimes ignores close or minimise, then comes
    /// back" — which is not a swallowed event (it recovers) but a main loop that
    /// stopped pumping. Under Wayland the titlebar is drawn by the app itself,
    /// so a stalled main thread IS a frozen set of window buttons.
    ///
    /// Reading it needs no reproduction and no debugger: a helper thread asks to
    /// run a closure on the main thread every half second and times how long
    /// that takes. On an idle loop it is microseconds; a line here is the number
    /// of milliseconds the window was unable to answer anybody, with a timestamp
    /// to line up against whatever the app was doing.
    ///
    /// It costs one wake-up per half second and prints nothing while things are
    /// well, which is why it can ship rather than live behind a flag: the fault
    /// is intermittent, and an instrument you have to enable first is an
    /// instrument that is off when it matters.
    fn watch_main_thread(app: AppHandle) {
        use std::sync::mpsc;
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let (tx, rx) = mpsc::channel();
            let asked = std::time::Instant::now();
            if app.run_on_main_thread(move || { let _ = tx.send(()); }).is_err() { return }
            // A wait, not a timeout: the point is the size of the stall, and a
            // closure that is late still arrives. The app is closing if the
            // channel dies, and then so does this thread.
            if rx.recv().is_err() { return }
            let waited = asked.elapsed();
            if waited > std::time::Duration::from_millis(400) {
                eprintln!("onchato: UI thread was busy for {} ms", waited.as_millis());
            }
        });
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

    /// Which half of the seam is answering. The webview shows different settings
    /// for a window and for a phone, and inferring that from a user agent is how
    /// it goes wrong quietly.
    #[tauri::command]
    fn desk_platform() -> String { "desktop".into() }

    /// How this copy was installed — which decides whether it may update ITSELF.
    ///
    /// The updater replaces a self-contained bundle: an AppImage, an installer's
    /// .exe, an .app. It cannot update a package the system owns. Point it at a
    /// .deb and it downloads a new version and fails at the end, having asked
    /// somebody to wait for it — so on a distro package the honest offer is a
    /// notice and a link, and the webview has to know which of the two it is.
    ///
    /// AppImage says so itself: its runtime exports `APPIMAGE`. Nothing here is
    /// inferred from a user agent or a path, both of which lie.
    #[tauri::command]
    fn desk_update_kind() -> String {
        #[cfg(target_os = "linux")]
        {
            if std::env::var_os("APPIMAGE").is_some() { "self".into() } else { "system".into() }
        }
        #[cfg(not(target_os = "linux"))]
        { "self".into() }
    }

    /// Open a URL in the system browser — the only kind of "new window" this
    /// app has.
    ///
    /// The webview forwards every `window.open` / `target="_blank"` to the
    /// host as a new-window request, and the shell installs no handler for
    /// those (a messenger opens no second webviews) — so without this command
    /// an outward link DIES SILENTLY in the packaged build. That shipped: the
    /// update dialog's download button for a .deb was such a link, and so is
    /// the arrow beside a URL in a message.
    ///
    /// http/https only, verbatim from the check the webview's linkify makes:
    /// this command is reachable from webview content, and a boundary that
    /// launches whatever it is handed has stopped being one.
    #[tauri::command]
    fn desk_open_url(url: String) -> Result<(), String> {
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err("not a web url".into());
        }
        #[cfg(target_os = "linux")]
        let r = std::process::Command::new("xdg-open").arg(&url).spawn();
        #[cfg(target_os = "macos")]
        let r = std::process::Command::new("open").arg(&url).spawn();
        // Not `cmd /C start`: cmd splits on the `&` that query strings carry.
        #[cfg(target_os = "windows")]
        let r = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn();
        r.map(|_| ()).map_err(|e| e.to_string())
    }

    /// Where this AppImage stands with the person's desktop.
    ///
    /// GNOME draws the dock icon and the menu entry from an INSTALLED .desktop
    /// file, matched to the window by WM_CLASS; the bundler puts the entry and
    /// the icons inside the AppImage, where the system never looks. So an
    /// AppImage run from Downloads wears the generic gear icon and is in no
    /// menu — reported as a bug, reasonably.
    ///
    ///   `none`      — not an AppImage (a .deb, another OS): nothing to offer.
    ///   `installed` — a desktop entry already answers for us: ours in
    ///                 ~/.local, or the distro package's in /usr/share (then
    ///                 the menu and the icon are already right, and a second
    ///                 entry would only duplicate them).
    ///   `offer`     — an AppImage with no working entry. The webview asks the
    ///                 person — in the app's language, like every other string
    ///                 — and calls `desk_appimage_install` on a yes.
    #[tauri::command]
    fn desk_appimage_status() -> String {
        #[cfg(target_os = "linux")]
        {
            if std::env::var_os("APPIMAGE").is_none() {
                return "none".into();
            }
            if std::path::Path::new("/usr/share/applications/onchato.desktop").exists() {
                return "installed".into();
            }
            if let Some(entry) = desktop_entry_path() {
                if let Ok(body) = std::fs::read_to_string(&entry) {
                    if entry_target_exists(&body) {
                        return "installed".into();
                    }
                    // The entry points at a file that is gone — the person
                    // deleted the installed AppImage and is running a fresh
                    // download. Offer again; a yes repairs the dead entry.
                }
            }
            "offer".into()
        }
        #[cfg(not(target_os = "linux"))]
        {
            "none".into()
        }
    }

    #[cfg(target_os = "linux")]
    fn home() -> Result<std::path::PathBuf, String> {
        std::env::var_os("HOME")
            .map(Into::into)
            .ok_or_else(|| "no HOME".to_string())
    }

    #[cfg(target_os = "linux")]
    fn desktop_entry_path() -> Option<std::path::PathBuf> {
        Some(home().ok()?.join(".local/share/applications/onchato.desktop"))
    }

    /// Does the entry's TryExec still point at something on disk? Only entries
    /// WE write carry one, and we write it precisely so this question is
    /// answerable; an entry without it is somebody else's integration
    /// (AppImageLauncher, Gear Lever, a hand-written one) and is left alone.
    #[cfg(target_os = "linux")]
    fn entry_target_exists(body: &str) -> bool {
        for line in body.lines() {
            if let Some(p) = line.strip_prefix("TryExec=") {
                return std::path::Path::new(p.trim()).exists();
            }
        }
        true
    }

    /// Put this AppImage where a person can find it again, and tell the desktop.
    ///
    /// The file MOVES to ~/Applications/Onchato.AppImage — a rename on the
    /// same filesystem, a copy + remove across ones — rather than being copied:
    /// a copy leaves the original in Downloads, where it is either launched
    /// again later (two copies that disagree after the first update) or swept
    /// out with the rest of the folder. Moving also renames: a filename
    /// carrying a version number would start lying at the first in-place
    /// update. Then the icon goes into the hicolor theme and a .desktop entry
    /// beside the other apps' — the same fields the bundler writes into the
    /// .deb, plus TryExec, which both lets `desk_appimage_status` notice a
    /// deleted target and makes the menu hide the entry meanwhile.
    ///
    /// Only ever called after `desk_appimage_status` said `offer`, from a
    /// dialog the person answered. The dock icon of the RUNNING window may only
    /// match from the next launch — GNOME pairs a window with its entry when
    /// the window appears.
    ///
    /// ⚠️ The updater replaces the file `APPIMAGE` names, so the variable is
    /// repointed at the new home for the rest of this process — otherwise an
    /// update accepted in this same session would try to land in the Downloads
    /// path the file just left.
    #[tauri::command]
    fn desk_appimage_install() -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            use std::fs;
            let src = std::path::PathBuf::from(
                std::env::var_os("APPIMAGE").ok_or_else(|| "not an AppImage".to_string())?,
            );
            let home = home()?;

            let apps_dir = home.join("Applications");
            fs::create_dir_all(&apps_dir).map_err(|e| e.to_string())?;
            let dest = apps_dir.join("Onchato.AppImage");
            if dest != src {
                if fs::rename(&src, &dest).is_err() {
                    fs::copy(&src, &dest).map_err(|e| e.to_string())?;
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755));
                    let _ = fs::remove_file(&src);
                }
            }
            std::env::set_var("APPIMAGE", &dest);

            let icon_dir = home.join(".local/share/icons/hicolor/128x128/apps");
            fs::create_dir_all(&icon_dir).map_err(|e| e.to_string())?;
            fs::write(
                icon_dir.join("onchato.png"),
                include_bytes!("../icons/128x128.png"),
            )
            .map_err(|e| e.to_string())?;

            let entry_dir = home.join(".local/share/applications");
            fs::create_dir_all(&entry_dir).map_err(|e| e.to_string())?;
            let path_str = dest.to_string_lossy();
            // Exec quoting per the spec: double quotes around the path, the
            // reserved characters backslash-escaped, and % doubled so nothing
            // in a path is ever read as a field code.
            let exec = format!(
                "\"{}\"",
                path_str
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('$', "\\$")
                    .replace('`', "\\`")
                    .replace('%', "%%")
            );
            let body = format!(
                "[Desktop Entry]\n\
                 Type=Application\n\
                 Name=onchato\n\
                 Comment=onchato — P2P messenger\n\
                 Exec={exec}\n\
                 TryExec={path_str}\n\
                 Icon=onchato\n\
                 Terminal=false\n\
                 Categories=Network;InstantMessaging;\n\
                 StartupWMClass=onchato\n"
            );
            fs::write(entry_dir.join("onchato.desktop"), body).map_err(|e| e.to_string())?;
            Ok(())
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err("not an AppImage".to_string())
        }
    }

    /// Is there a newer release, and what is it?
    ///
    /// The whole update lives on THIS side of the seam on purpose. The plugin's
    /// JavaScript API would work, and it would mean two npm packages, an event
    /// channel and a second way for the webview to reach a privileged plugin —
    /// for a question with a two-field answer. The webview asks the host, which
    /// is the pattern the rest of this file already is.
    ///
    /// `Ok(None)` means "asked, and this is the newest". An `Err` is a failure
    /// to ask — no network, an unreachable endpoint, a draft release nobody
    /// published — and the caller says nothing rather than inventing news.
    #[derive(serde::Serialize)]
    struct UpdateInfo { version: String, notes: Option<String> }

    #[tauri::command]
    async fn desk_update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
        use tauri_plugin_updater::UpdaterExt;
        let found = app.updater().map_err(|e| e.to_string())?
            .check().await.map_err(|e| e.to_string())?;
        Ok(found.map(|u| UpdateInfo {
            version: u.version.clone(),
            notes: u.body.clone(),
        }))
    }

    /// Fetch the update — and ONLY fetch it. Install-and-restart is a separate
    /// command, because the two deserve different consents: the download is the
    /// slow part (a person watches a bar), the restart is the disruptive part
    /// (a person picks the moment). 0.5.16's single command did both, and the
    /// report from the first live test was exact: "od kliknięcia nic się nie
    /// działo i nagle restart".
    ///
    /// ⚠️ Only ever called after `desk_update_kind` answered `self`. On a distro
    /// package this downloads a bundle it cannot install (§ the kind command).
    ///
    /// It checks again rather than holding the update from the call before it:
    /// the handle is not ours to keep across an IPC boundary, and asking twice
    /// costs one request against a release that has not moved. Progress goes
    /// into two atomics the webview POLLS (`desk_update_progress`) — no event
    /// plugin, no npm package, the same two-sided ask the rest of this file is.
    #[tauri::command]
    async fn desk_update_download(app: AppHandle) -> Result<(), String> {
        use std::sync::atomic::Ordering;
        use tauri_plugin_updater::UpdaterExt;
        let update = app.updater().map_err(|e| e.to_string())?
            .check().await.map_err(|e| e.to_string())?
            .ok_or_else(|| "nothing to download".to_string())?;
        {
            let shell = app.state::<Shell>();
            shell.upd_got.store(0, Ordering::Relaxed);
            shell.upd_total.store(0, Ordering::Relaxed);
        }
        let progress_app = app.clone();
        let bytes = update.download(
            move |chunk, total| {
                let shell = progress_app.state::<Shell>();
                shell.upd_got.fetch_add(chunk as u64, Ordering::Relaxed);
                if let Some(t) = total { shell.upd_total.store(t, Ordering::Relaxed); }
            },
            || {},
        ).await.map_err(|e| e.to_string())?;
        *app.state::<Shell>().pending_update.lock().unwrap() = Some(bytes);
        Ok(())
    }

    #[derive(serde::Serialize)]
    struct UpdateProgress { got: u64, total: Option<u64> }

    /// Where the download stands. Polled by the webview while its bar is up;
    /// `total: None` means the server did not say (the bar shows bytes then).
    #[tauri::command]
    fn desk_update_progress(app: AppHandle) -> UpdateProgress {
        use std::sync::atomic::Ordering;
        let shell = app.state::<Shell>();
        let total = shell.upd_total.load(Ordering::Relaxed);
        UpdateProgress {
            got: shell.upd_got.load(Ordering::Relaxed),
            total: if total == 0 { None } else { Some(total) },
        }
    }

    /// Put the downloaded bundle in place and come back up on the new version.
    /// The person said "now" — this is the restart they agreed to. The bytes
    /// were signature-checked against the release's minisign signature by the
    /// plugin during install; a release that MOVED between download and this
    /// call fails that check and the app stays on the old version, working.
    #[tauri::command]
    async fn desk_update_apply(app: AppHandle) -> Result<(), String> {
        use tauri_plugin_updater::UpdaterExt;
        let bytes = app.state::<Shell>().pending_update.lock().unwrap().take()
            .ok_or_else(|| "nothing downloaded".to_string())?;
        let update = app.updater().map_err(|e| e.to_string())?
            .check().await.map_err(|e| e.to_string())?
            .ok_or_else(|| "release moved since the download".to_string())?;
        update.install(bytes).map_err(|e| e.to_string())?;
        app.restart()
    }

    /// The webview asking to be brought forward (a notification was clicked in
    /// a build where the platform can tell us, or the app wants attention).
    #[tauri::command]
    fn desk_show(app: AppHandle) {
        reveal(&app);
    }

    /// macOS sends `Reopen` when the Dock icon of an app with no visible
    /// windows is clicked — and bringing the window back is what a Mac user
    /// means by that click. Without this, close-to-tray left the Dock icon
    /// dead: the window hid, the Dock click did nothing, and the only ways
    /// back were the menu bar icon or a terminal. The macOS twin of the GNOME
    /// no-watcher trap, and handled the same way: reveal, don't guess.
    pub fn on_run_event(app: &AppHandle, event: &tauri::RunEvent) {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            reveal(app);
        }
        let _ = (app, event);
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
        use webkit2gtk::glib::object::Cast;
        use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
        let Some(win) = app.get_webview_window("main") else { return };
        let _ = win.with_webview(|wv| {
            let view = wv.inner();
            if let Some(s) = WebViewExt::settings(&view) {
                s.set_enable_webrtc(true);
                s.set_enable_media_stream(true);
            }
            // ⚠️ And the half that `enable-media-stream` alone does not buy.
            //
            // Reported as "recording does not work in Tauri — no permission",
            // and it is the same shape as the notification bug: WebKitGTK does
            // not decide about a microphone, it ASKS the host, and a host that
            // answers nothing is a host that says no. Tauri installs no handler,
            // so `getUserMedia` was refused before the person had finished
            // pressing the button. Voice notes and the QR scanner both die there.
            //
            // Granting is safe HERE for a reason that does not generalise: this
            // webview loads one thing, our own bundle from disk. There is no
            // third-party page to ask on somebody else's behalf, and the request
            // only ever arrives because a control in that bundle was pressed.
            //
            // Media only. Geolocation, pointer lock and the rest fall through to
            // the default, which is to refuse — an app that grants whatever it is
            // asked has stopped being a boundary.
            view.connect_permission_request(|_, req| {
                use webkit2gtk::UserMediaPermissionRequest;
                if req.downcast_ref::<UserMediaPermissionRequest>().is_some() {
                    req.allow();
                    return true;
                }
                false
            });
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
            .plugin(tauri_plugin_updater::Builder::new().build())
            .manage(Shell::default())
            .invoke_handler(tauri::generate_handler![
                desk_notify,
                desk_notify_permission,
                desk_notify_request,
                desk_close_to_tray,
                desk_autostart,
                desk_strings,
                desk_tray_ok,
                desk_platform,
                desk_show,
                desk_open_url,
                desk_update_kind,
                desk_appimage_status,
                desk_appimage_install,
                desk_update_check,
                desk_update_download,
                desk_update_progress,
                desk_update_apply,
            ])
            .setup(|app| {
                // The webview's first frame is white — WebKitGTK paints before
                // the page does — and on a dark desktop that is a flash of the
                // wrong colour at every launch (reported: a white or half-white
                // window that turns dark a moment later). So the window stays
                // OFF screen until the page has painted: hidden here, before
                // the event loop has mapped anything, and shown by the
                // webview's own ping (`desk_show`, two animation frames into
                // its script — the first moment a theme-correct paint provably
                // exists). The watchdog is for a bundle that breaks before it
                // can ping: a window with an error on it beats an app that
                // looks like it never started. `booted` keeps the watchdog
                // from resurrecting a window somebody already hid to the tray.
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                {
                    let h = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(4));
                        if !h
                            .state::<Shell>()
                            .booted
                            .load(std::sync::atomic::Ordering::Relaxed)
                        {
                            reveal(&h);
                        }
                    });
                }

                let show = MenuItem::with_id(app, "show", "Show onchato", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &quit])?;

                let tray = TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .tooltip("onchato")
                    .menu(&menu);
                // The macOS menu bar tints template icons itself for the light
                // and dark bar; a colour icon is passed through as-is and can
                // sink into some bar tints. Template uses the alpha channel as
                // the silhouette — which our dot has.
                #[cfg(target_os = "macos")]
                let tray = tray.icon_as_template(true);
                tray
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
                watch_main_thread(app.handle().clone());

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
                // Remembered before hiding, spent by `reveal` — the WM will
                // not put a re-mapped window back by itself.
                *shell.hidden_at.lock().unwrap() = window.outer_position().ok();
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

/// The mobile half of the same seam.
///
/// `web/src/desktop.ts` asks the shell for what a browser tab cannot do, and it
/// asks by invoking commands. Those commands lived inside `mod desk`, which is
/// `cfg(desktop)` — so on Android they did not exist, every invoke was rejected
/// and notifications were dropped in silence. The webview had no way to know:
/// from its side "the host refused" and "the host has no such command" look
/// identical.
///
/// Mobile answers the same questions honestly: it can notify, and it has no
/// tray, no login item and no window to hide. Reachability on Android is not an
/// icon — it is `android/OnchatoService.kt`, which keeps the process from being
/// frozen while the app is open.
#[cfg(mobile)]
mod mobile {
    use tauri::{AppHandle, Builder, Wry};
    use tauri_plugin_notification::{NotificationExt, PermissionState};

    fn word(s: PermissionState) -> String {
        match s {
            PermissionState::Granted => "granted",
            PermissionState::Denied => "denied",
            _ => "default",
        }
        .into()
    }

    #[tauri::command]
    fn desk_notify(app: AppHandle, title: String, body: String, id: i32) -> Result<(), String> {
        app.notification().builder().id(id).title(title).body(body).show().map_err(|e| e.to_string())
    }

    #[tauri::command]
    fn desk_notify_permission(app: AppHandle) -> String {
        word(app.notification().permission_state().unwrap_or(PermissionState::Prompt))
    }

    /// Android asks for real here. The activity also asks at startup, because a
    /// permission dialog cannot be shown to an app that is already in the
    /// background — which is exactly when a message notification is wanted.
    #[tauri::command]
    fn desk_notify_request(app: AppHandle) -> Result<String, String> {
        app.notification().request_permission().map(word).map_err(|e| e.to_string())
    }

    /// Said plainly rather than by failing, so the settings screen can leave
    /// those switches out instead of showing ones that do nothing.
    #[tauri::command]
    fn desk_tray_ok() -> bool { false }
    #[tauri::command]
    fn desk_platform() -> String { "mobile".into() }

    /// Android updates by installing an APK, not by replacing a bundle in
    /// place. Answering keeps the webview on one code path — an unknown command
    /// throws, and a thrown check reads as "there is no update".
    #[tauri::command]
    fn desk_update_kind() -> String { "store".into() }
    #[tauri::command]
    fn desk_close_to_tray(_on: bool) {}
    #[tauri::command]
    fn desk_autostart(_on: Option<bool>) -> Result<bool, String> { Ok(false) }
    #[tauri::command]
    fn desk_strings(_show: String, _quit: String, _hidden_title: String, _hidden_body: String) {}
    #[tauri::command]
    fn desk_show() {}

    pub fn wire(b: Builder<Wry>) -> Builder<Wry> {
        b.plugin(tauri_plugin_notification::init())
            .invoke_handler(tauri::generate_handler![
                desk_notify,
                desk_notify_permission,
                desk_notify_request,
                desk_tray_ok,
                desk_platform,
                desk_close_to_tray,
                desk_autostart,
                desk_strings,
                desk_show,
                desk_update_kind,
            ])
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before the builder: the backend choice must land before GTK first looks
    // at the environment, and GTK initializes inside build()/run().
    #[cfg(desktop)]
    desk::prefer_x11();
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = desk::wire(builder);
    #[cfg(mobile)]
    let builder = mobile::wire(builder);
    // Two run shapes ON PURPOSE. Desktop needs the event callback (macOS
    // Reopen — the Dock click that brings a hidden window back). Mobile goes
    // through the exact `.run(context)` path that every working APK up to
    // 0.5.16 shipped with: the 0.5.17 switch to build()+run(callback) is the
    // one mobile-visible change of that release, and the 0.5.17 APK died on
    // launch with the service notification still standing — so mobile does not
    // get to pay for a desktop feature it cannot use.
    #[cfg(desktop)]
    builder
        .build(tauri::generate_context!())
        .expect("error while building onchato")
        .run(|app, event| desk::on_run_event(app, &event));
    #[cfg(mobile)]
    builder
        .run(tauri::generate_context!())
        .expect("error while running onchato");
}
