/**
 * app.ts — Encedo Chat web GUI (mockup skin). Login (HEM) → dashboard.
 *
 * Identity in the HEM (hem-sdk-js). Rendezvous/messages via the SAME engine as
 * the CLI (../../lib, WebCrypto). Browser libp2p peer dials the onchato relay.
 * Message crypto is INTERIM (lib/session.ts) — EH-2 replaces it. Content rides
 * GossipSub (interim); the §13 relay-blind data plane is pending the libp2p v3
 * ecosystem (gossipsub not yet migrated). Timestamps shown in UTC.
 *
 * Unbacked mockup elements (Groups/Network tabs, P1–P3 profiles, direct/relay
 * modes) are kept as visual placeholders until the engine backs them.
 */

import { HEM } from '../../../hem-sdk-js/hem-sdk.js'
import { hemIdentityFrom, browserSoftwareIdentity, startSession, hemContactBook, localContactBook, mergedContactBook, localOnlyManager, hemGkBackend, pubKeyReader, type Conversation, type ClientSession, type Identity, type ContactManager, type Contact } from '../../lib/core.ts'
import { seal, unseal, reseal, isSealedProfile, BadPassword } from '../../lib/profile.ts'
import { decodeInvite, inviteLink, type Invite } from '../../lib/invite.ts'
import type { GkBackend } from '../../lib/group.ts'
// `t` is taken: this file uses it for text, topics, timers and DOM nodes, and a
// local shadowing the translator fails at runtime with "t is not a function" —
// which is exactly how it failed once. `tr` cannot collide.
import { t as tr, setLocale, getLocale, applyDom } from './i18n.ts'
import { probeCapabilities, formatReport } from '../../lib/capabilities.ts'
import { splitByLinks } from '../../lib/linkify.ts'
import { newFileKey, encryptBytes, decryptBytes, MAX_FILE } from '../../lib/filecrypto.ts'
import { putBlob, getBlob } from '../../net/ipfs.ts'
import { parseNodeList } from '../../lib/nodelist.ts'
import type { FileEnv } from '../../lib/envelope.ts'
import { nowMs, utcHHMM } from '../../lib/time.ts'
import { nextRotationAfter } from '../../lib/presence.ts'
import { generateX25519, x25519FromPriv } from '../../lib/x25519.ts'
import { unb64, b64, randomBytes } from '../../lib/wc.ts'
import {
  kidOf, SELF_PREFIX, buildSelfDescr, parseSelfDescr, selfLabel, byteLen, sliceBytes, unhex,
  SELF_NAME_MAX, PEER_NAME_MAX,
} from '../../lib/descr.ts'
import { enableProtoLog } from '../../lib/protolog.ts'
import { cachePubKeys, traceHem } from '../../lib/hemwrap.ts'
import { sealCache, openCache } from '../../lib/gcache.ts'
import type { GroupRoom } from '../../lib/grouproom.ts'
import type { GroupSkdEnv } from '../../lib/envelope.ts'
// The published relay list, compiled in — see DEFAULT_NODES below for why.
import published from '../../../infra/nodes.json'

// ---- network nodes (relays): an editable list, chosen at login -------------
// The user keeps a list of relay multiaddrs and ticks which to use this session;
// the first enabled one is the relay we dial. Full multiaddrs so a node with its
// own PeerId (not derived from a pass) can be pasted in.
//
// The defaults are COMPILED FROM the published list rather than written out
// again here. They had drifted: the file behind the CID carried bs1 and bs2
// while a fresh client shipped with bs1 alone, so everybody started on one node
// and only got the second by pressing "load the official list". Two copies of a
// list that must agree is a bug with a delay on it; importing the file removes
// the second copy. `enabled` is the client's own idea and is not in the file.

interface NodeEntry { name: string; addr: string; enabled: boolean }
const DEFAULT_NODES: NodeEntry[] = (published.nodes as Array<{ name: string; addr: string }>)
  .map((n) => ({ name: n.name, addr: n.addr, enabled: true }))
/** The floor under every dial: the first published node. */
const RELAY = DEFAULT_NODES[0].addr
function loadNodes(): NodeEntry[] {
  try { const v = JSON.parse(localStorage.getItem('ec-nodes') || 'null'); if (Array.isArray(v) && v.length) return v } catch {}
  return DEFAULT_NODES.map((n) => ({ ...n }))
}
function saveNodes(list: NodeEntry[]) { try { localStorage.setItem('ec-nodes', JSON.stringify(list)) } catch {} }
/** The relay to dial this session — the first enabled node, or bs1 as a floor. */
function chosenRelay(): string { return loadNodes().find((n) => n.enabled)?.addr || RELAY }
/**
 * All enabled nodes in list order — the failover candidates (3b). The first is
 * the preferred relay; if it is down the session falls through to the next.
 * Because the relays are meshed this does not split users. Never empty: bs1 is
 * the floor so a login with every node unchecked still has something to dial.
 */
function chosenRelays(): string[] {
  const on = loadNodes().filter((n) => n.enabled).map((n) => n.addr)
  return on.length ? on : [RELAY]
}
/**
 * Transport. libp2p is the default; `?mqtt=1` switches to the broker (fall-back
 * transport — README has the trade-offs), `?mqtt=wss://host/mqtt` points it
 * somewhere else. Everything above the transport is identical either way.
 */
const MQTT_PARAM = new URLSearchParams(location.search).get('mqtt')
const USE_MQTT = MQTT_PARAM !== null && MQTT_PARAM !== '0'
// The broker lives on the SAME host as the relay (bs1.onchato.com), not on the
// site the app is served from — deriving it from `location.hostname` pointed it
// at onchato.com, where there is no broker. Take the host straight from RELAY so
// the two can never drift.
const RELAY_HOST = RELAY.match(/\/dns4\/([^/]+)/)?.[1] ?? location.hostname
const BROKER = MQTT_PARAM && MQTT_PARAM.startsWith('ws') ? MQTT_PARAM : `wss://${RELAY_HOST}/mqtt`
// `?rot=<hour>` forces every pair's topic rotation to that UTC time-of-day, so
// two test tabs can share a known rollover instant instead of waiting for each
// pair's real offset (§5.4). Absent or `0` = the real per-pair offset algorithm
// (the default). Accepts an hour (`14`), a decimal hour (`14.5`), or `HH:MM`.
function parseRotSec(v: string | null): number | undefined {
  if (v == null || v === '' || v === '0') return undefined
  const hm = v.match(/^(\d{1,2}):(\d{2})$/)
  const sec = hm ? +hm[1] * 3600 + +hm[2] * 60 : Math.round(parseFloat(v) * 3600)
  return Number.isFinite(sec) && sec >= 0 && sec < 86400 ? sec : undefined
}
const FORCED_ROTATION_SEC = parseRotSec(new URLSearchParams(location.search).get('rot'))
// `?webrtc=0` keeps content on GossipSub — the direct DataChannel is never
// negotiated. Not a preference: a live Direct link carries the conversation
// whatever the relay is doing, so it MASKS every relay-path test. Validating 3b
// failover meant blocking `createOffer` from the browser console, which does not
// survive a reload; the same applies to diagnosing a user ("turn Direct off and
// see if it still works"). Absent or any other value = the default, Direct on.
const WEBRTC_OFF = new URLSearchParams(location.search).get('webrtc') === '0'

/**
 * Where content travels: straight to the peer, or through the node.
 *
 * This is the one row of the threat-model matrix the client actually decides at
 * runtime, which is why it replaced the three profile names that promised a
 * policy nothing enforced. `relay` is the meaningful half: the direct plane is
 * never negotiated, so the peer never learns this device's address. It also
 * works one-sidedly — a channel needs both ends, so one refusal is enough.
 *
 * Not offered: a direct-ONLY mode. Refusing the relay is not a flag but a
 * behaviour — a pair behind hard NAT would have nowhere to send, and the honest
 * version of that needs a visible "not sent" state rather than a queue that
 * quietly fills. Worth building; not worth pretending it is a third radio.
 */
const TRANSPORT_KEY = 'ec-transport'
type TransportMode = 'auto' | 'relay'
const transportMode = (): TransportMode =>
  (localStorage.getItem(TRANSPORT_KEY) === 'relay' ? 'relay' : 'auto')
/** The direct plane is enabled unless the user or `?webrtc=0` says otherwise. */
const wantsDirect = () => !WEBRTC_OFF && transportMode() === 'auto'
const $ = (id: string) => document.getElementById(id) as HTMLElement
const val = (id: string) => ($(id) as HTMLInputElement).value.trim()
const dec = new TextDecoder()

let mode: 'login' | 'register' = 'login'
let session: { id: Identity; handle: string; pub: string; kid?: string; idKey: string; book: ContactManager } | null = null
/**
 * ONE transport for the whole app, opened at login: every room runs on it.
 * Building a node per conversation was invisible while only one chat was ever
 * open, and would have meant a WebSocket per contact the moment several are.
 */
let client: ClientSession | null = null
/** Resolves once the transport is up; rooms wait on it instead of on a null. */
let clientReady: Promise<ClientSession> | null = null

let linkState: 'online' | 'reconnecting' | 'offline' = 'online'

// ---- rooms: many open conversations, one shown at a time -------------------
// A message must not yank the view. An incoming conversation opens in the
// BACKGROUND — the handshake completes and the message is received — and only
// lights an unread dot on the contact list (Slack/Signal-style); the user
// switches when they want. Each room keeps a replayable LOG of its events, so
// switching to it just clears the transcript and replays that log through the
// same render functions: nothing is lost and no room is ever torn down to show
// another. The module-level render state (msgEls/stateEls/security DOM, the
// scroll counter) always describes whichever room is on screen.
type Ev =
  | { t: 'msg'; kind: 'me' | 'peer'; text: string; ts: number; id?: string; ooo?: boolean; who?: string; sent?: boolean }
  | { t: 'react'; id: string; emoji: string }
  | { t: 'delivery'; id: string; state: 'ok' | 'lost' | 'late'; ms?: number }
  | { t: 'sys'; text: string }
  // A file is its own event, not a message with a marker: it carries what is
  // needed to fetch and decrypt, and its bubble has an action rather than text.
  | { t: 'file'; kind: 'me' | 'peer'; who?: string; ts: number; file: FileEnv }
interface Room {
  contact: Contact
  conv: Conversation | null
  log: Ev[]
  unseen: number
  inRoom: boolean
  /** Header snapshots so a background room repaints correctly when shown. Two
   *  independent facts share the header — what the peer is doing, and whether WE
   *  have a transport at all (`linkState`, shared); a frozen laptop once looked
   *  exactly like a peer who left, so our own link wins when it is down. */
  security: Map<string, 'handshaking' | 'established' | 'failed'>
  transport: string
  peerLabel: string
  lastPresence: string | null
}
const rooms = new Map<string, Room>() // key = contact.pub
let activePub: string | null = null
let activeGid: string | null = null // a group is on screen instead of a 1:1 (see the groups module)
let wiping = false // wipeout in progress — block the unload flush from re-persisting groups
const activeRoom = (): Room | null => (activePub ? rooms.get(activePub) ?? null : null)
/** Am I actually LOOKING at this room? Being `activePub` is not enough — the
 *  mobile back-arrow leaves the room active but hides its pane (removes
 *  `.chat-open`). Without this the unread counter fired once, then messages for
 *  the still-active room rendered into the hidden pane instead of lighting the dot. */
const isViewing = (room: Room): boolean => room === activeRoom() && $('app').classList.contains('chat-open')
const LOG_CAP = 1000

function paintStatus() {
  const dot = $('peer-dot'), txt = $('peer-status')
  if (linkState !== 'online') {
    dot.className = 'dot bad'
    txt.textContent = linkState === 'reconnecting' ? tr('wznawiam połączenie…') : tr('brak połączenia z przekaźnikiem')
    return
  }
  if (activeGid) {
    // A group is on screen: its header is "N członków", not a 1:1 peer label. Without
    // this, every onLink/refresh repainted it as `activeRoom()?.peerLabel ?? 'łączę…'`
    // — activeRoom() is null for a group — so the group header flickered "łączę…".
    const gu = groupsUI.get(activeGid)
    dot.className = 'dot ok'
    txt.textContent = gu ? tr('{n} członków', { n: gu.members.length }) : ''
    return
  }
  const lp = activeRoom()?.lastPresence
  dot.className = 'dot ' + (lp === 'join' || lp === 'active' ? 'ok' : lp === 'away' || lp === 'quiet' ? 'away' : '')
  txt.textContent = activeRoom()?.peerLabel ?? tr('łączę…')
}
let rotTimer: any = null

// '' is a real third state, not a default: "no such profile — create it?" is a
// question, and dressing a question as an error teaches people to ignore red.
const setMsg = (id: string, text: string, kind: 'err' | 'ok' | '') => { const m = $(id); m.textContent = text; m.className = 'msg ' + kind }
const clr = (id: string) => { const m = $(id); m.textContent = ''; m.className = 'msg' }
const initials = (s: string) => (s || '?').slice(0, 2).toUpperCase()
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

async function fingerprint(pubB64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(pubB64), (c) => c.charCodeAt(0))
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 8)
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase()
}

// ---- HEM reachability ----
/**
 * A device that neither answers nor refuses is the case a bare `await` handles
 * worst: the button stays disabled and the user has nothing to press. Every probe
 * here is bounded, and running out of time is reported as itself rather than as
 * a failure of whatever came next.
 */
const HEM_VERSION_MS = 2_000    // the reachability probe: is a device there at all
const HEM_RETRY_MS = 3_000      // how long to wait after a probe that found nothing
const HEM_STATUS_MS = 5_000     // the sign-in gate: is it in a state to be talked to

/**
 * Two switches, and `keys` IMPLIES `debug` rather than depending on it.
 *
 *   `?debug=1`   what is being asked of the device, and every protocol
 *                derivation and state transition — but values elided.
 *   `?keys=1`    all of the above, plus the secret bytes themselves.
 *
 * They are separate because a debug console gets pasted into a bug report, and a
 * transcript plus a root key is the conversation itself. They are not
 * independent because a switch that only widens lines nobody is printing would
 * do nothing at all — asking for the strongest output has to give you output.
 *
 * Compile-time gate (webpack DefinePlugin, EC_ALLOW_KEYS): built with 0 the
 * second is `false && …`, the minifier drops the branch, and no URL can print a
 * key from that bundle.
 */
declare const __EC_ALLOW_KEYS__: boolean
declare const __EC_VERSION__: string
declare const __EC_COMMIT__: string

/**
 * Which build is on screen — `v0.1.1 (a1b2c3d4)`, in the login card and at the
 * foot of Settings.
 *
 * The version alone does not identify a build: several carry one version, and
 * the question a bug report has to answer first is which code produced the
 * behaviour. The hash is stamped in at build time by webpack, with a trailing
 * `+` when the tree was dirty — a build from uncommitted work is not the commit
 * it names, and one character says so.
 */
const BUILD_ID = `v${__EC_VERSION__} (${__EC_COMMIT__})`
for (const id of ['build-id-login', 'build-id-settings']) {
  const el = document.getElementById(id)
  if (el) { el.textContent = BUILD_ID; el.title = tr('Wersja i commit tej wersji aplikacji') }
}
const SHOW_KEYS = __EC_ALLOW_KEYS__ && new URLSearchParams(location.search).has('keys')
const HEM_TRACE = new URLSearchParams(location.search).has('debug') || SHOW_KEYS
if (HEM_TRACE) {
  enableProtoLog({ events: true, keys: SHOW_KEYS, sink: (line) => console.log(`%c${line}`, 'color:#2a8c6a') })
}

/**
 * Wrap a HEM for this session: remember public keys, and narrate the calls when
 * debugging. `traceHem` stays OUTERMOST so every call is announced, including
 * the ones the cache answers — and both layers hand out methods bound to the
 * real object, without which the SDK's `#private` fields are unreachable
 * (see lib/hemwrap.ts).
 */
const wrapHem = (hem: any) => {
  const cached = cachePubKeys(hem)
  if (!HEM_TRACE) return cached
  return traceHem(cached, (msg, kind) => console.log(
    `%c[HEM] %c${msg}`,
    'color:#b58900;font-weight:600',
    kind === 'error' ? 'color:#b23c26' : kind === 'cached' ? 'color:#7a8b7a' : kind === 'slow' ? 'color:#a08a5b' : 'color:#8a6d3b',
  ))
}

/**
 * Two endpoints, two questions, asked in that order.
 *
 * `getVersion` answers "is a device there at all". It is unauthenticated and
 * cheap, so it is what the badge watches: an answer turns it green and unlocks
 * Sign in, and nothing else is attempted until it does.
 *
 * `getStatus` answers "is it in a state to be talked to", and is read once the
 * user commits — after the badge is green, before anything is authorised.
 * Splitting them this way keeps the thing that runs on a timer as small as it
 * can be, and leaves the heavier question for the moment somebody actually asks
 * for a session.
 *
 * `timeoutMs` genuinely CANCELS the request rather than stopping the wait for
 * it, which is the whole point of the budget: racing a promise against a timer
 * leaves the socket open, and a screen polling an absent device that way piles
 * up one connection per attempt until the device appears and they all land at
 * once. That was live here, and the fix belongs in the transport — so it is now
 * in the SDK and this file no longer issues its own requests.
 */
const probeVersion = (url: string, ms = HEM_VERSION_MS) => wrapHem(new HEM(url)).getVersion({ timeoutMs: ms })
const probeStatus = (url: string, ms = HEM_STATUS_MS) => wrapHem(new HEM(url)).getStatus({ timeoutMs: ms })

/** Ran out of time, as opposed to answering with a refusal or not being there. */
const isTimeout = (e: any) => e?.code === 'timeout' || e?.code === 'aborted'

/**
 * Sign-in stays disabled until the device has answered `/status`.
 *
 * The green dot and the button now say the same thing, which is the point: a
 * form that lets you type a password and press a button, and only then reports
 * that the address was never reachable, spends the user's attention on the wrong
 * step. A software identity is unaffected — it needs no device.
 */
function setHemReady(ready: boolean) {
  const go = $('go') as HTMLButtonElement
  go.disabled = !ready
  go.title = ready ? '' : tr('Najpierw musi odpowiedzieć HEM pod podanym adresem')
}

/**
 * Probe the device and paint the result.
 *
 * `quiet` is what makes this usable on a timer: a poll must not blank the dot
 * and the hint on every tick, or a healthy device flickers every five seconds
 * and an unreachable one keeps erasing the explanation of why. So a background
 * check leaves the last answer standing until it has a new one.
 *
 * `ms` differs by caller on purpose. A tick gets 2 s because `/status` is fast
 * and a probe that outlived its own interval would pile up; a deliberate sign-in
 * gets 5 s, because a person who just pressed a button can afford to wait
 * longer than a timer can.
 */
let probing = false
async function refreshStatus(opts: { quiet?: boolean } = {}) {
  const url = val('hsm'), dot = $('status-dot'), hint = $('status-hint')
  // A background check leaves the last answer standing until it has a new one:
  // blanking these on a timer makes a healthy device flicker and keeps erasing
  // the explanation of why an unreachable one is unreachable.
  if (!opts.quiet) { dot.className = 'dot'; hint.textContent = ''; setHemReady(false) }
  if (!url) { setHemReady(false); return false }
  if (probing) return false
  probing = true
  try {
    const v: any = await probeVersion(url)
    dot.className = 'dot ok'
    setHemReady(true)
    hint.textContent = `HEM ok${v?.fwv ? ` — fw ${v.fwv}` : ''}`
    return true
  } catch (e: any) {
    dot.className = 'dot bad'
    setHemReady(false)
    hint.textContent = isTimeout(e) ? tr('HEM nie odpowiada (timeout)') : tr('HEM nieosiągalny (adres / CORS)')
    return false
  } finally { probing = false }
}

/**
 * Keep asking while the login screen is up, and stop the moment a device answers.
 *
 * Nothing tells a page that a HEM has been plugged in, so the page has to keep
 * asking — but each attempt is CANCELLED at its budget and the next is scheduled
 * only once the previous has settled. A fixed interval would start a new attempt
 * beside one still running; this cannot, so an absent device costs exactly one
 * open request at a time and a present one is noticed within a cycle.
 */
let hemPollT: any = null
function stopHemPoll() { clearTimeout(hemPollT); hemPollT = null }
function startHemPoll() {
  stopHemPoll()
  const tick = async () => {
    if ($('login').hidden) return stopHemPoll() // signed in — nothing to watch
    const ok = await refreshStatus({ quiet: true })
    if ($('login').hidden) return stopHemPoll()
    // Green ends the watch: the badge is what unlocks Sign in, and from here the
    // next word on this device comes from the user pressing it.
    if (!ok) hemPollT = setTimeout(tick, HEM_RETRY_MS)
  }
  void tick()
}
$('hsm').addEventListener('blur', () => startHemPoll())
// Typing a new address re-probes shortly after the typing stops. Without this the
// button could only be unlocked by leaving the field, and the field arrives
// pre-filled — so the first probe also runs now, or a default address would sit
// there with the button dead and nothing to click.
let hsmProbeT: any
$('hsm').addEventListener('input', () => { clearTimeout(hsmProbeT); hsmProbeT = setTimeout(startHemPoll, 600) })
startHemPoll()

// ---- login / register ----
$('toggle').addEventListener('click', () => {
  mode = mode === 'login' ? 'register' : 'login'
  const reg = mode === 'register'
  $('reg-handle-wrap').hidden = !reg
  $('go').textContent = reg ? 'Zarejestruj' : 'Zaloguj'
  $('toggle-pre').textContent = reg ? tr('Masz już konto?') : 'Nie masz konta?'
  $('toggle').textContent = reg ? 'Zaloguj' : tr('Zarejestruj tożsamość')
  clr('msg')
})

/**
 * Sign in as one identity on an authorised HEM. Everything per-identity hangs
 * off its KID from here on: the contact book is scoped to it, and so is every
 * local key (`identityKey`).
 */
async function signInAs(hem: any, id: { kid: string; handle: string }) {
  // The same broad read the contact book uses; the narrow `use:<kid>` token is
  // still taken later, by the ECDH that genuinely needs it.
  const pubkey = await pubKeyReader(hem)(id.kid)
  await enterApp(
    hemIdentityFrom(hem, id.kid, id.handle, pubkey),
    mergedContactBook(hemContactBook(hem, id.kid), makeLocalBook(await identityKey(pubkey, id.kid), localStorage)),
    'HEM', id.kid, hemGkBackend(hem, id.kid),
  )
}

/**
 * Choose between the identities on this HEM.
 *
 * Shown only when there are several — one identity signs straight in, because a
 * confirmation step with a single option is a click that asks nothing.
 *
 * Every row carries the first four bytes of the KID beside the name, and that is
 * not decoration: handles may repeat (nothing forbids two identities called
 * "Alice", and the KID is what tells them apart), so without it the two rows are
 * indistinguishable and picking the wrong one is silent — same contacts missing,
 * same messages not arriving, no error anywhere.
 */
