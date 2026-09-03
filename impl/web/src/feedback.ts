/**
 * The 💬 Feedback form — a bug, an idea, a question, in one step.
 *
 * It exists for the demo-day tester who has just seen something odd and has
 * about ten seconds of goodwill to spend on telling us. So: one text box, four
 * chips, an optional way to reach them back, and Send. No account, no sign-in,
 * works before there is a profile (the HEM question on the login card opens
 * this same form).
 *
 * What makes it fit an app that avoids metadata everywhere else:
 *
 *  - **The document that will be sent is on this screen**, folded under "show
 *    exactly what I will send", not in a second confirm — the preview IS the
 *    consent, and a second dialog is what makes people close the form.
 *  - **Nothing about the identity, keys, contacts or conversations** is in it,
 *    and nothing here can reach them: this module never sees the session.
 *  - **The technical part is one checkbox** (on by default: a bug report
 *    without the version and the webview is a guess). Off, the record still
 *    carries the version and the shell — the two facts without which a report
 *    cannot be acted on at all — and nothing else.
 *  - **The server learns the sender's IP**, like any HTTP request; the form
 *    says so in the same words the link dialog uses. It is not stored
 *    (infra/feedback), but honesty is about what is SEEN.
 *  - **Offline does not lose the report.** A failed send keeps the form open
 *    and offers a copy to the clipboard; nothing is retried behind the user.
 *
 * The record shape is `infra/feedback/feedback.mjs`'s and is validated there;
 * this side keeps to it, and anything extra would be dropped anyway.
 */
import { t as tr, getLocale } from './i18n.ts'
import { isDesktopShell, isMobileShell, updateKind, type UpdateKind } from './desktop.ts'

export type FbKind = 'bug' | 'idea' | 'question' | 'hem'
const KINDS: FbKind[] = ['bug', 'idea', 'question', 'hem']

export interface FeedbackDeps {
  version: string
  commit: string
  /** Where the record goes — `https://onchato.com/feedback` in every real build. */
  endpoint: string
  /** The Settings › Diagnostics report, or `null` while the probe is still running. */
  diagnostics: () => string | null
  toast: (msg: string) => void
}

