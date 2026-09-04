/**
 * desktop.ts — the three things the packaged shell can do and a browser tab
 * cannot, behind one interface so `app.ts` does not grow a fork per platform.
 *
 * ## Why this file exists at all
 *
 * The desktop build is the SAME bundle as the web build, running in a webview.
 * That is deliberate and it is not going to change. But a webview is not a
 * browser: it has no browser UI to ask the user anything, so a call like
 * `Notification.requestPermission()` is passed to the HOST — and a host that
 * does not answer it means a permanent `denied`. That is what shipped in
 * 0.3.1: a notification feature that was built, tested and impossible to turn
 * on, with nothing anywhere saying why.
 *
 * So the platform decides the mechanism and nothing else. `lib/notify.ts` still
 * decides WHETHER a notification happens and how much it may say — one policy,
 * one set of tests, two ways of drawing the banner.
 *
 * ## The shape of the seam
 *
 * `isDesktopShell()` is the only branch. Everything else answers the same in
 * both worlds, so the calling code reads as if there were one platform. In a
 * browser this module is a thin pass-through to the Web Notification API and
 * the desktop-only settings simply report themselves unavailable.
 *
 * Nothing here is allowed to know what a message says: `notifyShow` takes the
 * title and body that `planNotification` produced, and those never contain
 * message text in any mode.
 */

export type Perm = 'granted' | 'denied' | 'default'

/** A shown notification, in whatever the platform gave us. */
export interface Banner { close(): void }

type Internals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any> }
const internals = (): Internals | undefined => (globalThis as any).__TAURI_INTERNALS__

/**
 * Are we inside the packaged shell? Tauri injects this before any of our code
 * runs, so it is answerable synchronously from the first line — which matters,
 * because the notification permission has to be known before the settings
 * drawer is painted.
 */
export const isDesktopShell = (): boolean => typeof internals()?.invoke === 'function'

const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const i = internals()
  if (!i) return Promise.reject(new Error('not the desktop shell'))
  return i.invoke(cmd, args ?? {}) as Promise<T>
}

/**
 * The host answers about permission asynchronously, and every caller here is
 * synchronous (`planNotification` is a pure function called on the message
 * path). So the answer is cached at startup and refreshed whenever we ask for
 * it. `default` until `initDesktop()` has run — the honest value, and the one
 * that shows nothing rather than assuming a yes.
 */
let deskPerm: Perm = 'default'

/**
 * Can this desktop DISPLAY a tray icon?
 *
 * GNOME has no built-in tray — an extension draws it — so the icon can be
 * created successfully and seen by nobody. Assumed false until the shell says
 * otherwise, because the failure of hiding a window into an invisible tray is
 * a window you cannot get back.
 */
let deskTray = false
export const trayAvailable = (): boolean => deskTray

/**
 * Which shell is answering.
 *
 * Asked rather than inferred from the user agent: on Android the webview looks
 * enough like a browser to fool a sniff, and the settings that follow from
 * getting it wrong are a tray switch on a phone and a missing one on a desktop.
 */
let deskKind: 'desktop' | 'mobile' = 'desktop'
export const isMobileShell = (): boolean => isDesktopShell() && deskKind === 'mobile'

/**
 * A tag is a string on the web and an integer on the host, and it does the same
 * job in both: one banner per conversation, replaced rather than stacked.
 * FNV-1a, kept inside the positive half of an i32 because that is what the
 * platform takes.
 */
function tagId(tag: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 1) % 2147483647
}

export const notifySupported = (): boolean =>
  isDesktopShell() || typeof Notification === 'function'

export const notifyPermission = (): Perm =>
  isDesktopShell() ? deskPerm : (typeof Notification === 'function' ? Notification.permission as Perm : 'denied')

/** Ask, from the gesture that turned the setting on. */
export async function notifyRequest(): Promise<Perm> {
  if (isDesktopShell()) {
    try { deskPerm = await invoke<Perm>('desk_notify_request') } catch { deskPerm = 'denied' }
    return deskPerm
  }
  try { return await Notification.requestPermission() as Perm } catch { return 'denied' }
}

/**
 * Draw one banner. Returns something that can be closed, or null if the
 * platform refused — the caller keeps it per conversation so a stale banner can
 * be dismissed when the window comes back.
 *
 * WARNING: The click handler runs on the web and NOT in the packaged shell: a
 * libnotify banner with no actions reports nothing back, so there is nothing to
 * listen to. The tray icon is the way back to the window there, which is one of
 * the reasons the tray is part of this change rather than a nicety.
 */
export function notifyShow(o: { title: string; body: string; tag: string; onClick?: () => void }): Banner | null {
  if (isDesktopShell()) {
    void invoke('desk_notify', { title: o.title, body: o.body, id: tagId(o.tag) }).catch(() => {})
    // Nothing to close: the platform owns the banner and replaces it by id.
    return { close() {} }
  }
  try {
    const n = new Notification(o.title, { body: o.body, tag: o.tag, silent: false })
    if (o.onClick) n.addEventListener('click', () => { window.focus(); n.close(); o.onClick!() })
    return { close() { try { n.close() } catch {} } }
  } catch { return null }
}

// ---- shell settings (packaged build only) ----------------------------------

/**
 * Closing the window hides it instead of ending the process.
 *
 * On by default, and the reason is the product rather than taste: onchato has
 * no store-and-forward. A closed window is not "I will read it later", it is a
 * conversation that cannot happen and a contact who sees a grey dot. People
 * close windows all day without meaning to go offline.
 */
export const CLOSE_TRAY_KEY = 'ec-close-tray'

export const closeToTray = (): boolean => {
  try { return localStorage.getItem(CLOSE_TRAY_KEY) !== '0' } catch { return true }
}