function showIdentityPicker(ids: Array<{ kid: string; handle: string }>, onPick: (id: { kid: string; handle: string }) => void) {
  const box = $('identity-list')
  box.innerHTML = ''
  for (const id of ids) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'id-opt'
    const name = document.createElement('span')
    name.className = 'id-name'
    name.textContent = id.handle // never innerHTML: this string comes off the device
    const kid = document.createElement('span')
    kid.className = 'id-kid'
    kid.textContent = id.kid.slice(0, 8)
    row.append(name, kid)
    row.addEventListener('click', () => { close(); onPick(id) })
    box.appendChild(row)
  }

  const cancel = $('identity-cancel')
  const close = () => {
    $('scrim').classList.remove('open'); $('identity-modal').classList.remove('open')
    cancel.removeEventListener('click', onCancel)
    $('scrim').removeEventListener('click', onCancel)
    document.removeEventListener('keydown', onKey)
  }
  // Cancel RELOADS rather than merely closing. By this point we hold an
  // authorised token and the key derived from the password; a user who backs out
  // means "not this identity" or "not now", and a reload is the only ending that
  // leaves none of that behind. Same reasoning as the sign-out button.
  const onCancel = () => { close(); location.reload() }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
  cancel.addEventListener('click', onCancel)
  $('scrim').addEventListener('click', onCancel)
  document.addEventListener('keydown', onKey)
  $('scrim').classList.add('open'); $('identity-modal').classList.add('open')
}

$('go').addEventListener('click', async () => {
  const url = val('hsm'), pass = val('pass')
  if (!url || !pass) { setMsg('msg', tr('Podaj adres HEM i hasło.'), 'err'); return }
  const btn = $('go') as HTMLButtonElement
  btn.disabled = true; btn.textContent = tr('…'); clr('msg')
  try {
    // The gate: nothing is authorised until the device says it is in a state to
    // be talked to. Doing this first also means a wrong address or a sleeping
    // device fails HERE, with a message about reaching the HEM — rather than
    // three calls later as an authorisation error, which is what it looked like.
    try {
      await probeStatus(url)
      $('status-dot').className = 'dot ok'
    } catch (e: any) {
      $('status-dot').className = 'dot bad'
      const timedOut = isTimeout(e)
      await ask(
        timedOut ? tr('HEM nie odpowiedział') : tr('Nie mogę połączyć się z HEM'),
        timedOut
          ? tr('Urządzenie nie odpowiedziało w ciągu 5 sekund. Sprawdź, czy jest podłączone i odblokowane, i spróbuj ponownie.')
          : tr('Sprawdź adres HEM i czy urządzenie jest osiągalne z tej przeglądarki.') + ' ' + (e?.message ?? ''),
        tr('Zamknij'), undefined, undefined, null,
      )
      return // the button is re-enabled in `finally`, so the operation can simply be repeated
    }
    // Wrapped once here, so every later call — core's contact book, the group
    // backend, every ECDH — narrates itself without any of them knowing.
    const hem = wrapHem(new HEM(url)); await hem.hemCheckin()
    if (mode === 'register') {
      const handle = val('handle'); if (!handle) { setMsg('msg', tr('Podaj handle.'), 'err'); return }
      const gen = await hem.authorizePassword(pass, 'keymgmt:gen')
      // b64 of the UTF-8 bytes, not btoa: btoa throws on any character above
      // U+00FF, so registering as "Zażółć" used to fail with a DOM exception.
      const { kid } = await hem.createKeyPair(gen, selfLabel(handle), 'CURVE25519', b64(new TextEncoder().encode(buildSelfDescr(handle))))
      await signInAs(hem, { kid, handle })
    } else {
      const listTok = await hem.authorizePassword(pass, 'keymgmt:list')
      const keys: any[] = await hem.searchKeys(listTok, SELF_PREFIX)
      if (!keys.length) { setMsg('msg', tr('Brak tożsamości czatu na tym HEM — zarejestruj.'), 'err'); return }
      // Alphabetical, so the list does not reorder itself as identities are
      // added — the device returns them in whatever order it stores them.
      const ids = keys
        .map((k) => ({ kid: String(k.kid).toLowerCase(), handle: parseSelfDescr(k.description)?.handle || '(?)' }))
        .sort((a, b) => a.handle.localeCompare(b.handle, undefined, { sensitivity: 'base' }))
      if (ids.length === 1) { await signInAs(hem, ids[0]); return }
      showIdentityPicker(ids, (chosen) => { void signInAs(hem, chosen) })
    }
  } catch (e: any) { setMsg('msg', tr('Błąd: ') + (e?.message ?? e), 'err') }
  finally {
    const b = $('go') as HTMLButtonElement
    b.textContent = mode === 'register' ? 'Zarejestruj' : 'Zaloguj'
    // Re-probe rather than simply re-enabling: an attempt that failed because the
    // device went away must not leave a live-looking button behind it.
    startHemPoll() // re-probe: an attempt that failed because the device went away
                   // must not leave a live-looking button behind it
  }
})
$('pass').addEventListener('keydown', (e: any) => { if (e.key === 'Enter') ($('go') as HTMLButtonElement).click() })
// The two places a name becomes the tail of a DESCR: the handle at registration
// and a contact's name. Both count against a real budget, so both show it.
attachByteBudget($('handle') as HTMLInputElement, SELF_NAME_MAX, $('handle-bytes'))
attachByteBudget($('add-name') as HTMLInputElement, PEER_NAME_MAX, $('add-name-bytes'))

// dev / no-HEM: a persistent software X25519 identity (localStorage — one per
// browser). For two peers, open two DIFFERENT browsers (or profiles).
/**
 * One persistent software profile PER name: typing "Lab1" loads (or first
 * creates) the Lab1 keypair; "Kab88" is its own identity, not whatever was made
 * first. Several can coexist — which is how group testing across tabs works.
 * The keystore lives in localStorage under `ec-soft-id-<name>`, sealed with the
 * password (see `lib/profile.ts`).
 *
 * The three outcomes the screen has to tell apart come out of the storage and
 * the AEAD, with nothing compared and no password stored anywhere:
 * absent key → offer to create · opens → in · refuses → wrong password.
 */
const softKey = (name: string) => 'ec-soft-id-' + name
/**
 * The last profile signed in here, so it comes back prefilled.
 *
 * The NAME only. The password is the browser's password manager to remember or
 * not — its owner's choice, made in the browser's own UI, and revocable there.
 * Storing it ourselves would put the key that seals an identity next to the
 * identity it seals, which is the same as not having sealed it.
 *
 * This does reveal one name to anyone who opens the modal on this device. That
 * is the trade for not retyping it; it is why the full LIST stays behind a
 * login, where one name is the most that leaks rather than all of them.
 */
const LAST_PROFILE = 'ec-last-profile'
/** Set once the name has been shown not to exist, so the next click creates it
 *  rather than asking again. Cleared whenever the name changes. */
let softCreating = ''

function openSoftModal() {
  $('scrim').classList.add('open'); $('soft-modal').classList.add('open')
  clr('soft-msg'); softCreating = ''
  const last = localStorage.getItem(LAST_PROFILE) ?? ''
  ;($('soft-name') as HTMLInputElement).value = last; ($('soft-pass') as HTMLInputElement).value = ''
  softMode(false)
  // Focus lands where there is still something to type — on the password when
  // the name came back by itself, which is the common case after the first run.
  $(last ? 'soft-pass' : 'soft-name').focus()
}

/**
 * Sign-in or creation. The two look different on purpose: the same window with
 * only a changed button label read as "nothing happened, press it again", which
 * is what it looked like to the first person who used it.
 *
 * Creation asks for the password twice. Not ceremony — a typo here does not
 * cost a retry, it costs the identity: nothing is stored to compare against, so
 * there is no way to tell a wrong password from a mistyped one, ever.
 */
function softMode(creating: boolean) {
  softCreating = creating ? val('soft-name') : ''
  $('soft-pass2-wrap').hidden = !creating
  ;($('soft-pass2') as HTMLInputElement).value = ''
  $('soft-sub').textContent = creating
    ? tr('Nowa tożsamość na tym urządzeniu. Hasła nie da się odzyskać ani zmienić bez niego — nie ma czego z nim porównać.')
    : tr('Tożsamość trzymana w tej przeglądarce i zaszyfrowana hasłem. Bez HEM — do wypróbowania komunikatora.')
  ;($('soft-go') as HTMLButtonElement).textContent = creating ? tr('Utwórz profil') : tr('Dalej')
}

const closeSoftModal = () => { $('scrim').classList.remove('open'); $('soft-modal').classList.remove('open') }
$('go-soft').addEventListener('click', openSoftModal)
$('soft-cancel').addEventListener('click', closeSoftModal)
// Typing a different name drops creation mode — otherwise the next press would
// create a profile under a name nobody was asked about.
;($('soft-name') as HTMLInputElement).addEventListener('input', () => {
  if (softCreating && softCreating !== val('soft-name')) { clr('soft-msg'); softMode(false) }
})

async function softLogin() {
  const name = val('soft-name')
  const pass = ($('soft-pass') as HTMLInputElement).value
  if (!name) { setMsg('soft-msg', tr('Podaj nazwę profilu.'), 'err'); return }
  if (!pass) { setMsg('soft-msg', tr('Podaj hasło.'), 'err'); return }

  const btn = $('soft-go') as HTMLButtonElement
  btn.disabled = true
  // A million PBKDF2 rounds is a second or two on a phone. Without a label that
  // pause is indistinguishable from a dead button, and the user's next move is
  // to press it again.
  btn.textContent = tr('Otwieram…')
  clr('soft-msg')
  try {
    const raw = localStorage.getItem(softKey(name))

    if (!raw && softCreating !== name) {
      // A name that does not exist: ASK, on a surface of its own, and do not
      // create. Creating silently would turn a typo in an existing profile's
      // name into a brand new identity — which presents as "my contacts are
      // gone" — and a confirmation inside the same window read as no response
      // at all, because only the button's label moved.
      const { ok } = await ask(
        tr('Nie ma profilu „{name}"', { name }),
        tr('Utworzyć na tym urządzeniu nową tożsamość o tej nazwie? Jeśli chciałeś wejść na istniejącą, sprawdź pisownię — to osobne tożsamości, nie jedna.'),
        tr('Utwórz'))
      // ask() drops the scrim when it closes, but the profile window is still
      // up behind it — without this it floats with no backdrop and the
      // click-outside-to-close it relies on stops working.
      $('scrim').classList.add('open')
      if (ok) { softMode(true); $('soft-pass2').focus() }
      return
    }

    let id: Identity
    if (!raw) {
      // Twice, and compared before anything is written: there is no verifier
      // stored anywhere, so a typo sealed into the profile is unrecoverable and
      // indistinguishable from a wrong password for ever after.
      if (pass !== ($('soft-pass2') as HTMLInputElement).value) {
        setMsg('soft-msg', tr('Hasła się różnią.'), 'err'); return
      }
      let generated = ''
      id = await browserSoftwareIdentity(name, () => null, (v) => { generated = v })
      localStorage.setItem(softKey(name), JSON.stringify(await seal(pass, generated)))
    } else {
      const blob = JSON.parse(raw)
      // A profile from before passwords existed. Not migrated by decision — the
      // ones in the wild are developer tests — but it must not read as a wrong
      // password, or someone types the right one repeatedly and never learns why.
      if (!isSealedProfile(blob)) { setMsg('soft-msg', tr('Profil w starym, niezaszyfrowanym formacie — usuń go przyciskiem Wipeout i załóż nowy.'), 'err'); return }
      const plain = await unseal(pass, blob)
      id = await browserSoftwareIdentity(name, () => plain, () => {})
    }
    closeSoftModal()
    activeSoftProfile = name
    localStorage.setItem(LAST_PROFILE, name)
    await enterApp(id, localOnlyManager(makeLocalBook(await identityKey(id.pub), localStorage)), 'Software')
  } catch (e: any) {
    if (e instanceof BadPassword) setMsg('soft-msg', tr('Złe hasło.'), 'err')
    else setMsg('soft-msg', tr('Błąd tożsamości software: ') + (e?.message ?? e), 'err')
    // Derived from the mode rather than from a captured label: the previous
    // version restored what the button said on entry, which undid the switch to
    // creation mode that had just been made three lines earlier.
  } finally { btn.disabled = false; btn.textContent = softCreating ? tr('Utwórz profil') : tr('Dalej') }
}
$('soft-go').addEventListener('click', () => void softLogin())
for (const f of ['soft-pass', 'soft-pass2']) {
  ;($(f) as HTMLInputElement).addEventListener('keydown', (e: any) => { if (e.key === 'Enter') void softLogin() })
}

// ---- the node editor: ONE implementation, used at login and after it -------
// It exists in two places (the login card and the Network tab) because both
// questions are real: which nodes to dial before a session, and which to dial
// while one is running. Two copies of this would drift, so the markup and the
// handlers are shared and only the message sink and the "what now" differ.
//
// Order is not cosmetic: `failoverDial` sweeps the list from the top, so row 1
// IS the primary and the rest are its fallbacks. Until the arrows existed the
// order was insertion order, i.e. nobody could choose their primary at all.
function nodeRowsHTML(list: NodeEntry[]): string {
  return list.map((n, i) =>
    `<label class="node-row"><input type="checkbox" data-i="${i}" ${n.enabled ? 'checked' : ''}>`
    + `<span class="n-name" title="${escapeHtml(n.addr)}">${escapeHtml(n.name)}${i === 0 ? ' <span class="n-first">' + tr('1. wybór') + '</span>' : ''}</span>`
    + `<span class="n-up${i === 0 ? ' off' : ''}" data-up="${i}" title="${tr('Wyżej (wyżej = wcześniej wybierany)')}">↑</span>`
    + `<span class="n-dn${i === list.length - 1 ? ' off' : ''}" data-dn="${i}" title="${tr('Niżej')}">↓</span>`
    + `<span class="n-x" data-rm="${i}" title="${tr('Usuń')}">×</span></label>`).join('')
}
/**
 * The published list of public relays, by CID.
 *
 * **Compiled in, never fetched.** A CID is a hash of the content, so this
 * constant is what makes the list authentic: a substituted file has a different
 * CID and does not load. Reading the address of the list from anywhere — a
 * config endpoint, a DNS record — would hand whoever controls that the choice
 * of which relays every client dials, which is the first hop of every
 * conversation. Publishing an updated list therefore means publishing a new CID
 * and shipping a build, and that is the right price.
 */
const OFFICIAL_NODES_CID = 'QmPqyS3E8NcSU6kNF9owmvLqemHiRYhDg2tdMQwB47heTJ'

/**
 * Replace the local list with the published one.
 *
 * Read through the app's own `/f` proxy rather than a public gateway: same
 * origin, so no CORS and no third party learning which CID this client asks
 * for. The whole file is validated before anything is written — a list applied
 * in part would leave the user dialling some published relays and some of their
 * own, with no way to tell which.
 */
async function loadOfficialNodes(btnId: string, warn: (t: string) => void, redraw: () => void, onChange: () => void) {
  const btn = $(btnId) as HTMLButtonElement
  btn.disabled = true; const label = btn.textContent; btn.textContent = tr('Pobieram…')
  try {
    const text = new TextDecoder().decode(await getBlob(OFFICIAL_NODES_CID))
    const nodes = parseNodeList(text)
    // Asked before applying: this REPLACES a list the user may have edited by
    // hand, and the button sits one tap from the one that adds a node.
    const { ok } = await ask(
      tr('Wczytać oficjalną listę?'),
      tr('Zastąpi Twoją listę {n} węzłami z publikacji. Twoje własne wpisy znikną.', { n: nodes.length }),
      tr('Zastąp'))
    if (!ok) return
    saveNodes(nodes.map((n, i) => ({ ...n, enabled: i === 0 })))
    redraw(); onChange()
    toast(tr('Wczytano {n} węzłów', { n: nodes.length }))
  } catch (e: any) {
    // Includes ExpiredError: the list is pinned, so a 404 means the publication
    // is gone rather than that it timed out, and saying "try again" would be a lie.
    warn(tr('Nie udało się wczytać listy: ') + (e?.message ?? e))
  } finally { btn.disabled = false; btn.textContent = label ?? tr('Wczytaj oficjalną listę węzłów') }
}

/**
 * Bind one editor. `warn` reports refusals, `onChange` is what the caller does
 * with a changed list (nothing at login — the list is read when the session
 * starts; a live `setRelays` in the Network tab). Returns its redraw.
 */
function bindNodeEditor(listId: string, addId: string, warn: (t: string) => void, onChange: () => void, officialId?: string) {
  const redraw = () => { $(listId).innerHTML = nodeRowsHTML(loadNodes()) }
  if (officialId) $(officialId).addEventListener('click', () => void loadOfficialNodes(officialId, warn, redraw, onChange))
  $(listId).addEventListener('change', (e: any) => {
    const i = e.target?.dataset?.i; if (i == null) return
    const list = loadNodes(); list[+i].enabled = e.target.checked
    if (!list.some((n) => n.enabled)) { list[+i].enabled = true; e.target.checked = true; warn(tr('Przynajmniej jeden węzeł musi być aktywny.')); return }
    saveNodes(list); onChange()
  })
  $(listId).addEventListener('click', (e: any) => {
    const d = e.target?.dataset ?? {}
    const { rm, up, dn } = d
    if (rm == null && up == null && dn == null) return
    e.preventDefault() // the row is a <label>: ANY click inside it toggles the checkbox
    const list = loadNodes()
    if (rm != null) {
      if (list.length <= 1) { warn(tr('Musi zostać co najmniej jeden węzeł.')); return }
      list.splice(+rm, 1); if (!list.some((n) => n.enabled)) list[0].enabled = true
    } else {
      const i = +(up ?? dn), j = up != null ? i - 1 : i + 1
      if (j < 0 || j >= list.length) return // the end arrows are inert, not missing
      ;[list[i], list[j]] = [list[j], list[i]]
    }
    saveNodes(list); redraw(); onChange()
  })
  $(addId).addEventListener('click', () => {
    const addr = (prompt('Multiaddr węzła (np. /dns4/bs2.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3Koo…):') || '').trim()
    if (!addr) return
    if (!addr.startsWith('/') || !addr.includes('/p2p/')) { warn(tr('To nie wygląda na multiaddr (…/p2p/<PeerId>).')); return }
    const host = addr.match(/\/dns[46]\/([^/]+)/)?.[1] ?? addr.match(/\/ip[46]\/([^/]+)/)?.[1] ?? tr('węzeł')
    const name = (prompt('Nazwa węzła:', host) || host).trim()
    const list = loadNodes(); list.push({ name, addr, enabled: true }); saveNodes(list); redraw(); onChange()
  })
  return redraw
}

// ---- login: editable network-node list (collapsed; the "+" reveals it) ----
const renderNodes = bindNodeEditor('nodes-list', 'node-add', (t) => setMsg('msg', t, 'err'), () => {}, 'nodes-official')
$('nodes-toggle').addEventListener('click', () => {
  const panel = $('nodes-panel'), open = panel.hidden
  panel.hidden = !open; $('nodes-toggle').classList.toggle('open', open)
  if (open) renderNodes()
})

function makeLocalBook(idKey: string, storage: Storage) {
  const lsKey = 'ec-local-contacts-' + idKey
  return localContactBook(
    () => { try { return JSON.parse(storage.getItem(lsKey) || '[]') } catch { return [] } },
    (l) => storage.setItem(lsKey, JSON.stringify(l)),
  )
}

/** Short form of an HSM key id — the full one is long and adds no meaning here. */
const shortKid = (kid?: string) => (kid ? kid.slice(0, 8) + '…' : '')

/**
 * The id every per-identity local key hangs off: the identity's KID.
 *
 * Content-derived (`SHA-1(pub)[0:16]`), so a HEM identity and a software one are
 * named the same way and the value is the one the device itself would issue —
 * `kidOf` prefers the issued KID and derives only when there is none. Stable
 * across a rename, and distinct for two identities that share a handle, which is
 * exactly what a storage namespace has to be.
 */
const identityKey = async (pub: string, kid?: string) => (await kidOf({ kid, pub: unb64(pub) }))!

/** How many pre-KID entries the sweep below dropped, reported after the next sign-in. */
let sweptPreKid = 0

/**
 * One-time sweep of state written before local keys were namespaced by KID.
 *
 * Everything per-identity used to hang off the HANDLE, so the entries left over
 * name nothing this build can resolve. Pre-MVP they are dropped rather than
 * migrated — but SILENTLY dropping a contact list looks exactly like a fault, so
 * the caller says how many went.
 *
 * `ec-soft-id-` is deliberately not in the list: that is the sealed software
 * identity itself, and it is keyed by profile name on purpose.
 */
const ID_KEYED = /^[0-9a-f]{32}(-|$)/
function clearPreKidState(): number {
  if (localStorage.getItem('ec-idkey-swept')) return 0
  let n = 0
  for (const k of Object.keys(localStorage)) {
    // Longest prefix first — `ec-gcache-emp-` also starts with `ec-gcache-`.
    for (const p of ['ec-gcache-emp-', 'ec-gcache-', 'ec-local-contacts-', 'ec-groups-']) {
      if (!k.startsWith(p)) continue
      if (!ID_KEYED.test(k.slice(p.length))) { localStorage.removeItem(k); n++ }
      break
    }
  }
  try { localStorage.setItem('ec-idkey-swept', '1') } catch {}
  return n
}
sweptPreKid = clearPreKidState()
if (sweptPreKid) ecLog(`cleared ${sweptPreKid} local entries written before identities were keyed by KID`)

async function enterApp(id: Identity, book: ContactManager, sourceLabel: string, kid?: string, gkBackend?: GkBackend) {
  session = { id, handle: id.handle, pub: id.pub, kid, idKey: await identityKey(id.pub, kid), book }
  // Read by the browser harness, which used to parse the identity out of
  // localStorage — impossible now that the software profile is sealed, and a
  // good thing: if it could still be read there, the seal would be decorative.
  // Exposing it costs nothing, a public key being public.
  ;(window as any).__pub = id.pub
  // Start the transport, but do NOT make the app shell wait for it: dialing a
  // relay is network work, and a login screen that hangs on it looks broken
  // (it also blocked the first automated run of this app outright).
  clientReady = startSession(id, {
    relay: chosenRelay(),
    relays: chosenRelays(),   // 3b: fall through the enabled node list if one is down
    gkBackend,                // §8 bucket A: a HEM identity mints GK in the HSM
    transport: USE_MQTT ? 'mqtt' : 'libp2p',
    broker: BROKER,
    forcedRotationSec: FORCED_ROTATION_SEC,
    onGroupSkd: (from, skd) => { void onGroupInvite(from, skd) }, // a group invite arrived over a 1:1
    onGroupSkdReq: (from, req) => { void answerSkdReq(from, req) }, // …and a member asking for one back

    onLog: ecLog,
    onLink: (state) => {
      linkState = state; paintStatus()
      // The relay came back: 1:1 rooms are refreshed by core, but groups are passive
      // and not registered there — re-warm their meshes so they don't stay silently dead.
      if (state === 'online') {
        for (const gu of groupsUI.values()) gu.room?.refresh()
        void flushPendingSkd() // a key that could not leave while we were offline
      }
    },
    onRelay: (addr) => {
      // Failed over to another node (or returned to the primary). Tell the user
      // which node is carrying them now, and refresh the Network tab if it is open.
      const name = loadNodes().find((n) => n.addr === addr)?.name
        ?? (addr.match(/dns4\/([^/]+)/) ?? addr.match(/ip6\/([^/]+)/) ?? [, addr.slice(0, 24)])[1]
      const primary = chosenRelays()[0]
      toast(addr === primary ? tr('Wróciłem na węzeł {name}', { name }) : tr('Przełączono na węzeł {name} (poprzedni niedostępny)', { name }))
      renderNetwork()
    },
    onSessionTakenOver: () => {
      // §9.1/§9.2: a second window of this identity showed up, so BOTH stand
      // down — the other one is doing exactly this too. The transport is gone
      // by now; clear the transcript, because this window cannot decrypt
      // anything any more, and say plainly what to do about it.
      for (const r of rooms.values()) { r.conv = null; r.inRoom = false }
      $('messages').innerHTML = ''
      msgEls.clear(); stateEls.clear(); setTyping(false)
      appendMsg('sys', tr('Wykryto drugie okno zalogowane na tę samą tożsamość.')
        + tr(' Obie sesje zostały zamknięte — jedna tożsamość, jedna aktywna sesja.')
        + tr(' Zamknij nadmiarową kartę i odśwież tę, w której chcesz rozmawiać.'))
      linkState = 'offline'
      paintStatus()
      $('peer-status').textContent = tr('sesja zamknięta (duplikat)')
    },
  })
  clientReady.then((c) => { client = c; void restoreGroups() }, (e: any) => {
    ecLog(`session failed to start: ${e?.message ?? e}`)
    toast(tr('Brak połączenia z przekaźnikiem — odśwież stronę'))
  })
  $('login').hidden = true; $('app').hidden = false
  stopHemPoll() // the login screen is gone; nothing left to watch for
  // Said HERE and not at boot: an empty contact list is what the user is about
  // to look at, and this is the sentence that explains it. Once per device.
  if (sweptPreKid > 0) {
    toast(tr('Stan sprzed zmiany formatu tożsamości został wyczyszczony ({n}) — kontakty w HEM są nietknięte.', { n: sweptPreKid }))
    sweptPreKid = 0
  }
  $('me-avatar').textContent = initials(id.handle)
  $('me-handle').textContent = id.handle
  const fp = await fingerprint(id.pub)
  $('me-fp').textContent = tr('🔑 ') + fp
  $('me-fp').title = kid ? `KID ${kid} · dwuklik = kopiuj klucz publiczny` : 'Dwuklik = kopiuj klucz publiczny'
  $('sess-id').textContent = sourceLabel + ' · ' + fp
  $('sess-kid').textContent = kid ?? tr('— (klucz w przeglądarce)')
  $('sess-kid').title = kid ?? tr('Tożsamość programowa — brak klucza w HSM')
  await refreshContacts()
  // An invite clicked while logged out waited through the login screen for this.
  // It takes precedence over the welcome card: someone arriving with a link has
  // already been told what to do, and being told again first would be noise.
  if (pendingInvite) void showInvite(pendingInvite)
  else if (!contactsCache.length && !hasStoredGroups()) {
    $('scrim').classList.add('open'); $('welcome-modal').classList.add('open')
  }
}