interface FbRecord {
  kind: FbKind
  text: string
  contact?: string
  lang: string
  app: { version: string; commit: string; shell: string; update?: UpdateKind; ua?: string; screen?: string }
  diag?: string
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

let deps: FeedbackDeps | null = null
let kind: FbKind = 'bug'
let isOpen = false
// `updateKind` asks the host; asked once per open so the preview never waits.
let update: UpdateKind | undefined

const PLACEHOLDER: Record<FbKind, string> = {
  bug: 'Co się stało / co byś zmienił(a)?',
  idea: 'Co się stało / co byś zmienił(a)?',
  question: 'Co się stało / co byś zmienił(a)?',
  hem: 'O co chcesz zapytać? Do czego chcesz używać HEM?',
}

export function initFeedback(d: FeedbackDeps) {
  deps = d
  for (const b of $('fb-kinds').querySelectorAll<HTMLButtonElement>('.fb-kind')) {
    b.addEventListener('click', () => setKind(b.dataset.kind as FbKind))
  }
  $('fb-text').addEventListener('input', refreshPreview)
  $('fb-contact').addEventListener('input', refreshPreview)
  $('fb-diag').addEventListener('change', refreshPreview)
  $('fb-peek').addEventListener('click', () => {
    const pre = $('fb-pre')
    pre.hidden = !pre.hidden
    $('fb-peek').textContent = tr(pre.hidden ? 'Pokaż, co dokładnie wyślę' : 'Ukryj')
    refreshPreview()
  })
  $('fb-send').addEventListener('click', () => void send())
  $('fb-copy').addEventListener('click', () => void copy())
  $('fb-cancel').addEventListener('click', close)
  // Shared backdrop and Escape, gated on this modal being the open one.
  $('scrim').addEventListener('click', () => { if (isOpen) close() })
  document.addEventListener('keydown', (e) => {
    if (!isOpen) return
    if (e.key === 'Escape') close()
    // Enter is a new line in a text box; Ctrl/⌘+Enter sends, like the composer.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send()
  })
}

/** Open the form on a kind — `hem` from the two "ask about HEM" links. */
export function openFeedback(k: FbKind = 'bug') {
  if (!deps) return
  setKind(k)
  setMsg('')
  $('fb-copy').hidden = true
  $<HTMLButtonElement>('fb-send').disabled = false
  $('fb-send').textContent = tr('Wyślij')
  const pop = document.getElementById('members-pop'); if (pop) pop.hidden = true
  $('scrim').classList.add('open'); $('fb-modal').classList.add('open')
  isOpen = true
  update = undefined
  void updateKind().then((u) => { update = u; refreshPreview() })
  refreshPreview()
  $('fb-text').focus()
}

function close() {
  $('scrim').classList.remove('open'); $('fb-modal').classList.remove('open')
  isOpen = false
}

function setKind(k: FbKind) {
  kind = KINDS.includes(k) ? k : 'bug'
  for (const b of $('fb-kinds').querySelectorAll<HTMLButtonElement>('.fb-kind')) {
    b.classList.toggle('on', b.dataset.kind === kind)
    b.setAttribute('aria-checked', String(b.dataset.kind === kind))
  }
  $<HTMLTextAreaElement>('fb-text').placeholder = tr(PLACEHOLDER[kind])
  refreshPreview()
}

function setMsg(text: string) {
  const el = $('fb-msg')
  el.textContent = text
  el.className = text ? 'msg err' : 'msg'
}

/** The document exactly as it will go — built from the form, never cached. */
function record(): FbRecord {
  const d = deps!
  const withDiag = $<HTMLInputElement>('fb-diag').checked
  const shell = isMobileShell() ? 'mobile' : isDesktopShell() ? 'desktop' : 'web'
  const rec: FbRecord = {
    kind,
    text: $<HTMLTextAreaElement>('fb-text').value.trim(),
    lang: getLocale(),
    app: { version: d.version, commit: d.commit, shell },
  }
  const contact = $<HTMLInputElement>('fb-contact').value.trim()
  if (contact) rec.contact = contact
  if (withDiag) {
    if (update) rec.app.update = update
    rec.app.ua = navigator.userAgent
    rec.app.screen = `${window.innerWidth}x${window.innerHeight}`
    const diag = d.diagnostics()
    if (diag) rec.diag = diag
  }
  return rec
}

function refreshPreview() {
  const pre = $('fb-pre')
  if (pre.hidden || !deps) return
  pre.textContent = JSON.stringify(record(), null, 1)
}

async function send() {
  if (!deps) return
  const rec = record()
  if (!rec.text) { setMsg(tr('Napisz choć zdanie.')); $('fb-text').focus(); return }
  const btn = $<HTMLButtonElement>('fb-send')
  btn.disabled = true; btn.textContent = tr('Wysyłam…')
  setMsg('')
  // A bounded wait: a phone with one bar must not hold the form hostage. The
  // copy button is the way out, and it appears on any failure.
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 12_000)
  try {
    const r = await fetch(deps.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rec),
      signal: ctl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (r.status === 429) { setMsg(tr('Za dużo zgłoszeń naraz — spróbuj za chwilę.')); return }
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    close()
    $<HTMLTextAreaElement>('fb-text').value = ''
    $<HTMLInputElement>('fb-contact').value = ''
    deps.toast(tr('Dziękujemy — zgłoszenie wysłane ✓'))
  } catch {
    setMsg(tr('Nie udało się wysłać — sieć? Skopiuj zgłoszenie i prześlij je nam inną drogą.'))
    $('fb-copy').hidden = false
  } finally {
    clearTimeout(timer)
    btn.disabled = false; btn.textContent = tr('Wyślij')
  }
}

async function copy() {
  if (!deps) return
  const text = JSON.stringify(record(), null, 1)
  try { await navigator.clipboard.writeText(text) }
  catch {
    // WebKitGTK without a clipboard permission: the old textarea trick.
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy') } catch {} ta.remove()
  }
  deps.toast(tr('Zgłoszenie skopiowane'))
}