export function setCloseToTray(on: boolean) {
  try { localStorage.setItem(CLOSE_TRAY_KEY, on ? '1' : '0') } catch {}
  if (isDesktopShell()) void invoke('desk_close_to_tray', { on }).catch(() => {})
}

/**
 * The login item. Read from the SYSTEM rather than from a setting of ours —
 * a desktop can refuse it, and a toggle that shows what we asked for instead of
 * what happened is a toggle that lies.
 */
export async function autostartEnabled(): Promise<boolean> {
  if (!isDesktopShell()) return false
  try { return await invoke<boolean>('desk_autostart', { on: null }) } catch { return false }
}

export async function setAutostart(on: boolean): Promise<boolean> {
  if (!isDesktopShell()) return false
  try { return await invoke<boolean>('desk_autostart', { on }) } catch { return false }
}

/** Bring the window forward. */
export function showWindow() {
  if (isDesktopShell()) void invoke('desk_show').catch(() => {})
  else window.focus()
}

/**
 * Open a URL outside the app. In a browser that is a new tab; in the packaged
 * shell it is the SYSTEM browser — the webview forwards `target="_blank"` to
 * the host as a new-window request, no handler is installed for those (a
 * messenger opens no second webviews), and the click dies silently. The host
 * command re-checks the scheme; a shell too old to know it swallows the click
 * exactly as before, never navigates the app itself.
 */
export function openExternal(url: string) {
  if (isDesktopShell()) void invoke('desk_open_url', { url }).catch(() => {})
  else window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Hand the shell every string it shows, in the app's language, and tell it the
 * close-to-tray setting the webview is holding.
 *
 * The tray menu is the only part of onchato drawn outside the webview, so it is
 * the only part that can end up in a different language than the rest — which
 * is exactly the seam that makes a packaged web app feel packaged.
 */
export async function initDesktop(s: {
  show: string; quit: string; hiddenTitle: string; hiddenBody: string
}) {
  if (!isDesktopShell()) return
  try { deskPerm = await invoke<Perm>('desk_notify_permission') } catch { deskPerm = 'default' }
  try { deskTray = await invoke<boolean>('desk_tray_ok') } catch { deskTray = false }
  try { deskKind = await invoke<'desktop' | 'mobile'>('desk_platform') } catch { deskKind = 'desktop' }
  try { await invoke('desk_strings', { show: s.show, quit: s.quit, hiddenTitle: s.hiddenTitle, hiddenBody: s.hiddenBody }) } catch {}
  try { await invoke('desk_close_to_tray', { on: closeToTray() }) } catch {}
}

// ---- AppImage self-integration ---------------------------------------------
/**
 * An AppImage run from Downloads is in no menu and wears a generic gear icon:
 * GNOME draws both from an INSTALLED .desktop file, and the AppImage carries
 * its own inside, where the system never looks. The host can install it —
 * move the file to ~/Applications, write the entry and the icon — but whether
 * to ask, and in what words, is the webview's job like every other string.
 *
 *   `none`      — not an AppImage; say nothing.
 *   `installed` — a desktop entry already answers for us; say nothing.
 *   `offer`     — ask, once per launch, and install on a yes.
 */
export type AppimageStatus = 'none' | 'installed' | 'offer'

export async function appimageStatus(): Promise<AppimageStatus> {
  if (!isDesktopShell()) return 'none'
  // An older shell (or the mobile one) has no such command; the safe reading
  // of "no answer" is the one that asks nothing.
  try { return await invoke<AppimageStatus>('desk_appimage_status') } catch { return 'none' }
}

export const appimageInstall = () => invoke<void>('desk_appimage_install')

// ---- updating in place -----------------------------------------------------
/**
 * What this copy of the app can do about a newer version.
 *
 * WARNING: Not every install can update itself, and offering it where it cannot is
 * worse than not offering: the download runs, somebody waits, and it fails at
 * the last step. The updater replaces a self-contained bundle — an AppImage, an
 * installer's .exe, an .app — and a `.deb` belongs to the package manager, not
 * to us.
 *
 *   `self`   — replace it and relaunch. AppImage, Windows, macOS.
 *   `system` — a distro package. Say there is a new version, link to it, stop.
 *   `store`  — Android. A new APK is installed, not swapped in.
 *   `web`    — a browser tab, which updates by being reloaded.
 *
 * The host answers, because it is the only side that knows: `APPIMAGE` in the
 * environment is the AppImage runtime saying so, and everything else — a user
 * agent, a path — is a guess.
 */
export type UpdateKind = 'self' | 'system' | 'store' | 'web'

export async function updateKind(): Promise<UpdateKind> {
  if (!isDesktopShell()) return 'web'
  // An older shell has no such command, and the safe reading of "no answer" is
  // the one that offers a link instead of a swap.
  try { return await invoke<UpdateKind>('desk_update_kind') } catch { return 'system' }
}

export interface UpdateInfo { version: string; notes?: string | null }

/** `null` means asked, and this IS the newest. A rejection means we could not
 *  ask — no network, or a release nobody has published yet — and the caller
 *  must then say nothing rather than invent news. */
export const updateCheck = () => invoke<UpdateInfo | null>('desk_update_check')

/**
 * The download and the restart are SEPARATE calls, because they deserve
 * separate consents: the download is the slow part (a person watches a bar,
 * fed by polling `updateProgress`), the restart is the disruptive one (a
 * person picks the moment). 0.5.16 did both behind one click, and the first
 * live test named the cost precisely: nothing visibly happened, then a sudden
 * restart. Only ever after `updateKind()` said `self`.
 */
export const updateDownload = () => invoke<void>('desk_update_download')
export const updateProgress = () => invoke<{ got: number; total: number | null }>('desk_update_progress')
export const updateApply = () => invoke<void>('desk_update_apply')