// ---- contacts (HEM-backed book; in-memory cache keeps re-renders cheap) ----
let contactsCache: Contact[] = []
/** pub → fingerprint. Peers are shown exactly like our own identity: the
 *  8-byte SHA-256 of the key, not the raw base64 nobody can compare by eye. */
const fpCache = new Map<string, string>()
/**
 * Reload the contact list — at most one load at a time.
 *
 * Sign-in called this twice: once from `enterApp`, once from `restoreGroups`
 * (group recovery needs contacts to resolve an admin hint). On a HEM that is the
 * whole book twice — a key search plus one getPubKey per contact, seconds of
 * device time — and a trace showed exactly that. Callers that arrive while a
 * load is running now await THAT one instead of starting another, which keeps
 * both call sites honest about needing fresh contacts.
 */
let contactsLoad: Promise<void> | null = null
function refreshContacts(): Promise<void> {
  if (contactsLoad) return contactsLoad
  contactsLoad = loadContacts().finally(() => { contactsLoad = null })
  return contactsLoad
}
async function loadContacts() {
  if (!session) return
  try { contactsCache = await session.book.list() }
  catch (e: any) { toast(tr('Błąd listy kontaktów: ') + (e?.message ?? e)) }
  for (const c of contactsCache) if (!fpCache.has(c.pub)) fpCache.set(c.pub, await fingerprint(c.pub))
  renderContacts()
  // Groups name their members out of this list, so the list arriving is exactly
  // when a group's members stop being eight characters of a public key.
  renderGroups()
  if (activeGid) void activateGroup(activeGid)
  void syncPresence()
}

/** Contacts we currently show a green dot for, and the ones we hold a light
 *  presence watch on. The heavy conversation is a separate thing — being here
 *  means "announcing on our pair topic", no handshake, no room. */
const onlinePubs = new Set<string>()
const watchedPubs = new Set<string>()

/**
 * Bring the presence watches in line with the contact list: watch anyone new,
 * drop anyone removed. `watchContacts` starts a light watcher per contact (see
 * core `watchContacts` / `lib/presence.ts`) and calls back on the transitions —
 * a dot, and, when the contact actually sends, `onWantsConversation`, which is
 * the whole upgrade path: their EH-2 frame reached our watcher, so we open the
 * full room and it takes over the warm topic. Idempotent — safe to call on
 * every contact change; `startWatch` skips anyone already watched.
 */
async function syncPresence() {
  if (!clientReady) return
  let c: ClientSession
  try { c = await clientReady } catch { return }
  const current = new Set(contactsCache.map((x) => x.pub))
  for (const pub of [...watchedPubs]) if (!current.has(pub)) { c.unwatch(pub); watchedPubs.delete(pub); onlinePubs.delete(pub) }
  // Exclude only the ON-SCREEN room: it handed its topic to the room, which drives
  // that contact's dot via `inRoom`. Every OTHER contact — including ones with a
  // BACKGROUND room open — is light-watched, so its green "online" dot works again
  // (the earlier "exclude every open room" left opened contacts permanently
  // unwatched, since background rooms never close). The extra light watch over a
  // background room's topic is benign: idempotent subscribe, a harmless second
  // announce, and `onWantsConversation` is guarded by `rooms.has`.
  const toWatch = contactsCache.filter((x) => x.pub !== activePub)
  await c.watchContacts(toWatch.map((x) => ({ pub: x.pub, kid: x.kid })), {
    onOnline: (p) => { if (!onlinePubs.has(p.pub)) { onlinePubs.add(p.pub); renderContacts() } },
    onOffline: (p) => { if (onlinePubs.delete(p.pub)) renderContacts() },
    onWantsConversation: (p) => {
      // The contact is opening EH-2. Open the room IN THE BACKGROUND so their
      // frame is replayed and the handshake completes and the message arrives —
      // but do NOT steal the view (5 people writing must not thrash the UI).
      // A dot lights on the contact; the user switches when they want.
      const contact = contactsCache.find((x) => x.pub === p.pub)
      if (!contact || rooms.has(p.pub)) return
      toast(tr('{name} chce rozmawiać…', { name: contact.name }))
      void openRoomFor(contact, false)
    },
  })
  // Record every contact (incl. the active one, whose watch core owns and
  // restores on leave) so removal always tears its watch down.
  for (const x of contactsCache) watchedPubs.add(x.pub)
}
function renderContacts() {
  const pane = $('pane-contacts'); pane.innerHTML = ''
  // Add-peer lives INSIDE the contacts pane (like "+ Nowa grupa" in groups), so it
  // only shows on this tab — and above the empty-state, since that is when you need it.
  const add = document.createElement('div'); add.className = 'add-row'
  const addBtn = document.createElement('button'); addBtn.className = 'add-btn'; addBtn.textContent = tr('+ Dodaj peera')
  addBtn.addEventListener('click', () => openModal()); add.appendChild(addBtn); pane.appendChild(add)
  const filter = val('contact-search').toLowerCase()
  const list = contactsCache.filter((c) => !filter || c.name.toLowerCase().includes(filter))
  if (!list.length) { const e = document.createElement('div'); e.className = 'pane-label'; e.textContent = filter ? tr('(brak dopasowań)') : tr('(brak kontaktów — dodaj peera)'); pane.appendChild(e); return }
  for (const c of list) {
    const room = rooms.get(c.pub)
    const inRoom = !!room?.inRoom
    const online = onlinePubs.has(c.pub)
    const unseen = room?.unseen ?? 0
    const dotTitle = inRoom ? 'W rozmowie' : online ? 'Online (widoczny na Waszym topicu)' : 'Offline'
    const src = c.source === 'hem' ? { i: '🔒', t: tr('W HEM (trwałe, przenośne)') } : { i: '💻', t: tr('Lokalnie (ta przeglądarka)') }
    const b = document.createElement('button'); b.className = 'contact' + (activePub === c.pub && chatOnScreen() ? ' active' : '') + (unseen ? ' unread' : '')
    // The unread pill is the whole point of the background model: a message that
    // arrived while you were elsewhere lights here instead of yanking the view.
    const pill = unseen ? `<span class="c-unread" title="${unseen} nieprzeczytane">${unseen > 99 ? '99+' : unseen}</span>` : ''
    b.innerHTML = `<span class="dot ${inRoom || online ? 'ok' : ''}" title="${dotTitle}"></span><div class="avatar">${escapeHtml(initials(c.name))}</div>`
      + `<div class="c-info"><div class="c-name">${escapeHtml(c.name)} <span class="src" title="${src.t}">${src.i}</span></div>`
      + `<div class="c-sub" title="${escapeHtml(c.kid ? `KID ${c.kid}` : c.pub)}">🔑 ${escapeHtml(fpCache.get(c.pub) ?? '…')}${c.kid ? ' · KID ' + escapeHtml(shortKid(c.kid)) : ''}</div></div>`
      + pill + `<button class="c-edit" title="${tr('Zmień nazwę')}">✎</button><span class="c-x" title="${tr('Usuń')}">×</span>`
    b.addEventListener('click', async (e: any) => {
      if (e.target.classList.contains('c-edit')) {
        e.stopPropagation()
        const name = await promptName(tr('Zmień nazwę kontaktu'), `Widoczna tylko u Ciebie — ${c.name} nie zostanie o niej powiadomiony.`, c.name)
        if (name) await renameContact(c, name)
        return
      }
      if (e.target.classList.contains('c-x')) {
        e.stopPropagation()
        // Deleting a contact tears down the conversation and, on a HEM, removes
        // the imported key — not something to do on a mis-tap next to the name.
        if (!(await ask(tr('Usunąć kontakt?'), tr('„{name}” zniknie z listy, rozmowa zostanie zamknięta', { name: c.name })
          + `${c.source === 'hem' ? tr(', a klucz kontaktu zostanie usunięty z HEM') : ''}. Historia rozmowy i tak nie jest przechowywana.`, tr('Usuń'))).ok) return
        await closeRoom(c.pub)
        if (session) { try { await session.book.remove(c) } catch (err: any) { toast(tr('Błąd usuwania: ') + (err?.message ?? err)) } }
        await refreshContacts(); return
      }
      void openRoomFor(c, true)
    })
    pane.appendChild(b)
  }
}
$('contact-search').addEventListener('input', renderContacts)

// ---- ask / rename: two promise-shaped modals reused by every destructive or
// editing action. Deliberately NOT window.confirm/prompt: a mobile webview
// draws those as browser chrome outside the app's skin, and they block the
// event loop — which here means the transport stops pumping while a dialog is
// open. -------------------------------------------------------------------
function ask(title: string, body: string, yes = 'Tak', rememberLabel?: string, href?: string, noLabel: string | null = 'Nie'): Promise<{ ok: boolean; remember: boolean }> {
  return new Promise((resolve) => {
    $('ask-title').textContent = title
    $('ask-body').textContent = body
    $('ask-yes').textContent = yes
    // The checkbox is opt-in per call: a destructive confirm must never offer to
    // stop asking, only an advisory one may.
    // Both of these are OPTIONAL parts of the dialog, so they are read
    // defensively: a confirm that cannot be dismissed is worse than one without
    // a checkbox, and this exact shape failed once — the markup had not landed,
    // `$()` returned null, the assignment threw, and the click died after
    // preventDefault with no dialog and no navigation.
    const cb = document.getElementById('ask-remember') as HTMLInputElement | null
    const wrap = document.getElementById('ask-remember-wrap')
    if (cb) cb.checked = false
    if (wrap) {
      wrap.hidden = !rememberLabel
      const label = wrap.querySelector('span')
      if (rememberLabel && label) label.textContent = rememberLabel
    }
    // A link confirm affirms with an anchor, so the navigation is the user's own
    // click. `window.open` after an awaited dialog is outside the gesture and
    // browsers block it.
    const open = document.getElementById('ask-open') as HTMLAnchorElement | null
    if (open) {
      open.hidden = !href
      if (href) { open.href = href; open.textContent = yes }
    }
    $('ask-yes').hidden = !!(href && open)
    // A NOTICE has one way out. Passing no `noLabel` hides the second button, so
    // "close this and try again" does not have to be phrased as yes-or-no.
    const no = $('ask-no')
    no.hidden = noLabel === null
    if (noLabel) no.textContent = noLabel
    $('members-pop').hidden = true // nothing may stay clickable behind a modal
    $('scrim').classList.add('open'); $('ask-modal').classList.add('open')
    const done = (v: boolean) => {
      const remember = !!(rememberLabel && cb?.checked)
      $('scrim').classList.remove('open'); $('ask-modal').classList.remove('open')
      $('ask-yes').removeEventListener('click', onYes)
      document.getElementById('ask-open')?.removeEventListener('click', onYes)
      $('ask-no').removeEventListener('click', onNo)
      $('scrim').removeEventListener('click', onScrim)
      document.removeEventListener('keydown', onKey)
      resolve({ ok: v, remember })
    }
    const onYes = () => done(true), onNo = () => done(false)
    // Clicking the backdrop is the third way out, alongside Escape and "Nie".
    // A destructive dialog should be easy to leave and deliberate to confirm.
    const onScrim = () => done(false)
    // Escape cancels. A destructive dialog must have a way out that is not a click.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true) }
    $('ask-yes').addEventListener('click', onYes)
    document.getElementById('ask-open')?.addEventListener('click', onYes) // navigates natively; this only closes
    $('ask-no').addEventListener('click', onNo)
    $('scrim').addEventListener('click', onScrim)
    document.addEventListener('keydown', onKey)
    $('ask-no').focus() // the safe option is the one under the finger
  })
}

function promptName(title: string, sub: string, current: string, label = 'Nazwa'): Promise<string | null> {
  return new Promise((resolve) => {
    $('rename-title').textContent = title
    $('rename-sub').textContent = sub
    $('rename-label').textContent = label
    clr('rename-msg')
    const input = $('rename-input') as HTMLInputElement
    input.value = current
    $('members-pop').hidden = true
    $('scrim').classList.add('open'); $('rename-modal').classList.add('open')
    const done = (v: string | null) => {
      $('scrim').classList.remove('open'); $('rename-modal').classList.remove('open')
      $('rename-save').removeEventListener('click', onSave)
      $('rename-cancel').removeEventListener('click', onCancel)
      $('scrim').removeEventListener('click', onCancel)
      input.removeEventListener('keydown', onKey)
      resolve(v)
    }
    const onSave = () => {
      const v = input.value.trim()
      if (!v) { setMsg('rename-msg', tr('Nazwa nie może być pusta.'), 'err'); return }
      done(v === current ? null : v) // unchanged is the same as cancelled
    }
    const onCancel = () => done(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel() }
    $('rename-save').addEventListener('click', onSave)
    $('rename-cancel').addEventListener('click', onCancel)
    $('scrim').addEventListener('click', onCancel)
    input.addEventListener('keydown', onKey)
    input.focus(); input.select()
  })
}

/**
 * Rename a contact. Local to this device by design: the name is how YOU refer
 * to a key, it is not part of anyone's identity, and telling the peer would
 * leak a label they never chose. The key, its KID and every open room survive —
 * on a HEM this rewrites one DESCR rather than deleting and re-importing, so
 * the KID (a roster hint in group markers, §8) does not move.
 */
async function renameContact(c: Contact, name: string) {
  if (!session) return
  try {
    await session.book.rename(c, name)
    // Group member lists need no patching any more: they hold keys and look the
    // name up when they are drawn.
    await refreshContacts()
    if (activePub === c.pub) { $('peer-name').textContent = name; $('peer-name').title = name }
    if (activeGid) renderGroups()
    toast(`Kontakt to teraz „${name}"`)
  } catch (e: any) { toast(tr('Nie udało się zmienić nazwy: ') + (e?.message ?? e)) }
}

// ---- add-peer modal ----
/**
 * Make the storage choice describe the identity that is actually signed in.
 *
 * A software profile has no HEM, and `localOnlyManager` ignores the persistent
 * flag altogether — so "in the HEM, portable between devices" names a place
 * that does not exist and promises a difference the code does not make. The row
 * is removed rather than greyed out: a disabled option reads as a feature
 * waiting to be unlocked, and this one is simply not part of the software path.
 */
function paintStoreOptions(groupId: string) {
  const hasHem = !activeSoftProfile
  const group = $(groupId)
  const hemRow = group.querySelector('input[value="hem"]')?.closest('.store-opt') as HTMLElement | null
  if (hemRow) hemRow.hidden = !hasHem
  const local = group.querySelector('.store-local') as HTMLElement | null
  if (local) local.textContent = hasHem
    ? tr('💻 Tylko lokalnie — ta przeglądarka, nic nie trafia do HEM')
    : tr('💻 Zapisz w tym profilu — zostaje na tym urządzeniu')
  // Something has to be selected, and the default moves with the identity.
  const pick = group.querySelector(`input[value="${hasHem ? 'hem' : 'local'}"]`) as HTMLInputElement | null
  if (pick) pick.checked = true
}

/** Which destination the user picked in one of the two add windows. */
const storeChoice = (group: string) =>
  ($(group).querySelector('input:checked') as HTMLInputElement | null)?.value ?? 'hem'

/**
 * One notion of "the same contact", shared by both ways of adding one.
 *
 * The two paths disagreed: adding by hand replaced whatever had the same NAME,
 * importing a link replaced whatever had the same KEY. So one person added both
 * ways became two contacts, while two different people under one name silently
 * overwrote each other — the second of those loses a key you still needed.
 *
 * The key IS the person; the name is a label this device chose. A key that is
 * already here is therefore the same contact under a new label and is replaced
 * without asking, and a name collision is a question rather than a rule.
 *
 * Returns false when the user declines — the caller must not write.
 */
async function claimContact(name: string, pub: string): Promise<boolean> {
  if (!session) return false
  const samePub = contactsCache.find((c) => c.pub === pub)
  if (samePub) { await session.book.remove(samePub); return true }
  const sameName = contactsCache.find((c) => c.name === name)
  if (!sameName) return true
  const { ok } = await ask(
    tr('Masz już kontakt „{name}"', { name }),
    tr('Ta nazwa jest już zajęta przez kogoś o innym kluczu. Zastąpienie usunie tamten kontakt — jeśli to dwie różne osoby, wróć i nadaj inną nazwę.'),
    tr('Zastąp'))
  // ask() takes the scrim down with it and the window that asked is still open
  // behind it — the same repair as in the profile window.
  $('scrim').classList.add('open')
  if (!ok) return false
  await session.book.remove(sameName)
  return true
}


/**
 * A live UTF-8 byte counter on a name field, and a hard stop at zero.
 *
 * A DESCR is a fixed 128-byte record and the name is what is left of it, so the
 * limit is in BYTES and not characters: "Zażółć" is six characters and ten
 * bytes, and an emoji is four. Counting characters would let a Polish name pass
 * the form and be cut on save — the field would lose its ending silently, which
 * is the failure this replaces.
 *
 * The cut happens on input rather than on submit, because a name that arrives
 * shortened is one the user never agreed to. When the budget is spent the field
 * simply stops taking characters, and the caret is put back where it was so a
 * paste that overflows does not also jump the cursor to the end.
 */
function attachByteBudget(input: HTMLInputElement, max: number, out: HTMLElement) {
  const paint = () => {
    const used = byteLen(input.value)
    const left = max - used
    out.textContent = String(left)
    out.classList.toggle('full', left <= 0)
    out.title = tr('Pozostało bajtów UTF-8 na nazwę (limit {max})', { max })
  }
  input.addEventListener('input', () => {
    if (byteLen(input.value) > max) {
      const at = input.selectionStart ?? input.value.length
      input.value = sliceBytes(input.value, max)
      const p = Math.min(at, input.value.length)
      try { input.setSelectionRange(p, p) } catch {}
    }
    paint()
  })
  paint()
}

const openModal = () => { $('scrim').classList.add('open'); $('add-modal').classList.add('open'); clr('add-msg'); ;($('add-name') as HTMLInputElement).value = ''; ($('add-pub') as HTMLInputElement).value = ''; paintStoreOptions('add-store'); $('add-pub').focus() }
const closeModal = () => { $('scrim').classList.remove('open'); $('add-modal').classList.remove('open') }
$('add-cancel').addEventListener('click', closeModal)

/**
 * Turn the one device-level rule that reaches a user into a sentence.
 *
 * A HEM refuses to hold one public key twice whatever DESCR it sits under, so a
 * contact belongs to a single identity per device (§4 Proposal). The book sees
 * that coming and raises before writing anything; without this the user would
 * read "this key is already a contact of Work" as a raw error string, with no
 * hint that there is a way round it.
 *
 * There IS a way round it, and saying so is most of the point: the local book is
 * per-identity and takes anyone, at the cost of the portability that putting a
 * contact in the device buys.
 */
function contactAddError(e: any): string {
  if (e?.name !== 'ContactHeldByOtherIdentity') return tr('Błąd zapisu: ') + (e?.message ?? e)
  const who = e.ownerHandle || e.ownerKid.slice(0, 8)
  return tr('Ten klucz jest już kontaktem tożsamości „{who}”, a urządzenie trzyma każdy klucz tylko raz.', { who })
    + tr(' Zapisz go „tylko lokalnie” — będzie w tej przeglądarce, ale nie w HEM.')
}

$('add-save').addEventListener('click', async () => {
  if (!session) return
  const name = val('add-name'), pub = val('add-pub')
  // A pasted invite is not a key and must not be checked as one. It goes to the
  // import window instead — the same one a clicked link opens, fingerprint and
  // all. There is deliberately no shortcut past that comparison, because it is
  // the only thing between a link and a man in the middle. A name typed here
  // wins over the one in the link: someone who typed it meant it.
  const inv = pub ? inviteFromPaste(pub) : null
  if (inv) { closeModal(); await showInvite(inv, name); return }
  if (!name || !pub) { setMsg('add-msg', tr('Podaj nazwę i klucz.'), 'err'); return }
  try { if (Uint8Array.from(atob(pub), (c) => c.charCodeAt(0)).length !== 32) { setMsg('add-msg', tr('Klucz nie wygląda na 32-bajtowy X25519 (base64).'), 'err'); return } }
  catch { setMsg('add-msg', tr('Klucz nie jest poprawnym base64.'), 'err'); return }
  const store = storeChoice('add-store')
  if (store === 'none') { closeModal(); void openRoomFor({ name, pub, source: 'local' }, true); return } // ephemeral — nothing saved (HEM nor localStorage)
  const persistent = store !== 'local'
  const btn = $('add-save') as HTMLButtonElement; btn.disabled = true; btn.textContent = tr('Zapisuję…')
  try {
    if (!(await claimContact(name, pub))) return
    await session.book.add(name, pub, persistent)
    await refreshContacts()
    closeModal()
  } catch (e: any) { setMsg('add-msg', contactAddError(e), 'err') }
  finally { btn.disabled = false; btn.textContent = tr('Zapisz') }
})

