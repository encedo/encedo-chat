/**
 * notify.ts — whether an arriving message earns a system notification, and how
 * much of itself it is allowed to say.
 *
 * The product is synchronous: both parties have to be present, and there is no
 * store-and-forward to catch what you missed. That makes "your window is not on
 * screen right now" the single most expensive moment in the whole experience —
 * a conversation that could have happened simply does not. A notification is
 * the only thing that fixes it without inventing a server.
 *
 * ## Why the content is a setting, and why it defaults to nothing
 *
 * A notification is the one piece of a conversation that LEAVES the app. It is
 * drawn on the lock screen, kept in a notification centre, and on several
 * platforms written to a system log — all places this product otherwise never
 * puts anything. So:
 *
 * - The **message text is never shown**, in any mode. It is the one thing the
 *   app has promised not to leak anywhere, and no convenience is worth being
 *   the exception.
 * - `name` shows WHO wrote — useful, and still a claim about who you talk to,
 *   visible to anyone glancing at the screen.
 * - `quiet` shows that something arrived and nothing else.
 * - `off` is the default. Notifications require a permission prompt, and asking
 *   at startup, before the user has any idea what for, is how an app gets that
 *   permission denied permanently.
 */

/** How much a notification may say. */
export type NotifyMode = 'off' | 'name' | 'quiet'

export const NOTIFY_MODES: NotifyMode[] = ['off', 'name', 'quiet']
export const isNotifyMode = (s: unknown): s is NotifyMode => NOTIFY_MODES.includes(s as NotifyMode)

/** What the UI should do about one arriving event. */
export type NotifyPlan =
  | { show: false }
  /** `name` is null in quiet mode: something arrived, from nobody in particular. */
  | { show: true; name: string | null }

export function planNotification(o: {
  mode: NotifyMode
  /** The platform said yes. Nothing is shown on 'default' or 'denied'. */
  granted: boolean
  /** The app's own window is not on screen. */
  hidden: boolean
  /** Ours — a notification for something we just sent is pure noise. */
  mine: boolean
  /** Who or what it came from, as this device names them. */
  name?: string
}): NotifyPlan {
  if (o.mode === 'off' || !o.granted || !o.hidden || o.mine) return { show: false }
  return { show: true, name: o.mode === 'name' ? (o.name ?? null) : null }
}
