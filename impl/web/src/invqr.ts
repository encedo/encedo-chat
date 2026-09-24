/**
 * invqr.ts — what the invite-QR window shows, as a pure function of who is
 * waiting and who was already accepted there.
 *
 * Several people can scan one code: a family at a table, a room at a meetup.
 * Every knock lands under the code as its own row, each with its fingerprint
 * and its own "Przyjmij", and the code stays on screen while ANYBODY is
 * waiting -- the next person may be scanning right now. Only when the queue is
 * empty does the code give way to the result, which then names everybody
 * accepted in this window, not only the last one. "Otwórz rozmowę" opens the
 * last one (the person most likely still standing there); the others are in
 * the contact list like any contact.
 *
 * Kept out of app.ts so it can be tested without a DOM.
 */

export interface InvQrPerson { name: string; pub: string }

export interface InvQrView {
  /** The code is on screen. */
  showCode: boolean
  /** The result replaces the code. */
  success: boolean
  /** Everybody accepted in this window, oldest first. */
  accepted: InvQrPerson[]
  /** Who "Otwórz rozmowę" opens: the most recently accepted. */
  openTarget: InvQrPerson | null
  /** Requests still waiting under the code, in arrival order. */
  waiting: number
}

export function invQrView(waiting: number, accepted: InvQrPerson[], showCodeAgain: boolean): InvQrView {
  const success = accepted.length > 0 && waiting === 0 && !showCodeAgain
  return {
    showCode: !success,
    success,
    accepted: accepted.slice(),
    openTarget: accepted.length ? accepted[accepted.length - 1] : null,
    waiting,
  }
}