// ---- settings drawer ----
function paintTransportSetting() {
  const mode = transportMode()
  const chip = $('chip-profile')
  chip.textContent = mode === 'relay' ? tr('⚪ Tylko węzeł') : tr('🟢 Automatycznie')
  const pick = document.querySelector(`#tmode input[value="${mode}"]`) as HTMLInputElement | null
  if (pick) pick.checked = true
}
$('chip-profile').addEventListener('click', () => openDrawer())
for (const el of document.querySelectorAll('#tmode input')) {
  el.addEventListener('change', () => {
    const v = (document.querySelector('#tmode input:checked') as HTMLInputElement | null)?.value
    try { localStorage.setItem(TRANSPORT_KEY, v === 'relay' ? 'relay' : 'auto') } catch {}
    paintTransportSetting()
    toast(v === 'relay'
      ? tr('Nowe rozmowy pójdą tylko przez węzeł')
      : tr('Nowe rozmowy spróbują połączenia bezpośredniego'))
  })
}

const openDrawer = () => { $('scrim').classList.add('open'); $('drawer').classList.add('open'); renderProfiles(); paintTransportSetting() }
const closeDrawer = () => { $('scrim').classList.remove('open'); $('drawer').classList.remove('open') }
// ---- invite: my profile as a link, and someone else's arriving as one -------
/**
 * An invite read out of the URL and not yet dealt with.
 *
 * It has to survive the login screen. Someone who receives a link does not
 * choose when they click it, and the common case — click, get asked to log in,
 * log in — would otherwise end with nothing on screen and a link that looks
 * broken. RAM only: a pending invite is not worth persisting past a reload,
 * and the link can simply be opened again.
 */
let pendingInvite: Invite | null = takeInviteFromUrl()

/**
 * Take the invite out of the address bar the moment it is read.
 *
 * Leaving it there would keep a public key in the URL bar, in the history, and
 * in whatever the next screenshot catches — and a reload would re-ask about a
 * contact already added. `replaceState` drops the fragment without touching the
 * page.
 */
function takeInviteFromUrl(): Invite | null {
  const inv = decodeInvite(location.hash)
  if (inv) history.replaceState(null, '', location.pathname + location.search)
  return inv
}

/**
 * An invite arriving at a page that is ALREADY open.
 *
 * Clicking a link to the origin you are on is a same-document navigation: the
 * browser changes the fragment and runs no script, so nothing above this line
 * would ever see it. That is the common case rather than an edge one — the
 * person most likely to click an invite is someone already signed in on this
 * device — and without this it presents as a link that does nothing at all.
 */
window.addEventListener('hashchange', () => {
  const inv = takeInviteFromUrl()
  if (!inv) return
  pendingInvite = inv
  if (session) void showInvite(inv) // otherwise the login screen hands it over
})

/**
 * Whether this device holds any group state for the signed-in handle.
 *
 * Read straight from storage rather than from `groupsUI`, because the cache
 * restore is asynchronous: asked at login time, the map is still empty on a
 * device that has several groups and is a second away from showing them — and
 * the onboarding card would greet a returning user as a new one.
 */
function hasStoredGroups(): boolean {
  const p = gcachePrefix()
  for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith(p)) return true
  return false
}

const closeWelcome = () => { $('scrim').classList.remove('open'); $('welcome-modal').classList.remove('open') }
$('welcome-close').addEventListener('click', closeWelcome)
$('welcome-share').addEventListener('click', () => { closeWelcome(); void openShare() })

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE INVITE LINKS POINT — change these two lines to point a build at another
 * deployment (your own domain, your own path), then rebuild.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * They matter only OUTSIDE a browser. On the web the address bar is the source
 * of truth: the link names the origin the user is actually looking at, so
 * someone self-hosting hands out their own address and a test deployment hands
 * out itself. Nothing here overrides that.
 *
 * Inside the desktop and Android builds there is no address bar, and
 * `location.origin` is the app's own internal scheme — a valid origin that
 * means nothing anywhere else. Sharing your key from a phone produced a link
 * that looked right and that nobody could open.
 */
const CANONICAL_ORIGIN = 'https://onchato.com'
const CANONICAL_PATH = '/chat'

/**
 * True when this document is NOT a page on the web — i.e. it is the app shell.
 *
 * Tauri serves the bundle from `tauri://localhost` on some platforms and
 * `http://tauri.localhost` on others, so neither the protocol nor the host
 * alone is enough. If a future Tauri changes this again the symptom returns
 * quietly, so the origin is printed in the startup line: open the app with
 * `?debug=1` and read it there rather than guessing.
 */
const inAppShell = !/^https?:$/.test(location.protocol) || location.hostname === 'tauri.localhost'

const openShare = async (returnMode = false) => {
  if (!session) return
  $('scrim').classList.add('open'); $('share-modal').classList.add('open')
  $('share-title').textContent = returnMode ? tr('Odeślij swój profil') : tr('Udostępnij swój profil')
  // The return trip is not optional politeness — until the other side holds our
  // key too, neither of us can compute the pair topic, so nothing can be sent.
  $('share-sub').textContent = returnMode
    ? tr('Kontakt dodany. Żeby ta osoba mogła do Ciebie napisać, musi mieć też Twój klucz — odeślij jej ten link.')
    : tr('Wyślij ten link dowolnym kanałem. Nie zawiera niczego tajnego — sam klucz publiczny.')
  // A link produced in return mode says so, and that is what ends the exchange:
  // the far side imports it without being asked to send anything back, because
  // it already did.
  // The app shell has no address to hand out, so it hands out the canonical one.
  // A link is the better carrier either way: it can be CLICKED by someone with a
  // browser and PASTED by someone with the app, whereas a bare payload can only
  // be pasted — and `inviteFromPaste` accepts either, so nothing is lost.
  ;($('share-link') as HTMLInputElement).value = inviteLink(
    inAppShell ? CANONICAL_ORIGIN : location.origin,
    inAppShell ? CANONICAL_PATH : location.pathname,
    { pub: session.pub, name: session.handle, reply: returnMode })
  $('share-fp').textContent = fpCache.get(session.pub) ?? await fingerprint(session.pub)
}
const closeShare = () => { $('scrim').classList.remove('open'); $('share-modal').classList.remove('open') }
$('btn-share').addEventListener('click', () => void openShare())
$('share-close').addEventListener('click', closeShare)
$('share-copy').addEventListener('click', async () => {
  const el = $('share-link') as HTMLInputElement
  try { await navigator.clipboard.writeText(el.value); toast(tr('Link skopiowany')) }
  catch { el.select(); toast(tr('Zaznaczono — skopiuj ręcznie')) } // no clipboard permission, or plain http
})

const closeImport = () => { $('scrim').classList.remove('open'); $('import-modal').classList.remove('open') }
$('import-cancel').addEventListener('click', () => { pendingInvite = null; closeImport() })

/**
 * Pull an invite out of whatever was pasted into the key field.
 *
 * Nobody pastes a fragment. They paste a link, usually with the sentence around
 * it that came along from the messenger they copied it out of — so the fragment
 * is looked for inside the text rather than required to be the whole of it.
 *
 * The ORIGIN is ignored on purpose. A link is written by onchato.com and may be
 * pasted into the desktop app, whose origin is something else entirely; without
 * this, invites do not work there at all, and there is no address bar to fall
 * back on. Ignoring it costs nothing, because what makes an invite trustworthy
 * is the fingerprint the next window shows, never where the text came from.
 */
function inviteFromPaste(text: string): Invite | null {
  const t = text.trim()
  const whole = t.startsWith('#') || t.startsWith('i=') ? decodeInvite(t) : null
  if (whole) return whole
  const m = t.match(/#(i=[A-Za-z0-9\-_]+)/)
  return m ? decodeInvite(m[1]) : null
}

/**
 * Show a received invite. Called after login, so the contact book exists.
 *
 * `nameOverride` carries a name typed in the add window before the link was
 * pasted there — the person doing the adding gets to say what they call the
 * contact, over whatever the sender called themselves.
 */
async function showInvite(inv: Invite, nameOverride?: string) {
  pendingInvite = inv
  $('scrim').classList.add('open'); $('import-modal').classList.add('open')
  clr('import-msg')
  ;($('import-name') as HTMLInputElement).value = nameOverride || inv.name
  paintStoreOptions('import-store')
  $('import-fp').textContent = await fingerprint(inv.pub)
  if (inv.pub === session?.pub) setMsg('import-msg', tr('To Twój własny profil.'), 'err')
}

$('import-add').addEventListener('click', async () => {
  const inv = pendingInvite
  if (!inv || !session) return
  const name = val('import-name')
  if (!name) { setMsg('import-msg', tr('Podaj nazwę.'), 'err'); return }
  // Adding yourself would create a contact whose pair topic is the self-topic —
  // a room that looks real and can never carry a conversation.
  if (inv.pub === session.pub) { setMsg('import-msg', tr('To Twój własny profil.'), 'err'); return }
  const btn = $('import-add') as HTMLButtonElement
  btn.disabled = true; const label = btn.textContent; btn.textContent = tr('Dodaję…')
  try {
    // Arriving by link is not a decision to keep someone's key for ever, so the
    // destination is asked here exactly as it is when adding by hand. Before
    // this the link took the most durable option there was, without saying so.
    const store = storeChoice('import-store')
    if (store !== 'none') {
      if (!(await claimContact(name, inv.pub))) return
      await session.book.add(name, inv.pub, store !== 'local')
      await refreshContacts()
    }
    pendingInvite = null
    closeImport()
    // Nothing was written, so the conversation is all there is: open it, or the
    // import ends with no trace of having happened.
    if (store === 'none') void openRoomFor({ name, pub: inv.pub, source: 'local' }, true)
    // Only the FIRST leg asks for a key back. An imported reply means both sides
    // now hold both keys, and offering to send ours again is how this loops
    // forever — which is exactly what it did.
    if (inv.reply) toast(tr('Wymiana zakończona — możecie rozmawiać'))
    else await openShare(true)
  } catch (e: any) { setMsg('import-msg', contactAddError(e), 'err') }
  finally { btn.disabled = false; btn.textContent = label ?? tr('Dodaj kontakt') }
})

// ---- software profiles on this device (Settings) ---------------------------
/**
 * The software profile signed in right now, '' on the HEM path. Tracked
 * separately from the handle: a HEM identity's handle can equal some software
 * profile's name, and offering to change the password of a profile you are not
 * holding open is a way to lock someone out of one.
 */
let activeSoftProfile = ''

/**
 * Every localStorage namespace keyed by a profile's name.
 *
 * Deleting an identity has to take these with it. Contacts and group state
 * outliving the key that owned them would leave the names and public keys of
 * everyone that identity spoke to sitting under a prefix nobody owns any more —
 * and no way to reach them, since the identity that could is gone.
 */
const PROFILE_KEYS = ['ec-soft-id-', 'ec-local-contacts-', 'ec-gcache-', 'ec-gcache-emp-', 'ec-groups-']

function listSoftProfiles(): string[] {
  const out: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k?.startsWith('ec-soft-id-')) out.push(k.slice('ec-soft-id-'.length))
  }
  return out.sort((a, b) => a.localeCompare(b))
}

function renderProfiles() {
  const box = $('profiles-list'); box.textContent = ''
  const names = listSoftProfiles()
  if (!names.length) {
    const empty = document.createElement('div'); empty.className = 'hint'
    empty.textContent = tr('Brak profili software na tym urządzeniu.')
    box.appendChild(empty)
  }
  for (const n of names) {
    const row = document.createElement('div'); row.className = 'prof-row'
    const nm = document.createElement('span'); nm.className = 'p-name'; nm.textContent = n; nm.title = n
    const tag = document.createElement('span'); tag.className = 'p-tag'
    if (n === activeSoftProfile) tag.textContent = tr('aktywny')
    const del = document.createElement('button'); del.className = 'p-del'; del.textContent = '🗑'
    del.title = tr('Usuń profil'); del.setAttribute('aria-label', tr('Usuń profil'))
    del.addEventListener('click', () => void removeProfile(n))
    row.append(nm, tag, del)
    box.appendChild(row)
  }
  // Only the profile actually open can have its password changed — re-sealing
  // needs the old one, and we hold exactly one.
  $('btn-passwd').hidden = !activeSoftProfile
}

async function removeProfile(name: string) {
  const self = name === activeSoftProfile
  const { ok } = await ask(
    tr('Usunąć profil „{name}"?', { name }),
    self
      ? tr('To tożsamość, na której jesteś zalogowany. Znikną jej klucze, kontakty i grupy, a aplikacja wróci do ekranu logowania. Nieodwracalne — klucza nie da się odtworzyć.')
      : tr('Znikną klucze tego profilu, jego kontakty i grupy. Nieodwracalne — klucza nie da się odtworzyć.'),
    tr('Usuń'))
  if (!ok) return
  for (const p of PROFILE_KEYS) localStorage.removeItem(p + name)
  if (localStorage.getItem(LAST_PROFILE) === name) localStorage.removeItem(LAST_PROFILE)
  // Deleting the identity you are holding leaves a session with nothing behind
  // it — reload rather than let the app run on a key that no longer exists.
  if (self) { location.reload(); return }
  renderProfiles()
}

const openPasswd = () => {
  $('scrim').classList.add('open'); $('passwd-modal').classList.add('open'); clr('pw-msg')
  for (const f of ['pw-old', 'pw-new', 'pw-new2']) ($(f) as HTMLInputElement).value = ''
  ;($('pw-who') as HTMLInputElement).value = activeSoftProfile
  $('pw-old').focus()
}
const closePasswd = () => { $('scrim').classList.remove('open'); $('passwd-modal').classList.remove('open') }
$('btn-passwd').addEventListener('click', openPasswd)
$('pw-cancel').addEventListener('click', closePasswd)
$('pw-save').addEventListener('click', async () => {
  const oldPw = ($('pw-old') as HTMLInputElement).value
  const a = ($('pw-new') as HTMLInputElement).value, b = ($('pw-new2') as HTMLInputElement).value
  if (!a) { setMsg('pw-msg', tr('Podaj nowe hasło.'), 'err'); return }
  // Checked before touching the profile: a typo confirmed into the seal would
  // lock the identity away behind a password nobody knows.
  if (a !== b) { setMsg('pw-msg', tr('Nowe hasła się różnią.'), 'err'); return }
  const raw = localStorage.getItem(softKey(activeSoftProfile))
  const blob = raw ? JSON.parse(raw) : null
  if (!isSealedProfile(blob)) { setMsg('pw-msg', tr('Nie znaleziono profilu do zmiany.'), 'err'); return }
  const btn = $('pw-save') as HTMLButtonElement
  btn.disabled = true; const label = btn.textContent; btn.textContent = tr('Zmieniam…')
  try {
    // Sealed under the NEW password before the old blob is replaced, so a
    // failure anywhere in here leaves the profile openable with the old one.
    const next = await reseal(oldPw, a, blob)
    localStorage.setItem(softKey(activeSoftProfile), JSON.stringify(next))
    closePasswd(); toast(tr('Hasło zmienione.'))
  } catch (e: any) {
    if (e instanceof BadPassword) setMsg('pw-msg', tr('Złe obecne hasło.'), 'err')
    else setMsg('pw-msg', tr('Błąd: ') + (e?.message ?? e), 'err')
  } finally { btn.disabled = false; btn.textContent = label ?? tr('Zapisz') }
})

$('btn-settings').addEventListener('click', openDrawer)
$('chip-profile').addEventListener('click', openDrawer)
$('btn-close-drawer').addEventListener('click', closeDrawer)
$('scrim').addEventListener('click', () => { closeModal(); closeDrawer(); closeSoftModal(); closePasswd(); closeShare(); closeWelcome(); pendingInvite = null; closeImport() })
$('btn-logout').addEventListener('click', () => location.reload())
// The same act, from the header rather than from inside Settings — but asked
// first, because this one sits beside a button people press often. Logging out
// is a reload: the identity survives (it is in the HEM, or in this browser), the
// TRANSCRIPT does not, and neither do the ratchets carrying it.
$('btn-signout').addEventListener('click', async () => {
  if (!(await ask(tr('Wylogować?'), tr('Historia tej sesji zniknie — jest efemeryczna i nigdzie się nie zapisuje. Tożsamość i kontakty zostają.'), tr('Wyloguj'))).ok) return
  location.reload()
})

// ---- attach a file --------------------------------------------------------
/**
 * The clip PICKS; Send sends. Nothing is encrypted or uploaded at pick time, so
 * a file chosen by mistake costs one click to drop rather than an upload to sit
 * through — and the caption typed after choosing travels with it, which it
 * cannot do if the send has already left.
 */
let pendingAttach: File | null = null

/** The chip is the whole of the pending state's UI, so this is the only place
 *  the variable and the DOM can drift apart — set them together, always. */
function showAttach(f: File | null) {
  pendingAttach = f
  $('attach-chip').hidden = !f
  if (!f) return
  $('attach-name').textContent = f.name
  $('attach-name').title = f.name // the chip elides; the tooltip has the whole name
  $('attach-size').textContent = humanSize(f.size)
}

$('btn-attach').addEventListener('click', () => ($('file-input') as HTMLInputElement).click())
;($('file-input') as HTMLInputElement).addEventListener('change', (e: any) => {
  const f = e.target.files?.[0]
  e.target.value = '' // so picking the same file twice still fires
  if (!f) return
  // Refused at PICK time rather than at Send: the limit is a property of the
  // file alone, and finding out after writing a caption is a worse way to learn.
  if (f.size > MAX_FILE) { toast(tr('Plik jest za duży — limit to {mb} MB', { mb: Math.floor(MAX_FILE / 1024 / 1024) })); return }
  showAttach(f)
})
$('attach-drop').addEventListener('click', () => showAttach(null))

/**
 * Empty the composer when the screen changes rooms.
 *
 * Switching rooms is the one moment the RECIPIENT changes while the composer
 * looks untouched — so text meant for one peer, or a file picked for them, would
 * otherwise sit one Send away from the next. Both go.
 */
function clearComposer() {
  ;($('msg-input') as HTMLInputElement).value = ''
  showAttach(null)
}

// ---- theme ---------------------------------------------------------------
// The choice is APPLIED by the inline script in <head> (see index.html, and the
// reason it cannot live here); this only reflects it and records it. Setting the
// attribute is the entire switch, because the palette is three token blocks and
// nothing hard-codes a colour.
//
// "Jak w systemie" removes the attribute rather than writing the current system
// value — the difference shows up when the machine flips at dusk: an app that
// stored "dark" at noon would then be wrong, while an absent attribute keeps
// following prefers-color-scheme, which is what the app did before there was
// any control at all.
{
  const sel = $('theme-select') as HTMLSelectElement
  if (sel) {
    sel.value = document.documentElement.getAttribute('data-theme') ?? 'system'
    sel.addEventListener('change', () => {
      const v = sel.value
      try {
        if (v === 'light' || v === 'dark') {
          document.documentElement.setAttribute('data-theme', v)
          localStorage.setItem('ec-theme', v)
        } else {
          document.documentElement.removeAttribute('data-theme')
          localStorage.removeItem('ec-theme')
        }
      } catch {}
    })
  }
}

// ---- language ------------------------------------------------------------
// The static markup carries its Polish as default content, so the app is
// readable before this runs and stays readable if it throws. `applyDom`
// translates it in place; switching repaints it without a reload, because the
// transport and every open ratchet would not survive one.
{
  const sel = $('lang-select') as HTMLSelectElement
  if (sel) {
    sel.value = getLocale()
    sel.addEventListener('change', () => { setLocale(sel.value); renderContacts(); renderGroups() })
  }
  document.documentElement.lang = getLocale()
  applyDom()
  paintTransportSetting()
  // The boot screen goes now and not a moment earlier: this is the first point
  // at which the page says what it means in the reader's language. Removed
  // rather than hidden — it has served its whole purpose and must never come
  // back over a running conversation.
  $('boot')?.remove()
  // Paint the two header badges through the same helper the running app uses.
  // Their markup carries the icon/text split from the start (so the phone rule
  // has something to collapse before anything is painted), and this makes the
  // wording translated from the first frame rather than after the first room.
  setBadge($('transport-badge'), 'badge relay', tr('⚪ Relay'), tr('Treść przez relay (GossipSub)'))
  setBadge($('e2e-badge'), 'badge e2e', tr('🔒 E2E interim'), tr('Szyfrowane E2E — interim, EH-2 w drodze'))
}
$('btn-wipeout').addEventListener('click', async () => {
  if (!confirm('Wipeout: skasować lokalną tożsamość software, wszystkie kontakty i cały stan tej przeglądarki?\n\nTego nie da się cofnąć — Twój klucz publiczny się zmieni, więc Ty i rozmówcy musicie wymienić się nowymi kluczami. Klucze w HSM (login HEM) zostają nietknięte.')) return
  // §10 WIPE — reset like a new machine. Tear the live session down first (leave
  // rooms so peers see us go, drop the transport), then delete every ec-* key we
  // own, then reload to login. HEM-held keys live in the HSM and are untouched.
  ecLog('WIPEOUT — clearing all local state')
  wiping = true // stop persistGroups: the reload below fires unload handlers that would re-save
  clearTimeout(persistTimer)
  try { for (const r of rooms.values()) r.conv?.leave() } catch {}
  try { client?.close() } catch {}
  for (const k of Object.keys(localStorage)) { if (k.startsWith('ec-')) localStorage.removeItem(k) }
  location.reload()
})

// ---- resizable sidebar / chat splitter (desktop; hidden on phones) ----
{
  const SB_MIN = 260, SB_MAX = 560, SB_DEF = 330
  const setW = (w: number) => document.documentElement.style.setProperty('--sidebar-w', w + 'px')
  const saved = parseInt(localStorage.getItem('ec-sidebar-w') || '', 10)
  if (saved >= SB_MIN && saved <= SB_MAX) setW(saved)
  const splitter = $('splitter'); const sidebar = document.querySelector('.sidebar') as HTMLElement
  let dragging = false
  splitter.addEventListener('mousedown', (e: any) => { dragging = true; splitter.classList.add('drag'); e.preventDefault() })
  window.addEventListener('mousemove', (e: any) => {
    if (!dragging) return
    const w = Math.max(SB_MIN, Math.min(SB_MAX, Math.round(e.clientX - sidebar.getBoundingClientRect().left)))
    setW(w)
  })
  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false; splitter.classList.remove('drag')
    localStorage.setItem('ec-sidebar-w', String(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10) || SB_DEF))
  })
  splitter.addEventListener('dblclick', () => { setW(SB_DEF); localStorage.setItem('ec-sidebar-w', String(SB_DEF)) })
}
// Close the group members popover on any outside click.
document.addEventListener('click', (e: any) => {
  const pop = $('members-pop')
  // The popover has two openers now (the chat header cluster and a row in the
  // group list), so "outside" means outside the popover AND outside whichever
  // element opened it.
  if (pop.hidden) return
  if (pop.contains(e.target)) return
  if ($('members-cluster').contains(e.target)) return
  if (popAnchor?.contains(e.target)) return
  pop.hidden = true
})
// Admin actions inside the members popover (event-delegated — the pop is rebuilt
// on every open). stopPropagation so the outside-click close above does not fire.
$('members-pop').addEventListener('click', (e: any) => {
  const gid = popMembersGid ?? activeGid
  const gu = gid ? groupsUI.get(gid) : null
  if (!gu) return
  const rm = (e.target as HTMLElement).closest('[data-rm]') as HTMLElement | null
  if (rm) { e.stopPropagation(); const pub = rm.getAttribute('data-rm')!
    void changeMembers(gu.gid, gu.members.filter((m) => m.pub !== pub), tr('{name} usunięty z grupy', { name: memberName(pub) })); return }
  const tog = (e.target as HTMLElement).closest('[data-addmember]') as HTMLElement | null
  if (tog) { e.stopPropagation(); const list = $('members-pop').querySelector('.m-add-list') as HTMLElement | null; if (list) list.hidden = !list.hidden; return }
  const add = (e.target as HTMLElement).closest('[data-add-pub]') as HTMLElement | null
  if (add) { e.stopPropagation(); const pub = add.getAttribute('data-add-pub')!
    void changeMembers(gu.gid, [...gu.members, { pub }], `${memberName(pub)} dodany do grupy`); return }
})

