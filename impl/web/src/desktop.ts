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
 * ⚠️ The click handler runs on the web and NOT in the packaged shell: a
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
  try { await invoke('desk_strings', { show: s.show, quit: s.quit, hiddenTitle: s.hiddenTitle, hiddenBody: s.hiddenBody }) } catch {}
  try { await invoke('desk_close_to_tray', { on: closeToTray() }) } catch {}
}