// ---- copy my pubkey ----
let toastT: any
function toast(msg: string) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show')
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 1500)
}
async function copyPub() {
  if (!session) return
  try {
    await navigator.clipboard.writeText(session.pub)
  } catch {
    const ta = document.createElement('textarea'); ta.value = session.pub; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy') } catch {} ta.remove()
  }
  toast(tr('Skopiowano klucz publiczny ✓'))
}
$('me-fp').addEventListener('dblclick', copyPub)       // double-click fingerprint → copy pubkey
$('sess-id').addEventListener('dblclick', copyPub)     // double-click Tożsamość → copy pubkey

// ---- placeholder tabs ----
for (const [tab, pane] of [['tab-contacts', 'contacts'], ['tab-groups', 'groups'], ['tab-network', 'network']]) {
  $(tab).addEventListener('click', () => {
    for (const t of ['tab-contacts', 'tab-groups', 'tab-network']) $(t).classList.toggle('active', t === tab)
    for (const p of ['contacts', 'groups', 'network']) $('pane-' + p).hidden = (p !== pane)
    if (pane === 'groups') renderGroups()
    if (pane === 'network') startNetwork(); else stopNetwork()
  })
}

// ---- Network tab: a live view of the transport, plus the node editor -------
let netTimer: any = null
const NODES_NOTE = tr('Kolejność decyduje o wyborze: pierwszy aktywny węzeł jest podstawowy, kolejne to zapas. Zmiany działają natychmiast — bez wylogowania.')
/**
 * The pane is built ONCE and only its live half repainted. The editor below it
 * holds a checkbox, arrows and prompt-driven input, and `renderNetwork` runs
 * every 2.5 s — rebuilding the editor under the user's cursor would swallow
 * clicks and re-bind handlers on every tick.
 */
function ensureNetworkShell() {
  if ($('net-live')) return
  $('pane-network').innerHTML = `<div id="net-live"></div>
    <div class="nodes-panel net-nodes">
      <div class="nodes-head"><span>${tr('Węzły sieci')}</span> <button class="node-add" id="net-node-add" type="button">${tr('+ dodaj')}</button></div>
      <div id="net-nodes-list"></div>
      <div class="net-note" id="net-nodes-note">${NODES_NOTE}</div>
      <button class="node-official" id="net-nodes-official" type="button">${tr('Wczytaj oficjalną listę węzłów')}</button>
    </div>`
  const note = () => $('net-nodes-note')
  bindNodeEditor('net-nodes-list', 'net-node-add',
    (t) => { note().textContent = t; note().classList.add('err') },
    () => {
      note().textContent = NODES_NOTE; note().classList.remove('err')
      // Live: the running session dials the new list from now on. Dropping the
      // node we are ON re-dials at once; a reorder waits for the next sweep.
      client?.setRelays(chosenRelays())
      renderNetwork()
    }, 'net-nodes-official')()
}
function renderNetwork() {
  const pane = $('pane-network'); if (!pane) return
  if (!client) { pane.innerHTML = `<div class="pane-label">${tr('Brak sesji — zaloguj się.')}</div>`; return }
  ensureNetworkShell()
  const s = client.netStatus()
  const relayHost = (s.relay.match(/dns4\/([^/]+)/) ?? s.relay.match(/\/\/([^/:]+)/) ?? [, s.relay.slice(0, 40)])[1]
  const relayPeer = (s.relay.match(/p2p\/([^/]+)/) ?? [, ''])[1]
  const groupTopics = new Set([...groupsUI.values()].map((g) => g.room?.topic).filter(Boolean))
  const gCount = s.topics.filter((t) => groupTopics.has(t)).length
  const online = s.link === 'online' && s.connected
  const linkTxt = online ? tr('połączony') : s.link === 'reconnecting' ? 'wznawiam…' : s.link === 'offline' ? 'offline' : tr('łączę…')
  const linkCls = online ? 'ok' : s.link === 'reconnecting' ? 'away' : 'bad'
  // Failover view (3b): the candidate node list, with the live one marked. A
  // failover is simply "the active relay is not the first choice".
  const nodeName = (a: string) => loadNodes().find((n) => n.addr === a)?.name
    ?? (a.match(/dns4\/([^/]+)/) ?? a.match(/ip6\/([^/]+)/) ?? [, a.slice(0, 28)])[1] as string
  const candidates = chosenRelays()
  const isFailover = candidates.length > 1 && s.relay !== candidates[0]
  const nodesRow = candidates.length > 1
    ? `<div class="net-row wrap"><span class="k">${tr('Lista węzłów')}</span><span class="v net-nodes chips">${candidates.map((a) => {
        const act = a === s.relay
        return `<span class="net-node${act ? ' act' : ''}" title="${escapeHtml(a)}">${act ? '●' : '○'} ${escapeHtml(nodeName(a))}</span>`
      }).join('')}</span></div>`
    : ''
  $('net-live').innerHTML = `<div class="net-card">
    <div class="net-row"><span class="k">${tr('Status')}</span><span class="v"><span class="dot ${linkCls}"></span> ${linkTxt}${s.peers ? ` · ${tr('{n} poł.', { n: s.peers })}` : ''}</span></div>
    <div class="net-row"><span class="k">${tr('Transport')}</span><span class="v">${escapeHtml(s.transport)}${WEBRTC_OFF ? ' <span class="net-tag">' + tr('bez WebRTC') + '</span>' : ''}</span></div>
    <div class="net-row"><span class="k">${tr('Węzeł (relay)')}</span><span class="v" title="${escapeHtml(s.relay)}">${escapeHtml(relayHost)}${isFailover ? ' <span class="net-tag">' + tr('failover') + '</span>' : ''}</span></div>
    ${nodesRow}
    ${relayPeer ? `<div class="net-row"><span class="k">${tr('PeerId węzła')}</span><span class="v mono" title="${escapeHtml(relayPeer)}">${escapeHtml(relayPeer)}</span></div>` : ''}
    <div class="net-row"><span class="k">${tr('Twój PeerId')}</span><span class="v mono" title="${escapeHtml(s.self)}">${escapeHtml(s.self)}</span></div>
    ${capReport && capReport.degraded.length ? `<div class="net-row wrap"><span class="k">${tr('Platforma')}</span><span class="v chips" title="${escapeHtml(capReport.ua)}">`
      + capReport.degraded.map((c) => `<span class="net-node">○ ${escapeHtml(c.id)}</span>`).join('')
      + `</span></div>` : ''}
    ${DEBUG ? `<div class="net-row"><span class="k">${tr('Ekran')}</span><span class="v" title="${escapeHtml(navigator.userAgent)}">`
      + `${window.innerWidth}×${window.innerHeight} · ${window.devicePixelRatio || 1}× · `
      + `${matchMedia('(max-width:900px),(max-height:560px)').matches ? tr('układ telefonu') : tr('układ pulpitu')}</span></div>
    <div class="net-row"><span class="k">${tr('Topiki')}</span><span class="v">${s.topics.length} <span class="net-sub">(grupy: ${gCount} · pary/self: ${s.topics.length - gCount})</span></span></div>` : ''}
  </div>
  <div class="net-note">${candidates.length > 1
    ? tr('Failover po liście węzłów: gdy pierwszy węzeł nie odpowiada, sesja przechodzi na następny. Węzły są zmeshowane, więc przełączenie nie dzieli rozmówców.')
    : tr('Wszystkie topiki na jednym połączeniu. Więcej węzłów (i failover) dodasz z edytowalnej listy w oknie logowania.')}</div>`
}
function startNetwork() { renderNetwork(); clearInterval(netTimer); netTimer = setInterval(renderNetwork, 2500) }
function stopNetwork() { clearInterval(netTimer); netTimer = null }

// ---- chat ----
/**
 * Is a conversation actually ON SCREEN? On a phone the list and the chat swap, so
 * after the back arrow nothing is — and a row left highlighted then points at a
 * conversation the user is not looking at. The room itself stays open either way;
 * this is only about what the list claims.
 */
const COMPACT = matchMedia('(max-width:900px),(max-height:560px)')
const chatOnScreen = () => !COMPACT.matches || $('app').classList.contains('chat-open')

const msgEls = new Map<string, HTMLElement>() // msg id → its reactions container (both directions share the id)
const QUICK_EMOJI = ['👍', '❤️', '😂', '😮']
function addReaction(msgId: string, emoji: string) {
  const rx = msgEls.get(msgId); if (!rx) return
  const chip = document.createElement('span'); chip.className = 'rchip'; chip.textContent = emoji
  rx.appendChild(chip)
}
/**
 * Reading older messages must not be interrupted by new ones. If the view is
 * scrolled up we leave it where it is, show a jump-to-latest button (with a
 * count of what arrived meanwhile) and only follow along when the reader is
 * already at the bottom.
 */
const NEAR_BOTTOM_PX = 80
let unread = 0
const atBottom = () => {
  const box = $('messages')
  return box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX
}
function refreshJump() {
  const show = !atBottom()
  $('to-bottom').hidden = !show
  if (!show) { unread = 0 }
  const badge = $('unread')
  badge.hidden = unread === 0
  badge.textContent = String(unread)
}
function jumpToLatest() {
  const box = $('messages')
  const before = box.scrollTop
  box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' })
  // Smooth scrolling is an enhancement, not the mechanism. Where it is a no-op
  // — headless Chromium, Firefox with general.smoothScroll off, reduced-motion
  // settings — scrollTo moves nothing and the button appears and then does
  // nothing at all. If the animation has not started by now, land immediately.
  setTimeout(() => {
    if (box.scrollTop === before) box.scrollTop = box.scrollHeight
    // …and re-decide here. The refreshJump() below runs while we are still at
    // the top, so it leaves the button ON; what turns it off is the scroll
    // event — and a scroll set from code does not always produce one (headless
    // Chromium doesn't). Without this the view lands at the newest message and
    // the ⬇ stays on screen over it, pointing nowhere.
    refreshJump()
  }, 300)
  unread = 0
  refreshJump()
}
$('messages').addEventListener('scroll', refreshJump)
$('to-bottom').addEventListener('click', jumpToLatest)

/** msg id → the little delivery marker under our own bubble. */
const stateEls = new Map<string, HTMLElement>()
function setDelivery(id: string, state: 'ok' | 'lost' | 'late', ms?: number) {
  const el = stateEls.get(id)
  if (!el) return
  if (state === 'ok') {
    el.textContent = tr(' · ✓ ') + tr('dostarczone')
    el.title = tr('Klient rozmówcy potwierdził odbiór{when} — to nie jest „przeczytane”', { when: ms !== undefined ? tr(' po {ms} ms', { ms }) : '' })
  } else if (state === 'late') {
    // It said ⚠, and it was wrong: the confirmation came in after we had given
    // up. Say so plainly rather than quietly flipping it to a clean ✓ — the
    // long gap is exactly the thing worth noticing.
    el.textContent = ` · ⏱ ${tr('dostarczone z opóźnieniem')}${ms !== undefined ? ` (${Math.round(ms / 1000)}s)` : ''}`
    el.title = tr('Potwierdzenie przyszło już po tym, jak przestaliśmy ponawiać — wiadomość jednak dotarła')
    el.classList.add('late')
  } else {
    el.textContent = tr(' · ⚠ niedostarczone')
    el.title = tr('Brak potwierdzenia mimo ponowień — rozmówca prawdopodobnie tego nie dostał')
    // The transport gave up; give the decision back to the user instead of
    // leaving a dead ⚠ that can only be fixed by retyping the message.
    const again = document.createElement('button')
    again.type = 'button'
    again.className = 'b-resend'
    again.textContent = tr('↻')
    again.title = tr('Wyślij ponownie')
    again.addEventListener('click', () => {
      if (!activeRoom()?.conv?.resend(id)) return
      el.textContent = tr(' · wysyłam ponownie…')
      el.title = tr('Czekam na potwierdzenie od klienta rozmówcy')
    })
    el.appendChild(again)
  }
}

/**
 * Put a straggler where it was written. The transcript is otherwise strictly
 * append-order, which is a lie the moment the transport reorders: the message
 * the peer typed first shows up under two that came after it, and a reader
 * following a conversation reads the answer before the question.
 *
 * Placement is by the sender's own clock (`ts` on the envelope), scanning back
 * from the end — recent messages are where a straggler lands, and an unbounded
 * walk over a long transcript is not worth it for a rare event.
 */
const REORDER_LOOKBACK = 60
function insertByTime(box: HTMLElement, row: HTMLElement, ts: number) {
  const rows = box.children
  let at: Element | null = null
  for (let i = rows.length - 1, seen = 0; i >= 0 && seen < REORDER_LOOKBACK; i--, seen++) {
    const prev = rows[i] as HTMLElement
    const prevTs = Number(prev.dataset?.ts ?? 0)
    if (!prevTs) continue // sysline or something without a clock — skip over it
    if (prevTs <= ts) break // everything from here back is older: we go after it
    at = prev
  }
  box.insertBefore(row, at)
}

function appendMsg(kind: 'me' | 'peer' | 'sys', text: string, ts?: number, id?: string, outOfOrder = false, who?: string, sent = false) {
  const box = $('messages')
  if (kind === 'sys') {
    const stick = atBottom()
    const s = document.createElement('div'); s.className = 'sysline'; s.textContent = text; box.appendChild(s)
    if (stick) box.scrollTop = box.scrollHeight
    return
  }
  const stick = (atBottom() && !outOfOrder) || kind === 'me' // sending always follows your own message
  const row = document.createElement('div'); row.className = 'mrow ' + (kind === 'me' ? 'out' : 'in')
  row.dataset.ts = String(ts ?? nowMs())
  const bub = document.createElement('div'); bub.className = 'bubble'
  if (who && kind === 'peer') { const w = document.createElement('div'); w.className = 'b-who'; w.textContent = who; bub.appendChild(w) }
  const t = document.createElement('div'); t.className = 'b-text'; renderBody(t, text)
  const m = document.createElement('div'); m.className = 'b-meta'; m.textContent = utcHHMM(ts ?? nowMs()) + ' UTC'
  if (outOfOrder) {
    // Same ⏱ as a late confirmation on our own side: one mark, one meaning —
    // "this one did not travel normally".
    const late = document.createElement('span'); late.className = 'late-mark'; late.textContent = tr(' ⏱ spóźniona')
    late.title = tr('Dotarła po nowszych wiadomościach — wstawiona w miejscu, w którym została napisana')
    m.appendChild(late)
  }
  if (kind === 'me' && id) {
    // Delivery state for our own messages. Instant-only: this says the peer's
    // client holds it, never that anyone read it.
    const st = document.createElement('span'); st.className = 'b-state'
    if (sent) {
      // A group broadcast: fire-and-forget over GossipSub, no per-recipient acks —
      // so it is "sent", never the 1:1 "sending…→delivered" that would hang here.
      st.textContent = tr(' · wysłano'); st.title = tr('Wysłane do grupy (broadcast — bez potwierdzeń doręczenia)')
    } else {
      st.textContent = tr(' · wysyłam…'); st.title = tr('Czekam na potwierdzenie od klienta rozmówcy')
      stateEls.set(id, st) // only 1:1 gets delivery updates
    }
    m.appendChild(st)
  }
  const rx = document.createElement('div'); rx.className = 'b-reactions'
  bub.append(t, m, rx); row.appendChild(bub)
  if (id) {
    msgEls.set(id, rx)
    attachReactionBar(row, id)
    // Touch has no hover: tap the bubble to reveal its reaction bar (one row at a
    // time), tap again to hide. On desktop hover still shows it; this just adds a
    // way in for fingers without a permanently-visible bar on every message.
    bub.addEventListener('click', (e: any) => {
      if (e.target.closest('button')) return // a control inside the bubble (e.g. ↻ resend), not a reveal
      const open = row.classList.contains('tapped')
      for (const r of $('messages').querySelectorAll('.mrow.tapped')) r.classList.remove('tapped')
      if (!open) row.classList.add('tapped')
    })
  }
  if (outOfOrder) insertByTime(box, row, Number(row.dataset.ts))
  else box.appendChild(row)
  if (stick) { box.scrollTop = box.scrollHeight; unread = 0 }
  else if (kind === 'peer') unread++
  refreshJump()
}
const setTyping = (on: boolean, name = '') => { $('typing-ind').textContent = on ? `${name} pisze…` : '' }
/** `?debug=1` adds per-frame lines (every handshake frame, every sealed payload). */
const DEBUG = HEM_TRACE // `?keys=1` implies it, so one flag does not half-enable the other
// Transport diagnostics answer a support question ("send me what the Network
// tab says"), not a daily one — and on a phone there is no console to ask
// instead, which is why they are hidden rather than deleted. The harness runs
// with ?debug=1, so its assertions on `sess-peerid` still find the row.
{ const row = document.getElementById('kv-peerid'); if (row) row.hidden = !DEBUG }

/**
 * The engine narrates itself here (lib/room.ts, lib/core.ts) — everything that
 * decides whether a room forms: when the relay picked up our topic, when a peer
 * became visible, every handshake attempt and its outcome, presence timeouts,
 * queued frames. This is the log to paste when "it does not work": the badge
 * only ever shows the last state, while the sequence is what explains it.
 */
const t0 = Date.now()
function ecLog(msg: string, level: 'info' | 'debug' = 'info') {
  if (level === 'debug' && !DEBUG) return
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(6)
  const style = level === 'debug' ? 'color:#79829c' : 'color:#6579e0;font-weight:600'
  console.log(`%c[ec ${t}s] %c${msg}`, 'color:#74788d', style)
}
ecLog(`app start — debug=${DEBUG} transport=${USE_MQTT ? `mqtt (${BROKER})` : 'libp2p'}`
  + ` rotation=${FORCED_ROTATION_SEC == null ? 'per-pair offset' : `forced ${String(Math.floor(FORCED_ROTATION_SEC / 3600)).padStart(2, '0')}:${String(Math.floor((FORCED_ROTATION_SEC % 3600) / 60)).padStart(2, '0')} UTC`};`
  + ' add ?debug=1 for the full trace, ?mqtt=1 for the broker transport, ?rot=<hour> to force the rollover time')
// Printed because the app-shell test is a guess about somebody else's software:
// Tauri picks the origin, and if a future version changes it, invite links
// quietly go back to naming an address only this device understands. This line
// is where you check, on the device, instead of reasoning about it.
ecLog(`origin: ${location.origin}${location.pathname}`
  + ` — invites will say ${inAppShell ? `${CANONICAL_ORIGIN}${CANONICAL_PATH} (app shell: no address bar to quote)` : 'this origin'}`)

/**
 * What this platform can actually do, checked before anything needs it.
 *
 * WebKitGTK is why this exists: the desktop webview has X25519 but no WebRTC,
 * and discovering that cost a debugging session instead of a line of output.
 * Every webview is a different subset — Android's Chromium tracks the Play
 * Store rather than the OS version, iOS is whatever WebKit the system shipped —
 * so this asks the platform instead of inferring from a version number.
 *
 * A missing REQUIRED capability stops the app with the reason. Refusing to
 * start is the honest outcome: without X25519 there is no rendezvous and no
 * handshake, and carrying on presents as a conversation that never connects,
 * which is indistinguishable from a network problem and sends the user hunting
 * in the wrong place.
 */
let capReport: Awaited<ReturnType<typeof probeCapabilities>> | null = null
void (async () => {
  const rep = await probeCapabilities()
  capReport = rep
  renderNetwork() // a phone has no console — the Network tab is where this is readable
  ecLog(formatReport(rep))
  for (const d of rep.degraded) ecLog(`capability (degraded): ${d.id} — ${d.note}`)
  if (rep.ok) return
  const card = document.querySelector('.login-card')
  if (!card) return
  card.innerHTML = `<h1>${escapeHtml(tr('Ta przeglądarka nie wystarczy'))}</h1>`
    + `<div class="sub">${escapeHtml(tr('Encedo Chat potrzebuje kilku funkcji, których tu brakuje. Bez nich nie da się nawet ustalić wspólnego pokoju, więc logowanie jest wyłączone.'))}</div>`
    + rep.missing.map((m) => `<div class="msg err" style="display:block">${escapeHtml(m.id)} — ${escapeHtml(m.note ?? '')}</div>`).join('')
    + `<div class="nodes-hint" style="margin-top:14px">${escapeHtml(rep.ua)}</div>`
})()

/**
 * Per-peer handshake state. The badge shows ONE thing, but a room can have more
 * than one peer id in it — a peer that reloaded, or a second tab logged into the
 * same identity, which can never complete a handshake with us. Rendering
 * whichever event came last made the badge flicker 🔐 → ⚠ → 🔐 while a perfectly
 * good session was carrying messages. The best state wins instead: if any peer
 * has a live ratchet, we are secure, whatever the others are doing.
 */
/** Update a room's security map, then paint the badge if that room is on screen.
 *  The map is per-room now: a background handshake must not move the foreground
 *  badge. On switching in, `paintSecurity` repaints from the room's own map. */
function noteSecurity(room: Room, peer: string, state: 'handshaking' | 'established' | 'failed') {
  if (peer) room.security.set(peer, state)
  else { room.security.clear(); room.security.set('', state) }
  if (room === activeRoom()) paintSecurity(room)
}
function paintSecurity(room: Room) {
  const states = [...room.security.values()]
  const best = states.includes('established') ? 'established'
    : states.includes('handshaking') ? 'handshaking' : states.length ? 'failed' : 'handshaking'
  const b = $('e2e-badge')
  if (best === 'established') setBadge(b, 'badge direct', tr('🔐 Secure'), tr('Handshake EH-2 uzgodniony — forward secrecy per wiadomość, hybryda PQ (ML-KEM-768)'))
  else if (best === 'handshaking') setBadge(b, 'badge e2e', tr('🤝 Securing…'), tr('Trwa uzgadnianie klucza sesji (msg1→msg2→msg3)'))
  else setBadge(b, 'badge fail', tr('⚠️ Not secure'), tr('Handshake nie doszedł do skutku — ponowi się przy następnym Announce'))
}

/**
 * Set a badge as icon + text, not one string.
 *
 * A phone header cannot fit three badges and a name, and hiding them outright
 * would drop the security state — the one thing that must stay visible. Split
 * so CSS can collapse the words on a narrow screen and leave the glyph; the
 * full wording survives in the tooltip. (A `::first-letter` trick was tried and
 * does not work: `.badge` is inline-flex, and that pseudo-element only applies
 * to block containers.)
 */
function setBadge(el: HTMLElement, cls: string, label: string, title: string) {
  const sp = label.indexOf(' ')
  const icon = sp > 0 ? label.slice(0, sp) : label
  const text = sp > 0 ? label.slice(sp + 1) : ''
  el.className = cls
  el.innerHTML = `<span class="b-ico">${escapeHtml(icon)}</span>${text ? `<span class="b-txt">${escapeHtml(text)}</span>` : ''}`
  el.title = title
}

function noteTransport(room: Room, state: string) {
  // `demoted=` belongs here too: a stall hands content back to GossipSub for the
  // rest of the conversation, and the badge claimed Direct throughout because
  // this matcher only knew the `conn=` vocabulary. Anything that is not
  // `conn=connected` paints Relay, which is the safe direction to be wrong in.
  if (/^(conn=(connected|failed|disconnected|closed)|demoted=)/.test(state)) room.transport = state
  if (room === activeRoom()) paintTransport(room)
}
function paintTransport(room: Room) {
  const b = $('transport-badge')
  if (room.transport.startsWith('conn=connected')) setBadge(b, 'badge direct', tr('🟢 Direct'), tr('Treść bezpośrednio P2P — relay ślepy na treść/rozmiary/timing'))
  else setBadge(b, 'badge relay', tr('⚪ Relay'), tr('Treść przez relay (GossipSub)'))
}


/**
 * The quick-reaction bar, for any bubble that has an id.
 *
 * Shared because it has to be: it is attached to messages and to files, in 1:1
 * rooms and in groups, and the version this replaced knew only about
 * `activeRoom()` — which is null whenever a group is on screen, so the bar was
 * inert in every group without anything saying so.
 */
function attachReactionBar(row: HTMLElement, id: string) {
  const bar = document.createElement('div'); bar.className = 'b-react'
  for (const e of QUICK_EMOJI) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = e
    btn.addEventListener('click', () => {
      row.classList.remove('tapped')
      if (activeGid) {
        const gu = groupsUI.get(activeGid); if (!gu?.room) return
        void gu.room.sendReaction(id, e)
        recordGroup(gu, { t: 'react', id, emoji: e })
      } else {
        const r = activeRoom(); if (!r?.conv) return
        r.conv.sendReaction(id, e)
        record(r, { t: 'react', id, emoji: e })
      }
    })
    bar.appendChild(btn)
  }
  row.appendChild(bar)
}

// ---- files ----------------------------------------------------------------
/** A file bubble: icon, name, size, and one action. Rendered like any other
 *  event so switching rooms replays it from the log. */
function appendFile(kind: 'me' | 'peer', env: FileEnv, ts: number, who?: string) {
  const box = $('messages')
  const row = document.createElement('div'); row.className = 'mrow ' + (kind === 'me' ? 'out' : 'in')
  const bub = document.createElement('div'); bub.className = 'bubble'
  if (who && kind === 'peer') {
    const w = document.createElement('div'); w.className = 'b-who'; w.textContent = who; bub.appendChild(w)
  }
  const wrap = document.createElement('div'); wrap.className = 'b-file' + (fileGone(env) ? ' gone' : '')
  const ico = document.createElement('span'); ico.className = 'f-ico'; ico.textContent = '📄'
  const info = document.createElement('div'); info.className = 'f-info'
  const name = document.createElement('div'); name.className = 'f-name'; name.textContent = env.name; name.title = env.name
  const sub = document.createElement('div'); sub.className = 'f-sub'
  sub.textContent = humanSize(env.size) + (fileGone(env) ? ' · ' + tr('wygasł') : '')
  info.append(name, sub)
  const act = document.createElement('button'); act.className = 'f-act'
  // No cid yet means it is still being encrypted or uploaded: the button shows
  // that state instead of offering a download that cannot work. attachFile
  // updates these two elements as it goes, via `fileEls`.
  const pending = !env.cid
  if (pending) { act.textContent = tr('Wysyłam…'); act.disabled = true }
  else setFileAction(act, env)
  if (!pending) act.addEventListener('click', () => void downloadFile(env, act))
  fileEls.set(env, { act, sub })
  wrap.append(ico, info, act)
  bub.appendChild(wrap)

  // The caption goes through the SAME renderer as a message body — text nodes
  // and link arrows, never markup. A second way of showing user text is how the
  // two drift apart and one of them ends up interpreting something.
  if (env.body) {
    const cap = document.createElement('div'); cap.className = 'b-text b-caption'
    renderBody(cap, env.body)
    bub.appendChild(cap)
  }

  const meta = document.createElement('div'); meta.className = 'b-meta'; meta.textContent = utcHHMM(ts) + ' UTC'
  // Reactions need both halves: somewhere to draw them, and an entry in msgEls
  // so an incoming reaction can find this bubble. appendFile had neither, which
  // is why files could not be reacted to at all.
  const rx = document.createElement('div'); rx.className = 'b-reactions'
  bub.append(meta, rx)
  if (env.id) msgEls.set(env.id, rx)
  row.appendChild(bub)
  if (env.id) attachReactionBar(row, env.id)
  box.appendChild(row)
  refreshJump()
}


/** How long the store keeps an upload. Advisory: the fetch is what decides, and
 *  the node collects within a minute of expiry — so this is used to grey a
 *  bubble out, never to claim precision the mechanism does not have. */
const FILE_TTL_MS = 5 * 60_000

/**
 * A pending file's action button and subtitle, so an upload in flight can keep
 * them current. Keyed by the envelope OBJECT: the same object is what the room
 * log holds, so mutating it in place and repainting these two elements is all
 * it takes for the bubble to become the finished one — no id to reconcile, and
 * nothing left behind if the room is switched away and replayed.
 */
const fileEls = new WeakMap<FileEnv, { act: HTMLButtonElement; sub: HTMLElement }>()

const humanSize = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} kB` : `${n} B`

/**
 * Encrypt a file, upload the ciphertext, and send the metadata down whichever
 * conversation is on screen.
 *
 * The order is the point: the bytes are ciphertext before they leave the
 * device, and everything needed to read them — key, name, type, chunking —
 * travels in the envelope over the ratchet or a group sender key. The store
 * gets a nameless blob and its size, and holds it for minutes.
 */
async function attachFile(f: File) {
  const gid = activeGid
  const room = gid ? null : activeRoom()
  if (!gid && !room?.conv) return
  if (f.size > MAX_FILE) { toast(tr('Plik jest za duży — limit to {mb} MB', { mb: Math.floor(MAX_FILE / 1024 / 1024) })); return }

  // Whatever is in the composer travels WITH the file, as one message. Taken
  // and cleared now, before the encrypt/upload await, so what is sent is what
  // the user saw when they picked the file — not whatever they typed since.
  const inp = $('msg-input') as HTMLInputElement
  const caption = inp.value.trim()
  inp.value = ''

  // The bubble appears NOW, before any work — on an 80 MB file the encrypt and
  // upload take long enough that a line of system text is indistinguishable
  // from a freeze. It is the same bubble that will hold the finished file; only
  // its action changes, from a progress label to Download.
  const pending: FileEnv = {
    v: 1, t: 'file', id: '', ts: nowMs(), seq: 0,
    cid: '', name: f.name, size: f.size, mime: f.type || 'application/octet-stream',
    key: '', chunk: 0, chunks: 0, alg: '',
    ...(caption ? { body: caption } : {}),
  } as unknown as FileEnv
  if (gid) recordGroup(groupsUI.get(gid)!, { t: 'file', kind: 'me', ts: pending.ts, file: pending })
  else record(room!, { t: 'file', kind: 'me', ts: pending.ts, file: pending })

  const show = (label: string, sub?: string) => {
    const els = fileEls.get(pending); if (!els) return
    els.act.textContent = label
    if (sub !== undefined) els.sub.textContent = sub
  }
  const pct = (a: number, b: number) => b > 0 ? Math.round((a / b) * 100) : 0

  try {
    const key = newFileKey()
    const plain = new Uint8Array(await f.arrayBuffer())
    const { manifest, cipher } = await encryptBytes(key, plain, undefined,
      (done, total) => show(tr('Szyfruję…'), `${humanSize(f.size)} · ${pct(done, total)}%`))
    const { cid } = await putBlob(cipher, {
      onProgress: (sent, total) => show(tr('Wysyłam…'), `${humanSize(f.size)} · ${pct(sent, total)}%`),
    })
    ;(window as any).__lastFileCid = cid // read by the browser harness; harmless elsewhere
    const meta = {
      cid, name: f.name, size: f.size, mime: f.type || 'application/octet-stream',
      key: b64(key), chunk: manifest.chunk, chunks: manifest.chunks, alg: manifest.alg,
      exp: nowMs() + FILE_TTL_MS,
      ...(caption ? { body: caption } : {}),
    }
    // Evidence line (debug only). Everything needed to fetch the blob from the
    // store and open it — which is the point: paste it into net/file-decrypt.ts
    // and watch ciphertext become the original, then drop the key and watch it
    // stay ciphertext. That demonstration is the whole claim of this design.
    //
    // It IS a complete capability to the file, so it is behind ?debug=1, and
    // bounded anyway: the blob is gone from the store within minutes.
    ecLog('file evidence · ' + JSON.stringify(meta), 'debug')
    // Fill the SAME object the log already holds, so the pending bubble becomes
    // the finished one and a replay after switching rooms shows the real file.
    Object.assign(pending, meta)
    pending.id = gid ? await groupsUI.get(gid)!.room!.sendFile(meta) : room!.conv!.sendFile(meta)
    // The bubble was drawn before the message had an id — it could not have one,
    // the send had not happened — so appendFile skipped BOTH halves of
    // reactions. Registering msgEls let other people's reactions land here;
    // without the bar, we still could not add our own to a file we sent.
    // Received files were fine, which is why this looked like it was about
    // expiry: by the time anyone tries, five minutes have passed.
    if (pending.id) {
      const row = fileEls.get(pending)?.act.closest('.mrow') as HTMLElement | null
      const rx = row?.querySelector('.b-reactions') as HTMLElement | null
      if (rx) msgEls.set(pending.id, rx)
      if (row) attachReactionBar(row, pending.id)
    }
    show(tr('Pobierz'), humanSize(f.size))
    const els = fileEls.get(pending)
    if (els) { els.act.disabled = false; els.act.onclick = () => void downloadFile(pending, els.act) }
  } catch (e: any) {
    ecLog('file upload failed: ' + (e?.message ?? e))
    show(tr('Błąd'), tr('nie wysłano'))
    fileEls.get(pending)?.act.closest('.b-file')?.classList.add('gone')
  }
}

/** Has this file outlived the store's retention? Advisory — the fetch decides. */
const fileGone = (f: FileEnv) => !!f.exp && nowMs() > f.exp

/**
 * Fetch, decrypt, and hand the result to the browser as a download.
 *
 * A file that is no longer there is not an error: this store drops uploads
 * after minutes by design, so the user is told to ask for it again rather than
 * to retry something that will never work.
 */
/**
 * What the action button reads, and whether it can be pressed. ONE rule, used
 * when the bubble is built and again once a download finishes — the two used to
 * disagree, and a saved file was left with a button dead for good.
 */
function setFileAction(act: HTMLButtonElement, env: FileEnv) {
  const gone = fileGone(env)
  act.textContent = gone ? tr('Wygasł') : tr('Pobierz')
  act.disabled = gone
  if (gone) { act.closest('.b-file')?.classList.add('gone'); return }
  // Expiry is a moment in time, and nothing here was watching the clock: a
  // bubble drawn while the file was alive offered Download for ever, and
  // pressing it minutes later hung rather than saying the file was gone.
  // One timer per bubble, fired at the moment itself — a poll would have to be
  // frequent enough to be honest and would then run all day for nothing.
  const left = env.exp! - nowMs()
  if (env.exp && left > 0 && left < 2 ** 31) setTimeout(() => setFileAction(act, env), left + 500)
}

async function downloadFile(env: FileEnv, btn: HTMLButtonElement) {
  btn.disabled = true; btn.textContent = tr('Pobieram…')
  // The same evidence line on the RECEIVING side, which is where it is most
  // useful: this is a file someone else encrypted, and the key arrived over the
  // ratchet rather than being ours to begin with.
  ecLog('file evidence · ' + JSON.stringify({
    cid: env.cid, name: env.name, size: env.size, mime: env.mime,
    key: env.key, chunk: env.chunk, chunks: env.chunks, alg: env.alg,
  }), 'debug')
  try {
    const cipher = await getBlob(env.cid)
    const plain = await decryptBytes(unb64(env.key), { alg: env.alg as any, chunk: env.chunk, chunks: env.chunks, size: env.size }, cipher)
    const url = URL.createObjectURL(new Blob([plain as any], { type: env.mime }))
    const a = document.createElement('a')
    a.href = url; a.download = env.name; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    btn.textContent = tr('Zapisano')
    // Saving once must not be the end of it: browsers put downloads in places
    // people do not find, and a second copy is a reasonable thing to want. The
    // label parks on "Zapisano" long enough to be read, then returns to whatever
    // the file's own state says — expiry included, since it may have run out
    // while the bubble sat there.
    setTimeout(() => setFileAction(btn, env), 5000)
  } catch (e: any) {
    // Past its lifetime, ANY failure is expiry. The store answers a request for
    // a swept file by going looking for it on the public network — a hunt for
    // something we deleted on purpose — so what comes back is a proxy timeout,
    // not the 404 this used to insist on. Reporting "error" then is both wrong
    // and useless: there is nothing to retry.
    const gone = e?.name === 'ExpiredError' || fileGone(env)
    btn.textContent = gone ? tr('Wygasł') : tr('Błąd')
    btn.closest('.b-file')?.classList.toggle('gone', gone)
    if (!gone) ecLog('file download failed: ' + (e?.message ?? e))
    if (gone) toast(tr('Plik wygasł — poproś o ponowne wysłanie'))
    // Back to what the file's own state says, not to whatever the label was on
    // entry. Restoring "Pobierz" on an expired file is how a dead download
    // became a button that invites pressing again — and hangs again.
    setTimeout(() => setFileAction(btn, env), 2500)
  }
}

// ---- links in a message ---------------------------------------------------
/**
 * Whether the "you are leaving" warning has been silenced for this session.
 *
 * RAM only, by decision: reloading restores it. Persisting a dismissed security
 * warning would outlive the reason someone dismissed it, and this product keeps
 * nothing else across a reload either.
 */
let linkWarnMuted = false

/**
 * Render a message body with its URLs found but NOT clickable — an arrow beside
 * each one opens it.
 *
 * Two properties follow from that split. The text stays a text node, so there
 * is still no path from a message to markup. And what you read is what you
 * would visit: a phishing link works by showing one thing and going to another,
 * and here there is no separate label that could disagree with the target.
 */
function renderBody(into: HTMLElement, text: string) {
  for (const part of splitByLinks(text)) {
    into.appendChild(document.createTextNode(part.text))
    const l = part.link
    if (!l?.href) continue // refused (credentials, bad scheme): text only, no arrow
    const a = document.createElement('a')
    a.className = 'lnk' + (l.warn ? ' warn' : '')
    // The conventional "opens elsewhere" mark: a box with an arrow leaving it.
    // Drawn, not typed — no font has a glyph everyone renders the same way, and
    // this is our own constant markup, never message content.
    a.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"'
      + ' stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/>'
      + '<path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg>'
    a.href = l.href
    a.target = '_blank'
    // noopener: the opened page must not reach back into this window.
    // no-referrer: otherwise the destination learns you came from here, which is
    // exactly the kind of metadata the rest of this app works to avoid.
    a.rel = 'noopener noreferrer'
    a.referrerPolicy = 'no-referrer'
    const host = l.asciiHost ?? new URL(l.href).host
    a.title = l.warn === 'idn'
      ? tr('Otwórz — uwaga, adres używa znaków spoza ASCII; przeglądarka pójdzie do {host}', { host })
      : tr('Otwórz {host} w nowej karcie', { host })
    a.addEventListener('click', async (e) => {
      if (linkWarnMuted) return // muted for this session: let the browser open it
      e.preventDefault()
      const warn = l.warn === 'idn'
        ? tr('Ten adres używa znaków spoza ASCII i może udawać inny. Przeglądarka otworzy: {host}.', { host }) + ' '
        : ''
      const r = await ask(tr('Otworzyć link?'),
        warn + tr('Wyjdziesz poza aplikację. Strona {host} pozna Twój adres IP i czas wejścia — tego rozmowa nie ujawnia.', { host }),
        tr('Otwórz'), tr('Nie pokazuj tego ostrzeżenia ponownie'), l.href)
      if (r.remember) linkWarnMuted = true
      // Nothing opens here: the dialog's affirmative control IS the link, so the
      // browser navigates on the user's click and no popup blocker is involved.
    })
    into.appendChild(a)
  }
}

/** Record one event on a room's log; render it if that room is on screen,
 *  otherwise (background) just count it and light the dot. Replaying the log
 *  through applyEv reconstructs the transcript exactly. */
const record = (room: Room, ev: Ev) => {
  room.log.push(ev); if (room.log.length > LOG_CAP) room.log.shift()
  if (isViewing(room)) applyEv(ev)
  else if (ev.t === 'msg' && ev.kind === 'peer') { room.unseen++; renderContacts() }
}
function applyEv(ev: Ev) {
  if (ev.t === 'msg') appendMsg(ev.kind, ev.text, ev.ts, ev.id, ev.ooo, ev.who, ev.sent)
  else if (ev.t === 'react') addReaction(ev.id, ev.emoji)
  else if (ev.t === 'delivery') setDelivery(ev.id, ev.state, ev.ms)
  else if (ev.t === 'file') appendFile(ev.kind, ev.file, ev.ts, ev.who)
  else appendMsg('sys', ev.text)
}

/**
 * Show a room that is already open. No teardown, no rebuild of the conversation
 * — clear the transcript DOM and REPLAY the room's log, then repaint the header
 * from the room's own snapshots. This subsumes the old "return to a room" path
 * that once desynced by calling leave() (the ratchet came back after N seconds,
 * one side flipped to Relay): switching between rooms now never touches any
 * conversation, so there is nothing to tear down.
 */
async function activateRoom(pub: string) {
  const room = rooms.get(pub); if (!room) return
  // Only when the target actually changes — activateRoom also runs for the room
  // already on screen (clicking the same peer, a repaint), and wiping a draft
  // then would be a bug rather than a precaution.
  const sameTarget = activePub === pub
  activePub = pub; activeGid = null // a 1:1 takes the screen — no group is active
  if (!sameTarget) clearComposer()
  $('members-cluster').hidden = true; $('members-pop').hidden = true // group-only UI
  room.unseen = 0
  $('chat-empty').hidden = true; $('chat-view').hidden = false
  showChatPane(true)
  $('peer-avatar').textContent = initials(room.contact.name)
  $('peer-name').textContent = room.contact.name
  // The peer is identified the same way we identify ourselves: 8-byte
  // fingerprint (comparable out of band) plus the HSM key id when it has one.
  const peerFp = fpCache.get(room.contact.pub) ?? await fingerprint(room.contact.pub)
  fpCache.set(room.contact.pub, peerFp)
  // No key glyph here: the row is labelled "odcisk klucza" already, and the two
  // extra characters were enough to wrap the fingerprint's last one.
  $('sess-peer').textContent = peerFp + (room.contact.kid ? ' · KID ' + shortKid(room.contact.kid) : '')
  $('sess-peer').title = room.contact.kid ? `KID ${room.contact.kid}` : room.contact.pub
  // The name leads the tooltip now that the header can cut it short; the
  // fingerprint (the out-of-band MITM check) follows, as before.
  $('peer-name').title = `${room.contact.name} · ` + tr('🔑 ') + peerFp + (room.contact.kid ? ` · KID ${room.contact.kid}` : '')
  $('sess-peerid').textContent = room.conv ? room.conv.peerId.slice(0, 16) + '…' : '…'
  // Rebuild the transcript from the log; the module render state (msgEls/stateEls)
  // now describes this room.
  $('messages').innerHTML = ''; msgEls.clear(); stateEls.clear(); setTyping(false)
  for (const ev of room.log) applyEv(ev)
  paintSecurity(room); paintTransport(room); paintStatus()
  startRotation(); renderContacts()
  void syncPresence() // foreground changed → light-watch the contact we just left
  void room.conv?.refresh() // re-announce / flush pending — cheap, no teardown
}

/**
 * Open a conversation. `foreground` = the user asked for it (a contact click):
 * show it. Background (an incoming handshake surfaced by presence) opens the
 * room to RECEIVE — the handshake must complete or the message never arrives —
 * but does NOT steal the view: it only lights the unread dot. Idempotent; an
 * already-open room is just re-shown (foreground) or left alone (background).
 */
async function openRoomFor(contact: Contact, foreground: boolean) {
  if (!session) return
  if (rooms.has(contact.pub)) { if (foreground) await activateRoom(contact.pub); return }

  const room: Room = {
    contact, conv: null, log: [], unseen: 0, inRoom: false,
    security: new Map([['', 'handshaking']]), transport: '', peerLabel: tr('łączę…'), lastPresence: null,
  }
  rooms.set(contact.pub, room)
  record(room, { t: 'sys', text: tr('Pokój otwarty — czekam na {name}…', { name: contact.name }) })
  if (foreground) await activateRoom(contact.pub)
  else renderContacts()

  try {
    let peerTyping = false
    let warnedForeign = false
    const conv = await (await clientReady!).open({ pub: contact.pub, kid: contact.kid }, {
      webrtc: wantsDirect(),
      onWebrtcState: (s) => noteTransport(room, s),
      onSecurity: (peer, state) => noteSecurity(room, peer, state),
      onLog: ecLog,
      onDelivered: (id, ms) => record(room, { t: 'delivery', id, state: 'ok', ms }),
      onUndelivered: (id) => record(room, { t: 'delivery', id, state: 'lost' }),
      onLateDelivered: (id, ms) => record(room, { t: 'delivery', id, state: 'late', ms }),
      onMessage: (from, msg, meta) => {
        ecLog(`message from ${from.slice(0, 12)}…: "${msg.body.slice(0, 40)}"${meta.outOfOrder ? ' (out of order)' : ''}`)
        // A message IS activity: a peer that just wrote is not "away". Presence
        // announces lag (a backgrounded tab throttles them), so a stale away/quiet
        // label sat over a live conversation — clear it on any inbound message.
        if (room.lastPresence !== 'active' && room.lastPresence !== 'join') {
          room.lastPresence = 'active'; room.inRoom = true; room.peerLabel = 'w pokoju'
          if (room === activeRoom()) paintStatus()
          renderContacts()
        }
        if (room === activeRoom()) { peerTyping = false; setTyping(false) }
        record(room, { t: 'msg', kind: 'peer', text: msg.body, ts: msg.ts, id: msg.id, ooo: meta.outOfOrder })
      },
      onTyping: (_from, state) => { peerTyping = state === 'start'; if (room === activeRoom()) setTyping(peerTyping, contact.name) },
      onReaction: (_from, r) => record(room, { t: 'react', id: r.to, emoji: r.emoji }),
      onFile: (_from, f) => record(room, { t: 'file', kind: 'peer', ts: nowMs(), file: f }),
      onForeign: () => {
        // The user is the only one who can fix this, so say it in the transcript
        // rather than in a console nobody has open. Two windows on one identity
        // is by far the common cause; a rotated contact key is the other.
        if (!warnedForeign) {
          warnedForeign = true
          record(room, { t: 'sys', text: tr('Uwaga: w tym pokoju jest ktoś, kto nie uwierzytelnia się jako ten kontakt')
            + tr(' — najczęściej druga zakładka zalogowana na tę samą tożsamość. Zamknij jedną z nich.') })
        }
      },
      onPresence: (_peer, ev) => {
        room.inRoom = ev !== 'leave'
        const label = ev === 'join' ? 'w pokoju' : ev === 'active' ? tr('wrócił/a') : ev === 'away' ? 'nieobecny/a'
          : ev === 'quiet' ? tr('brak sygnału') : tr('wyszedł/wyszła')
        // Presence belongs in the header, not in the transcript. Every tab switch
        // flips away→active; only entering and leaving are worth a line, and only
        // when the state really changed.
        if ((ev === 'join' || ev === 'leave') && room.lastPresence !== ev) record(room, { t: 'sys', text: `${contact.name} ${label}` })
        room.lastPresence = ev
        room.peerLabel = ev === 'leave' ? 'poza pokojem' : label
        if (room === activeRoom()) { paintStatus(); if (ev === 'leave') { peerTyping = false; setTyping(false) } }
        renderContacts()
      },
    })
    if (!rooms.has(contact.pub)) { await conv.leave(); return } // room was closed mid-connect
    room.conv = conv
    // This room is what a queued SKD was waiting for. Doing it here rather than
    // on a timer is what makes the repair take seconds: the moment the channel
    // exists, the key that could not travel travels.
    void flushPendingSkd(contact.pub)
    if (room === activeRoom()) $('sess-peerid').textContent = conv.peerId.slice(0, 16) + '…'
  } catch (e: any) {
    record(room, { t: 'sys', text: tr('Błąd: ') + (e?.message ?? e) })
    if (room === activeRoom()) $('peer-status').textContent = tr('błąd połączenia')
  }
}

/** Close a room for good: leave the conversation (presence:leave, ratchet stop)
 *  and drop it. Used on contact removal — ordinary view switches never close a
 *  room, that is the whole point. Resets the view if the closed room was on it. */
async function closeRoom(pub: string) {
  const room = rooms.get(pub); if (!room) return
  rooms.delete(pub)
  if (activePub === pub) { activePub = null; $('chat-view').hidden = true; $('chat-empty').hidden = false; showChatPane(false) }
  try { await room.conv?.leave() } catch {}
}

// The composer targets whichever room is on screen — wired once, not per open.
function sendComposer() {
  const inp = $('msg-input') as HTMLInputElement
  // A pending file takes the composer over. attachFile() reads the caption out
  // of this same input and clears it, so the text goes once, with the file —
  // and the chip is dropped BEFORE the awaits, so what is sent is what the user
  // saw when they pressed Send.
  if (pendingAttach) { const f = pendingAttach; showAttach(null); void attachFile(f); return }
  const t = inp.value.trim(); if (!t) return
  if (activeGid) { // a group is on screen — broadcast to it
    const gu = groupsUI.get(activeGid); if (!gu?.room) return
    inp.value = ''
    gu.room.sendText(t).then((id) => recordGroup(gu, { t: 'msg', kind: 'me', text: t, ts: nowMs(), id, sent: true })).catch((e) => ecLog('group send failed: ' + (e?.message ?? e)))
    return
  }
  const room = activeRoom(); if (!room?.conv) return
  const id = room.conv.sendText(t)
  ecLog(`sent "${t.slice(0, 40)}" (id ${id}); secured peers: ${room.conv.secured().length}`)
  record(room, { t: 'msg', kind: 'me', text: t, ts: nowMs(), id }); inp.value = ''
}
;($('send') as HTMLButtonElement).onclick = sendComposer
;($('msg-input') as HTMLInputElement).oninput = () => activeRoom()?.conv?.noteActivity()
;($('msg-input') as HTMLInputElement).onkeydown = (e: any) => { if (e.key === 'Enter') sendComposer() }

// ---- groups (§8: Sender Keys over the shared topic) ------------------------
// A group is another kind of room in the same chat pane. It reuses the transcript
// (with sender labels via `who`); membership + keys are the engine's (session.groups).
/**
 * `members` holds KEYS, not names.
 *
 * It used to store the name resolved at the moment the group was joined or
 * restored, and that moment is the wrong one: `restoreGroups` reads localStorage
 * and wins its race against `refreshContacts`, which reads the HEM (a search plus
 * one getPubKey per contact). So on every device that restored a group, every
 * member's name froze to eight characters of a public key before the contact
 * list existed — and nothing recomputed it. The admin's own device looked fine
 * only because it had created the group interactively, from contacts already
 * loaded.
 *
 * Resolving at paint time removes the race rather than ordering it, and takes
 * the staleness after adding or renaming a contact with it.
 */
interface GroupUI { gid: string; name: string; epoch: number; members: { pub: string }[]; room: GroupRoom | null; log: Ev[]; unseen: number }
const groupsUI = new Map<string, GroupUI>()

const memberName = (pub: string): string =>
  session && pub === session.pub ? 'Ty' : (contactsCache.find((c) => c.pub === pub)?.name ?? (fpCache.get(pub) ?? pub.slice(0, 8)))
const groupDisplay = (gu: GroupUI): string =>
  gu.name || gu.members.filter((m) => m.pub !== session?.pub).map((m) => memberName(m.pub)).join(', ') || 'Grupa'

// Overlapping-avatar cluster (inner .ga spans; the caller wraps in .avatar-cluster).
function avatarClusterHTML(members: { pub: string }[], max = 5): string {
  let html = members.slice(0, max).map((m) => {
    const n = memberName(m.pub)
    return `<span class="ga" title="${escapeHtml(n)}">${escapeHtml(initials(n))}</span>`
  }).join('')
  if (members.length > max) html += `<span class="ga more">+${members.length - max}</span>`
  return html
}
/** I am the group admin iff I am roster[0] — the creator (createGroup puts self
 *  first, and that order is preserved on the wire, in snapshots and across rekeys). */
const isGroupAdmin = (gu: GroupUI): boolean => !!session && gu.members[0]?.pub === session.pub

// Fill the group members popover: each participant with an online dot. The admin
// (roster[0]) also gets a remove "×" per other member and an add-member picker.
function renderMembersPop(gu: GroupUI) {
  const admin = isGroupAdmin(gu)
  const rows = gu.members.map((m) => {
    const you = m.pub === session?.pub, online = you || onlinePubs.has(m.pub) // you are, by definition, here
    const nm = memberName(m.pub)
    return `<div class="member-row"><div class="gavatar">${escapeHtml(initials(nm))}</div>`
      + `<span class="m-name">${escapeHtml(nm)}</span>`
      + `<span class="dot ${online ? 'ok' : ''}" title="${online ? 'online' : 'offline / nieznany'}"></span>`
      + (admin && !you ? `<button class="m-rm" data-rm="${escapeHtml(m.pub)}" title="${tr('Usuń z grupy')}">×</button>` : '')
      + `</div>`
  }).join('')
  let addUI = ''
  if (admin) {
    const eligible = contactsCache.filter((c) => !gu.members.some((m) => m.pub === c.pub))
    const opts = eligible.length
      ? eligible.map((c) => `<button class="m-add-pub" data-add-pub="${escapeHtml(c.pub)}">${escapeHtml(initials(c.name))} ${escapeHtml(c.name)}</button>`).join('')
      : `<div class="m-add-empty">${tr('wszystkie kontakty już w grupie')}</div>`
    addUI = `<div class="m-add-wrap"><button class="m-add-toggle" data-addmember="1">${tr('+ Dodaj członka')}</button>`
      + `<div class="m-add-list" hidden>${opts}</div></div>`
  }
  $('members-pop').innerHTML = `<div class="m-head">${escapeHtml(tr('{n} członków', { n: gu.members.length }))}</div>` + rows + addUI
}

/**
 * Admin changes the roster: rekey (epoch++, new group_secret → new topic, fresh
 * sending key), re-open the group on the new topic, redistribute the SKD to the
 * NEW roster (a removed member is never sent it → cannot derive the new topic or
 * open new messages), and persist. roster[0] (the admin) is preserved so
 * admin-ness stays stable. The other members redistribute their own fresh keys
 * when they receive the new epoch (see onGroupInvite).
 */
async function changeMembers(gid: string, newMembers: { pub: string }[], note: string) {
  const gu = groupsUI.get(gid); if (!gu || !client) return
  $('members-pop').hidden = true
  try {
    await client.groups.rekey(gid, newMembers.map((m) => ({ pub: m.pub })))
    gu.room?.stop()
    gu.members = newMembers
    gu.epoch++
    gu.room = await client.openGroup(gid, groupHandlers(gid))
    recordGroup(gu, { t: 'sys', text: note })
    await distributeGroup(gid, gu.name) // new roster only → removed member is locked out
    // The HEM marker's roster blob is now stale, and a stale one reconstructs
    // the OLD member set on a recovering device. One HSM call, best effort —
    // a marker that failed to update must not undo a membership change that did.
    client.groups.writeMarker(gid, gu.name).catch((e) => ecLog('marker update failed: ' + (e?.message ?? e)))
    await persistGroups()
    if (activeGid === gid) activateGroup(gid); else renderGroups()
    toast(note)
  } catch (e: any) { ecLog('group rekey failed: ' + (e?.message ?? e)); toast(tr('Nie udało się zmienić składu grupy')) }
}

/**
 * Open the members popover against an arbitrary anchor — used by the group
 * list, where the popover's default position (absolute, inside the chat header)
 * would put it in the wrong pane entirely. Same content, same handlers: the
 * popover is rendered by one function so the list and the header cannot drift.
 */
let popAnchor: HTMLElement | null = null
/**
 * Which group the popover is showing. It used to be implied by `activeGid`,
 * which was fine while the only opener was the open group's own header — but
 * the list can now open it for a group that is NOT on screen, and acting on
 * `activeGid` there would remove a member from the wrong group.
 */
let popMembersGid: string | null = null
function openMembersPopFor(gu: GroupUI, anchor: HTMLElement, ev?: MouseEvent) {
  const pop = $('members-pop')
  if (!pop.hidden && popAnchor === anchor) { pop.hidden = true; popAnchor = null; return } // toggle
  popMembersGid = gu.gid
  renderMembersPop(gu)
  // Open where the pointer is, not where the row starts. The anchor is a whole
  // sidebar row, so its rect pinned the popover to the far left however far
  // right the button actually was. A click gives a real position; touch and
  // keyboard do not, and fall back to the button's own rect.
  const r = anchor.getBoundingClientRect()
  const btn = (ev?.target as HTMLElement | undefined)?.getBoundingClientRect?.()
  pop.hidden = false // measure first: clamping needs the real size, not a guess
  const w = Math.min(pop.offsetWidth || 260, window.innerWidth - 16)
  const h = Math.min(pop.offsetHeight || 300, window.innerHeight - 16)
  const x = ev?.clientX ?? btn?.left ?? r.left
  const y = ev?.clientY ?? btn?.bottom ?? r.bottom
  // Centred under the pointer, then pulled back inside the viewport — the clamp
  // is what keeps it on screen on a phone, where it is nearly as wide as the app.
  pop.style.left = `${Math.max(8, Math.min(x - w / 2, window.innerWidth - w - 8))}px`
  pop.style.top = `${Math.max(8, Math.min(y + 8, window.innerHeight - h - 8))}px`
  popAnchor = anchor
}

/** Am I the admin of this group? roster[0] is the creator — the same rule the members popover uses. */
const iAmAdmin = (gu: GroupUI) => gu.members[0]?.pub === session?.pub

/**
 * Rename a group, for everyone.
 *
 * No rekey. The name already travels in the SKD envelope (`name`, app metadata
 * the crypto ignores), and a same-epoch SKD is the ordinary "here is my sender
 * key again" handoff — so re-sending it carries the new name without a new
 * epoch, a new topic, a re-subscribe, or throwing away forward-secret sending
 * chains. Rotating keys to change a label would cost all of that and buy
 * nothing: the label is not a key and is not what the roster MAC protects.
 *
 * Admin-only, and enforced on BOTH sides: any member may legitimately send a
 * same-epoch SKD, so without the receive-side check in `onGroupInvite` any
 * member could rename the group under everyone else.
 */
async function renameGroup(gid: string, name: string) {
  const gu = groupsUI.get(gid); if (!gu || !client) return
  if (!iAmAdmin(gu)) { toast(tr('Tylko administrator grupy może zmienić jej nazwę')); return }
  const before = gu.name
  gu.name = name
  try {
    await distributeGroup(gid, name)   // same epoch: a key handoff that carries the label
    // Whichever of the two records this device holds — the admin's key pair or a
    // member's imported public half — carries the name, so both follow a rename.
    client.groups.writeMarker(gid, name).catch((e) => ecLog('marker update failed: ' + (e?.message ?? e)))
    client.groups.writeMemberMarker(gid, name).catch((e) => ecLog('member marker update failed: ' + (e?.message ?? e)))
    await persistGroups()
    recordGroup(gu, { t: 'sys', text: `Nazwa grupy zmieniona na „${name}"` })
    if (activeGid === gid) activateGroup(gid); else renderGroups()
    toast(`Grupa to teraz „${name}"`)
  } catch (e: any) {
    gu.name = before; renderGroups()
    toast(tr('Nie udało się zmienić nazwy grupy: ') + (e?.message ?? e))
  }
}

/**
 * Leave a group on THIS device.
 *
 * There is no "delete for everyone", and there deliberately is not: the others
 * hold their own sender keys and their own copy of the group, and nothing in
 * the design lets one client revoke that. Leaving is local — the room stops,
 * the cache entry goes, and the remaining members carry on. Being removed FROM
 * the group is a different act, it belongs to the admin, and it is what the
 * members popover's × does.
 */
async function leaveGroup(gid: string) {
  const gu = groupsUI.get(gid); if (!gu) return
  gu.room?.stop()
  // Before the record goes: a group left behind in the device would come back on
  // the next machine as a group we cannot rejoin.
  await client?.groups.dropMemberMarker(gid).catch(() => {})
  groupsUI.delete(gid)
  // Same reset the 1:1 path uses when the room on screen goes away.
  if (activeGid === gid) { activeGid = null; $('chat-view').hidden = true; $('chat-empty').hidden = false; showChatPane(false) }
  await persistGroups()
  renderGroups()
  toast(tr('Opuszczono grupę „{name}”', { name: gu.name }))
}

/**
 * Dissolve a group — admin only.
 *
 * Three steps, in this order for a reason. Say so on the topic while everyone
 * can still read it; then rekey to a roster of just me, which is the ordinary
 * membership change applied to all of them at once and leaves nobody able to
 * derive the new topic; then destroy the GK, after which no epoch can ever be
 * advanced again, so the group cannot be revived.
 *
 * What it does NOT do is delete anything on their devices — they keep their
 * copy and it goes quiet. Nothing in this design reaches into another client,
 * and the confirm text says so rather than promising a deletion we cannot
 * perform. The notice is a courtesy, not a control: the lockout is the rekey.
 */
async function deleteGroup(gid: string) {
  const gu = groupsUI.get(gid); if (!gu || !client) return
  if (!iAmAdmin(gu)) { toast(tr('Tylko administrator może usunąć grupę')); return }
  try {
    // While the old topic is still theirs to read.
    try { await gu.room?.sendText('🛑 Grupa została usunięta przez administratora.') } catch {}
    await client.groups.deleteGroup(gid)   // rekey to me alone, then destroy the GK
    gu.room?.stop()
    groupsUI.delete(gid)
    if (activeGid === gid) { activeGid = null; $('chat-view').hidden = true; $('chat-empty').hidden = false; showChatPane(false) }
    await persistGroups()
    renderGroups()
    toast(tr('Grupa „{name}” usunięta', { name: gu.name }))
  } catch (e: any) {
    ecLog('group delete failed: ' + (e?.message ?? e))
    toast(tr('Nie udało się usunąć grupy: ') + (e?.message ?? e))
  }
}

function renderGroups() {
  const pane = $('pane-groups'); pane.innerHTML = ''
  const add = document.createElement('div'); add.className = 'add-row'
  const btn = document.createElement('button'); btn.className = 'add-btn'; btn.textContent = tr('+ Nowa grupa')
  btn.addEventListener('click', openGroupModal); add.appendChild(btn); pane.appendChild(add)
  if (!groupsUI.size) { const e = document.createElement('div'); e.className = 'pane-label'; e.textContent = tr('(brak grup — utwórz)'); pane.appendChild(e); return }
  for (const gu of groupsUI.values()) {
    const b = document.createElement('button'); b.className = 'contact' + (activeGid === gu.gid && chatOnScreen() ? ' active' : '') + (gu.unseen ? ' unread' : '')
    const pill = gu.unseen ? `<span class="c-unread">${gu.unseen > 99 ? '99+' : gu.unseen}</span>` : ''
    const admin = iAmAdmin(gu)
    b.innerHTML = `<div class="avatar">👥</div><div class="c-info"><div class="c-name">${escapeHtml(groupDisplay(gu))}</div>`
      + `<div class="c-sub"><span class="avatar-cluster sm">${avatarClusterHTML(gu.members, 4)}</span> ${gu.members.length} · 🔐</div></div>` + pill
      // Admin-only affordances, on the list itself: no need to open a group to
      // manage it. The members button opens the SAME popover the chat header
      // uses — one implementation, so the two cannot drift.
      // The key button is NOT admin-only, and that is the point: what breaks is
      // one member's outgoing direction, and only that member holds the sender
      // key that repairs it. An admin button would be the wrong hand on the
      // wrong lever — and a rekey, which is what "reset the group" would mean,
      // changes the topic and locks out whoever is asleep at that moment.
      + `<button class="g-edit" data-skd="1" title="${tr('Wyślij ponownie mój klucz do wszystkich')}">🔑</button>`
      + (admin ? `<button class="g-edit" data-ren="1" title="${tr('Zmień nazwę grupy')}">✎</button>` : '')
      + (admin ? `<button class="g-edit" data-mem="1" title="${tr('Uczestnicy')}">👥</button>` : '')
      + `<span class="c-x" title="${admin ? tr('Usuń grupę') : tr('Opuść grupę')}">×</span>`
    b.addEventListener('click', async (e: any) => {
      const d = e.target?.dataset ?? {}
      if (d.ren) {
        e.stopPropagation()
        const name = await promptName(tr('Zmień nazwę grupy'), tr('Nazwa zmieni się u wszystkich członków — klucze zostają bez zmian.'), gu.name, 'Nazwa grupy')
        if (name) await renameGroup(gu.gid, name)
        return
      }
      if (d.skd) {
        e.stopPropagation()
        // Same epoch, same topic, same roster — this is the ordinary sender-key
        // handoff, not a rekey. Nobody is locked out by pressing it twice.
        await distributeGroup(gu.gid, gu.name)
        toast(tr('Wysłano Twój klucz do członków grupy „{name}”', { name: groupDisplay(gu) }))
        return
      }
      if (d.mem) {
        e.stopPropagation()
        // Anchor the shared popover next to the row it was opened from.
        openMembersPopFor(gu, b, e as MouseEvent)
        return
      }
      if (e.target.classList.contains('c-x')) {
        e.stopPropagation()
        if (admin) {
          if (!(await ask(tr('Usunąć grupę?'), tr('Wszyscy członkowie „{name}” stracą dostęp do nowych wiadomości,', { name: gu.name })
            + tr(' a klucz grupy zostanie skasowany z HEM — grupy nie da się już przywrócić.')
            + tr(' Ich dotychczasowa kopia rozmowy pozostanie u nich; nie da się jej usunąć zdalnie.'), tr('Usuń grupę'))).ok) return
          await deleteGroup(gu.gid)
        } else {
          if (!(await ask(tr('Opuścić grupę?'), tr('„{name}” zniknie z tego urządzenia i przestaniesz odbierać wiadomości.', { name: gu.name })
            + tr(' Pozostali członkowie zachowują grupę — nie da się jej usunąć u nich.'), tr('Opuść'))).ok) return
          await leaveGroup(gu.gid)
        }
        return
      }
      void activateGroup(gu.gid)
    })
    pane.appendChild(b)
  }
}

/** Record a group event: render if the group is on screen, else count it (dot). */
function recordGroup(gu: GroupUI, ev: Ev) {
  gu.log.push(ev); if (gu.log.length > LOG_CAP) gu.log.shift()
  if (activeGid === gu.gid && $('app').classList.contains('chat-open')) applyEv(ev)
  else if (ev.t === 'msg' && ev.kind === 'peer') { gu.unseen++; renderGroups() }
  // A send must be durable at once (a spent counter cannot be reused after a fast
  // reload); a receive is self-healing (the chain re-walks) so it can debounce.
  if (ev.t === 'msg') { if (ev.kind === 'me') void persistGroups(); else schedulePersist() }
}

// ---- persistence: the group's full state survives a reload (§10) -----------
// Each group's full state (material + my sending chain + EVERY member's receiving
// key) is sealed to its own §10-encrypted blob, so a reload continues without
// re-distribution. The at-rest key is anchored to the identity: base = ECDH(IK,
// emp_pub) (one id.ecdh per session; IK stays in the HEM), per-group AES key =
// HKDF(base, gid) — see lib/gcache.ts. One blob per gid: ec-gcache-<handle>-<gid>.
const genc = new TextEncoder()
// Keyed by the identity's KID, never by its handle. A handle is a caption: two
// identities may share one (the KID tells them apart), and editing it would
// orphan everything stored under the old spelling — which is what used to
// happen to a renamed profile's contacts and group cache.
const empKey = () => 'ec-gcache-emp-' + (session?.idKey ?? '')
const gcachePrefix = () => 'ec-gcache-' + (session?.idKey ?? '') + '-'
const legacyGroupsKey = () => 'ec-groups-' + (session?.idKey ?? '') // B1 plaintext (migrated away)
let cacheBase: Uint8Array | null = null
let persistTimer: any

/** The §10 cache master secret ECDH(IK, emp_pub), computed once and cached. The
 *  emp public key is random and kept in localStorage; IK never leaves the HEM. */
async function ensureCacheBase(): Promise<Uint8Array | null> {
  if (cacheBase) return cacheBase
  if (!session) return null
  let empPub = localStorage.getItem(empKey())
  if (!empPub) { empPub = b64((await generateX25519()).pub); localStorage.setItem(empKey(), empPub) }
  try { cacheBase = await session.id.ecdh(empPub) } catch (e: any) { ecLog('group cache: ecdh(base) failed — ' + (e?.message ?? e), 'debug'); return null }
  return cacheBase
}

/** Seal every group's full state to its own §10 blob. Async; the message path uses
 *  schedulePersist (debounced) for receives, immediate for my own sends. */
async function persistGroups() {
  if (!client || !session || wiping) return // a wipeout must not be undone by the unload flush
  const base = await ensureCacheBase(); if (!base) return
  for (const snap of client.groups.snapshot()) {
    const gidHex = client.groups.gidHexOf(unb64(snap.gid))
    const name = groupsUI.get(gidHex)?.name ?? ''
    try {
      const blob = await sealCache(base, gidHex, genc.encode(JSON.stringify({ snap, name })))
      localStorage.setItem(gcachePrefix() + gidHex, blob)
    } catch (e: any) { ecLog('group persist failed: ' + (e?.message ?? e), 'debug') }
  }
}
function schedulePersist() { clearTimeout(persistTimer); persistTimer = setTimeout(() => void persistGroups(), 1500) }

/** Bring one group back from a decrypted snapshot: engine + UI + re-subscribe. */
async function addRestoredGroup(snap: any, name: string): Promise<string | null> {
  if (!client) return null
  try {
    const [gidHex] = await client.groups.restore([snap])
    if (!groupsUI.has(gidHex)) {
      const members = (snap.roster as { pub: string }[]).map((m) => ({ pub: m.pub }))
      const gu: GroupUI = { gid: gidHex, name: name || 'Grupa', epoch: snap.epoch, members, log: [], unseen: 0, room: null }
      groupsUI.set(gidHex, gu)
      gu.room = await client.openGroup(gidHex, groupHandlers(gidHex))
    }
    return gidHex
  } catch (e: any) { ecLog('group restore failed: ' + (e?.message ?? e), 'debug'); return null }
}

/** Restore groups from the encrypted §10 cache on startup (+ migrate a B1 blob). */

/**
 * Groups this DEVICE knows about but this browser does not — the other half of
 * §8's portable membership.
 *
 * The marker yields `GK_pub`, hence the group id, its name and a hint at who
 * administers it. It deliberately does NOT yield `group_secret` or any sender
 * key: those are forward-secret and client-side, so a recovered device knows a
 * group exists and cannot read a word of it until somebody hands the material
 * over. That handover already exists — it is the sender-key request — so this
 * adds a trigger, not a protocol.
 *
 * Silence is ambiguous and is reported as such. A request goes unanswered when
 * the admin is offline exactly as when we are no longer in the roster, and the
 * client cannot tell those apart: `answerSkdReq` is silent on purpose, because a
 * denial would confirm to a stranger that a group exists and that they are out
 * of it. So the timeout says both possibilities and offers to drop the entry
 * rather than asserting the unkind one.
 */
const RECOVER_TIMEOUT_MS = 45_000
/** How long after sign-in to go looking for groups the browser has forgotten. */
const RECOVERY_DELAY_MS = 20_000
async function recoverGroupsFromDevice() {
  if (!client || !session?.kid) return
  let found: Awaited<ReturnType<typeof client.groups.deviceGroups>> = []
  try { found = await client.groups.deviceGroups(session.kid) } catch (e: any) {
    ecLog('group recovery: cannot read the device group list — ' + (e?.message ?? e), 'debug'); return
  }
  const missing = found.filter((g) => !groupsUI.has(g.gidHex) && !client!.groups.has(g.gidHex))
  if (!missing.length) return
  ecLog(`group recovery: ${missing.length} group(s) in the device this browser does not hold`)

  for (const g of missing) {
    // The admin travels as four bytes, so it is resolved against the contacts
    // this device already holds — the same lookup the roster hints use.
    const admin = await resolveByKidHint(g.adminHint)
    if (!admin) {
      toast(tr('Grupa „{name}” jest w HEM, ale nie mam kontaktu do jej administratora.', { name: g.name || g.gidHex.slice(0, 8) }))
      continue
    }
    await openRoomFor(admin, false)
    const conv = rooms.get(admin.pub)?.conv
    if (!conv) { ecLog(`group recovery: no 1:1 to ${admin.name} yet`, 'debug'); continue }
    // Epoch 0: we do not know which one we are owed, and a responder that is
    // further ahead answers at its own — the ordinary newer-epoch path.
    conv.sendGroupSkdReq(b64(unhex(g.gidHex)), 0)
    ecLog(`group recovery: asked ${admin.name} for "${g.name}"`)
    setTimeout(() => {
      if (groupsUI.has(g.gidHex)) return // the distribution arrived and opened it
      void offerToForgetGroup(g)
    }, RECOVER_TIMEOUT_MS)
  }
}

/** Resolve a 4-byte KID hint against the contacts this device holds. */
async function resolveByKidHint(hint: string): Promise<Contact | null> {
  const want = hint.toLowerCase()
  for (const c of contactsCache) {
    const kid = await kidOf({ kid: c.kid, pub: unb64(c.pub) })
    if (kid && kid.slice(0, 8) === want) return c
  }
  return null
}

/** No answer within the window: say what that can mean, and offer to drop the entry. */
async function offerToForgetGroup(g: { gidHex: string; name: string; kid: string }) {
  const name = g.name || g.gidHex.slice(0, 8)
  const { ok } = await ask(
    tr('Nie udało się odzyskać grupy „{name}”', { name }),
    tr('Administrator nie odpowiedział. Może być offline — albo nie jesteś już członkiem tej grupy; tego nie da się rozróżnić.')
      + tr(' Usunąć wpis grupy z HEM? Jeśli nie, spróbuję ponownie przy następnym logowaniu.'),
    tr('Usuń wpis'),
  )
  if (!ok || !client) return
  try {
    await client.groups.forgetDeviceGroup(g.kid)
    toast(tr('Wpis grupy „{name}” usunięty z HEM', { name }))
  } catch (e: any) { ecLog('group recovery: could not delete the marker — ' + (e?.message ?? e), 'debug') }
}

async function restoreGroups() {
  if (!client || !session) return
  const base = await ensureCacheBase(); if (!base) return
  const seen = new Set<string>()
  const prefix = gcachePrefix()
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith(prefix)) continue
    const gidHex = k.slice(prefix.length)
    const blob = localStorage.getItem(k); if (!blob) continue
    const pt = await openCache(base, gidHex, blob)
    if (!pt) { ecLog('group cache: decrypt failed for ' + gidHex.slice(0, 8) + '…', 'debug'); continue }
    let parsed: any; try { parsed = JSON.parse(dec.decode(pt)) } catch { continue }
    if (await addRestoredGroup(parsed.snap, parsed.name)) seen.add(gidHex)
  }
  await migrateLegacyGroups(seen)
  renderGroups()
  if (seen.size) ecLog(`restored ${seen.size} group(s) from the encrypted cache`)
  // The cache is what this browser remembers; the device is what the HEM knows.
  // Anything in the second and not the first is a group we have to be let back
  // into — which needs contacts loaded, so it runs after them.
  //
  // DELAYED, because it is recovery and not the way in. Reading the marker list
  // costs a key search plus a token and a getPubKey per group — 4.2 s of device
  // time in a measured sign-in, spent competing with the room the user is
  // waiting for, and usually to confirm there is nothing to do. A group that IS
  // missing needs a round of `group-skd-req` over a 1:1 anyway, so half a minute
  // later changes nothing about when it comes back.
  setTimeout(() => { void refreshContacts().then(() => recoverGroupsFromDevice()) }, RECOVERY_DELAY_MS)
}

/** One-time upgrade: a B1 plaintext blob (ec-groups-<handle>) → encrypt each group
 *  into the §10 cache, then delete the plaintext. Prevents groups vanishing on the
 *  B1→B2 upgrade the same way the identity change once broke 1:1. */
async function migrateLegacyGroups(seen: Set<string>) {
  const raw = localStorage.getItem(legacyGroupsKey()); if (!raw || !client) return
  try {
    const blob = JSON.parse(raw); const names = new Map<string, string>(blob.names ?? [])
    for (const snap of blob.groups ?? []) {
      const gidHex = client.groups.gidHexOf(unb64(snap.gid))
      if (!seen.has(gidHex)) { if (await addRestoredGroup(snap, names.get(gidHex) ?? '')) seen.add(gidHex) }
    }
    await persistGroups()                    // re-seal as encrypted blobs
    localStorage.removeItem(legacyGroupsKey()) // drop the plaintext
    ecLog('migrated the B1 plaintext group cache to the §10 encrypted cache')
  } catch (e: any) { ecLog('legacy group migration failed: ' + (e?.message ?? e), 'debug') }
}

/** Show a group in the chat pane (reuses #messages; sender labels via `who`). */
async function activateGroup(gid: string) {
  const gu = groupsUI.get(gid); if (!gu) return
  const sameTarget = activeGid === gid // as in activateRoom: a new audience empties the composer, a repaint does not
  activeGid = gid; activePub = null // a group takes over — no 1:1 is "active"
  if (!sameTarget) clearComposer()
  gu.unseen = 0
  $('chat-empty').hidden = true; $('chat-view').hidden = false
  showChatPane(true)
  $('peer-avatar').textContent = tr('👥')
  $('peer-name').textContent = groupDisplay(gu); $('peer-name').title = ''
  $('peer-dot').className = 'dot ok'; $('peer-status').textContent = tr('{n} członków', { n: gu.members.length })
  // Participant cluster in the header → click to see the full member list.
  const cluster = $('members-cluster'); cluster.hidden = false; cluster.innerHTML = avatarClusterHTML(gu.members)
  cluster.title = tr('Uczestnicy grupy')
  cluster.onclick = (e: any) => { e.stopPropagation(); openMembersPopFor(gu, cluster, e as MouseEvent) }
  $('members-pop').hidden = true
  setBadge($('e2e-badge'), 'badge direct', tr('🔐 Secure'), tr('Grupa — Sender Keys + per-recipient HMAC (deniable, §8)'))
  $('e2e-badge').title = tr('Grupa — Sender Keys + per-recipient HMAC (deniable, §8)')
  setBadge($('transport-badge'), 'badge relay', tr('⚪ Relay'), tr('Grupa idzie przez relay (GossipSub) — nie WebRTC'))
  $('transport-badge').title = tr('Grupa idzie przez relay (GossipSub) — nie WebRTC')
  $('sess-peerid').textContent = gid.slice(0, 12) + '…'
  $('messages').innerHTML = ''; msgEls.clear(); stateEls.clear(); setTyping(false)
  for (const ev of gu.log) applyEv(ev)
  startRotation(); renderGroups()
}

const groupHandlers = (gid: string) => ({
  onMessage: (from: string, env: { body: string; ts: number; id: string }) =>
    recordGroup(groupsUI.get(gid)!, { t: 'msg', kind: from === session?.pub ? 'me' : 'peer', text: env.body, ts: env.ts, id: env.id, who: memberName(from) }),
  onReaction: (_from: string, r: { to: string; emoji: string }) =>
    recordGroup(groupsUI.get(gid)!, { t: 'react', id: r.to, emoji: r.emoji }),
  // A file in a group is the same envelope as in a 1:1 — every member holds the
  // key it carries, so each fetches the blob itself within its short life.
  onFile: (from: string, f: FileEnv) =>
    recordGroup(groupsUI.get(gid)!, { t: 'file', kind: from === session?.pub ? 'me' : 'peer', ts: nowMs(), file: f, who: memberName(from) }),
  // A member we cannot decrypt: ask them to hand their sender key over again.
  onNeedSenderKey: (memberPub: string) => { void askForSenderKey(gid, memberPub) },
  onLog: (m: string) => ecLog('group: ' + m, 'debug'),
})

/**
 * Members whose SKD could not be handed over yet — `${gid}|${memberPub}`.
 *
 * A sender key is given out ONCE, over a 1:1 that may not be up at that instant,
 * and the receiving side of Sender Keys cannot derive what it was never given. So
 * a delivery that quietly failed here used to mean that member could not read
 * ANY of our group messages, for the life of the epoch, while every other
 * direction looked perfect — the one-way group silence this queue exists to end.
 */
const pendingSkd = new Set<string>()

/** Hand my SKD for `gid` (with the display name) to every other member over 1:1.
 *  `only` narrows it to one member (a retry, or an answer to their request). */
async function distributeGroup(gid: string, name: string, only?: string) {
  if (!client) return
  for (const m of groupsUI.get(gid)?.members ?? []) {
    if (m.pub === session?.pub) continue
    if (only && m.pub !== only) continue
    // Per recipient: when I am the admin, skdFor attaches THIS member's roster MAC
    // (rk from ECDH(GK_priv, IK_m)); a member's own redistribution carries none.
    // `continue`, not `return`: one member we cannot build an SKD for must not
    // cost the sender key to everyone standing behind them in the roster.
    const skd = await client.groups.skdFor(gid, m.pub); if (!skd) continue
    const contact = contactsCache.find((c) => c.pub === m.pub) ?? { name: memberName(m.pub), pub: m.pub, source: 'local' as const }
    await openRoomFor(contact, false) // ensure a background 1:1 room; sendGroupSkd queues until it is up
    // openRoomFor returns immediately when a room already EXISTS, and a room that
    // is still opening has no conv yet — so this is reached with conv === null
    // often enough to matter, and dropping it there is precisely the bug.
    const conv = rooms.get(m.pub)?.conv
    if (conv) { conv.sendGroupSkd({ ...skd, name }); pendingSkd.delete(`${gid}|${m.pub}`) }
    else {
      pendingSkd.add(`${gid}|${m.pub}`)
      ecLog(`group: 1:1 to ${contact.name} not ready — SKD queued for when it is`)
    }
  }
}

/** Re-try every queued SKD; `forPub` limits it to one contact (their room just came up). */
async function flushPendingSkd(forPub?: string) {
  for (const key of [...pendingSkd]) {
    const [gid, pub] = key.split('|')
    if (forPub && pub !== forPub) continue
    const gu = groupsUI.get(gid)
    if (!gu) { pendingSkd.delete(key); continue } // group is gone — nothing to hand over
    await distributeGroup(gid, gu.name, pub)
  }
}

/**
 * A member is sending group frames we cannot open, because their sender key never
 * reached us. Ask them for it over the 1:1 — the same channel an SKD travels on,
 * which is what makes the answer authenticated.
 *
 * Rate-limited upstream in `grouproom.ts` (once per member per 30 s), because the
 * condition fires on EVERY frame that member sends.
 */
async function askForSenderKey(gid: string, memberPub: string) {
  const gu = groupsUI.get(gid); if (!gu || !client) return
  const contact = contactsCache.find((c) => c.pub === memberPub)
    ?? { name: memberName(memberPub), pub: memberPub, source: 'local' as const }
  // The gid travels base64, as in the SKD itself; take the bytes off the live
  // session rather than parsing our own hex key back into them.
  const gs = client.groups.session(gid); if (!gs) return
  await openRoomFor(contact, false)
  const conv = rooms.get(memberPub)?.conv
  if (conv) conv.sendGroupSkdReq(b64(gs.gid), gu.epoch)
  else ecLog(`group: cannot ask ${contact.name} for a sender key — no 1:1 yet`)
}

/**
 * The other half: a contact says it cannot open our group frames. Hand our sender
 * key over again, at the epoch we are on.
 *
 * The roster check is the security of this, not a tidiness check. `from` is the
 * IK the 1:1 ratchet authenticated, so it is really them — but "really them" is
 * not "in this group", and a sender key handed to a non-member would let them
 * read a group they were removed from. A removed member asking is the expected
 * case, not a hypothetical one: they still hold our contact and the old group id.
 */
async function answerSkdReq(from: string, req: { gid: string; epoch: number }) {
  if (!client) return
  const gid = client.groups.gidHexOf(unb64(req.gid))
  const gu = groupsUI.get(gid); if (!gu) return
  if (!gu.members.some((m) => m.pub === from)) {
    ecLog(`group: ${from.slice(0, 12)}… asked for a sender key but is not in the roster — ignored`)
    return
  }
  await distributeGroup(gid, gu.name, from)
}

/** An SKD arrived over some 1:1 (already applied to the engine): join a new group
 *  (and hand my key back once), or update an existing one on a rekey. */
async function onGroupInvite(from: string, skd: GroupSkdEnv) {
  if (!client) return
  const gid = client.groups.gidHexOf(unb64(skd.gid))
  const members = skd.roster.map((pub) => ({ pub, name: memberName(pub) }))
  let gu = groupsUI.get(gid)
  if (!gu) {
    gu = { gid, name: skd.name || 'Grupa', epoch: skd.epoch, members, log: [], unseen: 0, room: null }
    groupsUI.set(gid, gu)
    gu.room = await client.openGroup(gid, groupHandlers(gid))
    toast(tr('Dołączono do grupy „{name}”', { name: groupDisplay(gu) }))
    void distributeGroup(gid, gu.name) // hand my sender key to everyone, once
    // The portable half: GK_pub goes into the device, so this membership survives
    // the browser. Best effort — it fails when a SECOND identity here is already
    // in this group (one device holds a key once), and then the group still works
    // from the local cache, just without a record that outlives it.
    void client.groups.writeMemberMarker(gid, gu.name).then(
      (ok) => { if (!ok) ecLog(`group: no portable record for ${gid.slice(0, 8)}… (not admin-owned, or the key is already here)`, 'debug') },
      (e: any) => ecLog('group: member marker failed — ' + (e?.message ?? e), 'debug'),
    )
  } else {
    gu.members = members
    // The name is app metadata the roster MAC does NOT cover, and any member may
    // legitimately send a same-epoch SKD (that is the ordinary sender-key
    // handoff) — so without this check any member could rename the group under
    // everyone else. The admin is roster[0]; who `from` is was authenticated by
    // the 1:1 ratchet the SKD arrived on.
    if (skd.name && from === members[0]?.pub) gu.name = skd.name
    // A newer epoch means a rekey → a new group_secret → a new topic, so the room
    // must re-join. A *same-epoch* SKD is just a member handing us its sender key
    // (already applied to the engine): keep the live room — tearing it down here
    // churns the mesh on every member's join-back and can drop in-flight frames.
    if (skd.epoch > gu.epoch) {
      gu.epoch = skd.epoch
      gu.room?.stop(); gu.room = await client.openGroup(gid, groupHandlers(gid))
      if (activeGid === gid) void activateGroup(gid)
      // A rekey gave the engine a FRESH sending key for us at this epoch, so hand
      // it to the new roster — otherwise only the admin (who redistributed) would
      // be readable after an add/remove. Same-epoch SKDs (the others doing the
      // same) hit the else-branch and do not re-trigger, so this converges.
      void distributeGroup(gid, gu.name)
    }
  }
  renderGroups()
  void persistGroups() // key/membership changed — flush now, not on the debounce
}

// ---- create-group modal ----
function openGroupModal() {
  const list = $('group-members'); list.innerHTML = ''
  if (!contactsCache.length) { const e = document.createElement('div'); e.className = 'pane-label'; e.textContent = tr('Najpierw dodaj kontakty — członkowie grupy muszą być kontaktami.'); list.appendChild(e) }
  for (const c of contactsCache) {
    const row = document.createElement('label'); row.className = 'gmember'
    row.innerHTML = `<div class="gavatar">${escapeHtml(initials(c.name))}</div><span class="gm-name">${escapeHtml(c.name)}</span>`
      + `<input type="checkbox" value="${escapeHtml(c.pub)}">`
    list.appendChild(row)
  }
  ;($('group-name') as HTMLInputElement).value = ''; clr('group-msg')
  $('scrim').classList.add('open'); $('group-modal').classList.add('open'); $('group-name').focus()
}
const closeGroupModal = () => { $('scrim').classList.remove('open'); $('group-modal').classList.remove('open') }
$('group-cancel').addEventListener('click', closeGroupModal)
$('group-create').addEventListener('click', async () => {
  if (!client || !session) return
  const name = val('group-name')
  const picked = [...document.querySelectorAll('#group-members input:checked')].map((el) => (el as HTMLInputElement).value)
  if (!name) { setMsg('group-msg', tr('Podaj nazwę grupy.'), 'err'); return }
  if (!picked.length) { setMsg('group-msg', tr('Wybierz co najmniej jednego członka.'), 'err'); return }
  try {
    const roster = [{ pub: session.pub }, ...picked.map((pub) => ({ pub }))]
    // GK comes from whatever backs this identity (bucket A): a HEM identity mints
    // it inside the HSM, a software one falls back to a scalar. The app does not
    // choose — and must not, or the two paths drift.
    const gid = await client.groups.createGroupWithNewKey(`chat-gk-${name}`.slice(0, 32), roster, name)
    const gu: GroupUI = { gid, name, epoch: 0, members: roster.map((m) => ({ pub: m.pub })), log: [], unseen: 0, room: null }
    groupsUI.set(gid, gu)
    gu.room = await client.openGroup(gid, groupHandlers(gid))
    closeGroupModal()
    await activateGroup(gid)
    void distributeGroup(gid, name) // send the invite (keys) to each member over 1:1
    void persistGroups() // the new group must survive a reload immediately
    toast(tr('Grupa „{name}” utworzona — rozsyłam zaproszenia…', { name }))
  } catch (e: any) { setMsg('group-msg', tr('Błąd: ') + (e?.message ?? e), 'err') }
})

document.addEventListener('visibilitychange', () => {
  ecLog(document.hidden ? 'tab hidden — browser will throttle our timers' : 'tab visible — re-announcing')
  // Every open room, not just the visible one: a background conversation must
  // stay alive across the throttle too. Coming back, the tab's timers were
  // throttled while hidden, so our Announce heartbeat went quiet and the peer may
  // already have written us off — speak up now instead of waiting for the tick.
  for (const r of rooms.values()) { if (document.hidden) r.conv?.noteAway(); else r.conv?.refresh() }
  if (document.hidden) void persistGroups() // best-effort flush on backgrounding (encrypt is async); sends are already durable
})
/**
 * Phone layout: one pane at a time (see the ≤720px rules in index.html). The
 * class is what switches between the contact list and the conversation; on a
 * desktop it changes nothing.
 */
const showChatPane = (on: boolean) => $('app').classList.toggle('chat-open', on)
$('btn-back').addEventListener('click', () => { showChatPane(false); renderContacts(); renderGroups() })

/**
 * Keep the app exactly as tall as the VISIBLE viewport.
 *
 * A software keyboard does not resize `100vh` — that is the screen — so the
 * composer ends up underneath it, which is the single most common way a chat
 * app is unusable on a phone. `visualViewport` reports what is actually visible,
 * including while the keyboard animates.
 */
function trackViewport() {
  const vv = window.visualViewport
  const apply = () => {
    const visible = Math.round(vv?.height ?? window.innerHeight)
    // Clamp to the visible area ONLY while a field is focused and something is
    // genuinely covering the screen. `visualViewport` can report a smaller
    // height for other reasons (a headless viewport override does), and shrinking
    // the app to that would waste a third of the screen for no reason.
    const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement
    const covered = window.innerHeight - visible > 120
    document.documentElement.style.setProperty('--app-h', typing && covered ? `${visible}px` : '100dvh')
  }
  apply()
  vv?.addEventListener('resize', apply)
  vv?.addEventListener('scroll', apply)
  window.addEventListener('resize', apply) // emulated viewports (and desktops) resize the window, not visualViewport
  document.addEventListener('focusin', apply)
  document.addEventListener('focusout', () => setTimeout(apply, 100))
  window.addEventListener('orientationchange', () => setTimeout(apply, 250))
}

// The browser tells us about the network directly — no need to infer it from
// silence. This is what makes a Wi-Fi drop or a tunnel show up instantly instead
// of after a couple of missed heartbeats.
window.addEventListener('offline', () => {
  ecLog('browser: offline')
  linkState = 'offline'; paintStatus()
  client?.setOffline(true)
})
window.addEventListener('online', () => {
  ecLog('browser: online')
  linkState = 'reconnecting'; paintStatus()
  client?.setOffline(false)
})

// Leaving the page ends the whole session, not just the open room: the §9.1
// watch has to stop announcing, or the next window sees a rival that is already
// gone and closes itself for nothing.
window.addEventListener('beforeunload', () => { void persistGroups(); for (const r of rooms.values()) r.conv?.leave(); client?.close() })

// ---- room rotation countdown — the ACTIVE pair's real instant (midnight+offset) ----
// The topic rotates per pair at `UTC-midnight + rotationOffsetSec` (§5.4), so the
// old "time to next UTC midnight" was both wrong and identical for every contact.
// Each tick reads the on-screen conversation's offset and counts to its rotation.
// Groups rotate per epoch (membership change), not daily, so the badge is hidden
// while a group is on screen.
function startRotation() {
  if (rotTimer) return
  const tick = () => {
    const el = document.getElementById('rot'); if (!el) return
    const badge = el.closest('.badge.rotate') as HTMLElement | null
    const conv = activeGid ? null : activeRoom()?.conv
    if (!conv) { if (badge) badge.style.display = 'none'; return }
    if (badge) badge.style.display = ''
    const now = Date.now()
    const next = nextRotationAfter(now, (conv.rotationOffsetSec ?? 0) * 1000)
    let s = Math.max(0, Math.floor((next - now) / 1000))
    const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60
    // Hours and minutes only. This counts down to a DAILY rotation, so a ticking
    // seconds field was three characters of header — the scarcest space on a
    // phone — spent on precision nobody acts on. Rounded UP, so it never reads
    // 00:00 while there is still time left.
    const mm = s > 0 ? m + 1 : m
    el.textContent = `${String(h + (mm === 60 ? 1 : 0)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`
  }
  // Still every second: the value changes on a minute boundary, and polling for
  // it is cheaper than computing when that boundary falls.
  tick(); rotTimer = setInterval(tick, 1000)
}

refreshStatus()
