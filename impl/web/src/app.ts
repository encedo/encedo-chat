/**
 * app.ts — onchato web GUI (mockup skin). Login (HEM) -> dashboard.
 *
 * Identity in the HEM (hem-sdk-js) or a password-sealed software profile.
 * Rendezvous/messages via the SAME engine as the CLI (../../lib, WebCrypto).
 * Content crypto is EH-2 + Double Ratchet, the only scheme; content prefers a
 * direct WebRTC DataChannel with GossipSub through the relay as the fallback
 * (docs/PROTOCOL.md §7.3/§13). The §13 relay-blind plane is pending the libp2p
 * v3 ecosystem (gossipsub not yet migrated). Timestamps are shown on the
 * READER's clock (`localHHMM`) — UTC is what the protocol computes in, not what
 * a person is asked to read.
 *
 * Unbacked mockup elements (P1–P3 profiles, direct/relay
 * modes) are kept as visual placeholders until the engine backs them.
 */

import { HEM } from '../../../hem-sdk-js/hem-sdk.js'
import { hemIdentityFrom, hemRenameIdentity, browserSoftwareIdentity, startSession, hemContactBook, localContactBook, mergedContactBook, localOnlyManager, hemGkBackend, pubKeyReader, type Conversation, type ClientSession, type Identity, type ContactManager, type Contact, type ContactBook } from '../../lib/core.ts'
import { seal, unseal, reseal, isSealedProfile, BadPassword } from '../../lib/profile.ts'
import { exportProfile, openBundle, applyBundle, conflictsWith, localKV, FILE_EXT } from '../../lib/migrate.ts'
import { decodeInvite, inviteLink, type Invite } from '../../lib/invite.ts'
import { pickFirst, orderFrom, nodeKey } from '../../lib/nodepick.ts'
import jsQR from './vendor/jsqr.cjs'
import { checkBook, signBook, pack, type Verdict } from '../../lib/bookmac.ts'
import type { GkBackend } from '../../lib/group.ts'
// `t` is taken: this file uses it for text, topics, timers and DOM nodes, and a
// local shadowing the translator fails at runtime with "t is not a function" —
// which is exactly how it failed once. `tr` cannot collide.
import { t as tr, setLocale, getLocale, applyDom } from './i18n.ts'
import { probeCapabilities, formatReport } from '../../lib/capabilities.ts'
import { initFeedback, openFeedback } from './feedback.ts'
import { probeWebrtc, formatWebrtcProbe, type WebrtcProbeResult, type ProbeStage } from '../../lib/webrtc-probe.ts'
import { voiceSupported, startRecording, type Recording } from './voice.ts'
import { splitByLinks } from '../../lib/linkify.ts'
import { splitByMentions, resolveMention, mentionName, closeMentions, mentionsPub, pubHint } from '../../lib/mentions.ts'
import { makeQuote, type QuoteRef } from '../../lib/quote.ts'
import { canEdit, acceptEdit, EDIT_WINDOW_MS } from '../../lib/edits.ts'
import { planNotification, isNotifyMode, type NotifyMode } from '../../lib/notify.ts'
import {
  isDesktopShell, notifySupported, notifyPermission, notifyRequest, notifyShow, type Banner,
  updateKind, updateCheck, updateDownload, updateProgress, updateApply,
  closeToTray, setCloseToTray, autostartEnabled, setAutostart, initDesktop, trayAvailable, isMobileShell,
  appimageStatus, appimageInstall, showWindow, openExternal,
  nativeScanAvailable, nativeScan, nativeScanCancel, nativeScanZoom, nativeScanSetZoom,
  diagFileAvailable, diagPath, diagAppend, hostSaveRoute,
} from './desktop.ts'
import { qrSvg } from '../../lib/qr.ts'
import { invQrView } from './invqr.ts'
import { assessPassword, ENFORCE_MIN } from '../../lib/passmeter.ts'
import { iceServersFor } from '../../lib/ice.ts'
import { clampToStep, zoomPlan, PREFERRED_START } from '../../lib/qrzoom.ts'
import { boxHeight } from '../../lib/composer.ts'
import { setRadioProfile, profileFor } from '../../lib/radiophase.ts'
import { newDiag } from '../../lib/diag.ts'
import { NOTE_MAX } from '../../lib/knock.ts'
import { contactState, seenLabel, noteSeen as foldSeen, noteAdded as foldAdded, PRESENCE_TTL_MS, type Seen } from '../../lib/seen.ts'
import { bodyBytes, fitsOnWire, overBy, MAX_BODY, WARN_AT, kb } from '../../lib/msgsize.ts'
import { MAX_DIRECT, MAX_OFFER_BODY } from '../../lib/xfer.ts'
import { newFileKey, encryptBytes, decryptBytes, MAX_FILE } from '../../lib/filecrypto.ts'
import { putBlob, getBlob, setStoreOrigin } from '../../net/ipfs.ts'
import { webrtcLinkTauri, tauriRtcAvailable, tauriRtcSelftest } from '../../net/webrtc-tauri.ts'
import { unwrapBlob } from '../../lib/fileenvelope.ts'
import { beginSave, browserSaveEnv, type SaveEnv, type SaveSink } from '../../lib/saveas.ts'
import { newInboxSecret, inboxSecretBytes } from '../../lib/invite.ts'
import { cidMatches, isVerifiableCid } from '../../lib/cid.ts'
import { parseNodeList } from '../../lib/nodelist.ts'
import type { FileEnv } from '../../lib/envelope.ts'
import { nowMs, localHHMM, utcISO } from '../../lib/time.ts'
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
import { sealPins, openPins, withPin, withoutPin, PIN_LIMIT, type Pin } from '../../lib/pincache.ts'
import { sealLocal, openLocal } from '../../lib/localstore.ts'
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

interface NodeEntry { name: string; addr: string; enabled: boolean; w?: number }
const DEFAULT_NODES: NodeEntry[] = (published.nodes as Array<{ name: string; addr: string; w?: number }>)
  .map((n) => ({ name: n.name, addr: n.addr, enabled: true, ...(typeof n.w === 'number' ? { w: n.w } : {}) }))
/** The floor under every dial: the first published node. */
const RELAY = DEFAULT_NODES[0].addr
function loadNodes(): NodeEntry[] {
  try { const v = JSON.parse(localStorage.getItem('ec-nodes') || 'null'); if (Array.isArray(v) && v.length) return v } catch {}
  return DEFAULT_NODES.map((n) => ({ ...n }))
}
function saveNodes(list: NodeEntry[]) { try { localStorage.setItem('ec-nodes', JSON.stringify(list)) } catch {} }
/**
 * The node drawn for THIS session, remembered.
 *
 * Drawn once and kept, because `chosenRelays()` is asked six times over a
 * session — when the room opens, when the relay set is refreshed, for the ICE
 * servers — and a fresh draw on each call would quietly change which node is
 * "first" underneath a session that had already been established on another.
 * Re-drawn only if the node it picked is no longer enabled, which is somebody
 * turning it off in Settings.
 */
let drawnRelay: string | null = null
function drawFirst(on: NodeEntry[]): NodeEntry[] {
  if (drawnRelay && on.some((n) => n.addr === drawnRelay)) {
    return orderFrom(on, on.findIndex((n) => n.addr === drawnRelay))
  }
  const ordered = orderFrom(on, pickFirst(on, Math.random()))
  drawnRelay = ordered[0]?.addr ?? null
  return ordered
}

/** The relay to dial this session — the drawn node, or the first published one as a floor. */
function chosenRelay(): string { return chosenRelays()[0] || RELAY }
/**
 * The ENABLED nodes (the checkboxes in Settings -> Network), with one of them
 * drawn to lead -- the failover candidates (3b). The draw happens once per page
 * load and holds for the session; the rest keep the list's order as the chain
 * to fall through to. Because the relays are meshed this does not split users.
 * Never empty: the first published node is the floor, so a login with every
 * node unchecked still has something to dial.
 *
 * Since 0.6.29 the list's order no longer decides WHERE a client starts: with
 * no weights in `infra/nodes.json` (the case today) the first node is a
 * uniform draw (`lib/nodepick.ts`), because "first in the list" put a whole
 * demo room on one 1-vCPU node. Weights, when published, aim the draw;
 * unchecking a node is how a person pins themselves to the rest.
 */
function chosenRelays(): string[] {
  const on = loadNodes().filter((n) => n.enabled)
  if (!on.length) return [RELAY]
  return drawFirst(on).map((n) => n.addr)
}
/**
 * Transport. libp2p is the default; `?mqtt=1` switches to the broker (fall-back
 * transport — README has the trade-offs), `?mqtt=wss://host/mqtt` points it
 * somewhere else. Everything above the transport is identical either way.
 */
const MQTT_PARAM = new URLSearchParams(location.search).get('mqtt')
const USE_MQTT = MQTT_PARAM !== null && MQTT_PARAM !== '0'
// The light transport (net/light.ts) is the DEFAULT since 0.6.24 (the user's
// call, 2026-09-24): same relays, no GossipSub in the client, pick/push over one
// stream -- no mesh upkeep, no per-frame signatures, a refused topic said out
// loud. `?light=0` brings back the full GossipSub peer, for comparison and as
// the escape hatch if a node without `--pick` is ever in the list.
const LIGHT_PARAM = new URLSearchParams(location.search).get('light')
const USE_LIGHT = !USE_MQTT && LIGHT_PARAM !== '0'
// Load-aware node choice (lib/nodepick.ts, wired in core): on by default,
// `?lb=0` turns it off -- e.g. to stay on a node picked by hand for a test.
const USE_LB = !USE_MQTT && new URLSearchParams(location.search).get('lb') !== '0'
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
 * The Linux desktop has no RTCPeerConnection in its webview, but since 0.5.77
 * the Tauri host can open the DataChannel itself (`src-tauri/src/rtc.rs`,
 * `net/webrtc-tauri.ts`). Whether it can is a build fact, asked once; until
 * the answer arrives the app behaves as if it cannot, which is the safe side.
 */
let rustRtc = false
void tauriRtcAvailable().then((v) => { rustRtc = v; if (v) { try { paintTransportSetting() } catch {} } })
/** A direct channel is possible here — natively, or through the host. */
const directPossible = () => typeof RTCPeerConnection !== 'undefined' || rustRtc
/** The link builder to hand the engine: the host's when the webview has none. */
const linkBuilder = () => (typeof RTCPeerConnection === 'undefined' && rustRtc ? webrtcLinkTauri : undefined)

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
 *
 * **`relay` is the default since 2026-09-03** (the user's decision: "stabler
 * UX"). Direct is the faster path when it works and a source of asymmetric
 * failure when it does not — a DataChannel that opens and then swallows
 * traffic, a NAT pair that never completes, a webview with no
 * `RTCPeerConnection` at all (the Linux desktop, measured). The relay path is
 * the one that behaves the same everywhere. It costs a hop for text — files and
 * voice notes ride the store either way — and it drops two exposures with it:
 * the peer no longer learns this device's address, and no public STUN server is
 * consulted. An explicit choice is stored, so anyone who picked `auto` keeps
 * it; only "never opened Settings" moves.
 */
const TRANSPORT_KEY = 'ec-transport'
/**
 * Three postures, and the third one is a promise rather than a preference.
 *
 * `relay`  — content always through the node (the default since 0.5.60).
 * `auto`   — direct when the channel comes up, node when it does not.
 * `direct` — the node is discovery ONLY: rendezvous, handshake and signalling
 *            still ride it, content never does. A message with no channel waits
 *            in the delivery contract and ends with a re-send button rather
 *            than quietly taking the road the setting refuses.
 */
type TransportMode = 'auto' | 'relay' | 'direct'
const transportMode = (): TransportMode =>
  ((v) => (v === 'auto' || v === 'direct' ? v : 'relay'))(localStorage.getItem(TRANSPORT_KEY))
/** The direct plane is negotiated only where it was CHOSEN (see above), and
 *  never when `?webrtc=0` says otherwise. */
const wantsDirect = () => !WEBRTC_OFF && transportMode() !== 'relay'
/** Content may ONLY go direct — the node carries no message bytes at all. */
const directOnly = () => wantsDirect() && transportMode() === 'direct'
const $ = (id: string) => document.getElementById(id) as HTMLElement

// The window stack lives in two halves on purpose. These two are DECLARED here,
// at the top, because windows register their tidying (`MODAL_EXIT[...] = ...`)
// next to their own code, and those lines run while the module is loading — a
// `const` further down would still be in its temporal dead zone and the whole
// app would fail to start. The functions that use them are hoisted, so they
// stay with the rest of the window code further down.
const modalStack: string[] = []
const MODAL_EXIT: Record<string, () => void> = {}
/** The published invite whose QR is on screen (its knocks are painted under it), and who was accepted there. */
let invQrShown: string | null = null
let invQrAccepted: { name: string; pub: string }[] = []
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
  | { t: 'msg'; kind: 'me' | 'peer'; text: string; ts: number; id?: string; ooo?: boolean; who?: string; sent?: boolean
      /** Came back from the pin store on entry — it is on screen BECAUSE it is
       *  pinned, which is why unpinning takes it away again. */
      pinned?: boolean
      /** The message this one answers, quoted (`lib/quote.ts`). */
      re?: QuoteRef
      /** When the text was last corrected (`lib/edits.ts`); `text` already holds
       *  the correction. Its presence is what puts "edytowano" on the bubble. */
      edited?: number
      /** OUR correction's own message id, and what became of it. Kept on the
       *  event so a room switch replays the truth: a correction that never
       *  arrived must not come back looking like one that did. */
      editId?: string
      editState?: 'sending' | 'ok' | 'lost' | 'late'
      /** Author's public key. Not shown — it is what a REPLY to this bubble puts
       *  in its own quote, and what resolves a quote of it to a name. */
      au?: string }
  | { t: 'react'; id: string; emoji: string }
  | { t: 'delivery'; id: string; state: 'ok' | 'lost' | 'late'; ms?: number }
  | {
      t: 'sys'; text: string
      /** Set on lines that may need REWRITING rather than repeating — presence
       *  is the one that does. See the flap collapse in `onPresence`. */
      sid?: string
    }
  // The count line above a restored pin block. It carries no text: the count
  // it shows is whatever the room holds NOW, so unpinning cannot leave a line
  // claiming a number that is no longer true.
  | { t: 'pinhdr' }
  // A file is its own event, not a message with a marker: it carries what is
  // needed to fetch and decrypt, and its bubble has an action rather than text.
  | { t: 'file'; kind: 'me' | 'peer'; who?: string; ts: number; file: FileEnv; au?: string }
/** The log event a bubble is rendered from. */
type MsgEv = Extract<Ev, { t: 'msg' }>

interface Room {
  contact: Contact
  /**
   * Ids of messages/files that travelled the DIRECT plane (WebRTC): ours as they
   * were last sent, theirs as they arrived. Drawn as the header's green badge in
   * the bubble's meta line; the node, the default plane, gets no mark.
   */
  direct?: Set<string>
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
  /** The channel answered the liveness ping, so content really rides it. The
   *  badge used to light on `conn=connected` alone, which is a fact about the
   *  connection and not about the channel — and read Direct while every
   *  message still went through the node (Linux desktop, 2026-09-14). */
  directProven?: boolean
  peerLabel: string
  lastPresence: string | null
  /** The presence line on screen, so a burst rewrites it instead of repeating
   *  itself. Null until the first join or leave. */
  presenceLine?: { ev: { t: 'sys'; text: string; sid?: string }; at: number; flaps: number } | null
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

/** The route mark on a bubble: the header's own green badge, small, only when the message went direct. */
function paintRoute(id: string | undefined) {
  if (!id) return
  const row = $('messages').querySelector(`.mrow[data-mid="${id}"]`) as HTMLElement | null
  const meta = row?.querySelector('.b-meta') as HTMLElement | null
  if (!meta) return
  const on = !!activeRoom()?.direct?.has(id)
  const had = meta.querySelector('.b-route')
  if (on && !had) {
    const m = document.createElement('span'); m.className = 'b-route'; m.textContent = '🟢'
    m.title = tr('Bezpośrednio (WebRTC) — ta wiadomość nie przeszła przez węzeł')
    // At the END of the line, never next to the time: the time is the line's
    // text node, which `stampTime` rewrites and readers parse.
    meta.appendChild(m)
  } else if (!on && had) had.remove()
}
function noteVia(room: Room, id: string | undefined, via: 'direct' | 'relay') {
  if (!id) return
  if (!room.direct) room.direct = new Set()
  if (via === 'direct') room.direct.add(id); else room.direct.delete(id)
  if (room === activeRoom()) paintRoute(id)
}
const LOG_CAP = 1000

/**
 * What an unconfirmed message of ours is actually waiting for -- said, instead
 * of an endless "wysylam...". Reported from a phone on a motorway: during a
 * minute without network, and after it, bubbles sat on "wysylam..." with no
 * hint whether the problem was our network or the other side. The delivery
 * machinery already tells the two apart (it pauses the retries while the peer
 * is absent); the label now does too. Painted over every bubble still marked
 * `data-pending`, whenever the link or the peer's presence changes.
 */
function pendingLabel(): { text: string; title: string } {
  if (linkState !== 'online') return { text: tr(' · czekam na sieć…'), title: tr('Brak połączenia z przekaźnikiem — wyślę, gdy wróci') }
  const lp = activeRoom()?.lastPresence
  // Never seen yet (null) counts as absent too: sending into an empty room is
  // exactly the case the retries stop for.
  if (!lp || lp === 'leave' || lp === 'quiet') return { text: tr(' · czeka na rozmówcę…'), title: tr('Rozmówcy teraz nie ma — wiadomość dojdzie, gdy wróci (i otworzy tę rozmowę)') }
  return { text: tr(' · wysyłam…'), title: tr('Czekam na potwierdzenie od klienta rozmówcy') }
}
function paintPending() {
  const l = pendingLabel()
  for (const el of stateEls.values()) {
    if (!el.dataset.pending) continue
    if (el.textContent !== l.text) { el.textContent = l.text; el.title = l.title }
  }
}

function paintStatus() {
  const dot = $('peer-dot'), txt = $('peer-status')
  paintPending() // the same two facts decide what an unconfirmed bubble says
  paintKnockButton() // whether anyone is there to hear it changes with this label
  if (linkState !== 'online') {
    dot.className = 'dot bad'
    txt.textContent = linkState === 'reconnecting' ? tr('wznawiam połączenie…') : tr('brak połączenia z przekaźnikiem')
    return
  }
  if (activeGid) {
    // A group is on screen: its header is "N członków", not a 1:1 peer label. Without
    // this, every onLink/refresh repainted it as `activeRoom()?.peerLabel ?? 'łączę...'`
    // — activeRoom() is null for a group — so the group header flickered "łączę...".
    const gu = groupsUI.get(activeGid)
    dot.className = 'dot ok'
    txt.textContent = gu ? tr('{n} członków', { n: gu.members.length }) : ''
    return
  }
  // Green = a live EH-2 channel (secured), not merely "peer active" — the
  // same delivery-promise meaning as the contact-list dot. A peer that is
  // present but not yet secured (or gone away/quiet with the channel dropped)
  // is orange; text still carries the exact presence word.
  const r = activeRoom()
  const lp = r?.lastPresence
  const secured = !!r?.conv && r.conv.secured().length > 0
  dot.className = 'dot ' + (secured ? 'ok' : lp && lp !== 'leave' ? 'online' : '')
  txt.textContent = r?.peerLabel ?? tr('łączę…')
}
let rotTimer: any = null

// '' is a real third state, not a default: "no such profile — create it?" is a
// question, and dressing a question as an error teaches people to ignore red.
const setMsg = (id: string, text: string, kind: 'err' | 'ok' | '') => { const m = $(id); m.textContent = text; m.className = 'msg ' + kind }
const clr = (id: string) => { const m = $(id); m.textContent = ''; m.className = 'msg' }
/**
 * Two letters for an avatar. NOT the first two: "DevMachine" and "DevBox" both
 * came out "DE", and two people behind one badge is the thing a badge exists to
 * prevent. Several words -> first letter of the first and of the LAST word (Ala
 * Kowalska -> AK); one word -> its first and last letter (DevM -> DM). Iterated by
 * code point, so an emoji or a Polish letter is never cut in half.
 */
const initials = (s: string) => {
  const words = (s || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  const first = [...words[0]]
  const second = words.length > 1 ? [...words[words.length - 1]][0] : first[first.length - 1]
  return (first[0] + (second ?? '')).toUpperCase()
}
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
 * second is `false && ...`, the minifier drops the branch, and no URL can print a
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
/** The connection diary. Created HERE, above everything: `ecLog` feeds it and
 *  is called from module top-level long before the rest of the wiring below. */
const diag = newDiag()

const SHOW_KEYS = __EC_ALLOW_KEYS__ && new URLSearchParams(location.search).has('keys')
const HEM_TRACE = new URLSearchParams(location.search).has('debug') || SHOW_KEYS
// `?debug=2` adds the wire dump (lib/protolog.ts `wire`): every frame at the
// node edge and on the direct channel, with its first 64 bytes -- evidence that
// what the node carries is ciphertext. Nothing secret; `?keys=1` stays separate.
// getAll, not get: `?debug=1&debug=2` (a link that already carried debug=1) means the higher.
const WIRE_TRACE = Math.max(0, ...new URLSearchParams(location.search).getAll('debug').map(Number).filter((n) => !isNaN(n))) >= 2
if (HEM_TRACE) {
  enableProtoLog({ events: true, keys: SHOW_KEYS, wire: WIRE_TRACE, sink: (line) => console.log(`%c${line}`, 'color:#2a8c6a') })
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
  if (!opts.quiet) { dot.className = 'dot'; hint.textContent = ''; hint.title = ''; setHemReady(false) }
  if (!url) { setHemReady(false); return false }
  if (probing) return false
  probing = true
  try {
    const v: any = await probeVersion(url)
    dot.className = 'dot ok'
    setHemReady(true)
    // One word, at the end of the field it belongs to. The device's firmware and
    // the reason for an unreachable one are still here — in the tooltip, where
    // somebody who needs them will look and nobody else has to read them.
    hint.textContent = tr('Online')
    hint.title = v?.fwv ? `fw ${v.fwv}` : ''
    return true
  } catch (e: any) {
    dot.className = 'dot bad'
    setHemReady(false)
    hint.textContent = tr('Offline')
    hint.title = isTimeout(e) ? tr('HEM nie odpowiada (timeout)') : tr('HEM nieosiągalny (adres / CORS)')
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
  // WARNING: All four through `tr`. Three of them were bare Polish sitting next to
  // translated siblings in the same expression — which is how an English UI ends
  // up half in Polish and why the mix is invisible to whoever wrote it.
  $('go').textContent = reg ? tr('Zarejestruj') : tr('Zaloguj')
  $('toggle-pre').textContent = reg ? tr('Masz już konto?') : tr('Nie masz konta?')
  $('toggle').textContent = reg ? tr('Zaloguj') : tr('Zarejestruj tożsamość')
  clr('msg')
})

/**
 * How THIS identity rewrites its own handle, set by whichever door signed in.
 *
 * The two kinds differ in what it costs, not in what it means. A HEM identity
 * is one `updateKey` on the IK. A software profile keeps its handle INSIDE the
 * sealed blob, so the rename has to unseal and re-seal it - which means the
 * password, and that is right rather than a nuisance: rewriting your own
 * identity record should cost what changing its password costs.
 *
 * Null until somebody is signed in; the pencil is hidden until then.
 */
let renameIdentity: ((next: string) => Promise<boolean>) | null = null

/**
 * Sign in as one identity on an authorised HEM. Everything per-identity hangs
 * off its KID from here on: the contact book is scoped to it, and so is every
 * local key (`identityKey`).
 */
async function signInAs(hem: any, id: { kid: string; handle: string }) {
  // The same broad read the contact book uses; the narrow `use:<kid>` token is
  // still taken later, by the ECDH that genuinely needs it.
  const pubkey = await pubKeyReader(hem)(id.kid)
  rememberMethod('hem')
  const hemId = hemIdentityFrom(hem, id.kid, id.handle, pubkey)
  const renameOnHem = hemRenameIdentity(hem, id.kid)
  renameIdentity = async (next: string) => { await renameOnHem(next); return true }
  const idKey = await identityKey(pubkey, id.kid)
  loadSeen(idKey) // per identity, like every other local record
  const local = await makeLocalBook(idKey, localStorage, hemId)
  if (local.verdict === 'tampered') warnTampered()
  await enterApp(
    hemId,
    mergedContactBook(hemContactBook(hem, id.kid), local.verdict === 'tampered' ? taintedBook() : local.book),
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
/** Set while the picker is open; whoever finishes the sign-in takes it away. */
let closeIdentityModal: () => void = () => {}

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
    row.addEventListener('click', () => {
      // NOT closed here. Signing in takes a few seconds of device time, and
      // closing would uncover the login form — password still filled, Sign-in
      // button live — which reads as "the click did nothing". The modal stays and
      // becomes the progress, and `enterApp` takes it away with the login screen.
      box.innerHTML = ''
      const busy = document.createElement('div')
      busy.className = 'hint'
      busy.textContent = tr('Loguję jako {name}…', { name: id.handle })
      box.appendChild(busy)
      cancel.hidden = true
      onPick(id)
    })
    box.appendChild(row)
  }

  const cancel = $('identity-cancel')
  cancel.hidden = false
  const close = () => {
    dropModal('identity-modal')
    cancel.removeEventListener('click', onCancel)
    $('scrim').removeEventListener('click', onCancel)
    document.removeEventListener('keydown', onKey)
    closeIdentityModal = () => {}
  }
  closeIdentityModal = close
  // Cancel RELOADS rather than merely closing. By this point we hold an
  // authorised token and the key derived from the password; a user who backs out
  // means "not this identity" or "not now", and a reload is the only ending that
  // leaves none of that behind. Same reasoning as the sign-out button.
  const onCancel = () => { close(); location.reload() }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
  cancel.addEventListener('click', onCancel)
  $('scrim').addEventListener('click', onCancel)
  document.addEventListener('keydown', onKey)
  pushModal('identity-modal')
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
  } catch (e: any) { closeIdentityModal(); setMsg('msg', tr('Błąd: ') + (e?.message ?? e), 'err') }
  finally {
    const b = $('go') as HTMLButtonElement
    b.textContent = mode === 'register' ? tr('Zarejestruj') : tr('Zaloguj')
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
attachByteBudget($('import-note') as HTMLTextAreaElement, NOTE_MAX, $('import-note-bytes'))

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
 * absent key -> offer to create | opens -> in | refuses -> wrong password.
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

/**
 * The profiles this device holds, on the card, as the first thing offered.
 *
 * The old card led with the HEM address and hid everything else under links —
 * which is backwards twice over: coming back is the common case, and a HEM is
 * the path that needs hardware nobody has on their first evening. So the list
 * leads, a click on a row goes straight to that profile's password, and HEM
 * keeps a place of its own on the line below.
 *
 * WARNING: The names are on screen before anyone signs in, which the single
 * remembered name this replaces was careful about. It is a deliberate trade and
 * a small one: local profile names are a caption on this device, the identity
 * behind them stays sealed by its password, and hiding them bought nothing
 * except a click for the person who owns the machine.
 *
 * There is no KID beside a name because there CANNOT be one: the public key
 * lives inside the sealed blob, so nothing here can read it before the password
 * does. Names are unique per device anyway — the storage key IS the name — so
 * there is nothing to disambiguate.
 */
/**
 * WARNING: A HEM sign-in is NOT remembered here, and that is the point.
 *
 * A row for it was tried and taken out on sight: it put a handle and a HEM
 * address on the sign-in screen, which tells anyone glancing at the machine
 * that this browser has something in a HEM and where. The profiles below are
 * captions for keys that live in THIS browser; a HEM identity lives in the
 * device and the browser has no business advertising it.
 *
 * The cost is a click for the HEM user, every time. That is the trade and it is
 * the right way round.
 */
const LAST_HEM = 'ec-last-hem'

/**
 * Which way this browser signed in last, so the daily return costs no clicks:
 * a software user meets the list, a HEM user meets the HEM form.
 *
 * WARNING: This is the SAME class of fact as the HEM row that was removed, in its
 * smallest possible form — it says a HEM was used here, and nothing about which
 * one, whose, or where. That trade is the user's call and it was made
 * deliberately; the address and the handle stay unremembered.
 */
const LAST_METHOD = 'ec-last-method'
const rememberMethod = (m: 'soft' | 'hem') => { try { localStorage.setItem(LAST_METHOD, m) } catch {} }
const lastMethod = (): string => { try { return localStorage.getItem(LAST_METHOD) ?? '' } catch { return '' } }

function renderLoginProfiles(boot = false) {
  // Written by a build that offered a HEM row. Removed on sight rather than
  // left to sit: it is the address and the handle, and nothing reads it now.
  try { localStorage.removeItem(LAST_HEM) } catch {}
  const box = $('login-profiles'); if (!box) return
  const names = listSoftProfiles()
  box.textContent = ''

  for (const n of names) {
    const b = document.createElement('button')
    b.type = 'button'; b.className = 'pick'
    const av = document.createElement('span'); av.className = 'av'
    av.textContent = n.slice(0, 2).toUpperCase()
    const who = document.createElement('span'); who.className = 'who'; who.textContent = n; who.title = n
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = tr('software')
    b.append(av, who, tag)
    b.addEventListener('click', () => openSoftModal(n))
    box.appendChild(b)
  }
  const has = names.length > 0
  $('login-links').hidden = false
  $('login-profiles-sec').hidden = !has
  $('login-empty-sec').hidden = has
  // The HEM form is a choice on this card, not the card itself.
  $('hem-sec').hidden = true
  // WARNING: ...unless this browser last came in that way — and this must be the LAST
  // line, after the hiding above. Put before it, `showHemForm` unhid the section
  // and the very next statement hid it again: every part of the card off, an
  // empty box on screen. Caught by rendering it, which is why the screens get
  // looked at rather than assumed.
  //
  // Only at boot: after that, this function is how somebody gets BACK to the
  // profiles, and sending them straight out again would make that link dead.
  if (boot && lastMethod() === 'hem') showHemForm()
}

/** Show the HEM form, and stand the profile list down while it is up. */
function showHemForm() {
  $('hem-sec').hidden = false
  $('login-profiles-sec').hidden = true
  $('login-empty-sec').hidden = true
  // The line of other ways in goes with them — one of those ways is this form,
  // and offering it while it is open is noise on a screen that should read as
  // one thing to do.
  $('login-links').hidden = true
  $('hsm').focus()
}
$('go-hem')?.addEventListener('click', showHemForm)
$('go-hem-empty')?.addEventListener('click', showHemForm)
$('go-create')?.addEventListener('click', () => openSoftModal(undefined, true))
// Back to the card. `renderLoginProfiles` decides what belongs on it, so this
// restores the right thing whether this device holds profiles or nothing.
$('hem-back')?.addEventListener('click', () => renderLoginProfiles())

/**
 * The user came here to CREATE, not to sign in. Set by "+ new profile" and by
 * the empty device's button, and it is what stops the flow asking a second time
 * whether a profile that does not exist should be made — they just said so.
 */
let softIntendsNew = false

function openSoftModal(name?: string, creating = false) {
  pushModal('soft-modal')
  clr('soft-msg'); softCreating = ''
  softIntendsNew = creating
  // WARNING: A NEW profile starts EMPTY. Prefilling the last name here was the sign-in
  // behaviour leaking into creation: "+ new profile" opened with somebody else's
  // name in the field and only one password box, which reads as the wrong
  // window — and one careless press away from a confusing error.
  const start = creating ? '' : (name ?? localStorage.getItem(LAST_PROFILE) ?? '')
  ;($('soft-name') as HTMLInputElement).value = start; ($('soft-pass') as HTMLInputElement).value = ''
  softMode(creating)
  // Focus lands where there is still something to type — on the password when
  // the name came back by itself, which is the common case after the first run.
  $(!creating && start ? 'soft-pass' : 'soft-name').focus()
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
  paintSoftMeter()
  $('soft-sub').textContent = creating
    ? tr('Nowa tożsamość na tym urządzeniu. Hasła nie da się odzyskać ani zmienić bez niego — nie ma czego z nim porównać.')
    : tr('Tożsamość trzymana w tej przeglądarce i zaszyfrowana hasłem. Bez HEM — do wypróbowania komunikatora.')
  ;($('soft-go') as HTMLButtonElement).textContent = creating ? tr('Utwórz profil') : tr('Dalej')
}

// ---- password strength (a floor since 2026-09-03 — the user's decision) ---
/**
 * The meter paints only where a password is being CHOSEN: profile creation
 * and the change-password modal. `mig-pass` gets none on purpose — a move
 * seals under the profile's EXISTING password, and grading what cannot be
 * changed in that window is noise. Those same two sites are where the floor
 * (`ENFORCE_MIN`, lib/passmeter.ts) refuses — never at sign-in, which would
 * lock someone out of an identity nobody can recover.
 */
function paintMeter(box: HTMLElement, pw: string, visible: boolean) {
  if (!visible || !pw) { box.hidden = true; return }
  const s = assessPassword(pw)
  box.hidden = false
  box.dataset.score = String(s.score)
  box.querySelectorAll('.pwm-bar i').forEach((seg, i) => seg.classList.toggle('on', i <= s.score))
  // "dobre" was the advisory era's word for the third bucket; under the floor
  // that bucket is refused, and a meter reading "good" beside a refusal is the
  // form arguing with itself.
  const word = [tr('słabe'), tr('przeciętne'), tr('prawie'), tr('mocne')][s.score]
  const hint = {
    common: tr('jest na listach najczęściej używanych haseł'),
    short: tr('wydłuż je — najlepiej do 12+ znaków'),
    'one-class': tr('dodaj inne rodzaje znaków albo drugie słowo'),
    patterns: tr('unikaj sekwencji i powtórzeń'),
    ok: '',
  }[s.advice]
  box.querySelector('.pwm-note')!.textContent = hint ? `${word} — ${hint}` : word
}
const paintSoftMeter = () =>
  paintMeter($('pwm-soft'), ($('soft-pass') as HTMLInputElement).value, !$('soft-pass2-wrap').hidden)
$('soft-pass').addEventListener('input', paintSoftMeter)
$('pw-new').addEventListener('input', () =>
  paintMeter($('pwm-new'), ($('pw-new') as HTMLInputElement).value, true))

/**
 * The floor, as the message to show — '' when the password clears it.
 *
 * It replaced a confirm dialog ("weak — use it anyway?"), and the reason is
 * that the dialog was the wrong shape for this decision: the person choosing
 * cannot see what an offline grind of the stolen blob costs, the profile has
 * no recovery to fall back on, and a modal asking permission to do the unsafe
 * thing is answered "yes" by everyone in a hurry. So: refused inline, beside
 * the meter that already says what is wrong with the password they typed,
 * with the field kept and focused rather than a dialog to dismiss first.
 */
function weakRefusal(pw: string): string {
  if (assessPassword(pw).score >= ENFORCE_MIN) return ''
  return tr('Za słabe hasło — miernik musi być pełny. Najprościej dopisać drugie słowo albo wydłużyć do 12+ znaków. Profilu nie da się odzyskać, więc to hasło jest całą jego ochroną.')
}

const closeSoftModal = () => { softIntendsNew = false; dropModal('soft-modal') }
MODAL_EXIT['soft-modal'] = () => { softIntendsNew = false }
// WARNING: An arrow, not a reference. `openSoftModal` grew a `name` parameter when the
// login card learned to open a NAMED profile, and a listener passed by reference
// hands it the PointerEvent — which landed in the name field as
// "[object PointerEvent]" the moment anybody tried to create a profile.
// "+ new profile" means new. Anything else here would be the sign-in window
// wearing a different label, which is exactly how it was reported.
$('go-soft').addEventListener('click', () => openSoftModal(undefined, true))
$('soft-cancel').addEventListener('click', closeSoftModal)
// Typing a different name drops creation mode — otherwise the next press would
// create a profile under a name nobody was asked about.
;($('soft-name') as HTMLInputElement).addEventListener('input', () => {
  if (!softIntendsNew && softCreating && softCreating !== val('soft-name')) { clr('soft-msg'); softMode(false) }
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

    if (!raw && !softIntendsNew && softCreating !== name) {
      // A name that does not exist: ASK, on a surface of its own, and do not
      // create. Creating silently would turn a typo in an existing profile's
      // name into a brand new identity — which presents as "my contacts are
      // gone" — and a confirmation inside the same window read as no response
      // at all, because only the button's label moved.
      const { ok } = await ask(
        tr('Nie ma profilu „{name}"', { name }),
        tr('Utworzyć na tym urządzeniu nową tożsamość o tej nazwie? Jeśli chciałeś wejść na istniejącą, sprawdź pisownię — to osobne tożsamości, nie jedna.'),
        tr('Utwórz'))
      // (The scrim used to be put back by hand here: `ask()` took it down
      // while this window was still up. The window stack restores both.)
      if (ok) { softMode(true); $('soft-pass2').focus() }
      return
    }

    // Asked to CREATE, and the name is already taken. Signing in instead would
    // work and would be a surprise; the honest answer names the two ways out.
    if (raw && softIntendsNew) {
      setMsg('soft-msg', tr('Profil o tej nazwie już tu jest — wybierz inną nazwę albo wejdź w niego z listy.'), 'err')
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
      const weak = weakRefusal(pass)
      if (weak) { setMsg('soft-msg', weak, 'err'); ($('soft-pass') as HTMLInputElement).focus(); return }

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
    endModals() // signed in: the app is behind this, not another window
    activeSoftProfile = name
    // The handle lives INSIDE the sealed blob, and the blob's own storage key is
    // the name - so a rename is unseal, rewrite, re-seal, move, and only then is
    // it safe to forget the old copy. Sealed under the new name BEFORE the old
    // entry goes, so a failure anywhere in here leaves a profile that still opens.
    renameIdentity = async (next: string) => {
      const pw = await promptName(tr('Potwierdź hasłem'),
        tr('Nazwa siedzi w zapieczętowanym profilu, więc zmiana wymaga hasła.'), '', tr('Hasło'), true)
      if (pw === null) return false // backed out at the password: nothing written
      const blob = JSON.parse(localStorage.getItem(softKey(activeSoftProfile)) ?? 'null')
      if (!isSealedProfile(blob)) throw new Error(tr('Nie znaleziono profilu do zmiany.'))
      const inner = JSON.parse(await unseal(pw, blob))
      inner.handle = next
      localStorage.setItem(softKey(next), JSON.stringify(await seal(pw, JSON.stringify(inner))))
      if (next !== activeSoftProfile) localStorage.removeItem(softKey(activeSoftProfile))
      localStorage.setItem(LAST_PROFILE, next)
      activeSoftProfile = next
      return true
    }
    rememberMethod('soft')
    localStorage.setItem(LAST_PROFILE, name)
    const idKey2 = await identityKey(id.pub)
    loadSeen(idKey2)
    const local = await makeLocalBook(idKey2, localStorage, id)
    if (local.verdict === 'tampered') warnTampered()
    await enterApp(id, localOnlyManager(local.verdict === 'tampered' ? taintedBook() : local.book), 'Software')
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
 *
 * CIDv1 with raw leaves, deliberately: a v0 `Qm…` names a dag-pb node rather
 * than the file, and `lib/cid.ts` refuses what it cannot check — so a v0 here
 * would mean the bytes were never verified, which is how this constant spent
 * its first months. Publish with
 * `ipfs add --cid-version=1 --raw-leaves --pin`.
 */
const OFFICIAL_NODES_CID = 'bafkreies7oi6xdeyz7gpqifoa7loas65nu25pp6shdczelkxjbiras77ti'

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
    const raw = await getBlob(OFFICIAL_NODES_CID)
    // The CID is compiled in so nobody can redirect WHICH list is asked for —
    // and until this check, nothing said the bytes coming back were the ones it
    // names. They arrive through our own `/f`, so whoever could shape that
    // response chose the relays for every client: the first hop of every
    // conversation. Content addressing is only integrity where somebody
    // computes the hash (lib/cid.ts).
    if (!await cidMatches(OFFICIAL_NODES_CID, raw)) {
      warn(isVerifiableCid(OFFICIAL_NODES_CID)
        ? tr('Pobrana lista NIE zgadza się ze swoim CID — nie wczytuję jej. Zgłoś to.')
        : tr('Tej listy nie da się zweryfikować (stary format CID) — nie wczytuję jej.'))
      return
    }
    const text = new TextDecoder().decode(raw)
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
    const addr = (prompt(tr('Multiaddr węzła (np. /dns4/bs2.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3Koo…):')) || '').trim()
    if (!addr) return
    if (!addr.startsWith('/') || !addr.includes('/p2p/')) { warn(tr('To nie wygląda na multiaddr (…/p2p/<PeerId>).')); return }
    const host = addr.match(/\/dns[46]\/([^/]+)/)?.[1] ?? addr.match(/\/ip[46]\/([^/]+)/)?.[1] ?? tr('węzeł')
    const name = (prompt(tr('Nazwa węzła:'), host) || host).trim()
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

/**
 * The local contact book, with a signature over it.
 *
 * WARNING: The book is the TRUST ANCHOR and it was the one piece of state with nothing
 * guarding it. Reading the file tells somebody who you talk to; WRITING it is
 * the attack — swap a contact's `pub` and the app derives the rendezvous with
 * the attacker, handshakes with the attacker and encrypts to the attacker,
 * while every layer underneath works perfectly on the key it was handed. No
 * badge turns red, because nothing failed.
 *
 * So it is signed (`lib/bookmac.ts`), and the shape here follows from where the
 * crypto can afford to be: **verify once at sign-in, hold the verified list in
 * memory, re-sign on every write.** The UI reads contacts synchronously on the
 * render path, and that stays true.
 *
 * Three outcomes, and the middle one is the reason this can ship at all:
 *
 *   ok        — signed by this identity, and the signature matches.
 *   unsigned  — a book from before this existed. ACCEPTED, and signed on the
 *               next write. Locking somebody out of their own contacts to
 *               introduce a security feature is worse than the risk it closes.
 *   tampered  — signed, and the signature does not match. The list is NOT used
 *               and writes are refused, so the file is left exactly as found:
 *               it is evidence, and overwriting it with an empty signed book
 *               would destroy both the evidence and the contacts.
 */
async function makeLocalBook(idKey: string, storage: Storage, id: Identity): Promise<{ book: ContactBook; verdict: Verdict }> {
  const lsKey = 'ec-local-contacts-' + idKey
  const readRaw = () => { try { return JSON.parse(storage.getItem(lsKey) || '[]') } catch { return [] } }

  // The §10 secret, which the group cache will want later anyway — computing it
  // here means one ECDH per session, not two (on a HEM that is a device round
  // trip, so it is worth the small refactor).
  const base = await cacheBaseFor(id, idKey)
  if (!base) {
    // The identity will not do ECDH (an HSM that refuses, a platform without
    // it). Signing is impossible, so the book works as it always did rather
    // than the app becoming unusable — said out loud in the log, not silently.
    ecLog('contact book: no ECDH base, running unsigned', 'debug')
    return { book: localContactBook(readRaw, (l) => storage.setItem(lsKey, JSON.stringify(l))), verdict: 'unsigned' }
  }

  const { verdict, body } = await checkBook(base, idKey, storage.getItem(lsKey))
  let list: Array<{ name: string; pub: string }> = []
  if (verdict !== 'tampered') { try { list = JSON.parse(body) } catch { list = [] } }

  const save = (l: Array<{ name: string; pub: string }>) => {
    if (verdict === 'tampered') throw new Error('contact book failed its signature — refusing to write over it')
    list = l
    const text = JSON.stringify(l)
    // Fire-and-forget is deliberate: `localContactBook`'s save is synchronous,
    // and the in-memory list is already correct. A failure to SIGN must not lose
    // the write, so the text goes down first and the signature follows.
    storage.setItem(lsKey, text)
    void signBook(base, idKey, text)
      .then((mac) => storage.setItem(lsKey, pack(text, mac)))
      .catch((e) => ecLog('contact book: signing failed — ' + (e?.message ?? e), 'debug'))
  }
  return { book: localContactBook(() => list, save), verdict }
}

/**
 * A book whose signature did not check out: empty, and it refuses to be edited.
 * Not merely a precaution — every write would overwrite the evidence.
 */
function taintedBook(): ContactBook {
  const no = async () => { throw new Error(tr('Książka kontaktów nie przeszła weryfikacji')) }
  return { async list() { return [] }, add: no, remove: no, rename: no }
}

/** Tell the user, once, in a way that cannot be mistaken for a network hiccup. */
function warnTampered() {
  toast(tr('⚠️ Książka kontaktów została zmieniona poza aplikacją — nie została wczytana'))
  ecLog('contact book FAILED its MAC — refusing to load or overwrite it')
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
    for (const p of ['ec-gcache-emp-', 'ec-gcache-', 'ec-local-contacts-', 'ec-groups-', 'ec-seen-']) {
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
    transport: USE_MQTT ? 'mqtt' : USE_LIGHT ? 'light' : 'libp2p',
    broker: BROKER,
    loadBalance: USE_LB,
    // Capacity weights from the published list, by the name a node announces.
    nodeWeights: Object.fromEntries(loadNodes().filter((n) => typeof n.w === 'number').map((n) => [nodeKey(n.addr), n.w as number])),
    // Light only: the relay said no to a topic. Until now a full node looked
    // exactly like an empty room; this is the first time the client is told.
    onRefused: (topic) => { ecLog(`relay refused topic ${topic.slice(0, 12)}...`); toast(t('Węzeł odmówił tematu — jest pełny. Wybierz inny węzeł w Ustawieniach → Sieć.'), 4000) },
    forcedRotationSec: FORCED_ROTATION_SEC,
    onGroupSkd: (from, skd) => { void onGroupInvite(from, skd) }, // a group invite arrived over a 1:1
    onGroupSkdReq: (from, req) => { void answerSkdReq(from, req) }, // …and a member asking for one back

    onLog: ecLog,
    onLink: (state) => {
      linkState = state; paintStatus()
      diag.note(`link ${state}`)
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
      // The inbox watches die with the transport, but the handles would keep
      // looking live and a later `startInboxWatches` would skip every invite as
      // already watched. Logout does not need this - it reloads the page.
      stopInboxWatches()
      $('messages').innerHTML = ''
      msgEls.clear(); stateEls.clear(); setTyping(false)
      appendSys(tr('Wykryto drugie okno zalogowane na tę samą tożsamość.')
        + tr(' Obie sesje zostały zamknięte — jedna tożsamość, jedna aktywna sesja.')
        + tr(' Zamknij nadmiarową kartę i odśwież tę, w której chcesz rozmawiać.'))
      linkState = 'offline'
      paintStatus()
      $('peer-status').textContent = tr('sesja zamknięta (duplikat)')
    },
  })
  clientReady.then((c) => { client = c; void restoreGroups(); void startInboxWatches(); void resumeKnocking() }, (e: any) => {
    ecLog(`session failed to start: ${e?.message ?? e}`)
    toast(tr('Brak połączenia z przekaźnikiem — odśwież stronę'))
  })
  closeIdentityModal() // the picker, if one was open, goes with the login screen
  $('login').hidden = true; $('app').hidden = false
  // The composer's resting height is COMPUTED, not left to the stylesheet: on a
  // touch target the 44px finger floor is taller than one line of text, so
  // without this the box visibly shrank on the first keystroke and every
  // measurement of "did it grow" started from the wrong number.
  growComposer(); paintLength()
  stopHemPoll() // the login screen is gone; nothing left to watch for
  // Said HERE and not at boot: an empty contact list is what the user is about
  // to look at, and this is the sentence that explains it. Once per device.
  if (sweptPreKid > 0) {
    toast(tr('Stan sprzed zmiany formatu tożsamości został wyczyszczony ({n}) — kontakty w HEM są nietknięte.', { n: sweptPreKid }))
    sweptPreKid = 0
  }
  $('me-avatar').textContent = initials(id.handle)
  $('me-handle').textContent = id.handle
  loadNotifyMode() // per identity, like every other stored preference
  loadMediaAuto()
  // A HEM identity has nothing to move, so the whole section goes rather than
  // offering a button that can only refuse.
  const soft = !!localStorage.getItem('ec-soft-id-' + (session?.handle ?? ''))
  for (const id of ['mig-section', 'mig-hint', 'btn-export']) { const el = $(id); if (el) el.hidden = !soft }
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
  // Shown on EVERY sign-in with an empty contact book, not only a first run:
  // somebody returning to a profile they have not used still has nobody to
  // write to, and the old rule also suppressed it for anyone holding groups,
  // which is exactly a person who can have groups and still no contacts.
  //
  // Sign-in is the ONLY trigger. Removing your last contact deliberately shows
  // nothing: a window that reappears on an ordinary delete is a window that
  // punishes tidying up. It comes back the next time you log in (user's call).
  else if (!contactsCache.length) {
    pushModal('welcome-modal')
  }
}

// ---- contacts (HEM-backed book; in-memory cache keeps re-renders cheap) ----
let contactsCache: Contact[] = []
/** pub -> fingerprint. Peers are shown exactly like our own identity: the
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
    // Written down as well as painted: a dot that went dark at 03:14 and came
    // back at 03:15 is the whole evidence for what the night did, and by
    // morning the screen only shows the last state. The key prefix, not the
    // name — the file has no business holding who somebody is.
    onOnline: (p) => {
      // Written down whether or not the dot changes: an Announce that verifies
      // is proof they hold our key, which is the whole question a cold contact
      // raises.
      markSeen(p.pub)
      // They announced, so they hold our key: the knock was let in and the wait
      // is over. Nothing else signals acceptance, and nothing else needs to.
      if (waiting.has(p.pub)) { stopKnocking(p.pub); renderContacts() }
      if (onlinePubs.has(p.pub)) return
      onlinePubs.add(p.pub); renderContacts()
      diag.note(`peer ${p.pub.slice(0, 12)} lit`)
    },
    onOffline: (p) => {
      markGone(p.pub)
      if (!onlinePubs.delete(p.pub)) return
      renderContacts()
      diag.note(`peer ${p.pub.slice(0, 12)} dark`)
    },
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
// ---- show-the-password eye -------------------------------------------------
/**
 * Every password field gets the eye, wired here rather than drawn in markup:
 * one loop over `input[type="password"]` covers all eight fields today and
 * whatever field arrives tomorrow. Two decisions:
 *
 * - **Masked again on blur.** Peeking is a GESTURE, not a state: a password
 *   left visible in a reopened window is a password on a projector. Tapping
 *   the eye itself does not blur the input (pointerdown preventDefault), so
 *   the toggle works without fighting this rule.
 * - **SVG, not a glyph** (the /tofu rule), and `tabindex=-1` — tabbing
 *   from password to the next field should not stop at an ornament.
 */
const EYE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>'
const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'

for (const input of document.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
  const wrap = document.createElement('span')
  wrap.className = 'pw-wrap'
  input.parentElement!.insertBefore(wrap, input)
  wrap.appendChild(input)
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'pw-eye'
  btn.tabIndex = -1
  const paint = () => {
    const shown = input.type === 'text'
    btn.innerHTML = shown ? EYE_OFF_SVG : EYE_SVG
    btn.title = shown ? tr('Ukryj hasło') : tr('Pokaż hasło')
    btn.setAttribute('aria-label', btn.title)
  }
  // The eye must not steal focus — a focus shift would blur the input and the
  // blur rule below would re-mask before the click even lands.
  btn.addEventListener('pointerdown', (e) => e.preventDefault())
  btn.addEventListener('click', () => {
    input.type = input.type === 'text' ? 'password' : 'text'
    paint()
    input.focus()
  })
  input.addEventListener('blur', () => {
    if (input.type === 'text') { input.type = 'password'; paint() }
  })
  paint()
  wrap.appendChild(btn)
}

/**
 * Long-press flips a row's actions into view — the touch stand-in for hover
 * (see the .c-edit CSS note: the delete x was unreachable on a phone).
 * Android reports the gesture as `contextmenu`; a mouse keeps its real
 * context menu, so the handler is gated to coarse pointers. One row at a
 * time — the gesture that opens B closes A — and a re-render (which these
 * lists do often) simply resets to clean rows.
 */
function wireRowActions(row: HTMLElement) {
  row.addEventListener('contextmenu', (e) => {
    if (!matchMedia('(pointer:coarse)').matches) return
    e.preventDefault()
    const was = row.classList.contains('show-actions')
    for (const r of row.parentElement?.querySelectorAll('.show-actions') ?? []) r.classList.remove('show-actions')
    if (!was) row.classList.add('show-actions')
  })
}
// A tap anywhere OUTSIDE the revealed row puts it away. Tapping another row
// already worked by accident (opening it re-renders the list), but a tap into
// empty space had no listener and the icons stood for ever (reported from the
// phone, with a screenshot). Capture phase: the action buttons stopPropagation
// for their own reasons, and the inside-the-row case must be decided BEFORE
// they do — taps on the row's own icons keep it open.
document.addEventListener('click', (e) => {
  for (const open of document.querySelectorAll('.contact.show-actions')) {
    if (!open.contains(e.target as Node)) open.classList.remove('show-actions')
  }
}, true)

// ---- when each contact was last heard from ---------------------------------
/**
 * A soft, per-device record beside the contact book — never inside it. The book
 * is MAC'd and can live in an HSM, where a rewrite is a device round trip; this
 * is bookkeeping whose loss costs a few days of "new" badges. See lib/seen.ts
 * for what the states mean and why the app refuses to guess between "switched
 * off" and "holding the wrong key".
 */
const SEEN_PREFIX = 'ec-seen-'
let seenMap: Record<string, Seen> = {}
let seenKey = ''

function loadSeen(idKey: string) {
  seenKey = SEEN_PREFIX + idKey
  try { seenMap = JSON.parse(localStorage.getItem(seenKey) || '{}') } catch { seenMap = {} }
}
const saveSeen = () => { if (seenKey) try { localStorage.setItem(seenKey, JSON.stringify(seenMap)) } catch {} }

/** They announced: they are here, and they hold our key. */
function markSeen(pub: string, at = nowMs()) {
  seenMap[pub] = foldSeen(seenMap[pub], at)
  saveSeen()
}
/**
 * They stopped announcing. The watch waits out its TTL before saying so, so the
 * last thing actually heard was that long ago — stamping this "now" would claim
 * a sighting that did not happen.
 */
const markGone = (pub: string) => markSeen(pub, nowMs() - PRESENCE_TTL_MS)
/** A contact exists as of now. Not a sighting. */
function markAdded(pub: string) { seenMap[pub] = foldAdded(seenMap[pub], nowMs()); saveSeen() }

/** The phrase under a contact, in the reader's own clock. */
function seenText(pub: string): string {
  const l = seenLabel(seenMap[pub], nowMs())
  if (l.kind === 'never') return ''
  if (l.kind === 'today') return tr('widziany {t}', { t: l.hhmm })
  if (l.kind === 'yesterday') return tr('wczoraj {t}', { t: l.hhmm })
  return tr('{d}, {t}', { d: l.date, t: l.hhmm })
}

function renderContacts() {
  const pane = $('pane-contacts'); pane.innerHTML = ''
  // Add-peer and the filter are static markup above this pane — see index.html
  // for why neither can live inside something that is rebuilt on every keystroke.
  const filter = val('contact-search').toLowerCase()
  const list = contactsCache.filter((c) => !filter || c.name.toLowerCase().includes(filter))
  if (!list.length) {
    // A search that matched nothing is not an empty address book, and must not
    // be answered with a tutorial: that person knows perfectly well what they have.
    if (filter) {
      const e = document.createElement('div'); e.className = 'pane-label'
      e.textContent = tr('(brak dopasowań)'); pane.appendChild(e); return
    }
    const e = document.createElement('div'); e.className = 'pane-label'
    e.textContent = tr('(brak kontaktów — dodaj peera)')
    pane.appendChild(e); return
  }
  for (const c of list) {
    const room = rooms.get(c.pub)
    const inRoom = !!room?.inRoom
    const online = onlinePubs.has(c.pub)
    const unseen = room?.unseen ?? 0
    // Green only for a live EH-2 channel; announcing-without-a-channel is
    // orange (see the .dot CSS). secured() reads the engine's live session
    // set, so it drops the instant the peer is forgotten.
    const secured = !!room?.conv && room.conv.secured().length > 0
    const dotClass = secured ? 'ok' : (inRoom || online) ? 'online' : ''
    const dotTitle = secured ? tr('Bezpieczny kanał (EH-2)')
      : (inRoom || online) ? tr('Dostępny — otwórz rozmowę, żeby zestawić kanał')
        : tr('Offline')
    const src = c.source === 'hem' ? { i: '🔒', t: tr('W HEM (trwałe, przenośne)') } : { i: '💻', t: tr('Lokalnie (ta przeglądarka)') }
    const b = document.createElement('button'); b.className = 'contact' + (activePub === c.pub && chatOnScreen() ? ' active' : '') + (unseen ? ' unread' : '')
    // The unread pill is the whole point of the background model: a message that
    // arrived while you were elsewhere lights here instead of yanking the view.
    const pill = unseen ? `<span class="c-unread" title="${unseen} nieprzeczytane">${unseen > 99 ? '99+' : unseen}</span>` : ''
    // What this contact has ever done, as opposed to what it is doing (the dot).
    // `new` and `cold` are the same fact — never once heard from — told
    // differently because after three days it stops being ordinary. Both offer
    // the same remedy, which happens to fix either cause without the app
    // claiming to know which one it was (lib/seen.ts).
    const state = contactState(seenMap[c.pub], nowMs(), online || inRoom)
    const stamp = seenText(c.pub)
    // Waiting beats `new` and `cold`: those say "has never answered", which is
    // true here and useless - this contact came from an invite we knocked on,
    // and the remedy they offer (send them your code) is exactly what the knock
    // already did.
    //
    // The badge is ALL of it. A sentence under the name saying the same thing in
    // engineering language was here and is gone (the user asked for none of it):
    // this line's job on a list of people is to identify one, and the sentence
    // pushed the fingerprint out of the row. What it said lives in the badge's
    // tooltip, and in the toast that pressing the badge shows.
    const wait = waiting.get(c.pub)
    const mark = wait
      ? `<span class="c-new waiting" title="${escapeHtml(tr('Zapukaliśmy i czekamy na przyjęcie. Nie ma potwierdzenia, że doręczono — ponawiamy, dopóki aplikacja jest otwarta.'))}">${tr('CZEKAM')}</span>`
      : unseen ? '' // an unread message is louder than either of these
      : state === 'new' ? `<span class="c-new" title="${escapeHtml(tr('Jeszcze się nie odezwał — jeśli nie ma Twojego klucza, wyślij mu swój kod (kliknij)'))}">${tr('NOWY')}</span>`
      : state === 'cold' ? `<span class="c-new cold" title="${escapeHtml(tr('Ani razu się nie odezwał. Albo go nie było, albo nie ma Twojego klucza — kliknij, żeby wysłać kod ponownie'))}">?</span>`
      : state === 'quiet' && stamp ? `<span class="c-seen">${escapeHtml(stamp)}</span>`
      : ''
    b.innerHTML = `<span class="dot ${dotClass}" title="${escapeHtml(dotTitle)}"></span><div class="avatar">${escapeHtml(initials(c.name))}</div>`
      + `<div class="c-info"><div class="c-name">${escapeHtml(c.name)} <span class="src" title="${src.t}">${src.i}</span></div>`
      // For a cold contact the explanation goes FIRST: this line ellipsizes on a
      // phone, and the fingerprint losing its tail costs nothing next to the
      // sentence that says why the dot will never light.
      + `<div class="c-sub" title="${escapeHtml(c.kid ? `KID ${c.kid}` : c.pub)}">`
      + `${state === 'cold' && !wait ? escapeHtml(tr('nigdy się nie odezwał')) + ' · ' : ''}`
      + `🔑 ${escapeHtml(fpCache.get(c.pub) ?? '…')}${c.kid ? ' · KID ' + escapeHtml(shortKid(c.kid)) : ''}</div></div>`
      + mark + pill + `<button class="c-edit" title="${tr('Zmień nazwę')}">✎</button><span class="c-x" title="${tr('Usuń')}">×</span>`
    b.addEventListener('click', async (e: any) => {
      // Pressing the badge sends them your code instead of opening a room —
      // which is the thing to do about a contact that has never answered, and
      // the reason the badge is worth having at all.
      if (e.target.classList.contains('c-new')) { e.stopPropagation(); void openShare(); return }
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
          + `${c.source === 'hem' ? tr(', a klucz kontaktu zostanie usunięty z HEM') : ''}. `
          + tr('Historia rozmowy i tak nie jest przechowywana.'), tr('Usuń'))).ok) return
        await closeRoom(c.pub)
        if (session) { try { await session.book.remove(c) } catch (err: any) { toast(tr('Błąd usuwania: ') + (err?.message ?? err)) } }
        await refreshContacts(); return
      }
      void openRoomFor(c, true)
    })
    wireRowActions(b)
    pane.appendChild(b)
  }
}
$('contact-search').addEventListener('input', renderContacts)
$('group-search').addEventListener('input', renderGroups)
$('btn-add-peer').addEventListener('click', () => openModal())
$('btn-new-group').addEventListener('click', openGroupModal)

// ---- ask / rename: two promise-shaped modals reused by every destructive or
// editing action. Deliberately NOT window.confirm/prompt: a mobile webview
// draws those as browser chrome outside the app's skin, and they block the
// event loop — which here means the transport stops pumping while a dialog is
// open. -------------------------------------------------------------------
function ask(title: string, body: string, yes = 'Tak', rememberLabel?: string, href?: string, noLabel: string | null = 'Nie', danger = true): Promise<{ ok: boolean; remember: boolean }> {
  return new Promise((resolve) => {
    $('ask-title').textContent = title
    $('ask-body').textContent = body
    $('ask-yes').textContent = tr(yes)   // same reason as `noLabel` below
    // Every use of this dialog until now was destructive — deleting a contact,
    // wiping a device — so the affirmative button is red in the markup. An
    // offer is not a warning, and a red "send my code" would teach people to
    // hesitate over the one action the dialog exists to encourage.
    $('ask-yes').classList.toggle('danger', danger)
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
      if (href) { open.href = href; open.textContent = tr(yes) }
    }
    $('ask-yes').hidden = !!(href && open)
    // A NOTICE has one way out. Passing no `noLabel` hides the second button, so
    // "close this and try again" does not have to be phrased as yes-or-no.
    const no = $('ask-no')
    no.hidden = noLabel === null
    // Through `tr`, because the DEFAULTS here are Polish literals and this line
    // overwrites the translated text the markup already carried. Every
    // confirmation in the app said "Nie" in an English UI - caught in a
    // screenshot of the invites tab, 2026-09-15. A key with no entry comes back
    // unchanged, so a caller that already translated its label is unaffected.
    if (noLabel) no.textContent = tr(noLabel)
    $('members-pop').hidden = true; closeEmojiPop() // nothing may stay clickable behind a modal
    pushModal('ask-modal')
    const done = (v: boolean) => {
      const remember = !!(rememberLabel && cb?.checked)
      dropModal('ask-modal')
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

function promptName(title: string, sub: string, current: string, label = 'Nazwa', secret = false): Promise<string | null> {
  return new Promise((resolve) => {
    $('rename-title').textContent = title
    $('rename-sub').textContent = sub
    $('rename-label').textContent = label
    clr('rename-msg')
    const input = $('rename-input') as HTMLInputElement
    // One window for "give me one string", so a password reuses it rather than
    // growing a second form to keep in step. Put back on the way out, always -
    // the next caller is a contact name and must not be typed into dots.
    input.type = secret ? 'password' : 'text'
    input.value = current
    $('members-pop').hidden = true; closeEmojiPop()
    pushModal('rename-modal')
    const done = (v: string | null) => {
      if (v) endModals(); else dropModal('rename-modal') // saved, or withdrawn
      input.type = 'text'
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
 * Escape leaves any window that has a way out.
 *
 * Every modal ends in a `.modal-actions` row whose ghost button is that way
 * out, and each of those buttons carries its own TEARDOWN: `scan-cancel`
 * releases the camera, `rec-cancel` drops the take, `identity-cancel` reloads
 * the page because the derived key must not outlive the decision. So Escape
 * presses that button rather than hiding the box - hiding it would leave the
 * camera running behind a window that looks closed.
 *
 * Which button: the id, not the position. `fb-modal` has a SECOND ghost button
 * (`fb-copy`, unhidden only after a failed send), so "the ghost one" would pick
 * the wrong one exactly when the user most wants out.
 *
 * Two sets stay out of it:
 *  - `ask`, `rename` and `identity` bind Escape themselves while they are open,
 *    because each resolves a promise and the answer is part of the teardown.
 *    Their handlers happen to be idempotent, so a double press would be
 *    harmless, but one owner per window is the reason there is no bug to have.
 *  - `xfer-modal` is not a dialog with a Cancel. Its ghost button ABORTS a
 *    transfer that is already moving bytes, and a key hit by reflex must not be
 *    able to do that. Leaving it is a click, deliberately.
 */
const ESC_SELF_OWNED = new Set(['ask-modal', 'rename-modal', 'identity-modal', 'xfer-modal'])
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return
  // Document order is stacking order here, so the LAST open one is the one on
  // top - the rare case being a modal opened from another.
  const open = Array.from(document.querySelectorAll('.modal.open'))
    .filter((m) => !ESC_SELF_OWNED.has(m.id)).pop()
  if (!open) return
  const out = open.querySelector(
    '.modal-actions [id$="-cancel"]:not([hidden]),.modal-actions [id$="-close"]:not([hidden])',
  ) as HTMLElement | null
  if (!out) return
  e.preventDefault()
  out.click()
})

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
  // (Same repair as above, and gone for the same reason: the stack puts the
  // asking window and its backdrop back when `ask()` closes.)
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
function attachByteBudget(input: HTMLInputElement | HTMLTextAreaElement, max: number, out: HTMLElement) {
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

// ---- one window at a time, and a way back ----------------------------------
/**
 * The windows on screen, outermost first.
 *
 * Before this each window closed itself and whatever it opened simply appeared,
 * which produced two failures with one cause. Two windows could share the
 * screen -- scanning a QR left "Dodaj peera" behind the import window, its own
 * Save and Cancel poking out below (reported with screenshots, 2026-09-23). And
 * a window opened FROM another had no way back: the welcome card offers three
 * ways in, each one closed it, and cancelling what it opened left an empty
 * screen in the first minute of a new profile.
 *
 * So the windows form a stack, and there are two ways to leave one. The
 * difference is not technical, it is what happened:
 *
 *   `backModal()` -- you withdrew. Cancel, Escape, a click on the backdrop.
 *                    This window goes, the one it came from returns.
 *   `endModals()` -- the errand is finished. The contact was added, the file
 *                    was sent. Everything goes, because coming back to "Dodaj
 *                    peera" after adding somebody would be absurd.
 *
 * Every close has to pick one, and the pick is a judgement about the flow, not
 * a mechanical substitution -- which is why they are named for the answer
 * rather than for the mechanism.
 */

/**
 * What a window has to put away on its way out, whoever closes it.
 *
 * Leaving used to be the window's own function, so the tidying lived there —
 * and a generic "go back" would have walked past it, leaving the camera on
 * after a backdrop click. Registered against the window instead, so it happens
 * for every exit: its own button, Escape, the backdrop, or a flow that moved
 * on. Each entry must be safe to run twice, because the window's own close
 * still does its part.
 */

/** Open a window. Whatever was on screen becomes the one to return to. */
function pushModal(id: string) {
  const top = modalStack[modalStack.length - 1]
  if (top === id) return // already here: an open() that also repaints
  if (top) $(top).classList.remove('open')
  modalStack.push(id)
  $('scrim').classList.add('open')
  $(id).classList.add('open')
}

/** You withdrew from this window: it goes, the one behind it comes back. */
function backModal() {
  const id = modalStack.pop()
  if (id) { MODAL_EXIT[id]?.(); $(id).classList.remove('open') }
  const prev = modalStack[modalStack.length - 1]
  if (prev) $(prev).classList.add('open')
  else $('scrim').classList.remove('open')
}

/** The errand is over. Nothing to come back to. */
function endModals() {
  for (const id of modalStack) { MODAL_EXIT[id]?.(); $(id).classList.remove('open') }
  modalStack.length = 0
  $('scrim').classList.remove('open')
}

/**
 * Leave THIS window whether or not it is the one on top.
 *
 * A window can be closed by something other than its own button -- a scan that
 * succeeded, a transfer that ended -- and by then the stack may have moved on.
 * Removing it by name keeps the stack honest instead of popping whatever
 * happens to be last.
 */
function dropModal(id: string) {
  const i = modalStack.lastIndexOf(id)
  if (i < 0) {
    // On screen but not in the stack: something put it there outside this
    // mechanism. Close it anyway and leave the stack alone — a window that
    // refuses to close because the bookkeeping disagrees is a worse failure
    // than the bookkeeping being wrong, and it is the one the person is stuck
    // looking at.
    MODAL_EXIT[id]?.()
    $(id).classList.remove('open')
    if (!modalStack.length) $('scrim').classList.remove('open')
    return
  }
  modalStack.splice(i, 1)
  MODAL_EXIT[id]?.()
  $(id).classList.remove('open')
  const top = modalStack[modalStack.length - 1]
  if (top) $(top).classList.add('open')
  else $('scrim').classList.remove('open')
}

const paintScanButton = () => { $('btn-scan').hidden = !scanSupported() }
// Focus only where a keyboard is already on the desk: on a phone, focusing
// the field pops the software keyboard OVER the modal before the person can
// reach the scan button — and scan is the primary door there.
const openModal = () => { pushModal('add-modal'); clr('add-msg'); ;($('add-name') as HTMLInputElement).value = ''; ($('add-pub') as HTMLInputElement).value = ''; paintStoreOptions('add-store'); paintScanButton(); if (matchMedia('(pointer:fine)').matches) $('add-pub').focus() }
const closeModal = () => dropModal('add-modal')
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
  // Not closed: the window stays in the stack, so Cancel on the invite comes
  // back here instead of to an empty screen.
  if (inv) { await showInvite(inv, name); return }
  if (!name || !pub) { setMsg('add-msg', tr('Podaj nazwę i klucz.'), 'err'); return }
  try { if (Uint8Array.from(atob(pub), (c) => c.charCodeAt(0)).length !== 32) { setMsg('add-msg', tr('Klucz nie wygląda na 32-bajtowy X25519 (base64).'), 'err'); return } }
  catch { setMsg('add-msg', tr('Klucz nie jest poprawnym base64.'), 'err'); return }
  const store = storeChoice('add-store')
  if (store === 'none') { endModals(); void openRoomFor({ name, pub, source: 'local' }, true); return } // ephemeral — nothing saved (HEM nor localStorage)
  const persistent = store !== 'local'
  const btn = $('add-save') as HTMLButtonElement; btn.disabled = true; btn.textContent = tr('Zapisuję…')
  try {
    if (!(await claimContact(name, pub))) return
    await session.book.add(name, pub, persistent)
    markAdded(pub)
    await refreshContacts()
    endModals() // added: there is nothing to come back to
    // Same question as the link path. Typing a key by hand is exactly the case
    // where the other side has nothing of yours yet.
    if ((await ask(tr('Dodano {name}', { name }),
      tr('{name} nie ma jeszcze Twojego klucza — bez niego nie zobaczycie się nawzajem. Odesłać teraz swój kod?', { name }),
      tr('Odeślij mój kod'), undefined, undefined, tr('Nie teraz'), false)).ok) await openShare(true)
  } catch (e: any) { setMsg('add-msg', contactAddError(e), 'err') }
  finally { btn.disabled = false; btn.textContent = tr('Zapisz') }
})

// ---- settings drawer ----
function paintTransportSetting() {
  const mode = transportMode()
  const chip = $('chip-profile')
  chip.textContent = mode === 'relay' ? tr('⚪ Tylko węzeł')
    : mode === 'direct' ? tr('🔒 Tylko bezpośrednio')
    : tr('🟢 Automatycznie')
  const pick = document.querySelector(`#tmode input[value="${mode}"]`) as HTMLInputElement | null
  if (pick) pick.checked = true
  // WebKitGTK (the packaged desktop) has no RTCPeerConnection at all, so this
  // mode would not be a stricter posture there — it would be a mute button.
  // `auto` is safe to offer anywhere because it degrades to the node; this one
  // has nowhere to degrade to, by definition.
  const canDirect = directPossible() && !WEBRTC_OFF
  const row = document.getElementById('tmode-direct-row') as HTMLElement | null
  const radio = document.querySelector('#tmode input[value="direct"]') as HTMLInputElement | null
  if (row && radio) {
    radio.disabled = !canDirect
    row.style.opacity = canDirect ? '' : '.5'
    row.title = canDirect ? '' : tr('Ta przeglądarka nie ma WebRTC — nie ma czym prowadzić rozmowy bez węzła')
  }
}
$('chip-profile').addEventListener('click', () => openDrawer())
for (const el of document.querySelectorAll('#tmode input')) {
  el.addEventListener('change', () => {
    const v = (document.querySelector('#tmode input:checked') as HTMLInputElement | null)?.value
    // Written on every press, both ways: the stored value is what tells an
    // explicit choice apart from "never opened this drawer", and the default
    // (relay) is what the second group gets.
    try { localStorage.setItem(TRANSPORT_KEY, v === 'auto' || v === 'direct' ? v : 'relay') } catch {}
    paintTransportSetting()
    toast(v === 'relay' ? tr('Nowe rozmowy pójdą tylko przez węzeł')
      : v === 'direct' ? tr('Nowe rozmowy pójdą wyłącznie kanałem bezpośrednim — bez grup')
      : tr('Nowe rozmowy spróbują połączenia bezpośredniego'))
  })
}

const openDrawer = () => { $('scrim').classList.add('open'); $('drawer').classList.add('open'); renderProfiles(); paintTransportSetting(); paintNotifySetting(); void paintDiagSetting(); paintDiagnostics(); startNetwork(); paintHelpToggles() }

/**
 * The diary's row in Settings: where the file is, and a way to take the log
 * with you from anywhere else. Painted on open rather than at boot — the path
 * is a question for the host, and asking it costs nothing once a drawer opens.
 */
async function paintDiagSetting() {
  const path = await diagPath()
  for (const id of ['log-section', 'log-hint', 'btn-log-copy']) $(id).hidden = false
  const p = $('log-path')
  p.hidden = !path
  if (path) { p.textContent = path; p.title = path }
}
$('btn-log-copy').addEventListener('click', async () => {
  // The in-memory ring, which on a desktop is the tail of the same file and in
  // a browser is all there is.
  const text = diag.all().join('\n')
  try {
    await navigator.clipboard.writeText(text)
    toast(tr('Dziennik skopiowany ({n} linii)', { n: diag.all().length }))
  } catch {
    // A clipboard that refuses (no permission, no secure context) must not be
    // the end of the road: the log is the reason somebody pressed this.
    console.log(text)
    toast(tr('Schowek odmówił — dziennik jest w konsoli'))
  }
  diagFlush()
})
// The 2.5 s refresh belongs to whatever is showing the node list, and that is
// the drawer now. Left running behind a closed drawer it would poll for ever.
/**
 * One question mark beside each section's name, folding that section's
 * explanations.
 *
 * Per section rather than per paragraph: a heading with several notes under it
 * (the desktop block has three) would otherwise grow a row of buttons, and the
 * point was one consistent affordance in one consistent place.
 *
 * The button is a SIBLING of the heading, both wrapped in a flex row. It cannot
 * be a child: `applyDom` writes textContent on anything carrying data-i18n, so
 * a button inside the heading would vanish on the first language switch — which
 * is exactly how the invites tab lost its badge once.
 *
 * Diagnostics are skipped: that block already sits behind one button.
 */
function paintHelpToggles() {
  for (const head of [...document.querySelectorAll('#drawer .d-section')] as HTMLElement[]) {
    if (head.closest('#diag-more')) continue
    // Everything explanatory until the next heading belongs to this one.
    const notes: HTMLElement[] = []
    for (let el = head.nextElementSibling; el && !el.classList.contains('d-section'); el = el.nextElementSibling) {
      if (el.classList.contains('d-note') || el.classList.contains('hint')) notes.push(el as HTMLElement)
    }
    let row = head.parentElement
    if (!row || !row.classList.contains('d-sec-row')) {
      if (!notes.length) continue
      row = document.createElement('div')
      row.className = 'd-sec-row'
      head.parentNode!.insertBefore(row, head)
      row.appendChild(head)
      const btn = document.createElement('button')
      btn.type = 'button'; btn.className = 'help-toggle'
      btn.textContent = '?'
      btn.setAttribute('aria-expanded', 'false')
      btn.title = tr('Potrzebujesz pomocy?')
      btn.addEventListener('click', () => {
        const open = btn.getAttribute('aria-expanded') !== 'true'
        btn.setAttribute('aria-expanded', String(open))
        for (const n of notes) n.classList.toggle('is-open', open)
      })
      for (const n of notes) n.classList.add('collapsible')
      row.appendChild(btn)
    }
    // A section whose notes the app hides for its own reasons (no tray here, no
    // HEM on this profile) must not keep a button that opens nothing.
    const btn = row.querySelector('.help-toggle') as HTMLElement | null
    if (btn) btn.hidden = notes.every((n) => n.hidden)
  }
}

const closeDrawer = () => { $('scrim').classList.remove('open'); $('drawer').classList.remove('open'); stopNetwork() }
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
/**
 * The invite in a link, if the link is to THIS app: the canonical address the
 * packaged builds hand out, or the page we are on (a self-hosted or test
 * deployment hands out itself). Anything else is somebody else's page, and a
 * fragment that merely looks like an invite does not make it ours.
 */
function ownInvite(href: string): Invite | null {
  let u: URL
  try { u = new URL(href) } catch { return null }
  const at = (origin: string, path: string) => u.origin === origin && u.pathname.replace(/\/$/, '') === path.replace(/\/$/, '')
  if (!at(CANONICAL_ORIGIN, CANONICAL_PATH) && !at(location.origin, location.pathname)) return null
  return decodeInvite(u.hash)
}

window.addEventListener('hashchange', () => {
  const inv = takeInviteFromUrl()
  if (!inv) return
  pendingInvite = inv
  if (session) void showInvite(inv) // otherwise the login screen hands it over
})


/**
 * -----------------------------------------------------------------------------
 * WHERE INVITE LINKS POINT — change these two lines to point a build at another
 * deployment (your own domain, your own path), then rebuild.
 * -----------------------------------------------------------------------------
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
 * A packaged build has no origin that serves the file store, so it is told one.
 *
 * The desktop and Android shells load this bundle from `tauri://localhost`,
 * where the store's `/f/<cid>` is an asset that does not exist — so `Pokaż`,
 * `Pobierz` and sending a file all died at the fetch, and did so identically,
 * because they are one URL with three buttons on it. Reported on the desktop as
 * "Show does nothing and Download turns into an error".
 *
 * The web is untouched: there the default same-origin path still holds, which
 * is what keeps the store free of CORS and the IPFS node invisible to clients.
 * WARNING: A packaged build now makes a CROSS-ORIGIN request to onchato.com, so the
 * `/f` blocks in nginx must answer with `Access-Control-Allow-Origin`. Ship the
 * two together or the packaged apps stay exactly as broken.
 */
if (isDesktopShell()) setStoreOrigin(CANONICAL_ORIGIN)
// The login card's way back to the landing. The markup carries the same address
// so the link survives a dead bundle; this makes the constant the one that decides,
// so a moved domain cannot leave a stale link on the screen people log in from.
{
  const home = document.getElementById('home-link') as HTMLAnchorElement | null
  if (home) { home.href = CANONICAL_ORIGIN + '/'; home.textContent = new URL(CANONICAL_ORIGIN).host }
}

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
  pushModal('share-modal')
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
  // The same link as a QR, so the exchange can happen across a table instead of
  // through a messenger. A phone's own camera opens it — the code holds the URL
  // itself, not a private format only this app understands.
  try {
    $('share-qr').innerHTML = qrSvg(($('share-link') as HTMLInputElement).value, { size: 220 })
    $('share-qr').hidden = false
  } catch (e: any) {
    // A link too long for the encoder: the text field above still works, and a
    // silent empty box would be the worse outcome.
    $('share-qr').hidden = true
    ecLog('QR not drawn: ' + (e?.message ?? e), 'debug')
  }
}
const closeShare = () => dropModal('share-modal')
// Zaznaczenie linku po kliknięciu było atrybutem `onclick` w markupie; CSP nie
// przepuszcza atrybutów zdarzeń, a jeden taki atrybut wymusiłby `unsafe-inline`
// w `script-src`, co unieważnia całą politykę.
;($('share-link') as HTMLInputElement).addEventListener('click', function () { this.select() })
$('btn-share').addEventListener('click', () => void openShare())
$('share-close').addEventListener('click', closeShare)
$('share-copy').addEventListener('click', async () => {
  const el = $('share-link') as HTMLInputElement
  try { await navigator.clipboard.writeText(el.value); toast(tr('Link skopiowany')) }
  catch { el.select(); toast(tr('Zaznaczono — skopiuj ręcznie')) } // no clipboard permission, or plain http
})

const closeImport = () => dropModal('import-modal')
// A half-read invite must not survive the window that was reading it.
MODAL_EXIT['import-modal'] = () => { pendingInvite = null }
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
  if (m) return decodeInvite(m[1])
  // The bare code: what someone reads out loud, or copies out of a link by
  // hand, with nothing in front of it. Its SHAPE buys it nothing - the check is
  // the same `decodeInvite` every other form goes through, which demands
  // base64url that parses as JSON carrying a 32-byte key and a name with no
  // invisible characters in it. A public key pasted into the add window cannot
  // be mistaken for one: 32 bytes of key do not parse as JSON, and this branch
  // is reached last in any case.
  return /^[A-Za-z0-9\-_]+$/.test(t) ? decodeInvite('i=' + t) : null
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
  // The add window is the usual way in here — somebody pressed "scan" or pasted
  // a link inside it — and it was left OPEN underneath. Two windows then shared
  // the screen: the invite's fields in the middle with "Dodaj peera" above it
  // and that window's own Save/Cancel poking out below (reported with
  // screenshots from Android and iOS, 2026-09-23). Closed here rather than at
  // each call site, because every path that reaches an invite comes through
  // some window it came from, and that window is where Cancel belongs.
  pushModal('import-modal')
  clr('import-msg')
  ;($('import-name') as HTMLInputElement).value = nameOverride || inv.name
  paintStoreOptions('import-store')
  // Nothing to answer on means nothing to say: an invite with no inbox has no
  // knock to carry a note, so the field would be a box that swallows what you
  // wrote. Cleared every time - a note is about one request, not a preference.
  const note = $('import-note') as HTMLTextAreaElement
  note.value = ''
  note.dispatchEvent(new Event('input'))
  $('import-note-box').hidden = !inv.inbox
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
    // An invite carrying an inbox answers itself: this side knocks on it, and
    // the contact stays marked as waiting until the other side announces. There
    // is no reply channel to watch - the answer IS them appearing on the pair
    // topic, which this client could always derive (DISCOVERY-PROPOSAL.md §2.2).
    if (inv.inbox && store !== 'none') startKnocking(inv.pub, inv.inbox, name, val('import-note'))
    pendingInvite = null
    endModals() // imported: the windows it came through are finished too
    // Nothing was written, so the conversation is all there is: open it, or the
    // import ends with no trace of having happened.
    if (store === 'none') void openRoomFor({ name, pub: inv.pub, source: 'local' }, true)
    // Only the FIRST leg asks for a key back. An imported reply means both sides
    // now hold both keys, and offering to send ours again is how this loops
    // forever — which is exactly what it did.
    if (store !== 'none') markAdded(inv.pub)
    // Reported 2026-09-10: the app answered "contact added" by putting YOUR OWN
    // code on screen, which reads as a non-sequitur unless you already know
    // why. The reason is that adding somebody is one-way — they still have
    // nothing of yours — so it is said in a sentence and left as a choice.
    if (inv.reply) toast(tr('Wymiana zakończona — możecie rozmawiać'))
    // An inbox invite has already sent our key: that is what the knock IS.
    // Asking to send it again right afterwards would read as the app not
    // knowing what it just did, and answering yes would hand the person a
    // second, manual copy of a thing already in flight.
    else if (inv.inbox && store !== 'none') toast(tr('Zapukaliśmy — czekamy, aż {name} przyjmie', { name }))
    else if ((await ask(tr('Dodano {name}', { name }),
      tr('{name} nie ma jeszcze Twojego klucza — bez niego nie zobaczycie się nawzajem. Odesłać teraz swój kod?', { name }),
      tr('Odeślij mój kod'), undefined, undefined, tr('Nie teraz'), false)).ok) await openShare(true)
  } catch (e: any) { setMsg('import-msg', contactAddError(e), 'err') }
  finally { btn.disabled = false; btn.textContent = label ?? tr('Dodaj kontakt') }
})



// ---- knocking --------------------------------------------------------------
/**
 * "I am here — are you?"
 *
 * The hardest problem in a synchronous messenger is not delivery, it is being
 * in the room at the same time. There is no push here and nothing that holds a
 * message for later, so a knock is the one thing that can turn "they are online
 * but looking elsewhere" into a conversation.
 *
 * Everything about it follows from what it cannot do:
 *
 * - **It is not queued and not re-sent.** A knock that lands ten minutes late is
 *   worse than one that never landed, so the button refuses when there is no
 *   live session rather than pretending.
 * - **It reports "sent into the room", never "delivered".** There is no
 *   acknowledgement, and there should not be — an ack would make it a message.
 * - **It is rate-limited on BOTH sides.** Ten seconds locally so it cannot be
 *   leant on, and five seconds per peer on the way in, because attention is
 *   exactly what an unwanted contact would try to take.
 */
const KNOCK_COOLDOWN_MS = 10_000
const KNOCK_IGNORE_MS = 5_000
let knockedAt = 0
const knockHeard = new Map<string, number>()

/**
 * The beep, and why it is this complicated.
 *
 * A knock is heard by somebody who is, by definition, NOT interacting with the
 * page — that is the point of knocking. An AudioContext created at that moment
 * starts `suspended` under every browser's autoplay policy and its scheduled
 * notes never sound; building one per knock also runs into the per-page limit
 * on contexts. Together that produced exactly the reported failure: it played
 * once, and then never again.
 *
 * So: ONE context, created on a user gesture (when creating it is allowed),
 * kept rather than closed, and resumed on every gesture afterwards, because a
 * tab that has been in the background can have it suspended again. A knock then
 * only has to schedule notes on a context that is already running.
 */
let audioCtx: any = null
function primeAudio() {
  const Ctx = (window as any).AudioContext ?? (window as any).webkitAudioContext
  if (!Ctx) return
  try {
    audioCtx ??= new Ctx()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
  } catch { /* no audio here; the title flash and the transcript still speak */ }
}
// Any gesture will do, and every gesture re-arms it: `resume()` needs the page
// to have activation, and a page that sat in the background loses it.
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  document.addEventListener(ev, primeAudio, { passive: true })
}

function knockSound() {
  try {
    primeAudio()
    const ctx = audioCtx
    // Suspended means the platform never granted audio here. Say nothing rather
    // than scheduling notes into a context that will not play them — the title
    // flash is the fallback that needs no permission.
    if (!ctx || ctx.state !== 'running') return
    const t0 = ctx.currentTime
    for (const [at, hz] of [[0, 880], [0.14, 660]] as const) {
      const osc = ctx.createOscillator(); const gain = ctx.createGain()
      osc.frequency.value = hz; osc.type = 'sine'
      gain.gain.setValueAtTime(0.0001, t0 + at)
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.12)
      osc.connect(gain); gain.connect(ctx.destination)
      osc.start(t0 + at); osc.stop(t0 + at + 0.14)
    }
    // The context is NOT closed: it is the one we keep. Closing it is what made
    // the second knock silent.
  } catch { /* no audio: the title flash and the transcript line remain */ }
}

/**
 * The attention-getter that needs no permission and no speaker: the tab title.
 * It is the only channel that still works with notifications denied, sound
 * blocked and the window behind something — which, for a knock, is the whole
 * situation.
 */
let titleFlash: any = null
const REAL_TITLE = document.title
function flashTitle(text: string) {
  clearInterval(titleFlash)
  if (!windowAway()) return // being used: the transcript line is right there
  let on = false
  titleFlash = setInterval(() => { document.title = (on = !on) ? text : REAL_TITLE }, 900)
}
function stopTitleFlash() {
  clearInterval(titleFlash); titleFlash = null
  if (document.title !== REAL_TITLE) document.title = REAL_TITLE
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) stopTitleFlash() })
window.addEventListener('focus', stopTitleFlash)

function paintKnockButton() {
  const room = activeRoom()
  const can = !activeGid && !!room?.conv && room.conv.secured().length > 0 && nowMs() - knockedAt > KNOCK_COOLDOWN_MS
  const btn = $('btn-knock') as HTMLButtonElement
  btn.hidden = !!activeGid // groups have no knock: it would be a room-wide alarm
  btn.disabled = !can
  btn.title = activeGid ? '' : (can ? tr('Puknij — zwróć uwagę') : tr('Puknięcie działa tylko, gdy rozmówca jest w pokoju'))
}
$('btn-knock').addEventListener('click', () => {
  const room = activeRoom()
  if (!room?.conv || !room.conv.secured().length) { toast(tr('Puknięcie działa tylko, gdy rozmówca jest w pokoju')); return }
  room.conv.sendKnock()
  knockedAt = nowMs()
  paintKnockButton()
  setTimeout(paintKnockButton, KNOCK_COOLDOWN_MS + 100)
  // "Into the room", not "delivered": nothing acknowledges a knock.
  record(room, { t: 'sys', text: tr('👋 Puknięcie wysłane do pokoju — jeśli rozmówca tu jest, usłyszy je teraz') })
})

/** Somebody knocked at us. */
function knockReceived(room: Room) {
  const last = knockHeard.get(room.contact.pub) ?? 0
  if (nowMs() - last < KNOCK_IGNORE_MS) {
    // Said out loud in the trace, because from the outside a rate-limited
    // knock and a lost one look identical — and one of them is a bug report.
    ecLog(`knock from ${room.contact.name} ignored: another one under ${KNOCK_IGNORE_MS} ms ago`)
    return
  }
  knockHeard.set(room.contact.pub, nowMs())
  record(room, { t: 'sys', text: tr('👋 {name} puka — jest teraz przy klawiaturze', { name: room.contact.name }) })
  knockSound()
  flashTitle(tr('👋 {name} puka', { name: room.contact.name }))
  const plan = planNotification({
    mode: notifyMode,
    granted: notifySupported() && notifyPermission() === 'granted',
    away: windowAway(),
    mine: false,
    name: room.contact.name,
  })
  if (!plan.show) return
  // The sound and the transcript line have already said it, so a banner that
  // cannot be drawn is not worth reporting.
  notifyShow({
    title: plan.name ?? 'onchato',
    body: tr('Puka do Ciebie'),
    tag: 'knock:' + room.contact.pub,
    onClick: () => { void activateRoom(room.contact.pub) },
  })
}

// ---- reading a QR: pairing, and the one honest verification ----------------
/**
 * The same control does two jobs, because from the outside they are one act —
 * "point the camera at what they are showing":
 *
 * - **an unknown key is an invite**, and goes through exactly the same import
 *   window as a pasted link, fingerprint and all. There is no shortcut around
 *   that window, and scanning does not earn one: a code photographed off a
 *   screen is no more trustworthy than a link out of a chat.
 * - **a key already in the contact list is a VERIFICATION.** This is the moment
 *   the product otherwise handles by two people reading hex to each other: the
 *   app compares what it holds with what the code says and answers. A key that
 *   does NOT match a contact of the same name is the interesting case and is
 *   reported as such, not folded into "new contact".
 *
 * Scanning is a PHONE feature, and that is a decision rather than a capability
 * test (the user's call, 2026-09-19). Two attempts at asking the platform both
 * failed, and the second failure is the instructive one:
 *
 *   - `typeof BarcodeDetector === 'function'` says yes on Chrome for macOS,
 *     which cannot use it. That shipped a button that opened a camera and
 *     resolved nothing.
 *   - `getSupportedFormats()` -- the spec's own answer -- ALSO says `qr_code`
 *     there. Reported from a Mac the same day: the button was still offered,
 *     the permission prompt appeared and the camera came on.
 *
 * So the platform advertises the format and does not deliver it, and no probe
 * can tell the two apart. What is left is where scanning makes sense at all:
 * a handheld with a rear camera, pointed at somebody else's screen. On a
 * laptop, pasting the link is the way in and always was.
 *
 * The packaged mobile app answers for itself (`nativeScanAvailable`, CameraX).
 * A browser is judged by shape rather than by user-agent: a coarse pointer AND
 * a narrow screen. Both, because a touchscreen laptop is not a phone.
 */
const onPhoneBrowser = () =>
  matchMedia('(pointer:coarse)').matches && matchMedia('(max-width:900px)').matches
const scanSupported = () => nativeScanAvailable()
  || (onPhoneBrowser() && !!navigator.mediaDevices?.getUserMedia)
let scanStream: MediaStream | null = null
let scanTimer: any = null
/** The native scanner is running: `closeScan` has a camera to stop. */
let scanNative = false

/**
 * One video frame in, the code's text or null out — with whichever reader this
 * browser actually has.
 *
 * `BarcodeDetector` is a Chromium API. WebKit never shipped it, and on iOS
 * EVERY browser is WebKit by Apple's rule — so scanning worked on Android and
 * was impossible on an iPhone in Chrome, Safari and Firefox alike. Reported
 * 2026-09-23. Showing a code was never affected (`lib/qr.ts` is our own
 * encoder); only reading one was.
 *
 * So there are two readers and the platform picks. Where the native one exists
 * it stays: it is decoded outside JavaScript and it is faster. Where it does
 * not, the vendored jsQR decodes the frame here — same input, same answer, and
 * the loop around it does not know the difference.
 *
 * The frame is SCALED DOWN first, and that is not an optimisation to skip. A
 * 1920x1080 frame is two million pixels through a pure-JavaScript binariser
 * every 250 ms; on a phone that is a visibly stuttering viewfinder. A QR code
 * held up to a camera survives 640px with room to spare, because a code needs
 * its modules resolved, not its pixels.
 *
 * `willReadFrequently` is asked for because that is exactly what this does —
 * without it a browser may keep the canvas on the GPU, where every
 * `getImageData` costs a readback.
 */
type QrReader = (v: HTMLVideoElement) => Promise<string | null>

/** Longest side a frame is scaled to before our own decoder reads it. */
const QR_DECODE_PX = 640

function makeQrReader(): QrReader {
  const Ctor = (globalThis as any).BarcodeDetector
  if (typeof Ctor === 'function') {
    try {
      const native = new Ctor({ formats: ['qr_code'] })
      ecLog('qr reader: BarcodeDetector')
      return async (v) => {
        const codes = await native.detect(v)
        const raw = codes?.[0]?.rawValue
        return raw ? String(raw) : null
      }
    } catch {
      // It exists and refuses the format. Chrome for macOS advertises `qr_code`
      // and does not deliver it, so this is a real case, not a defensive one —
      // and ours works there too.
    }
  }
  ecLog('qr reader: jsQR (this browser has no BarcodeDetector)')
  let cv: HTMLCanvasElement | null = null
  return async (v) => {
    const w = v.videoWidth, h = v.videoHeight
    if (!w || !h) return null // the first frames arrive before the video has size
    const k = Math.min(1, QR_DECODE_PX / Math.max(w, h))
    const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k))
    if (!cv) cv = document.createElement('canvas')
    if (cv.width !== dw || cv.height !== dh) { cv.width = dw; cv.height = dh }
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(v, 0, 0, dw, dh)
    const img = ctx.getImageData(0, 0, dw, dh)
    // `dontInvert`: a QR code is dark-on-light. Trying the inverse doubles the
    // work of every frame to find codes nobody prints.
    const found = (jsQR as any)(img.data, dw, dh, { inversionAttempts: 'dontInvert' })
    return found?.data ?? null
  }
}

async function openScan() {
  if (!scanSupported()) return
  clr('scan-msg')
  pushModal('scan-modal')
  if (nativeScanAvailable()) { await runNativeScan(); return }

  // The READER is built before the camera is asked for, and the order is the
  // whole point. On every WebKit `BarcodeDetector` does not exist -- and on
  // iOS that means EVERY browser, Chrome and Firefox included, because they
  // are all WKWebView underneath. Asking for a camera we are about to refuse
  // spent the user a permission grant for nothing: reported from iOS Chrome,
  // 2026-09-23, where the prompt appeared, was granted, and was answered with
  // "this browser cannot read a QR code". Android is a real Chromium and has
  // the reader, which is why the same flow looks fine there.
  //
  // `scanSupported()` cannot prevent this: it deliberately judges SHAPE (a
  // coarse pointer and a narrow screen), because Chrome for macOS claims the
  // `qr_code` format and then does not deliver it, so no capability answer can
  // be trusted. Constructing the reader is the only honest test, and it costs
  // nothing to do it first.
  const read = makeQrReader()

  const video = $('scan-video') as HTMLVideoElement
  try {
    // The rear camera on a phone; whatever exists on a laptop. The resolution
    // is ASKED FOR rather than accepted: with no constraint a browser is free
    // to hand back 640x480, and a QR code at arm's length is then a handful of
    // pixels that `BarcodeDetector` cannot resolve. `ideal` degrades quietly
    // on a camera that cannot do it.
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
    })
    video.srcObject = scanStream
    await video.play()
  } catch (e: any) {
    setMsg('scan-msg', tr('Brak dostępu do kamery: ') + (e?.message ?? e), 'err')
    return
  }
  setupScanZoom(scanStream)
  // A frame with no code in it resolves to null; the read THROWING is a
  // different thing, and treating the two alike is what left a live camera
  // pointed at a code it would never resolve, saying nothing, for ever. A few
  // throws in a row are allowed because the first frames can arrive before the
  // video is ready; past that it is the platform, not the picture.
  //
  // EACH PASS SCHEDULES THE NEXT — a fixed interval would not do here, and the
  // numbers say why. Our own decoder is quick when there IS a code (a few ms:
  // it finds the finder patterns and stops) and slow when there is NOT, which
  // is the normal state of a viewfinder: measured at ~130 ms for a 640px frame
  // on a laptop, and a phone is several times that. On a 250 ms interval those
  // passes would start overlapping and the preview would stutter while the
  // queue grew. Chained, a slow decode only means a slower scan, never a
  // backlog.
  let misfires = 0
  const pass = async () => {
    try {
      const raw = await read(video)
      misfires = 0
      if (raw) { handleScanned(raw); return } // handled: it reopens or closes
    } catch (e: any) {
      if (++misfires >= 4) {
        ecLog('qr scan unavailable: ' + (e?.message ?? e))
        // The camera goes out, the window stays: somebody is looking at it and
        // deserves to be told, rather than have it vanish.
        stopScanCamera()
        setMsg('scan-msg', tr('Ta przeglądarka nie odczyta kodu QR — wklej link zamiast skanować.'), 'err')
        return
      }
    }
    if (scanStream) scanTimer = setTimeout(pass, 120) // the camera is still on
  }
  scanTimer = setTimeout(pass, 120)
}

/**
 * The same scan, on the phone, through CameraX (see `nativeScanAvailable` in
 * desktop.ts for why the webview's own camera is not good enough).
 *
 * The preview is drawn BEHIND the webview, so the page goes transparent for
 * the duration — `html.scanning` in index.html — and this modal's text and its
 * Cancel button are what is left floating over the picture.
 *
 * One call scans one code. A code that is not an invite leaves the modal open
 * with a complaint, and the scanner is then started AGAIN: the plugin has
 * already stopped its camera by the time we look at what it read, and a
 * scanner that quietly stops after the first stray barcode is worse than one
 * that never started.
 */
async function runNativeScan() {
  scanNative = true
  document.documentElement.classList.add('scanning')
  void pollNativeZoom()
  let raw: string | null
  try {
    raw = await nativeScan(PREFERRED_START)
  } catch (e: any) {
    closeScanNative()
    setMsg('scan-msg', tr('Brak dostępu do kamery: ') + (e?.message ?? e), 'err')
    return
  }
  // `closeScan()` ran while we were waiting: the answer is stale, and acting on
  // it would reopen a window the user has just closed.
  if (!scanNative) return
  if (raw === null) { closeScan(); return } // backed out of the camera
  handleScanned(raw)
  if (scanNative && $('scan-modal').classList.contains('open')) void runNativeScan()
}

/** Stop the native camera and give the page its background back. */
function closeScanNative() {
  if (!scanNative) return
  scanNative = false
  void nativeScanCancel()
  document.documentElement.classList.remove('scanning')
}

/**
 * The lens's zoom, once there is a lens.
 *
 * CameraX binds the camera some way into the scan, so `zoom_range` answers
 * nothing for the first few hundred milliseconds and the slider stays hidden
 * until it does. Twelve tries at 300ms is ~3.6s, after which the honest
 * reading is that this camera has no zoom to offer.
 */
async function pollNativeZoom() {
  const row = $('scan-zoom-row')
  const slider = $('scan-zoom') as HTMLInputElement
  const label = $('scan-zoom-lab')
  row.hidden = true
  for (let i = 0; i < 12 && scanNative; i++) {
    const r = await nativeScanZoom()
    // A step of 0.1 is ours to choose: the plugin reports the ends of the range
    // and nothing about granularity.
    const plan = r ? zoomPlan({ zoom: { min: r.min, max: r.max, step: 0.1 } }) : null
    if (plan && r) {
      slider.min = String(plan.min); slider.max = String(plan.max); slider.step = String(plan.step)
      const apply = (v: number, tell: boolean) => {
        const z = clampToStep(v, plan.min, plan.max, plan.step)
        slider.value = String(z)
        label.textContent = `${z.toFixed(1)}x`
        if (tell) void nativeScanSetZoom(z)
      }
      slider.oninput = () => apply(Number(slider.value), true)
      // The scan opened at `PREFERRED_START`; show where the lens actually is
      // rather than asking it again for a zoom it already has.
      apply(r.current, false)
      row.hidden = false
      return
    }
    await new Promise((f) => setTimeout(f, 300))
  }
}

/**
 * The camera's own zoom, where it has one.
 *
 * Reported from Android: the scanner was "1:1, impractical". With several rear
 * lenses `facingMode: 'environment'` often lands on the wide one, so the code
 * is a small patch of a big frame. This is the camera's zoom, not a CSS
 * transform: it crops inside the capture pipeline, so the code arrives bigger
 * AND sharper - scaling the picture afterwards would only make the same few
 * pixels larger.
 *
 * The arithmetic lives in `lib/qrzoom.ts` and is unit-tested, because
 * capabilities are a driver detail that differs per device and per browser,
 * and this file cannot be run by a test at all: headless Chromium has neither
 * `BarcodeDetector` nor a camera that reports a zoom range.
 */
function setupScanZoom(stream: MediaStream) {
  const row = $('scan-zoom-row')
  const slider = $('scan-zoom') as HTMLInputElement
  const label = $('scan-zoom-lab')
  // Every step of this is optional and none of it may take the scanner down
  // with it. A stream that does not answer `getVideoTracks` is not exotic — a
  // webview with a partial implementation is one, and so is a test double —
  // and losing the whole scan because there was no zoom control to build is
  // the wrong trade by a mile. (Found by the browser harness, which had been
  // failing on exactly this since the zoom landed.)
  const track = stream.getVideoTracks?.()?.[0]
  const plan = zoomPlan(track?.getCapabilities?.() as any)
  row.hidden = !plan
  if (!plan || !track) return

  slider.min = String(plan.min); slider.max = String(plan.max); slider.step = String(plan.step)
  const apply = (v: number) => {
    const z = clampToStep(v, plan.min, plan.max, plan.step)
    slider.value = String(z)
    label.textContent = `${z.toFixed(1)}x`
    // `advanced` so a camera that cannot do it keeps working instead of
    // failing the whole constraint set; a rejected promise is not an error
    // worth showing - the picture is still there, only closer than asked.
    void track.applyConstraints({ advanced: [{ zoom: z } as any] } as any).catch(() => {})
  }
  slider.oninput = () => apply(Number(slider.value))
  apply(plan.start)
}

/**
 * Everything except closing the window: the camera goes out, the loop stops.
 *
 * Separate from `closeScan` because one case needs exactly this half -- a
 * reader that turns out not to work has to stop looking WITHOUT taking the
 * window away, or the explanation would close on the same tick it appeared.
 */
function stopScanCamera() {
  closeScanNative()
  clearTimeout(scanTimer); scanTimer = null // a chained pass, not an interval
  ;($('scan-zoom-row') as HTMLElement).hidden = true // the next camera may have no zoom
  for (const t of scanStream?.getTracks() ?? []) t.stop() // the camera light goes out
  scanStream = null
  ;($('scan-video') as HTMLVideoElement).srcObject = null
}

function closeScan() {
  stopScanCamera()
  dropModal('scan-modal')
}
// However it is dismissed — its own button, Escape, the backdrop, or a flow
// that moved on — the camera goes out with it.
MODAL_EXIT['scan-modal'] = () => stopScanCamera()

function handleScanned(text: string) {
  const inv = inviteFromPaste(text)
  // Not an invite: keep looking rather than closing on the first stray barcode.
  if (!inv) { setMsg('scan-msg', tr('To nie jest kod zaproszenia — pokaż kod z okna „Udostępnij swój profil”'), 'err'); return }
  closeScan()
  if (inv.pub === session?.pub) { toast(tr('To Twój własny kod')); return }
  const known = contactsCache.find((c) => c.pub === inv.pub)
  if (known) {
    // Verification: the key on screen is the key we hold. Said as a fact about
    // the KEY, not about the person — the name is ours, the key is what matched.
    toast(tr('✓ Ten sam klucz, który masz zapisany jako „{name}”', { name: known.name }))
    endModals() // the question was answered; nothing is half-done behind it
    return
  }
  const sameName = contactsCache.find((c) => c.name === inv.name)
  void showInvite(inv).then(() => {
    if (sameName) {
      // The dangerous shape: a familiar name presenting an unfamiliar key. It
      // may be a re-registration, and it may be somebody standing in the middle.
      setMsg('import-msg', tr('Masz już kontakt „{name}” z INNYM kluczem — potwierdź odcisk osobno, zanim dodasz.', { name: inv.name }), 'err')
    }
  })
}
$('btn-scan').addEventListener('click', () => void openScan())
$('scan-cancel').addEventListener('click', closeScan)

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
const PROFILE_KEYS = ['ec-soft-id-', 'ec-local-contacts-', 'ec-gcache-', 'ec-gcache-emp-', 'ec-groups-', 'ec-seen-']

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
  // The "ask about HEM" line is for the person whose key lives in this browser.
  const hemAsk = document.getElementById('hem-ask-settings'); if (hemAsk) hemAsk.hidden = !activeSoftProfile
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
  pushModal('passwd-modal'); clr('pw-msg')
  for (const f of ['pw-old', 'pw-new', 'pw-new2']) ($(f) as HTMLInputElement).value = ''
  paintMeter($('pwm-new'), '', true) // empty hides — no stale bar from last time
  ;($('pw-who') as HTMLInputElement).value = activeSoftProfile
  $('pw-old').focus()
}
const closePasswd = () => dropModal('passwd-modal')
$('btn-passwd').addEventListener('click', openPasswd)
$('pw-cancel').addEventListener('click', closePasswd)
$('pw-save').addEventListener('click', async () => {
  const oldPw = ($('pw-old') as HTMLInputElement).value
  const a = ($('pw-new') as HTMLInputElement).value, b = ($('pw-new2') as HTMLInputElement).value
  if (!a) { setMsg('pw-msg', tr('Podaj nowe hasło.'), 'err'); return }
  // Checked before touching the profile: a typo confirmed into the seal would
  // lock the identity away behind a password nobody knows.
  if (a !== b) { setMsg('pw-msg', tr('Nowe hasła się różnią.'), 'err'); return }
  const weak = weakRefusal(a)
  if (weak) { setMsg('pw-msg', weak, 'err'); ($('pw-new') as HTMLInputElement).focus(); return }
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
    endModals(); toast(tr('Hasło zmienione.')) // changed; Settings is outside the stack and stays
  } catch (e: any) {
    if (e instanceof BadPassword) setMsg('pw-msg', tr('Złe obecne hasło.'), 'err')
    else setMsg('pw-msg', tr('Błąd: ') + (e?.message ?? e), 'err')
  } finally { btn.disabled = false; btn.textContent = label ?? tr('Zapisz') }
})

$('btn-settings').addEventListener('click', openDrawer)
$('chip-profile').addEventListener('click', openDrawer)
$('btn-close-drawer').addEventListener('click', closeDrawer)
$('scrim').addEventListener('click', () => {
  // A click on the backdrop is a withdrawal, the same as Cancel — so it steps
  // BACK one window rather than sweeping the screen. Each window puts its own
  // things away through MODAL_EXIT, which is what keeps the camera from
  // staying on when the scanner is dismissed this way.
  if (modalStack.length) { backModal(); return }
  closeDrawer()
})
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
/**
 * The rest of a multi-file pick (a colleague's request, 2026-09-25: "several
 * photos at once"). The chip shows the first and a count; Send sends every one
 * as its own file message, the caption and the reply going with the first.
 * Always empty on the direct door: the engine carries one transfer at a time.
 */
let pendingMore: File[] = []
/** How many files one pick may carry, and how much in total. All of them are
 *  encrypted and uploaded at once, so the total bounds the memory it takes. */
const PICK_MAX = 10
/**
 * Which door the pending file is going through. The paperclip's menu is where
 * that is chosen, and the answer has to survive until Send — before this, the
 * direct entry sent the file the instant it was picked, so there was never a
 * moment in which to type anything.
 */
let pendingDirect = false

/** The chip is the whole of the pending state's UI, so this is the only place
 *  the variable and the DOM can drift apart — set them together, always. */
function showAttach(f: File | null, direct = false, more: File[] = []) {
  if (f) cancelEdit() // a correction is text; the chip would take the send from it
  pendingAttach = f
  pendingDirect = !!f && direct
  pendingMore = f && !direct ? more : []
  $('attach-chip').hidden = !f
  const thumb = $('attach-thumb') as HTMLImageElement
  // Whatever the chip was showing stops being anybody's business the moment it
  // is dropped — and the URL would leak for the life of the page otherwise.
  if (thumb.src.startsWith('blob:')) { URL.revokeObjectURL(thumb.src); thumb.removeAttribute('src') }
  thumb.hidden = true
  if (!f) return
  $('attach-name').textContent = f.name
  $('attach-name').title = f.name // the chip elides; the tooltip has the whole name
  $('attach-size').textContent = pendingMore.length
    ? `${humanSize(pendingMore.reduce((a, m) => a + m.size, f.size))} \u00b7 ${tr('+{n} plików', { n: pendingMore.length })}`
    : humanSize(f.size)
  // A pasted screenshot arrives called "image.png". The name is no help at all,
  // so the chip shows the picture — the one place where paste and the clip
  // genuinely differ is what the file is CALLED, and this closes it.
  //
  // Pictures ONLY. `isPreviewable` grew to cover voice notes, and an <img> in
  // the chip pointed at an audio blob draws a broken-image icon — caught by
  // rendering the real stylesheet, which is the fourth time that pass has
  // found something no test would.
  if (previewKind(f.type) === 'image') { thumb.src = URL.createObjectURL(f); thumb.hidden = false }
}

/**
 * One door for all three ways a file arrives: the clip, a paste, a drop.
 *
 * They must not diverge. What comes after picking — the chip, the caption, the
 * quote, Send — is the same machinery whichever way the file got here, and the
 * refusals have to be the same too or two of the three paths quietly accept
 * something the third does not.
 */
/**
 * The transfer window: one surface for all four states, because they are one
 * act seen from two sides and nothing may jump while somebody is watching a
 * progress bar. Waiting for consent, sending, being asked, receiving.
 *
 * It is modal on purpose (the user's call): one transfer at a time per
 * conversation, and the engine refuses a second one anyway.
 */
type XferUi = {
  room: Room
  dir: 'in' | 'out'
  name: string; size: number; mime: string
  /** The note typed with it, for the sender's own bubble. */
  body?: string
  /** The sender's own file, so its bubble can offer the same actions as the receiver's. */
  file?: File
  t0: number
  /** Bytes at the last repaint, for a speed that means something. */
  markAt: number; markBytes: number; rate: number
}
let xfer: XferUi | null = null
let xferTimer: any = null

function xferOpen() { pushModal('xfer-modal') }
function xferClose() {
  clearInterval(xferTimer); xferTimer = null
  xfer = null
  dropModal('xfer-modal')
  setFill(0)
}
const setFill = (pct: number) => { ($('xfer-fill') as HTMLElement).style.width = `${Math.max(0, Math.min(100, pct))}%` }
/** No bar while nothing is moving — an empty track reads as a stalled one. */
const showTrack = (on: boolean) => { (document.querySelector('.xfer-track') as HTMLElement).hidden = !on }
function xferButtons(yes: string | null, no: string | null) {
  const y = $('xfer-yes') as HTMLButtonElement, n = $('xfer-no') as HTMLButtonElement
  y.hidden = !yes; n.hidden = !no
  if (yes) y.textContent = yes
  if (no) n.textContent = no
}

/**
 * Start one: the chip was filled through the direct entry in the paperclip menu
 * and Send was pressed.
 *
 * Whatever is in the composer travels WITH the file, exactly as it does on the
 * way through the store (`attachFile`) — one message, not a note chasing a
 * file. The quote bar is the one thing that does NOT come along: a direct
 * transfer has nowhere on the wire to put a reply reference, so the bar is left
 * standing for the next message rather than silently spent on this one.
 */
function startTransfer(f: File | null | undefined) {
  const room = activeRoom()
  if (!f || !room?.conv) return
  const inp = $('msg-input') as HTMLTextAreaElement
  const note = inp.value.trim()
  // Checked before anything is cleared. The offer frame is one DataChannel
  // message and its ceiling is `MAX_OFFER_BODY`, far under a chat body's —
  // so this refusal is common enough to be worth being gentle about.
  if (note && bodyBytes(note) > MAX_OFFER_BODY) {
    toast(tr('Notatka przy transferze może mieć najwyżej {n} — skróć ją albo wyślij plik przez czat', { n: kb(MAX_OFFER_BODY) }))
    return
  }
  const r = room.conv.offerFile(f, note || undefined)
  if (r !== 'ok') {
    toast(r === 'no-channel' ? tr('Kanał bezpośredni nie stoi — wyślij plik przez czat')
      : r === 'busy' ? tr('Jeden transfer naraz — poczekaj, aż ten się skończy')
      : r === 'too-big' ? tr('Plik jest za duży — limit to {mb} MB', { mb: Math.floor(MAX_DIRECT / 1024 / 1024) })
      : r === 'note-too-big' ? tr('Notatka przy transferze może mieć najwyżej {n} — skróć ją albo wyślij plik przez czat', { n: kb(MAX_OFFER_BODY) })
      : tr('Pusty plik'))
    return
  }
  // Taken only now, when the engine has accepted the offer: every refusal above
  // leaves the chip and the text untouched.
  showAttach(null)
  inp.value = ''; growComposer(); paintLength()
  xfer = { room, dir: 'out', name: f.name, size: f.size, mime: f.type, file: f, body: note || undefined, t0: nowMs(), markAt: nowMs(), markBytes: 0, rate: 0 }
  $('xfer-title').textContent = tr('Transfer bezpośredni')
  $('xfer-sub').textContent = tr('do: {who}', { who: room.contact.name })
  $('xfer-file').textContent = `${f.name} · ${humanSize(f.size)}`
  $('xfer-note').textContent = tr('Plik pójdzie prosto do drugiej przeglądarki. Nie trafi na żaden serwer i nie da się go pobrać później — musicie oboje zostać w rozmowie.')
  $('xfer-left').textContent = tr('czekam na potwierdzenie…')
  $('xfer-right').textContent = ''
  xferButtons(null, tr('Anuluj'))
  showTrack(true)
  xferOpen()
  // The wait has a bar of its own: thirty seconds of nothing is the state most
  // likely to be read as "it hung", and the engine really does give up there.
  const t0 = nowMs()
  clearInterval(xferTimer)
  xferTimer = setInterval(() => {
    const left = Math.max(0, 30 - Math.round((nowMs() - t0) / 1000))
    setFill(((30 - left) / 30) * 100)
    $('xfer-right').textContent = tr('{s} s', { s: left })
  }, 250)
}

/** Progress, for either direction, with a rate that is not jitter. */
function xferProgress(done: number, total: number) {
  if (!xfer) return
  const t = nowMs()
  if (t - xfer.markAt > 700) {
    xfer.rate = ((done - xfer.markBytes) / (t - xfer.markAt)) * 1000
    xfer.markAt = t; xfer.markBytes = done
  }
  setFill((done / total) * 100)
  $('xfer-left').textContent = `${humanSize(done)} / ${humanSize(total)}`
  const left = xfer.rate > 0 ? Math.round((total - done) / xfer.rate) : 0
  $('xfer-right').textContent = xfer.rate > 0
    ? `${humanSize(Math.round(xfer.rate))}/s · ${tr('zostało ~{s} s', { s: Math.max(1, left) })}`
    : ''
}

/** Everything the engine reports about a transfer, for one room. */
function onXferEvent(room: Room, e: any) {
  const label = room.contact.name
  switch (e.t) {
    case 'offer': {
      // Asked before a byte moves, because acceptance starts it immediately.
      // The name and size are the SENDER's claims and are shown as such — a
      // .pdf in a name does not make a file a PDF.
      xfer = { room, dir: 'in', name: e.name, size: e.size, mime: e.mime, t0: nowMs(), markAt: nowMs(), markBytes: 0, rate: 0 }
      clearInterval(xferTimer); xferTimer = null
      $('xfer-title').textContent = tr('Przychodzi plik')
      $('xfer-sub').textContent = tr('{who} chce wysłać:', { who: label })
      $('xfer-file').textContent = `${e.name} · ${humanSize(e.size)}`
      $('xfer-note').textContent = tr('Transfer bezpośredni — plik idzie prosto z tamtej przeglądarki do Twojej, nie przez nasz serwer. Musicie oboje zostać w rozmowie do końca.')
      $('xfer-left').textContent = ''
      $('xfer-right').textContent = ''
      setFill(0); showTrack(false)
      xferButtons(tr('Odbierz'), tr('Nie teraz'))
      xferOpen()
      return
    }
    case 'accepted': {
      clearInterval(xferTimer); xferTimer = null
      $('xfer-note').textContent = tr('Wysyłam…')
      xferButtons(null, tr('Przerwij'))
      setFill(0)
      return
    }
    case 'progress': return xferProgress(e.done, e.total)
    case 'done': {
      if (xfer?.file) {
        const env = directFileEnv({ name: xfer.name, size: xfer.size, mime: xfer.mime }, xfer.file, e.id, xfer.body)
        record(room, { t: 'file', kind: 'me', ts: nowMs(), file: env, au: session?.pub })
      }
      xferClose()
      toast(tr('Wysłano'))
      return
    }
    case 'received': {
      // The file lands in the conversation as a bubble with the same two
      // actions the sender's has, and the window closes: a modal that only
      // repeats what the bubble offers is a modal that is in the way.
      const env = directFileEnv({ name: e.name, size: e.blob.size, mime: e.mime }, e.blob, e.id, e.body)
      record(room, { t: 'file', kind: 'peer', ts: nowMs(), file: env, au: room.contact.pub })
      xferClose()
      toast(tr('Odebrano'))
      return
    }
    case 'failed': {
      const why: Record<string, string> = {
        rejected: tr('odrzucony'), timeout: tr('niepodjęty'),
        'cancelled-local': tr('przerwany'), 'cancelled-peer': tr('przerwany po drugiej stronie'),
        channel: tr('kanał bezpośredni padł'), busy: tr('druga strona jest zajęta'),
        'too-big': tr('za duży'), empty: tr('pusty'),
        'out-of-order': tr('uszkodzony w drodze'), 'bad-frame': tr('uszkodzony w drodze'),
      }
      const name = xfer?.name ?? ''
      record(room, { t: 'sys', text: tr('Transfer: {name} — {why}', { name, why: why[e.why] ?? e.why }) })
      // A dead channel is the one failure that must be LOUD: content has gone
      // back to the relay for the rest of the conversation, and the ordinary
      // path is right there — but nothing may continue over it by itself.
      if (e.why === 'channel') {
        $('xfer-title').textContent = tr('Transfer przerwany')
        $('xfer-note').textContent = tr('Kanał bezpośredni przestał działać. Plik nie doszedł — wyślij go przez czat.')
        $('xfer-left').textContent = ''; $('xfer-right').textContent = ''
        xferButtons(null, tr('Zamknij'))
        xferOpen()
        clearInterval(xferTimer); xferTimer = null
        xfer = null
        return
      }
      xferClose()
      toast(tr('Transfer: {why}', { why: why[e.why] ?? e.why }))
      return
    }
  }
}

$('xfer-yes').addEventListener('click', () => {
  if (!xfer || xfer.dir !== 'in') return
  const conv = xfer.room.conv
  $('xfer-title').textContent = tr('Odbieram')
  $('xfer-sub').textContent = tr('od: {who}', { who: xfer.room.contact.name })
  $('xfer-note').textContent = tr('Plik idzie prosto z tamtej przeglądarki do Twojej.')
  showTrack(true)
  xferButtons(null, tr('Przerwij'))
  conv?.acceptFile()
})
$('xfer-no').addEventListener('click', () => {
  const cur = xfer
  if (!cur) { xferClose(); return }
  const conv = cur.room.conv
  if (cur.dir === 'in' && $('xfer-title').textContent === tr('Przychodzi plik')) conv?.rejectFile()
  else conv?.cancelFile()
  xferClose()
})

function offerFile(list: FileList | File[] | null | undefined, direct = false) {
  const all = [...(list ?? [])]
  const f = all[0]
  if (!f) return
  // Paste and drop can happen with no conversation on screen, which the clip
  // cannot — the composer is not there to click.
  if (!activeGid && !activeRoom()) { toast(tr('Najpierw otwórz rozmowę')); return }
  // Refused at PICK time rather than at Send: the limit is a property of the
  // file alone, and finding out after writing a caption is a worse way to learn.
  //
  // The two doors have DIFFERENT ceilings, so this gate has to ask which one
  // was chosen. `MAX_FILE` is the store's - the file is chunked, encrypted and
  // parked on a node. `MAX_DIRECT` is the direct channel's, four times larger,
  // because nothing is stored. Until 0.6.10 this line charged every pick the
  // store's 128 MB even when the direct row had been clicked, so a 306 MB file
  // was refused by a limit that did not apply to it (reported 2026-09-20) - and
  // refused before the transfer it WAS allowed to use could say otherwise.
  const cap = direct ? MAX_DIRECT : MAX_FILE
  const tooBig = all.find((x) => x.size > cap)
  if (tooBig) { toast(tr('Plik jest za duży — limit to {mb} MB', { mb: Math.floor(cap / 1024 / 1024) })); return }
  // The direct door carries one file; say which one was taken rather than
  // silently dropping the rest on the floor.
  if (direct) {
    showAttach(f, true)
    if (all.length > 1) toast(tr('Bezpośrednio jeden plik naraz — wziąłem {name}', { name: f.name }))
    return
  }
  const picked = all.slice(0, PICK_MAX)
  // Every file of a pick is encrypted and uploaded at once, so the store's
  // per-file ceiling is also the ceiling for the whole pick.
  if (picked.length > 1 && picked.reduce((a, x) => a + x.size, 0) > MAX_FILE) {
    toast(tr('Razem za dużo — limit to {mb} MB na raz', { mb: Math.floor(MAX_FILE / 1024 / 1024) })); return
  }
  showAttach(f, false, picked.slice(1))
  if (all.length > PICK_MAX) toast(tr('Naraz najwyżej {max} plików — wziąłem pierwsze {max}', { max: PICK_MAX }))
}

/**
 * The paperclip does what it always did, and grows a CHOICE when the direct
 * channel is live: send through the chat (the store, 5-minute lease) or hand
 * the file straight to the other browser (`lib/xfer.ts`, §13.1).
 *
 * A menu rather than a second icon, deliberately. This option appears and
 * disappears with the transport, and an icon that comes and goes reads as
 * something broken; a menu that grows a row reads as a choice. The badge is
 * repeated inside the row so the reason sits next to the option.
 */
$('btn-attach').addEventListener('click', () => {
  const conv = activeRoom()?.conv
  if (!conv?.canTransfer?.()) { pickFile('store'); return }
  openXferMenu($('btn-attach'))
})
function pickFile(mode: 'store' | 'direct') {
  pickMode = mode
  ;($('file-input') as HTMLInputElement).click()
}
let pickMode: 'store' | 'direct' = 'store'

function openXferMenu(anchor: HTMLElement) {
  const m = $('xfer-menu')
  if (!m.hidden) { closeXferMenu(); return }
  m.innerHTML = ''
  const row = (title: string, sub: string, badge: string, fn: () => void) => {
    const b = document.createElement('button'); b.type = 'button'
    const hd = document.createElement('span'); hd.className = 'hd'
    const t = document.createElement('span'); t.textContent = title
    hd.appendChild(t)
    if (badge) { const g = document.createElement('span'); g.className = 'badge direct'; g.textContent = badge; hd.appendChild(g) }
    const s2 = document.createElement('small'); s2.textContent = sub
    b.append(hd, s2)
    b.addEventListener('click', () => { closeXferMenu(); fn() })
    m.appendChild(b)
  }
  row(tr('Wyślij plik'), tr('przez czat — do {mb} MB, znika po 5 minutach', { mb: Math.floor(MAX_FILE / 1024 / 1024) }), '', () => pickFile('store'))
  // Both rows name their own ceiling. They differ by a factor of four, and the
  // menu is the one moment where the choice is being made - a limit learned
  // afterwards, from a refusal, is a limit learned too late.
  row(tr('Transfer bezpośredni'), tr('prosto do drugiej przeglądarki — do {mb} MB, nic nie trafia na serwer', { mb: Math.floor(MAX_DIRECT / 1024 / 1024) }), tr('🟢 Direct'), () => pickFile('direct'))
  // Anchored to the button and flipped above it, like the emoji popover: the
  // composer sits at the bottom edge, so below is never where this fits.
  const r = anchor.getBoundingClientRect()
  m.hidden = false
  const w = Math.min(m.offsetWidth || 300, window.innerWidth - 16)
  const h = Math.min(m.offsetHeight || 120, window.innerHeight - 16)
  const below = r.bottom + 8
  m.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8))}px`
  m.style.top = `${below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 8) : below}px`
}
const closeXferMenu = () => { $('xfer-menu').hidden = true }
document.addEventListener('click', (e: any) => {
  if ($('xfer-menu').hidden) return
  if ($('xfer-menu').contains(e.target) || $('btn-attach').contains(e.target)) return
  closeXferMenu()
})
;($('file-input') as HTMLInputElement).addEventListener('change', (e: any) => {
  const files: FileList | undefined = e.target.files
  const picked = [...(files ?? [])] // copied before the reset below empties the live list
  e.target.value = '' // so picking the same file twice still fires
  const direct = pickMode === 'direct'; pickMode = 'store'
  offerFile(picked, direct)
})
$('attach-drop').addEventListener('click', () => showAttach(null))

// ---- a voice note ---------------------------------------------------------
/**
 * Record, and hand the result to the same door every other file goes through.
 *
 * A voice note is not a new kind of message here — it is a file with an audio
 * `mime`, so it inherits the encryption, the expiry, the caption, the reply and
 * the delivery marker without a line of new wire format. What this code owns is
 * the microphone and the two seconds around it.
 *
 * **Recording does not send.** It fills the composer chip, exactly like a
 * pasted screenshot, so a note can carry a caption or answer a message — and so
 * a recording made by accident costs one [fail] rather than an upload and an
 * apology.
 *
 * The button is HIDDEN where the platform cannot record rather than dead. Same
 * rule as the QR scanner: WebKitGTK is precisely the place where `MediaRecorder`
 * and `getUserMedia` can come apart, and a switch that does nothing is worse
 * than one that is not there.
 */
const VOICE_MAX_MS = 120_000
let recording: Recording | null = null
/** The finished take, held between Stop and Send so it can be listened to and
 *  thrown away without ever reaching a conversation. */
let recTake: File | null = null

const recTime = (ms: number) => {
  const t = Math.floor(ms / 1000)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

/** Recording is a MODE, so it gets a surface that says so and offers the way
 *  back. The window has two faces and one clock. */
function paintRecWindow(state: 'recording' | 'ready' | 'off') {
  const modal = $('rec-modal')
  if (state === 'off') { dropModal('rec-modal'); return }
  pushModal('rec-modal')
  const done = state === 'ready'
  $('rec-dot').classList.toggle('done', done)
  $('rec-title').textContent = tr(done ? 'Nagranie gotowe' : 'Nagrywam…')
  $('rec-note').textContent = tr(done ? 'Odsłuchaj, zanim wyślesz.' : 'Limit nagrania to 2 minuty.')
  $('rec-stop').textContent = tr(done ? 'Wyślij' : 'Zatrzymaj')
  $('rec-preview').hidden = !done
}

function endRecording() {
  const r = recording
  recording = null
  recTake = null
  $('rec-preview').innerHTML = ''
  paintRecWindow('off')
  r?.cancel() // releases the microphone on every path out of here
}

$('btn-voice')?.addEventListener('click', async () => {
  if (recording || recTake) return // the window owns the flow once it is up
  if (!activeGid && !activeRoom()) { toast(tr('Najpierw otwórz rozmowę')); return }
  try {
    $('rec-clock').textContent = '0:00'
    recording = await startRecording({
      maxMs: VOICE_MAX_MS,
      onTick: (ms) => { $('rec-clock').textContent = recTime(ms) },
      // The cap stops it the way the person would have, and says so — a
      // recording that simply ends is one you find out about after sending.
      onLimit: () => { toast(tr('Nagranie ma limit {s} s — zatrzymane', { s: VOICE_MAX_MS / 1000 })); void stopRecording() },
      // The microphone stopped before Stop was pressed, so the take is shorter
      // than the clock said. Said out loud: a note that plays half of what
      // somebody said, with nothing on screen about it, is how this was
      // discovered in the first place — from a file, days later.
      onShort: (got, wanted) => toast(tr('Mikrofon ucichł — nagrało się {got} s z {wanted} s',
        { got: got.toFixed(1), wanted: wanted.toFixed(0) })),
    })
    paintRecWindow('recording')
  } catch (e: any) {
    // A refused microphone is an ordinary answer, not a fault to hide.
    recording = null; paintRecWindow('off')
    ecLog('microphone refused: ' + (e?.name ?? '') + ' ' + (e?.message ?? e), 'debug')
    toast(tr('Nie udało się nagrać — mikrofon niedostępny albo odmówiono dostępu'))
  }
})

/** Stop, and hold the take for listening. Nothing is sent yet: a voice note is
 *  the one message people want back the instant it leaves. */
async function stopRecording() {
  const r = recording
  if (!r) return
  recording = null
  try {
    recTake = await r.stop()
    $('rec-preview').innerHTML = ''
    $('rec-preview').appendChild(voicePlayer(URL.createObjectURL(recTake)))
    paintRecWindow('ready')
  } catch (e: any) {
    ecLog('recording failed: ' + (e?.message ?? e))
    endRecording()
    toast(tr('Nie udało się nagrać — mikrofon niedostępny albo odmówiono dostępu'))
  }
}

$('rec-stop')?.addEventListener('click', () => {
  if (recording) return void stopRecording()
  const take = recTake
  if (!take) return
  recTake = null
  paintRecWindow('off')
  $('rec-preview').innerHTML = ''
  // Straight out through the same door every other file uses, so a voice note
  // can still carry a caption or answer a message.
  offerFile([take])
  void sendComposer()
})

$('rec-cancel')?.addEventListener('click', () => {
  const had = !!(recording || recTake)
  endRecording()
  if (had) toast(tr('Nagranie odrzucone'))
})

// Hidden, not disabled, where the platform cannot record.
if (voiceSupported()) $('btn-voice')!.hidden = false

// ---- the other two ways a file arrives ------------------------------------
/**
 * Pasting and dropping, both landing in `offerFile` — so what you get is the
 * chip you would have got from the clip, with the same caption field and the
 * same Send. That parity is the feature; a second, shortcut path that sends
 * immediately would be a different product for the same gesture.
 *
 * WARNING: **The document refuses a dropped file everywhere.** A file dropped on a
 * page NAVIGATES to it, and here that is not a nuisance — it replaces the
 * running app, which takes the transport, every ratchet and the whole
 * ephemeral transcript with it. So the default is cancelled window-wide and
 * only the conversation pane acts on the drop.
 */
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

document.addEventListener('paste', (e: ClipboardEvent) => {
  const files = e.clipboardData?.files
  // An ordinary text paste carries no files and must reach the field it was
  // aimed at untouched — including the key field, where pasting is the way in.
  if (!files?.length) return
  e.preventDefault()
  offerFile(files)
})

{
  const pane = document.querySelector('main.chat') as HTMLElement | null
  if (pane) {
    // `dragleave` fires when the pointer crosses onto a CHILD element, so a
    // counter is what tells "left the pane" from "moved inside it". Without it
    // the outline flickers and eventually sticks.
    let depth = 0
    const off = () => { depth = 0; pane.classList.remove('drop-on') }
    pane.addEventListener('dragenter', (e) => {
      if (!(e as DragEvent).dataTransfer?.types.includes('Files')) return
      depth++; pane.classList.add('drop-on')
    })
    pane.addEventListener('dragleave', () => { if (--depth <= 0) off() })
    pane.addEventListener('drop', (e) => {
      e.preventDefault(); off()
      const files = (e as DragEvent).dataTransfer?.files
      if (files?.length) offerFile(files)
    })
  }
}

/**
 * Empty the composer when the screen changes rooms.
 *
 * Switching rooms is the one moment the RECIPIENT changes while the composer
 * looks untouched — so text meant for one peer, or a file picked for them, would
 * otherwise sit one Send away from the next. Both go.
 */
/**
 * What was typed and not sent, per room.
 *
 * Switching rooms used to throw it away, for a good reason that has not gone
 * anywhere: text meant for one person must never sit one Send away from the
 * next. A buffer per room keeps that property — every room gets ITS OWN text
 * back, and the box is empty in a room you have not written in — while ending
 * the thing the user reported: check something in another conversation and the
 * half-written message is gone.
 *
 * In memory only. A draft is message content, and this device does not keep
 * message content across a reload; that is the product, not an omission.
 *
 * The attachment and the recording still go. A file or a live microphone
 * belongs to the conversation it was started in, and having either reappear
 * silently is a far worse surprise than retyping a sentence.
 */
const drafts = new Map<string, string>()
const draftKey = () => activeGid ? 'g:' + activeGid : activePub ? 'p:' + activePub : null

function stashDraft() {
  const k = draftKey(); if (!k) return
  const v = ($('msg-input') as HTMLTextAreaElement).value
  if (v.trim()) drafts.set(k, v); else drafts.delete(k)
}

function restoreDraft() {
  const k = draftKey()
  ;($('msg-input') as HTMLTextAreaElement).value = (k && drafts.get(k)) || ''
  growComposer(); paintLength()
}

/**
 * Opening a room puts the cursor where you are about to type.
 *
 * Fine pointers only — the same guard the add window uses. On a phone, focusing
 * pops the software keyboard over the conversation you just asked to see, which
 * is the opposite of helping.
 *
 * CALL IT AFTER THE PANE IS ON SCREEN. `focus()` on an element inside a
 * `display:none` ancestor does nothing and reports nothing, so calling this
 * while `#chat-view` is still hidden fails SILENTLY. That shipped: the first
 * room opened after sign-in had no cursor in the composer, and only the first,
 * because by the second click the pane was already revealed by the first.
 * Reported from a browser, 2026-09-23.
 *
 * The visibility test is `offsetParent`, not `hidden`: the composer never
 * carries `hidden` itself — its ANCESTOR does, and `element.hidden` says
 * nothing about ancestors. Same trap as reading `classList` to decide whether
 * the user can see something.
 */
function focusComposer() {
  const inp = $('msg-input') as HTMLTextAreaElement | null
  if (!inp) return
  // The ORDERING check comes first and it says so out loud, because this is
  // the failure that shipped and it leaves no other trace: a caller that runs
  // before the pane is revealed gets nothing, silently. Said here, the harness
  // can assert that nobody calls this too early — on a machine with no pointer
  // at all, where the focus itself would never be taken and the fault would be
  // invisible. With the calls in the right order this line never appears.
  if (inp.hidden || !inp.offsetParent) { ecLog('focusComposer: composer is not on screen'); return }
  if (!matchMedia('(pointer:fine)').matches) return
  inp.focus()
  // After a restored draft the caret belongs at the END of what was written.
  try { inp.selectionStart = inp.selectionEnd = inp.value.length } catch {}
}

function clearComposer() {
  ;($('msg-input') as HTMLTextAreaElement).value = ''
  growComposer(); paintLength() // an emptied box is one line again
  showAttach(null)
  // A recording belongs to the conversation it was started in, and the
  // microphone must not outlive it — leaving it live would keep the platform's
  // recording indicator on for a room nobody is in.
  if (recording || recTake) endRecording()
  closeMentionPop() // a picker left open would offer the previous group's members
  mentionPicks.clear() // …and its choices would name people the new group does not have
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
    sel.addEventListener('change', () => { setLocale(sel.value); renderContacts(); renderGroups(); initDesktopShell() })
  }
  document.documentElement.lang = getLocale()
  applyDom()
  paintTransportSetting()
  renderLoginProfiles(true)
  initDesktopShell()
  void paintDesktopSettings()
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
  // The loudest window in the app, and it was the one that stayed Polish
  // whatever the UI language was: a warning nobody can read is a warning that
  // does not exist.
  if (!confirm(tr('Wipeout: skasować lokalną tożsamość software, wszystkie kontakty i cały stan tej przeglądarki?')
    + '\n\n' + tr('Tego nie da się cofnąć — Twój klucz publiczny się zmieni, więc Ty i rozmówcy musicie wymienić się nowymi kluczami. Klucze w HSM (login HEM) zostają nietknięte.'))) return
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
  // 420, not 330: measured, a contact's fingerprint plus its KID needs 420px to
  // fit, and at the old default it was cut 72px short — so the line that
  // identifies a person was the one thing the panel would not show.
  const SB_MIN = 260, SB_MAX = 620, SB_DEF = 420
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
function toast(msg: string, ms = 1500) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show')
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), ms)
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
// The circle with your own initials opens the share card. It is what a hand
// reaches for when somebody asks "how do I add you" — Settings keeps the same
// button, this only shortens the road to it. Keyboard gets the same door: the
// circle is a div, so it needs role/tabindex in the markup and Enter/Space here.
$('me-avatar').addEventListener('click', () => void openShare())
// The icon beside the fingerprint is the DISCOVERABLE way to the same thing:
// clicking an avatar and getting a share dialog reads as a non sequitur unless
// you already know it does that (the user's report).
$('btn-fp-share')?.addEventListener('click', () => void openShare())

/**
 * Change the name this identity goes by.
 *
 * The KID does not move - it is `SHA-1(pub)`, a function of the key - so every
 * contact, group and local record scoped to this identity survives untouched.
 * What changes is the header, the name inside invites and knocks sent from now
 * on, and the label in the device. `renameIdentity` knows how, per kind.
 *
 * Nobody is told. A contact holds the name THEY chose for you, locally, which
 * is the same rule that makes renaming a contact a private act - so the window
 * says so rather than letting someone believe they have announced anything.
 */
$('btn-rename-me')?.addEventListener('click', async () => {
  const doRename = renameIdentity
  if (!session || !doRename) return
  const was = session.handle
  const next = await promptName(tr('Zmień nazwę tożsamości'),
    tr('Zmieni się u Ciebie i w nowych zaproszeniach. Kontakty, które już Cię mają, dalej widzą nazwę, którą sami Ci nadali.'),
    was, tr('Nazwa'))
  if (next === null || next === was) return
  // The device caps the DESCR, so a name that does not fit would come back
  // silently shortened - said here instead, before anything is written.
  if (byteLen(next) > SELF_NAME_MAX) {
    toast(tr('Nazwa jest za długa — limit to {n} bajtów', { n: SELF_NAME_MAX })); return
  }
  // A software profile IS its storage key, so two of them cannot share a name.
  if (activeSoftProfile && localStorage.getItem(softKey(next))) {
    toast(tr('Profil o tej nazwie już tu jest — wybierz inną.')); return
  }
  try {
    if (!await doRename(next)) return
  } catch (e: any) {
    toast(e instanceof BadPassword ? tr('Złe hasło.') : tr('Nie udało się zmienić nazwy: ') + (e?.message ?? e))
    return
  }
  session.handle = next
  ;(session.id as any).handle = next // the Identity is what invites and knocks read
  $('me-avatar').textContent = initials(next)
  $('me-handle').textContent = next
  // Settings lists the profiles on this device and marks the open one; the name
  // it prints is the storage key that just moved.
  if (activeSoftProfile) renderProfiles()
  toast(tr('Nazwa zmieniona na {name}', { name: next }))
})
$('me-avatar').addEventListener('keydown', (e: any) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openShare() }
})
$('sess-id').addEventListener('dblclick', copyPub)     // double-click Tożsamość → copy pubkey

// ---- placeholder tabs ----
const TABS = [['tab-contacts', 'contacts'], ['tab-groups', 'groups'], ['tab-invites', 'invites']] as const
for (const [tab, pane] of TABS) {
  $(tab).addEventListener('click', () => {
    for (const [t] of TABS) $(t).classList.toggle('active', t === tab)
    for (const [, p] of TABS) $('pane-' + p).hidden = (p !== pane)
    // Each list's box travels with its list. Nothing on the Network tab is a
    // list of names, so neither box follows it there.
    $('head-contacts').hidden = pane !== 'contacts'
    $('head-groups').hidden = pane !== 'groups'
    $('head-invites').hidden = pane !== 'invites'
    if (pane === 'groups') renderGroups()
    if (pane === 'invites') { renderInvites(); void loadIgnored().then(paintIgnoredButton) }
  })
}

// ---- the Source's half: knock, then wait honestly ---------------------------
/**
 * A contact imported from an invite that carried an inbox is not a contact yet:
 * we hold their key, they hold nothing of ours, and the knock is what tells them
 * we exist. Until they accept it there is no channel and no way to know whether
 * the frame was even delivered — GossipSub stores nothing, so a knock reaches a
 * listener or reaches nobody (DISCOVERY-PROPOSAL.md §4.7).
 *
 * So this re-knocks while the app is open, and the contact carries a plain
 * label saying there is no confirmation of delivery. For a Source an ambiguous
 * screen is the dangerous outcome: "I clicked and something probably happened"
 * must never be what is on display.
 *
 * Persisted, unlike the Journalist's pending list. This is OUR state about a
 * contact WE chose to add, not a store strangers can fill: after a reload we
 * must go on knocking, or a reload would silently end the attempt.
 *
 * Nothing here watches for a reply. The answer is the other side appearing on
 * the pair topic, which this client could always derive — `onOnline` ends the
 * wait, and that is the whole mechanism.
 */
/** `note` is OURS and travels with every re-knock, so the request says the same
 *  thing whichever attempt is the one that lands. */
interface Waiting { inbox: string; name: string; since: number; note?: string }
const waitingKey = () => 'ec-waiting-' + (session?.idKey ?? '')
let waiting = new Map<string, Waiting>()
let knockTimer: any = null
/** Under a minute would be rude to the relay; over a few makes a Source wait. */
const KNOCK_EVERY_MS = 90_000

const WAITING_SALT = 'encedo-chat-waiting-v1'

/**
 * Read a store that may still be in the plain JSON this app wrote before §10
 * reached these keys, and re-seal it on the spot.
 *
 * The migration is not politeness: `ec-invites` holds the secrets of links that
 * are already hanging somewhere public, and dropping them means you stop
 * listening on your own published invite with no way to get the secret back.
 * A sealed blob is base64 of iv||ct and never parses as JSON, so the two
 * formats tell themselves apart without a version byte or a second key.
 */
async function readSealed<T>(key: string, salt: string, isMine: (v: any) => boolean): Promise<T | null> {
  const raw = localStorage.getItem(key)
  if (!raw) return null
  try { const v = JSON.parse(raw); if (isMine(v)) return v as T } catch {}
  const base = await ensureCacheBase()
  if (!base) { ecLog(`${key}: no cache base — cannot open the sealed store`, 'debug'); return null }
  return openLocal<T>(base, salt, session?.idKey ?? '', raw)
}

async function writeSealed(key: string, salt: string, value: unknown): Promise<void> {
  const base = await ensureCacheBase()
  // No base, no write. Falling back to plaintext would quietly undo the whole
  // point of sealing these, so the record stays in memory for this session and
  // the log says why.
  if (!base) { ecLog(`${key}: no cache base — NOT persisted`, 'debug'); return }
  try { localStorage.setItem(key, await sealLocal(base, salt, session?.idKey ?? '', value)) }
  catch (e: any) { ecLog(`${key}: seal failed — ${e?.message ?? e}`, 'debug') }
}

async function loadWaiting() {
  const v = await readSealed<any[]>(waitingKey(), WAITING_SALT, Array.isArray)
  waiting = new Map(Array.isArray(v) ? v : [])
  if (v) void saveWaiting()   // re-seals a plain list the moment it is read
}
function saveWaiting() { void writeSealed(waitingKey(), WAITING_SALT, [...waiting]) }

async function knockOnce(pub: string, w: Waiting) {
  if (!client || !session) return
  const raw = inboxSecretBytes({ pub: '', name: '', inbox: w.inbox })
  if (!raw) { ecLog(`knock: unusable inbox for ${pub.slice(0, 12)}…`); return }
  try {
    const reach = await client.knock(raw, pub, { name: session.handle, note: w.note })
    // "Sent" and "sent to nobody" look identical from here otherwise: publishing
    // into a topic nothing carries succeeds quietly. Nobody listening is the
    // ordinary case (§4.7 - they must be online), not a fault, so it is a line in
    // the log rather than anything the Source is asked to do about it.
    ecLog(reach === 0
      ? `knock to ${pub.slice(0, 12)}… reached nobody — nothing is listening on that invite right now`
      : `knock sent to ${pub.slice(0, 12)}… (no delivery confirmation exists)`)
  } catch (e: any) { ecLog(`knock failed: ${e?.message ?? e}`) }
}

function ensureKnockTimer() {
  if (knockTimer || !waiting.size) return
  knockTimer = setInterval(() => {
    if (!waiting.size) { clearInterval(knockTimer); knockTimer = null; return }
    for (const [pub, w] of waiting) void knockOnce(pub, w)
  }, KNOCK_EVERY_MS)
  ;(knockTimer as any).unref?.()
}

function startKnocking(pub: string, inbox: string, name: string, note?: string) {
  waiting.set(pub, { inbox, name, since: nowMs(), note: note || undefined })
  saveWaiting()
  renderContacts()
  const w = waiting.get(pub)!
  void knockOnce(pub, w)
  ensureKnockTimer()
}

function stopKnocking(pub: string) {
  if (!waiting.delete(pub)) return
  saveWaiting()
  if (!waiting.size && knockTimer) { clearInterval(knockTimer); knockTimer = null }
}

/** After a reload: pick the waiting contacts back up and knock again. */
async function resumeKnocking() {
  await loadWaiting()
  if (!waiting.size) return
  for (const [pub, w] of waiting) void knockOnce(pub, w)
  ensureKnockTimer()
  renderContacts()
}

// ---- published invites, and the knocks they bring ---------------------------
/**
 * A PUBLISHED invite is not the share modal's one-off link. That one hands your
 * key to one person who hands theirs back by hand; this one is hung somewhere
 * public and answers itself, because it carries an inbox secret that names a
 * topic you listen on (DISCOVERY-PROPOSAL.md §2).
 *
 * One secret per invite, never shared between them: retiring an invite is
 * unsubscribing from its topic, and a shared secret would mean retiring one
 * retires them all (§4.1).
 *
 * A knock is a REQUEST and never a contact (§4.4). It reaches this list, a
 * person reads the fingerprint, and only then does anything get written.
 *
 * The pending list lives in memory ON PURPOSE. It is filled by strangers over a
 * topic anybody holding the link can publish to, so persisting it would be an
 * attacker-fillable store on disk; and the Source's client re-knocks while it is
 * open, so a request missed by a closed app is not a request lost. The UI says
 * so rather than implying a queue that is not there.
 */
/** `expires` is epoch ms, absent = never. It is LOCAL bookkeeping and never
 *  travels: a knocker cannot tell an expired invite from one nobody is at. */
interface PubInvite { id: string; label: string; secret: string; created: number; expires?: number }
interface PendingKnock { ik: string; name: string; note: string; at: number; inviteId: string }

/**
 * Keys whose knocks this session will not show again.
 *
 * "Zignoruj" used to drop the row and nothing else, while the Source re-knocks
 * every 90 s - so the request was back inside the minute and the button was
 * really "remind me shortly". A decision somebody made has to hold.
 *
 * In memory, for the reason the pending list is: it is filled by strangers over
 * a topic anybody holding the link can publish to, so it never touches disk.
 * Bounded for the same reason - a flood of knocks under fresh keys must not
 * grow it without limit. A reload is therefore a clean slate, and the button
 * says so rather than implying a block list that is not there.
 */
const IGNORED_MAX = 512
const IGNORED_SALT = 'encedo-chat-ignored-v1'
const ignoredKey = () => 'ec-ignored-' + (session?.idKey ?? '')

/**
 * Two fields and no more (the user's call): the FINGERPRINT of the key, and
 * when you dismissed it.
 *
 * Not the key itself, because a truncated hash is enough to recognise a knock
 * we have already been told to drop and is a weaker thing to find on a seized
 * device. Not the name either — that is a stranger's claim, typed by whoever
 * knocked, and keeping somebody else's text on disk is the opposite of the
 * point. The cost is that the list reads as fingerprints, which is also how you
 * are asked to identify people everywhere else in this app.
 */
interface Ignored { fp: string; at: number }
let ignored: Ignored[] = []
let ignoredReady: Promise<void> | null = null

function loadIgnored(): Promise<void> {
  if (!ignoredReady) ignoredReady = (async () => {
    const v = await readSealed<Ignored[]>(ignoredKey(), IGNORED_SALT, Array.isArray)
    ignored = Array.isArray(v) ? v.filter((r) => r && typeof r.fp === 'string') : []
  })()
  return ignoredReady
}
function saveIgnored() { void writeSealed(ignoredKey(), IGNORED_SALT, ignored) }

async function ignoreKnock(ik: string) {
  const fp = await fingerprint(ik)
  if (ignored.some((r) => r.fp === fp)) return
  ignored.unshift({ fp, at: nowMs() })
  // Oldest out first. A flood of knocks under fresh keys cannot grow this
  // without limit, and the ones you dismissed most recently are the ones you
  // are most likely to want back.
  if (ignored.length > IGNORED_MAX) ignored.length = IGNORED_MAX
  saveIgnored()
}
async function isIgnored(ik: string): Promise<boolean> {
  await loadIgnored()
  const fp = await fingerprint(ik)
  return ignored.some((r) => r.fp === fp)
}

/**
 * Mint or edit an invite. One window for both, because the two questions are
 * the same either way: what it is called, and how long you go on listening.
 *
 * Returns null for cancel. `expires` absent means never — which is the default,
 * because an invite that dies on its own is a choice, not something to have
 * happen to you by accident.
 */
function promptInvite(current?: PubInvite): Promise<{ label: string; expires?: number } | null> {
  return new Promise((resolve) => {
    const input = $('invite-label') as HTMLInputElement
    const ttl = $('invite-ttl') as HTMLSelectElement
    const when = $('invite-when') as HTMLInputElement
    $('invite-title').textContent = current ? tr('Zaproszenie') : tr('Nowe zaproszenie')
    clr('invite-msg')
    input.value = current?.label ?? tr('Zaproszenie z {date}', { date: new Date(nowMs()).toISOString().slice(0, 10) })
    // An existing deadline comes back as the exact instant, not as the preset it
    // was picked from: the presets are shorthand for "from now", and reopening a
    // week later would silently move the date if they were re-applied.
    ttl.value = current?.expires ? 'custom' : '0'
    when.value = current?.expires ? localInputValue(current.expires) : ''
    $('invite-when-box').hidden = ttl.value !== 'custom'
    pushModal('invite-modal')

    const onTtl = () => { $('invite-when-box').hidden = ttl.value !== 'custom' }
    // The value says which of the two exits this is, and it is the only place
    // that knows: `done` is shared by Save and Cancel. Creating an invite is a
    // finished errand — coming back to the card that offered it (reported from
    // onboarding: "dałem utwórz i wróciło na modal onboardingu") is the same
    // absurdity as returning to "Dodaj peera" after adding somebody.
    const done = (v: { label: string; expires?: number } | null) => {
      if (v) endModals(); else dropModal('invite-modal')
      $('invite-save').removeEventListener('click', onSave)
      $('invite-cancel').removeEventListener('click', onCancel)
      ttl.removeEventListener('change', onTtl)
      resolve(v)
    }
    const onSave = () => {
      const label = input.value.trim().slice(0, 60)
      if (!label) { setMsg('invite-msg', tr('Nazwa nie może być pusta.'), 'err'); return }
      let expires: number | undefined
      if (ttl.value === 'custom') {
        if (!when.value) { setMsg('invite-msg', tr('Podaj datę i godzinę.'), 'err'); return }
        const at = new Date(when.value).getTime()
        if (!Number.isFinite(at)) { setMsg('invite-msg', tr('Podaj datę i godzinę.'), 'err'); return }
        // A deadline already behind us would create an invite that is dead on
        // arrival - which reads as the app having ignored what was typed.
        if (at <= nowMs()) { setMsg('invite-msg', tr('Ta chwila już minęła.'), 'err'); return }
        expires = at
      } else if (ttl.value !== '0') expires = nowMs() + parseInt(ttl.value) * 1000
      done({ label, expires })
    }
    const onCancel = () => done(null)
    $('invite-save').addEventListener('click', onSave)
    $('invite-cancel').addEventListener('click', onCancel)
    ttl.addEventListener('change', onTtl)
  })
}

/** Epoch ms -> the value a datetime-local input wants, in LOCAL time. */
function localInputValue(t: number): string {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

const inviteExpired = (inv: PubInvite) => !!inv.expires && nowMs() >= inv.expires
/** Local clock on purpose — this is the only date in the app a person sets. */
const inviteWhen = (t: number) => new Date(t).toLocaleString(getLocale() === 'en' ? 'en-GB' : 'pl-PL',
  { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const invitesKey = () => 'ec-invites-' + (session?.idKey ?? '')
let pubInvites: PubInvite[] = []
let pendingKnocks: PendingKnock[] = []
const inboxWatches = new Map<string, { stop(): void }>()

const INVITES_SALT = 'encedo-chat-invites-v1'

/**
 * Loaded ONCE per session, then memory is the truth. Re-reading on every call
 * would race the sealing writes, which are async by necessity — an ECDH stands
 * between this list and the disk.
 */
let invitesReady: Promise<void> | null = null
function loadInvites(): Promise<void> {
  if (!invitesReady) invitesReady = (async () => {
    const v = await readSealed<PubInvite[]>(invitesKey(), INVITES_SALT, Array.isArray)
    pubInvites = Array.isArray(v) ? v : []
    if (v) void writeSealed(invitesKey(), INVITES_SALT, pubInvites)
  })()
  return invitesReady
}
function saveInvites() { void writeSealed(invitesKey(), INVITES_SALT, pubInvites) }

/** The button only exists when there is something behind it. */
function paintIgnoredButton() {
  const b = $('btn-ignored'); if (!b) return
  b.hidden = ignored.length === 0
  $('ignored-count').textContent = String(ignored.length)
}

function renderIgnored() {
  const box = $('ignored-list')
  box.innerHTML = ''
  if (!ignored.length) {
    box.innerHTML = `<div class="hint">${escapeHtml(tr('Nikogo nie ignorujesz.'))}</div>`
    return
  }
  for (const rec of ignored) {
    const row = document.createElement('div'); row.className = 'ign-row'
    const fp = document.createElement('div'); fp.className = 'ign-fp'; fp.textContent = rec.fp
    const at = document.createElement('div'); at.className = 'ign-at'; at.textContent = inviteWhen(rec.at)
    const back = document.createElement('button'); back.textContent = tr('Cofnij')
    back.title = tr('Przestaniesz ignorować ten klucz. Jeśli ta osoba wciąż puka, prośba pojawi się przy kolejnym pukaniu.')
    back.addEventListener('click', () => {
      ignored = ignored.filter((r) => r !== rec)
      saveIgnored(); renderIgnored(); paintIgnoredButton()
    })
    row.append(fp, at, back)
    box.appendChild(row)
  }
}

$('btn-ignored')?.addEventListener('click', async () => {
  await loadIgnored()
  renderIgnored()
  pushModal('ignored-modal')
})
const closeIgnored = () => dropModal('ignored-modal')
$('ignored-close')?.addEventListener('click', closeIgnored)

function paintInviteBadge() {
  const b = $('inv-badge')
  b.textContent = String(pendingKnocks.length)
  b.hidden = pendingKnocks.length === 0
}

/** Listen on every invite this identity has published. Idempotent. */
async function startInboxWatches() {
  if (!client) return
  await loadInvites()
  // Expiry is enforced HERE rather than only in the view: an invite whose time
  // is up must stop being a subscription, not merely stop looking like one.
  for (const [id, w] of [...inboxWatches]) {
    const inv = pubInvites.find((i) => i.id === id)
    if (inv && !inviteExpired(inv)) continue
    try { w.stop() } catch {}
    inboxWatches.delete(id)
  }
  for (const inv of pubInvites) {
    if (inboxWatches.has(inv.id) || inviteExpired(inv)) continue
    const raw = inboxSecretBytes({ pub: '', name: '', inbox: inv.secret })
    if (!raw) { ecLog(`invite ${inv.id}: unusable secret, not watched`); continue }
    inboxWatches.set(inv.id, client.watchInbox(raw, {
      onKnock: (k) => void (async () => {
        const ik = b64(k.ik)
        // One request per key per invite: a Source that re-knocks while waiting
        // must not stack up, and that is the ordinary case, not an attack. This
        // runs BEFORE the await as well as after it, because the ignore check
        // is a hash now and two frames can arrive inside one tick.
        if (pendingKnocks.some((p) => p.ik === ik && p.inviteId === inv.id)) return
        if (await isIgnored(ik)) return
        if (pendingKnocks.some((p) => p.ik === ik && p.inviteId === inv.id)) return
        pendingKnocks.unshift({ ik, name: k.name, note: k.note, at: nowMs(), inviteId: inv.id })
        paintInviteBadge()
        if (!$('pane-invites').hidden) renderInvites()
        if (invQrShown === inv.id) paintInviteQrKnocks()
        else toast(tr('Ktoś puka do zaproszenia „{label}"', { label: inv.label }))
      })(),
      onLog: ecLog,
    }))
  }
  paintInviteBadge()
  ensureInviteTimer()
}

/**
 * An invite that expires while the app is open has to stop by itself, or the
 * lifetime would only be honoured by a reload — which is exactly the promise a
 * person is making when they set one.
 */
let inviteTimer: any = null
function ensureInviteTimer() {
  if (inviteTimer) return
  inviteTimer = setInterval(async () => {
    const done = pubInvites.filter((i) => inviteExpired(i) && inboxWatches.has(i.id))
    if (!done.length) return
    await startInboxWatches()                 // stops exactly those
    if (!$('pane-invites').hidden) renderInvites()
    for (const i of done) toast(tr('Zaproszenie „{label}" wygasło', { label: i.label }))
  }, 30_000)
  ;(inviteTimer as any).unref?.()
}

function stopInboxWatches() {
  for (const w of inboxWatches.values()) { try { w.stop() } catch {} }
  inboxWatches.clear()
}

$('btn-new-invite')?.addEventListener('click', async () => {
  // Only the identity is required. Minting an invite is a LOCAL act - a random
  // secret and a line in storage - and `startInboxWatches` is idempotent, so the
  // listening starts when the transport arrives. Requiring the client here made
  // the button dead for the seconds a connection takes, which reads as broken.
  if (!session) { toast(tr('Najpierw się zaloguj')); return }
  // Before anything is added to the list: the read is async now (an ECDH stands
  // between it and the disk) and it REPLACES the array, so minting into a list
  // that has not arrived yet would be undone the moment it does.
  await loadInvites()
  const got = await promptInvite()
  if (!got) return
  const inv: PubInvite = {
    id: Math.random().toString(36).slice(2, 10),
    label: got.label,
    secret: newInboxSecret(),
    created: nowMs(),
    expires: got.expires,
  }
  pubInvites.unshift(inv)
  saveInvites()
  await startInboxWatches()
  renderInvites()
})

/**
 * "Mam zaproszenie" - the other half of the invites tab.
 *
 * Redeeming an invite somebody handed you lived inside "Dodaj peera", under a
 * label about adding a peer by key. That is the wrong place to look for it, and
 * in the packaged app it was the ONLY place, because there is no address bar
 * there to open a link with. You mint an invite in this tab; this is where you
 * look to answer one.
 *
 * A door, not a path. Whatever is pasted goes through the same
 * `inviteFromPaste` and lands in the same import window, with the same
 * fingerprint to compare against what the person told you by another channel.
 * There is deliberately no shortcut past that comparison - it is the only thing
 * standing between a link and a man in the middle.
 */
/**
 * The first screen: shown on every sign-in with an empty contact book.
 *
 * Not only on a first run, and not suppressed for somebody holding groups —
 * a person returning to a profile they have not used still has nobody to write
 * to, and having groups is no evidence of having contacts.
 *
 * Sign-in is the ONLY trigger (the user's call, 2026-09-22). Removing the last
 * contact deliberately shows nothing: a window that reappears on an ordinary
 * delete punishes tidying up. It returns at the next sign-in.
 *
 * Each row hands off to the surface that already owns the job — the invites tab
 * mints and lists, the paste window reads. This points; it does not perform.
 */
const closeWelcome = () => dropModal('welcome-modal')
$('welcome-close')?.addEventListener('click', closeWelcome)
// The three ways do NOT close this card: it stays underneath as the place to
// come back to. It is the first minute of a new profile, and the old behaviour
// closed the only orientation there was, so backing out of what you picked
// left an empty screen with nothing to pick again (the user's report).
$('welcome-share')?.addEventListener('click', () => { void openShare() })
$('welcome-invite')?.addEventListener('click', () => {
  $('tab-invites').click(); $('btn-new-invite').click()
})
$('welcome-have')?.addEventListener('click', () => {
  $('tab-invites').click(); $('btn-have-invite').click()
})

const closePaste = () => dropModal('paste-modal')
$('btn-have-invite')?.addEventListener('click', () => {
  ;($('paste-input') as HTMLTextAreaElement).value = ''
  clr('paste-msg')
  pushModal('paste-modal')
  // Same rule as the add window: a phone pops its keyboard over the modal.
  if (matchMedia('(pointer:fine)').matches) $('paste-input').focus()
})
$('paste-cancel')?.addEventListener('click', closePaste)
$('paste-go')?.addEventListener('click', async () => {
  const text = val('paste-input')
  if (!text) { setMsg('paste-msg', tr('Wklej link albo kod zaproszenia.'), 'err'); return }
  const inv = inviteFromPaste(text)
  // Refused HERE, with the text still in the field, so a truncated paste can be
  // fixed rather than retyped. The window it would open has no way to say this:
  // by then there is nothing to show a fingerprint for.
  if (!inv) { setMsg('paste-msg', tr('To nie wygląda na zaproszenie — sprawdź, czy skopiowałeś całość.'), 'err'); return }
  // Left open behind: Cancel on the invite returns here, with the text still in
  // the field, instead of ending the errand.
  await showInvite(inv)
})

function inviteUrlFor(inv: PubInvite): string {
  return inviteLink(
    inAppShell ? CANONICAL_ORIGIN : location.origin,
    inAppShell ? CANONICAL_PATH : location.pathname,
    { pub: session!.pub, name: session!.handle, inbox: inv.secret })
}

async function acceptKnock(k: PendingKnock) {
  if (!session) return
  const name = (k.name || tr('Bez nazwy')).slice(0, 64)
  if (!(await claimContact(name, k.ik))) return
  await session.book.add(name, k.ik, true)
  await refreshContacts()
  pendingKnocks = pendingKnocks.filter((p) => p !== k)
  paintInviteBadge(); renderInvites()
  if (invQrShown === k.inviteId) { invQrAccepted.push({ name, pub: k.ik }); paintInviteQrKnocks() }
  toast(tr('Dodano kontakt „{name}"', { name }))
}

// ---- a published invite as a QR, with its knocks underneath -------------------
// The pairing people actually want across a table: show the code, the other
// phone scans it (the camera app or ours -- the code is the plain invite link),
// taps Dodaj, and the knock lands HERE, under the code, with its fingerprint and
// one button. Not an auto-accept: the invite is public and lives until you
// withdraw it, so anybody who ever photographed this code can knock with it.
MODAL_EXIT['invqr-modal'] = () => { invQrShown = null; invQrAccepted = [] }

function openInviteQr(inv: PubInvite) {
  invQrShown = inv.id
  invQrAccepted = []
  $('invqr-title').textContent = inv.label
  try {
    $('invqr-qr').innerHTML = qrSvg(inviteUrlFor(inv), { size: 300 })
    $('invqr-qr').hidden = false
  } catch (e: any) {
    // Too long for the encoder (a very long non-ASCII name): the link still
    // works, so say where it is rather than showing an empty box.
    $('invqr-qr').hidden = true
    ecLog('invite QR not drawn: ' + (e?.message ?? e), 'debug')
    toast(tr('Ten link jest za długi na kod QR — użyj „Kopiuj link".'), 4000)
    return
  }
  paintInviteQrKnocks()
  pushModal('invqr-modal')
}

/**
 * Three states, one window. Waiting: the code, and "waiting for a scan".
 * Somebody knocked: the code stays and their request sits under it -- a second
 * person may be about to scan. Accepted and nobody else waiting: the code is
 * REPLACED by "connected with X" and three ways on (the user's call after the
 * first live test: a code left on screen after a successful pairing read as
 * "not done yet"). "Pokaz kod dla kolejnej osoby" brings the code back.
 */
function paintInviteQrKnocks(showCodeAgain = false) {
  const box = $('invqr-knocks')
  box.innerHTML = ''
  const mine = pendingKnocks.filter((k) => k.inviteId === invQrShown)
  // Several people can scan one code: the rules are in web/src/invqr.ts.
  const v = invQrView(mine.length, invQrAccepted, showCodeAgain)
  $('invqr-qr').hidden = !v.showCode
  $('invqr-done').hidden = !v.success
  const names = v.accepted.map((a) => `„${a.name}"`).join(', ')
  $('invqr-sub').textContent = v.success
    ? (v.accepted.length === 1
      ? tr('„{name}" jest już w Twoich kontaktach.', { name: v.accepted[0].name })
      : tr('{names} są już w Twoich kontaktach.', { names }))
    : tr('Pokaż ten kod osobie, którą zapraszasz. Zeskanuje go aparatem albo w aplikacji — jej prośba pojawi się tutaj, a Ty przyjmiesz ją jednym dotknięciem.')
  if (v.success) {
    $('invqr-who').textContent = v.accepted.length === 1
      ? tr('Połączono z „{name}"', { name: v.accepted[0].name })
      : tr('Połączono: {names}', { names })
    // One fingerprint line per person accepted here, filled as they are computed.
    const fpBox = $('invqr-fp'); fpBox.innerHTML = ''
    for (const a of v.accepted) {
      const line = document.createElement('div')
      line.textContent = (v.accepted.length > 1 ? `${a.name} — ` : '') + tr('odcisk: ') + '…'
      fpBox.appendChild(line)
      void fingerprint(a.pub).then((f) => { line.textContent = (v.accepted.length > 1 ? `${a.name} — ` : '') + tr('odcisk: ') + f })
    }
    $('invqr-open').textContent = v.accepted.length === 1
      ? tr('Otwórz rozmowę')
      : tr('Otwórz rozmowę z „{name}"', { name: v.openTarget!.name })
    return
  }
  for (const a of invQrAccepted) {
    const d = document.createElement('div'); d.className = 'invqr-done'
    d.textContent = tr('Połączono z „{name}"', { name: a.name })
    box.appendChild(d)
  }
  if (!mine.length) {
    const w = document.createElement('div'); w.className = 'invqr-wait'
    w.textContent = tr('Czekam na zeskanowanie…')
    box.appendChild(w)
  }
  for (const k of mine) {
    const row = document.createElement('div'); row.className = 'knock-row'
    const nm = document.createElement('div'); nm.className = 'k-name'; nm.textContent = k.name || tr('Bez nazwy')
    const fp = document.createElement('div'); fp.className = 'k-fp'; fp.textContent = tr('odcisk: ') + '…'
    void fingerprint(k.ik).then((f) => { fp.textContent = tr('odcisk: ') + f })
    row.append(nm, fp)
    if (k.note) { const n = document.createElement('div'); n.className = 'k-note'; n.textContent = k.note; row.appendChild(n) }
    const acts = document.createElement('div'); acts.className = 'inv-acts'
    const yes = document.createElement('button'); yes.textContent = tr('Przyjmij')
    yes.addEventListener('click', () => void acceptKnock(k))
    acts.appendChild(yes); row.appendChild(acts)
    box.appendChild(row)
  }
}
$('invqr-close').addEventListener('click', () => backModal())
$('invqr-open').addEventListener('click', () => {
  const last = invQrView(0, invQrAccepted, false).openTarget
  const c = last && contactsCache.find((x) => x.pub === last.pub)
  endModals()
  if (c) void openRoomFor(c, true)
})
$('invqr-again').addEventListener('click', () => paintInviteQrKnocks(true))

function renderInvites() {
  const pane = $('pane-invites')
  pane.innerHTML = ''
  if (!session) { pane.innerHTML = `<div class="pane-label">${escapeHtml(tr('Najpierw się zaloguj'))}</div>`; return }

  if (pendingKnocks.length) {
    const h = document.createElement('div')
    h.className = 'pane-label'
    h.textContent = tr('Ktoś puka — przyjmij dopiero po sprawdzeniu odcisku')
    pane.appendChild(h)
    for (const k of pendingKnocks) {
      const row = document.createElement('div'); row.className = 'knock-row'
      const inv = pubInvites.find((i) => i.id === k.inviteId)
      const nm = document.createElement('div'); nm.className = 'k-name'
      nm.textContent = k.name || tr('Bez nazwy')
      const fp = document.createElement('div'); fp.className = 'k-fp'
      fp.textContent = tr('odcisk: ') + '…'
      void fingerprint(k.ik).then((f) => { fp.textContent = tr('odcisk: ') + f })
      row.append(nm, fp)
      if (k.note) { const n = document.createElement('div'); n.className = 'k-note'; n.textContent = k.note; row.appendChild(n) }
      if (inv) { const w = document.createElement('div'); w.className = 'inv-when'; w.textContent = tr('przez: ') + inv.label; row.appendChild(w) }
      const acts = document.createElement('div'); acts.className = 'inv-acts'
      const yes = document.createElement('button'); yes.textContent = tr('Przyjmij')
      yes.addEventListener('click', () => void acceptKnock(k))
      const no = document.createElement('button'); no.className = 'danger'; no.textContent = tr('Zignoruj')
      no.title = tr('Nie zobaczysz już pukań tym kluczem. Listę zignorowanych znajdziesz nad spisem zaproszeń i możesz ją cofnąć.')
      no.addEventListener('click', async () => {
        await ignoreKnock(k.ik)
        pendingKnocks = pendingKnocks.filter((p) => p !== k)
        paintInviteBadge(); renderInvites(); paintIgnoredButton()
      })
      acts.append(yes, no); row.appendChild(acts)
      pane.appendChild(row)
    }
  }

  const h2 = document.createElement('div'); h2.className = 'pane-label'
  h2.textContent = pubInvites.length
    ? tr('Opublikowane — każde można wycofać osobno')
    : tr('Nie masz opublikowanych zaproszeń. Takie zaproszenie możesz powiesić na stronie: kto je ma, może do Ciebie zapukać.')
  pane.appendChild(h2)

  for (const inv of pubInvites) {
    const dead = inviteExpired(inv)
    const row = document.createElement('div'); row.className = 'inv-row' + (dead ? ' expired' : '')
    const top = document.createElement('div'); top.className = 'inv-top'
    const label = document.createElement('span'); label.className = 'inv-label'; label.textContent = inv.label
    // An expired invite offers NO pencil: the only thing left to do with it is
    // delete it (the user's call). Editing it would mean reviving a link that
    // has been hanging somewhere public, dead, for however long - a decision
    // that deserves a new invite with a new secret, not an extension of one
    // whose address strangers may have been collecting.
    const edit = document.createElement('button'); edit.className = 'inv-edit'; edit.textContent = '✎'
    edit.title = tr('Zmień nazwę i czas życia')
    edit.addEventListener('click', async () => {
      const got = await promptInvite(inv)
      if (!got) return
      inv.label = got.label; inv.expires = got.expires
      saveInvites()
      // Shortening a live invite can end it on the spot, so the subscription is
      // resynced rather than only the row.
      await startInboxWatches(); renderInvites()
    })
    const when = document.createElement('span'); when.className = dead ? 'inv-dead' : 'inv-when'
    when.textContent = dead ? tr('wygasło')
      : inv.expires ? tr('do {when}', { when: inviteWhen(inv.expires) })
      : new Date(inv.created).toISOString().slice(0, 10)
    top.append(label, ...(dead ? [] : [edit]), when)
    const acts = document.createElement('div'); acts.className = 'inv-acts'
    const copy = document.createElement('button'); copy.textContent = tr('Kopiuj link')
    // Handing somebody a link nobody listens on is a trap: they knock into
    // silence and read it as being ignored.
    copy.disabled = dead
    if (dead) copy.title = tr('To zaproszenie wygasło — nikt się na nie nie dopuka. Przedłuż je albo zrób nowe.')
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(inviteUrlFor(inv)); toast(tr('Skopiowano')) }
      catch { toast(tr('Nie udało się skopiować')) }
    })
    const kill = document.createElement('button'); kill.className = 'danger'; kill.textContent = tr('Wycofaj')
    kill.addEventListener('click', async () => {
      const { ok } = await ask(
        tr('Wycofać „{label}"?', { label: inv.label }),
        tr('Przestaniesz słuchać na tym zaproszeniu. Kto ma ten link, nie dopuka się już nigdy. Pozostałe zaproszenia działają dalej.'),
        tr('Wycofaj'))
      if (!ok) return
      inboxWatches.get(inv.id)?.stop(); inboxWatches.delete(inv.id)
      pubInvites = pubInvites.filter((i) => i !== inv)
      pendingKnocks = pendingKnocks.filter((p) => p.inviteId !== inv.id)
      saveInvites(); paintInviteBadge(); renderInvites()
    })
    const qr = document.createElement('button'); qr.className = 'inv-qr'; qr.textContent = tr('Pokaż QR')
    qr.disabled = dead
    qr.addEventListener('click', () => openInviteQr(inv))
    acts.append(copy, qr, kill)
    row.append(top, acts)
    pane.appendChild(row)
  }

  // Not a `pane-label`: that style is an uppercase mono heading, and a sentence
  // set in it reads as shouting rather than as a footnote.
  const foot = document.createElement('div'); foot.className = 'inv-foot'
  foot.textContent = tr('Prośby nie są zapisywane na dysku. Jeśli zamkniesz aplikację, druga strona zapuka ponownie.')
  pane.appendChild(foot)
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
  $('net-box').innerHTML = `<div id="net-live"></div>
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
/**
 * The protocol's name as Settings shows it. The pick/push client is ours, over
 * libp2p, and the user named it "libp2p-light" (2026-09-25); the engine keeps
 * its short internal value `light`.
 */
const transportName = (t: string) => (t === 'light' ? 'libp2p-light' : t)
function renderNetwork() {
  const pane = $('net-box'); if (!pane) return
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
    <div class="net-row"><span class="k">${tr('Transport')}</span><span class="v">${escapeHtml(transportName(s.transport))}${WEBRTC_OFF ? ' <span class="net-tag">' + tr('bez WebRTC') + '</span>' : ''}</span></div>
    <div class="net-row"><span class="k">${tr('Węzeł (relay)')}</span><span class="v" title="${escapeHtml(s.relay)}">${escapeHtml(relayHost)}${isFailover ? ' <span class="net-tag">' + tr('failover') + '</span>' : ''}</span></div>
    ${nodesRow}
    ${relayPeer ? `<div class="net-row"><span class="k">${tr('PeerId węzła')}</span><span class="v mono" title="${escapeHtml(relayPeer)}">${escapeHtml(relayPeer)}</span></div>` : ''}
    <div class="net-row"><span class="k">${tr('Twój PeerId')}</span><span class="v mono" title="${escapeHtml(s.self)}">${escapeHtml(s.self)}</span></div>
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
/**
 * What the picker offers, most-used first.
 *
 * The bar used to carry the first four of these as four buttons of its own,
 * beside reply / edit / pin — up to seven controls hanging off a bubble, which
 * on a phone is most of its width. They live behind one opener now (the user's
 * decision, 2026-09-03): a reaction costs a second tap and the bar stays short
 * enough to read the message under it.
 */
const QUICK_EMOJI = [
  '👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉',
  '👏', '💯', '✅', '❌', '🤔', '😅', '😍', '🥳',
  '😎', '🤝', '👀', '💪', '🙌', '☕', '🍺', '🎂',
  '🚀', '⭐', '⚡', '🐛', '🔒', '📌', '😴', '🤷',
]
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
    // ...and re-decide here. The refreshJump() below runs while we are still at
    // the top, so it leaves the button ON; what turns it off is the scroll
    // event — and a scroll set from code does not always produce one (headless
    // Chromium doesn't). Without this the view lands at the newest message and
    // the stays on screen over it, pointing nowhere.
    refreshJump()
  }, 300)
  unread = 0
  refreshJump()
}
$('messages').addEventListener('scroll', refreshJump)
$('to-bottom').addEventListener('click', jumpToLatest)

/** msg id -> the little delivery marker under our own bubble. */
const stateEls = new Map<string, HTMLElement>()
function setDelivery(id: string, state: 'ok' | 'lost' | 'late', ms?: number) {
  const el = stateEls.get(id)
  if (!el) return
  delete el.dataset.pending // settled one way or the other: no longer "waiting for"
  if (state === 'ok') {
    el.textContent = tr(' · ✓ ') + tr('dostarczone')
    el.title = tr('Klient rozmówcy potwierdził odbiór{when} — to nie jest „przeczytane”', { when: ms !== undefined ? tr(' po {ms} ms', { ms }) : '' })
  } else if (state === 'late') {
    // It said undelivered, and it was wrong: the confirmation came in after we had given
    // up. Say so plainly rather than quietly flipping it to a clean [ok] — the
    // long gap is exactly the thing worth noticing.
    el.textContent = ` · ⏱ ${tr('dostarczone z opóźnieniem')}${ms !== undefined ? ` (${Math.round(ms / 1000)}s)` : ''}`
    el.title = tr('Potwierdzenie przyszło już po tym, jak przestaliśmy ponawiać — wiadomość jednak dotarła')
    el.classList.add('late')
  } else {
    el.textContent = tr(' · ⚠ niedostarczone')
    el.title = tr('Brak potwierdzenia mimo ponowień — rozmówca prawdopodobnie tego nie dostał')
    // The transport gave up; give the decision back to the user instead of
    // leaving a dead undelivered mark that can only be fixed by retyping the message.
    const again = document.createElement('button')
    again.type = 'button'
    again.className = 'b-resend'
    // A word, not only the arrow: "wysylam..." that never ended was the report
    // (2026-09-25), and the fix has to say what pressing does.
    again.textContent = tr('↻ Ponów')
    again.title = tr('Wyślij ponownie — przyjdzie też samo, gdy rozmówca wróci')
    again.addEventListener('click', () => {
      if (!activeRoom()?.conv?.resend(id)) return
      el.textContent = tr(' · wysyłam ponownie…')
      el.title = tr('Czekam na potwierdzenie od klienta rozmówcy')
      el.dataset.pending = '1'
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

/** A line the app says to itself in the transcript — not somebody's message. */
function appendSys(text: string, sid?: string) {
  const box = $('messages')
  const stick = atBottom()
  const s = document.createElement('div'); s.className = 'sysline'; s.textContent = text
  if (sid) s.dataset.sys = sid
  box.appendChild(s)
  if (stick) box.scrollTop = box.scrollHeight
}

/** Rewrite a system line that is already on screen. Silent when the line belongs
 *  to a room that is not the one being shown — the log carries the new text and
 *  the replay will draw it. */
function repaintSys(ev: { text: string; sid?: string }) {
  if (!ev.sid) return
  const el = $('messages').querySelector(`[data-sys="${ev.sid}"]`)
  if (el) el.textContent = ev.text
}

/**
 * One bubble, rendered from the log event itself rather than from a dozen
 * positional arguments — the list had reached ten and every feature since has
 * wanted to add to it, which is how a call site ends up passing `undefined`
 * through six slots to reach the seventh.
 */
function appendMsg(ev: MsgEv) {
  const { kind, text, id, who, re, au } = ev
  const ts = ev.ts, outOfOrder = !!ev.ooo, sent = !!ev.sent, pinned = !!ev.pinned
  const box = $('messages')
  const stick = (atBottom() && !outOfOrder) || kind === 'me' // sending always follows your own message
  const row = document.createElement('div'); row.className = 'mrow ' + (kind === 'me' ? 'out' : 'in')
    + (pinned || (id && isPinned(id)) ? ' pinned' : '')
  row.dataset.ts = String(ts ?? nowMs())
  if (id) row.dataset.mid = id
  if (au) row.dataset.au = au
  // Restored FROM the store, as opposed to a live message that happens to be
  // pinned: only the first kind vanishes when it is unpinned.
  if (pinned) row.dataset.frompin = '1'
  const bub = document.createElement('div'); bub.className = 'bubble'
  if (who && kind === 'peer') { const w = document.createElement('div'); w.className = 'b-who'; w.textContent = who; bub.appendChild(w) }
  if (re) bub.appendChild(quoteBlock(re))
  const t = document.createElement('div'); t.className = 'b-text'; renderBody(t, text)
  const m = document.createElement('div'); m.className = 'b-meta'; stampTime(m, ts ?? nowMs())
  // A corrected bubble says so, on both sides and always: silently swapping what
  // somebody is reading is the one thing this feature must not do.
  if (ev.edited) m.appendChild(editedMark(ev))
  if (outOfOrder) {
    // Same as a late confirmation on our own side: one mark, one meaning —
    // "this one did not travel normally".
    const late = document.createElement('span'); late.className = 'late-mark'; late.textContent = tr(' ⏱ spóźniona')
    late.title = tr('Dotarła po nowszych wiadomościach — wstawiona w miejscu, w którym została napisana')
    m.appendChild(late)
  }
  // A restored pin carries no delivery state: the acknowledgement it once had
  // died with the session, and defaulting to "wysyłam..." would leave every kept
  // message of ours sending forever.
  if (kind === 'me' && id && !pinned) {
    // Delivery state for our own messages. Instant-only: this says the peer's
    // client holds it, never that anyone read it.
    const st = document.createElement('span'); st.className = 'b-state'
    if (sent) {
      // A group broadcast: fire-and-forget over GossipSub, no per-recipient acks —
      // so it is "sent", never the 1:1 "sending...->delivered" that would hang here.
      st.textContent = tr(' · wysłano'); st.title = tr('Wysłane do grupy (broadcast — bez potwierdzeń doręczenia)')
    } else {
      const l = pendingLabel()
      st.textContent = l.text; st.title = l.title; st.dataset.pending = '1'
      stateEls.set(id, st) // only 1:1 gets delivery updates
    }
    m.appendChild(st)
  }
  const rx = document.createElement('div'); rx.className = 'b-reactions'
  bub.append(t, m, rx); row.appendChild(bub)
  if (id) {
    msgEls.set(id, rx)
    attachReactionBar(row, id, true)
    attachReveal(row, bub)
  }
  if (outOfOrder) insertByTime(box, row, Number(row.dataset.ts))
  else box.appendChild(row)
  paintRoute(id)
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
  // The diary takes the connection lines out of this stream and drops
  // everything else — including this file's own `sent "..."`, which carries
  // message text. The allowlist lives in lib/diag.ts and is tested there.
  diag.fromLog(msg)
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(6)
  const style = level === 'debug' ? 'color:#79829c' : 'color:#6579e0;font-weight:600'
  console.log(`%c[ec ${t}s] %c${msg}`, 'color:#74788d', style)
}
// ---- the connection diary --------------------------------------------------
/**
 * What was happening to the connection at three in the morning.
 *
 * `ecLog` goes to a console, and a packaged app has no console anybody can
 * open — so the events that decide whether a contact looks present are also
 * written down with a wall clock, and on a desktop into a file that survives a
 * restart. `lib/diag.ts` holds the rule about what may go in: the connection,
 * never the conversation.
 *
 * Everything here is periodic and cheap. The instrument that cannot be got any
 * other way is the LATENESS probe: a timer that knows when it was due says how
 * long the process was not running, which is the difference between "the peer
 * went quiet" and "we were not there to hear them".
 */
const DIAG_TICK_MS = 15_000
const DIAG_SUMMARY_MS = 5 * 60_000
const DIAG_FLUSH_MS = 60_000

const diagFlush = () => { const lines = diag.take(); if (lines.length) void diagAppend(lines.join('\n') + '\n') }

function startDiag() {
  diag.note(`start ${BUILD_ID} ${isMobileShell() ? 'mobile' : isDesktopShell() ? 'desktop' : 'browser'}`)
  let due = Date.now() + DIAG_TICK_MS
  setInterval(() => {
    const late = Date.now() - due
    due = Date.now() + DIAG_TICK_MS
    diag.tick(Math.max(0, late))
  }, DIAG_TICK_MS)
  setInterval(() => {
    // Whatever the transport can say about itself right now. `topics` is the
    // one worth watching over a night: a subscription list that shrinks while
    // the socket stays up is a mesh problem, and nothing else in the app would
    // ever say so.
    let extra = 'link=? '
    try {
      const n = client?.netStatus()
      if (n) extra = `link=${n.link} peers=${n.peers} topics=${n.topics.length} `
    } catch {}
    diag.summary(`${extra}lit=${onlinePubs.size}/${contactsCache.length}`)
  }, DIAG_SUMMARY_MS)
  setInterval(diagFlush, DIAG_FLUSH_MS)
  // A window being closed is exactly when the last minute matters most.
  window.addEventListener('pagehide', diagFlush)
}
startDiag()
// A seam for looking at the diary from the outside — the browser harness reads
// it, and on a desktop `?debug=1` is not reachable anyway (there is no address
// bar), so this costs the packaged app nothing.
if (DEBUG) (globalThis as any).__diag = diag

ecLog(`app start — debug=${DEBUG} transport=${USE_MQTT ? `mqtt (${BROKER})` : USE_LIGHT ? 'libp2p-light (pick/push)' : 'libp2p'}`
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
 * WebKitGTK is why this exists: the desktop webview has X25519 and no WebRTC —
 * not for want of a setting, which the shell turns on to no effect,
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
  const rep = await probeCapabilities({ hostRtc: await tauriRtcAvailable() })
  capReport = rep
  paintCaps()
  renderNetwork() // a phone has no console — the Network tab is where this is readable
  ecLog(formatReport(rep))
  for (const d of rep.degraded) ecLog(`capability (degraded): ${d.id} — ${d.note}`)
  if (rep.ok) return
  refuse(rep)
})()

/**
 * Replace the login card with what is missing — and with a way to ask again.
 *
 * Reported on WebKitGTK: X25519 failed once, the card said the browser was not
 * enough, and RESTARTING THE APP fixed it. Whatever the platform was doing, our
 * half was worse: one probe decided it, and the only way back was to quit. The
 * probe retries internally now, and this is the second line of defence — the
 * user can ask again without leaving.
 *
 * A successful retry RELOADS rather than restoring the form. The card's markup
 * is gone by then, and putting it back would produce nodes with none of the
 * listeners the app attached at start-up — a login screen that looks right and
 * responds to nothing is worse than a reload.
 */
function refuse(rep: Awaited<ReturnType<typeof probeCapabilities>>) {
  const card = document.querySelector('.login-card')
  if (!card) return
  card.innerHTML = `<h1>${escapeHtml(tr('Ta przeglądarka nie wystarczy'))}</h1>`
    + `<div class="sub">${escapeHtml(tr('onchato potrzebuje kilku funkcji, których tu brakuje. Bez nich nie da się nawet ustalić wspólnego pokoju, więc logowanie jest wyłączone.'))}</div>`
    // `error` is the platform's own words. It is the difference between "your
    // browser cannot" and "your browser would not, this time" — and without it
    // the last report of this could not be diagnosed at all.
    + rep.missing.map((m) => `<div class="msg err" style="display:block">${escapeHtml(m.id)} — ${escapeHtml(m.note ?? '')}`
      + (m.error ? `<br><span style="opacity:.75;font-family:var(--mono);font-size:11px">${escapeHtml(m.error)}</span>` : '')
      + `</div>`).join('')
    + `<button class="btn" id="cap-retry" style="margin-top:12px">${escapeHtml(tr('Spróbuj ponownie'))}</button>`
    + `<div class="nodes-hint" style="margin-top:14px">${escapeHtml(rep.ua)}</div>`
  const retry = document.getElementById('cap-retry') as HTMLButtonElement | null
  retry?.addEventListener('click', async () => {
    retry.disabled = true; retry.textContent = tr('…')
    const again = await probeCapabilities({ hostRtc: await tauriRtcAvailable() })
    capReport = again
    ecLog(formatReport(again))
    if (again.ok) { location.reload(); return }
    refuse(again) // same card, this attempt's error — so a repeat is visible as one
  })
}

/**
 * Per-peer handshake state. The badge shows ONE thing, but a room can have more
 * than one peer id in it — a peer that reloaded, or a second tab logged into the
 * same identity, which can never complete a handshake with us. Rendering
 * whichever event came last made the badge flicker secure -> failed -> secure while a perfectly
 * good session was carrying messages. The best state wins instead: if any peer
 * has a live ratchet, we are secure, whatever the others are doing.
 */
/** Update a room's security map, then paint the badge if that room is on screen.
 *  The map is per-room now: a background handshake must not move the foreground
 *  badge. On switching in, `paintSecurity` repaints from the room's own map. */
function noteSecurity(room: Room, peer: string, state: 'handshaking' | 'established' | 'failed') {
  // A finished handshake is proof they hold our key — they could not have
  // completed one without it — so the wait is over. Presence used to be the only
  // thing that ended it, and the presence watch EXCLUDES the contact whose
  // conversation is on screen: accept a knock, open the chat, and the row said
  // CZEKAM for ever while the two of you were talking. Reported live; the
  // harness missed it because its B never opens the room.
  if (state === 'established' && room.contact && waiting.has(room.contact.pub)) {
    stopKnocking(room.contact.pub)
  }
  if (peer) room.security.set(peer, state)
  else { room.security.clear(); room.security.set('', state) }
  if (room === activeRoom()) { paintSecurity(room); paintKnockButton(); paintStatus() }
  // The channel just came up or went down — the contact-list dot is
  // green-vs-orange on exactly that, so repaint the list too.
  renderContacts()
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
  // Two writers share the tooltip: the state (here) and the rotation
  // countdown (startRotation's tick), which lost its own badge to header
  // space. Each writes its dataset half and composes, so neither erases
  // the other.
  el.dataset.baseTitle = title
  applyBadgeTitle(el)
}

function applyBadgeTitle(el: HTMLElement) {
  const rot = el.dataset.rot
  el.title = rot ? `${el.dataset.baseTitle ?? ''}\n${rot}` : (el.dataset.baseTitle ?? '')
}

// Hover does not exist on a phone, so the tooltip this badge carries — the
// security state and the rotation countdown — was unreachable exactly where
// the header is tightest. A tap says it out loud instead; the desktop keeps
// its hover and loses nothing to the extra click.
$('e2e-badge').addEventListener('click', () => {
  const b = $('e2e-badge')
  const line = [b.dataset.rot, b.dataset.baseTitle].filter(Boolean).join('\n')
  // Two lines need more than the default blink — but this is the only caller
  // that does; everything else keeps the short toast.
  if (line) toast(line, 4000)
})

function noteTransport(room: Room, state: string) {
  // `demoted=` belongs here too: a stall hands content back to GossipSub for the
  // rest of the conversation, and the badge claimed Direct throughout because
  // this matcher only knew the `conn=` vocabulary. Anything that is not
  // `conn=connected` paints Relay, which is the safe direction to be wrong in.
  if (/^(conn=(connected|failed|disconnected|closed)|demoted=)/.test(state)) room.transport = state
  // The badge is a security indicator, so it follows PROOF, not state: the
  // link reports probe=ok once its ping came back, and only then does the room
  // send content down the channel. Anything that ends the channel ends the proof.
  if (state === 'probe=ok') room.directProven = true
  if (state === 'probe=failed' || /^(conn=(failed|disconnected|closed)|demoted=)/.test(state)) room.directProven = false
  if (room === activeRoom()) paintTransport(room)
}
function paintTransport(room: Room) {
  const b = $('transport-badge')
  if (room.directProven) setBadge(b, 'badge direct', tr('🟢 Direct'), tr('Treść bezpośrednio P2P — relay ślepy na treść/rozmiary/timing'))
  else setBadge(b, 'badge relay', tr('⚪ Relay'), tr('Treść przez relay (GossipSub)'))
}


// ---- pinned messages (local, §10 at rest) ---------------------------------
/**
 * A conversation here is ephemeral on purpose — a reload takes the transcript,
 * and nothing on the device remembers it. Pinning is the exception a person
 * opens by hand: the chosen message is sealed into this browser under the
 * identity's own key (`lib/pincache.ts`), and comes back at the TOP of the
 * conversation the next time the page is loaded.
 *
 * Three shapes follow from what that is:
 *
 * - **Nothing goes over the wire.** The other side is never told; a pin is a
 *   note to self, not a signal, so there is no protocol here to review.
 * - **Read once per page-load, per room.** Re-entering a room replays its log,
 *   which already holds what was read — so a second read would duplicate. The
 *   pins are unshifted INTO that log, which is also why they land first and why
 *   ordering needs no special case anywhere else.
 * - **A fresh pin does not move.** It is written to the store and marked where
 *   it sits; only the next page-load brings it back at the top. Reordering a
 *   transcript under someone's eyes is not worth the tidiness.
 *
 * Consent is asked once per session for each direction, in RAM only, like the
 * link warning: a dismissal that survived a reload would outlive the reason it
 * was given.
 */
const pins = new Map<string, Pin[]>()   // roomId (peer pub | gidHex) → kept messages
const pinsLoaded = new Set<string>()    // rooms whose store was read this page-load
let pinConsent = false
let unpinConsent = false

// Keyed by KID like every other per-identity store — a second identity on the
// same HEM must not see the first one's pins.
const pinsKey = (roomId: string) => 'ec-pins-' + (session?.idKey ?? '') + '-' + roomId
const pinRoomId = (): string | null => activeGid ?? activePub
const roomPins = (roomId: string | null): Pin[] => (roomId ? pins.get(roomId) ?? [] : [])
const isPinned = (id: string): boolean => roomPins(pinRoomId()).some((p) => p.id === id)
const activeLog = (): Ev[] | null => (activeGid ? groupsUI.get(activeGid)?.log ?? null : activeRoom()?.log ?? null)

/** Read a room's pins once per page-load and put them at the head of its log. */
async function loadPins(roomId: string, log: Ev[]) {
  if (pinsLoaded.has(roomId)) return
  pinsLoaded.add(roomId) // claimed BEFORE the awaits: two fast entries must not both read
  const blob = localStorage.getItem(pinsKey(roomId)); if (!blob) return
  const base = await ensureCacheBase(); if (!base) return
  const kept = await openPins(base, roomId, blob)
  if (!kept?.length) return
  pins.set(roomId, kept)
  log.unshift({ t: 'pinhdr' }, ...kept.map((p): Ev => ({
    t: 'msg', kind: p.mine ? 'me' : 'peer', text: p.text, ts: p.ts, id: p.id, who: p.who, pinned: true, re: p.re, au: p.au,
  })))
  ecLog(`pins: restored ${kept.length} for ${roomId.slice(0, 12)}…`, 'debug')
}

async function persistPins(roomId: string) {
  if (wiping) return
  const kept = roomPins(roomId)
  if (!kept.length) { localStorage.removeItem(pinsKey(roomId)); return }
  const base = await ensureCacheBase()
  if (!base) { toast(tr('Nie udało się zapisać — brak klucza tej tożsamości')); return }
  try { localStorage.setItem(pinsKey(roomId), await sealPins(base, roomId, kept)) }
  catch (e: any) {
    // A full quota is the realistic failure, and it must not look like success.
    ecLog('pins: save failed — ' + (e?.message ?? e))
    toast(tr('Nie udało się zapisać przypiętej wiadomości'))
  }
}

/** The count line above the restored block; repainted rather than re-replayed. */
function repaintPinHeader() {
  const el = $('messages').querySelector('.sysline.pinhdr') as HTMLElement | null
  if (!el) return
  const n = roomPins(pinRoomId()).length
  if (!n) el.remove(); else el.textContent = tr('📌 Przypięte ({n})', { n })
}

async function togglePin(row: HTMLElement, id: string, btn: HTMLButtonElement) {
  const roomId = pinRoomId(); if (!roomId) return
  const kept = roomPins(roomId)
  if (kept.some((p) => p.id === id)) {
    if (!unpinConsent) {
      const r = await ask(tr('Odpiąć wiadomość?'),
        tr('Odpięcie skasuje ją z pamięci tej przeglądarki. Ten komunikat pokaże się raz na sesję.'), tr('Odepnij'))
      if (!r.ok) return
      unpinConsent = true
    }
    pins.set(roomId, withoutPin(kept, id))
    await persistPins(roomId)
    // A bubble that is on screen only BECAUSE it was pinned goes with the pin —
    // it was a copy from the store. A live message just loses its mark; deleting
    // it would take a real piece of the conversation with it.
    if (row.dataset.frompin) {
      row.remove(); msgEls.delete(id); stateEls.delete(id)
      const log = activeLog()
      const at = log?.findIndex((e) => e.t === 'msg' && e.id === id && e.pinned) ?? -1
      if (log && at >= 0) log.splice(at, 1)
    } else {
      row.classList.remove('pinned'); paintPinBtn(btn, false)
    }
    repaintPinHeader()
    return
  }
  if (!pinConsent) {
    const r = await ask(tr('Przypiąć wiadomość?'),
      tr('Przypięcie zapisze ją w zaszyfrowanej formie w pamięci tej przeglądarki, żeby przetrwała przeładowanie. Ten komunikat pokaże się raz na sesję.'),
      tr('Przypnij'))
    if (!r.ok) return
    pinConsent = true
  }
  const ev = activeLog()?.find((e) => e.t === 'msg' && e.id === id) as Extract<Ev, { t: 'msg' }> | undefined
  if (!ev) return
  const next = withPin(kept, { id, text: ev.text, ts: ev.ts, who: ev.who, mine: ev.kind === 'me', pinnedAt: nowMs(), re: ev.re, au: ev.au })
  if (!next) { toast(tr('W tej rozmowie można przypiąć {n} wiadomości — odepnij coś, żeby zrobić miejsce', { n: PIN_LIMIT })); return }
  if (next === kept) return // already pinned; nothing to write
  pins.set(roomId, next)
  await persistPins(roomId)
  row.classList.add('pinned'); paintPinBtn(btn, true)
  repaintPinHeader()
}

// The two icons are ONE drawing at two angles, and drawn rather than typed for
// the reason the link arrow is: no font renders a pushpin the same way twice.
// Tilted = a pin you could still push in. Upright and struck through = one that
// is in, and comes out.
//
// Neither is filled. The filled version was tried and is a smudge at 14px — the
// slash disappears into it — and it was never needed: the pinned state already
// arrives in the accent colour with a tinted button behind it, so the fill was
// a third voice saying the same thing, badly.
const PIN_PATH = '<path d="M12 17v5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>'
const pinSvg = (on: boolean) =>
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + (on ? PIN_PATH + '<path d="M4 4l16 16"/>' : `<g transform="rotate(45 12 12)">${PIN_PATH}</g>`)
  + '</svg>'

function paintPinBtn(btn: HTMLButtonElement, on: boolean) {
  btn.innerHTML = pinSvg(on) // our own constant markup, never message content
  btn.title = on ? tr('Odepnij — skasuje z pamięci przeglądarki') : tr('Przypnij — zachowa w tej przeglądarce')
  btn.setAttribute('aria-label', btn.title)
  btn.classList.toggle('on', on)
}

function pinButton(row: HTMLElement, id: string): HTMLButtonElement {
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'b-pin'
  paintPinBtn(btn, isPinned(id))
  btn.addEventListener('click', () => { row.classList.remove('tapped'); void togglePin(row, id, btn) })
  return btn
}

/**
 * The quick-reaction bar, for any bubble that has an id.
 *
 * Shared because it has to be: it is attached to messages and to files, in 1:1
 * rooms and in groups, and the version this replaced knew only about
 * `activeRoom()` — which is null whenever a group is on screen, so the bar was
 * inert in every group without anything saying so.
 */
function attachReactionBar(row: HTMLElement, id: string, canPin = false) {
  const bar = document.createElement('div'); bar.className = 'b-react'
  // Reply comes first: it is the one control here that continues the
  // conversation rather than decorating it. It is also the one that still works
  // on a message restored from a pin — a reply carries its own quote, so the
  // other side does not have to be holding the message it answers.
  const rb = document.createElement('button'); rb.type = 'button'; rb.className = 'b-reply'
  rb.textContent = '↩'; rb.title = tr('Odpowiedz'); rb.setAttribute('aria-label', tr('Odpowiedz'))
  rb.addEventListener('click', () => startReply(row))
  bar.appendChild(rb)
  // Correcting is 1:1 only (`lib/edits.ts`): a group broadcast carries no
  // acknowledgements, so there the sender could never be told that the fix did
  // not land. Own text messages only, and not one restored from a pin — the
  // other side stopped holding that message sessions ago.
  if (!activeGid && row.classList.contains('out') && !row.dataset.frompin && !row.querySelector('.b-file')) {
    const eb = document.createElement('button'); eb.type = 'button'; eb.className = 'b-edit'
    eb.innerHTML = PENCIL_SVG // our own constant markup, never message content
    eb.title = tr('Edytuj'); eb.setAttribute('aria-label', tr('Edytuj'))
    eb.addEventListener('click', () => startEdit(row))
    bar.appendChild(eb)
  }
  // Files are NOT pinnable, by decision: the blob behind a file bubble is swept
  // from the store on its own schedule, so a kept file would become a button
  // that lies about what it can still fetch. The caption is not offered either —
  // half a message kept under the whole message's promise is worse than none.
  if (canPin) bar.appendChild(pinButton(row, id))
  // A message restored FROM the store gets the pin control and nothing else: a
  // reaction sent for it would travel with an id the other side stopped holding
  // when its own transcript went, so it would land nowhere and say nothing.
  if (row.dataset.frompin) { row.appendChild(bar); return }
  // One opener instead of a row of emoji: the picker holds the whole set.
  const more = document.createElement('button'); more.type = 'button'; more.className = 'b-more'
  more.textContent = '☺'; more.title = tr('Reakcja'); more.setAttribute('aria-label', tr('Reakcja'))
  more.addEventListener('click', () => {
    openEmojiPop(more, (e) => {
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
  })
  bar.appendChild(more)
  row.appendChild(bar)
}

/**
 * The emoji picker — one popover, reused by every bubble.
 *
 * One element and one handler rather than a grid built into each bar: the
 * transcript can hold hundreds of bubbles, and thirty-two buttons on each of
 * them is a DOM nobody needs to pay for. It borrows the members-popover's
 * geometry (open at the pointer, clamped into the viewport) because on a phone
 * it is nearly as wide as the app and would otherwise open off-screen.
 */
let emojiPick: ((e: string) => void) | null = null
let emojiAnchor: HTMLElement | null = null
function openEmojiPop(anchor: HTMLElement, pick: (e: string) => void) {
  const pop = $('emoji-pop')
  if (!pop.hidden && emojiAnchor === anchor) { closeEmojiPop(); return } // second press closes
  emojiPick = pick; emojiAnchor = anchor
  if (!pop.childElementCount) {
    for (const e of QUICK_EMOJI) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = e
      b.setAttribute('data-emoji', e)
      pop.appendChild(b)
    }
  }
  // Anchored to the BUTTON, never to the pointer. The members popover opens at
  // the pointer because its anchor is a whole sidebar row; this one hangs off a
  // 30px control, so the button IS the position — and a click carrying no
  // coordinates (a synthetic one, a keyboard activation) would otherwise report
  // 0,0 and throw the picker into the corner of the screen.
  const r = anchor.getBoundingClientRect()
  pop.hidden = false // measure with the real size, like the members popover
  const w = Math.min(pop.offsetWidth || 240, window.innerWidth - 16)
  const h = Math.min(pop.offsetHeight || 200, window.innerHeight - 16)
  const x = r.left + r.width / 2
  // Above the button when there is no room below — a bubble near the composer
  // is exactly where people react, and a picker pinned to the bottom edge would
  // cover the message it belongs to.
  const below = r.bottom + 8
  const y = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 8) : below
  pop.style.left = `${Math.max(8, Math.min(x - w / 2, window.innerWidth - w - 8))}px`
  pop.style.top = `${y}px`
}
function closeEmojiPop() { $('emoji-pop').hidden = true; emojiPick = null; emojiAnchor = null }
$('emoji-pop').addEventListener('click', (e: any) => {
  const b = (e.target as HTMLElement).closest('[data-emoji]') as HTMLElement | null
  if (!b) return
  e.stopPropagation() // the outside-click closer below must not see this
  const pick = emojiPick; closeEmojiPop()
  pick?.(b.getAttribute('data-emoji')!)
})
document.addEventListener('click', (e: any) => {
  if ($('emoji-pop').hidden) return
  if ($('emoji-pop').contains(e.target) || emojiAnchor?.contains(e.target)) return
  closeEmojiPop()
})
document.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape') closeEmojiPop() })

/**
 * Tap a bubble to show what can be done with it — the same gesture on a phone
 * and on a desktop (the user's decision, 2026-09-03).
 *
 * It replaced hover-on-desktop / tap-on-touch. Two mechanisms for one thing
 * meant the tap was never discovered by anyone using a mouse, and the bar
 * appeared under the pointer while somebody was only reading. One bubble is
 * open at a time, and pressing it again closes it.
 *
 * WARNING: A drag that selects text ends with a `click` on the bubble, so copying a
 * message would have popped the bar every time. A collapsed selection means a
 * real press; anything else is somebody reading, and we keep out of the way.
 */
function attachReveal(row: HTMLElement, bub: HTMLElement) {
  row.classList.add('has-act')
  bub.addEventListener('click', (e: any) => {
    if (e.target.closest('button')) return // a control inside the bubble (↻ resend, a file action)
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && sel.anchorNode && bub.contains(sel.anchorNode)) return
    const open = row.classList.contains('tapped')
    for (const r of $('messages').querySelectorAll('.mrow.tapped')) r.classList.remove('tapped')
    if (!open) row.classList.add('tapped')
  })
}

/**
 * The time on a bubble: the READER's clock, with UTC kept in the tooltip.
 *
 * The stamp used to say "12:03 UTC", which is right for the protocol and wrong
 * for the person — a message sent a minute ago read as two hours old for
 * anybody east of Greenwich (reported 2026-09-03). `ts` is epoch ms, so the
 * conversion is `new Date(ts)` and the zone never leaves the device; putting a
 * timezone on the wire would be handing out a location.
 *
 * The tooltip keeps the absolute UTC instant, because that is the form two
 * machines can be compared in when something looks out of order.
 */
function stampTime(el: HTMLElement, ts: number) {
  el.textContent = localHHMM(ts)
  el.title = utcISO(ts)
}

// ---- replies ---------------------------------------------------------------
/**
 * Answering one particular message, the way Signal and Slack do it: pick a
 * bubble, write, and the reply carries a quote of what it answers.
 *
 * What travels is `re` on the message envelope (`lib/quote.ts`): the quoted
 * message's id, a hint at its author's key, and a short copy of its text. The
 * COPY is the part that looks redundant and is not — this transcript dies with
 * the page, so a quote that referred to an id and nothing else would render as
 * "message unavailable" for most of the replies anybody sends. The id is still
 * there, and buys the one thing it can: clicking the quote scrolls to the
 * original when it does happen to be on screen.
 *
 * The author travels as a key hint for the same reason a mention does — names
 * are local, so the reader resolves the hint against the people in THIS
 * conversation and sees their own name for that key. A hint that matches nobody
 * there shows the words without a name rather than attributing them to somebody
 * the reader cannot see.
 */
let replyTo: { id: string; au?: string; text: string; who: string } | null = null

/** The quoted author, in the reader's own words. Empty when the hint matches
 *  nobody here, or two people at once — a quote never guesses whose words. */
function quoteAuthorName(hint?: string): string {
  if (!hint) return ''
  if (session && pubHint(session.pub) === hint) return tr('Ty')
  const pool = activeGid
    ? (groupsUI.get(activeGid)?.members ?? []).map((m) => ({ pub: m.pub, name: memberName(m.pub) }))
    : (() => { const r = activeRoom(); return r ? [{ pub: r.contact.pub, name: r.contact.name }] : [] })()
  const hits = pool.filter((p) => pubHint(p.pub) === hint)
  return hits.length === 1 ? hits[0].name : ''
}

/** The quote drawn inside a bubble: who, one clipped line, and a way back. */
function quoteBlock(re: QuoteRef): HTMLElement {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'b-quote'
  b.title = tr('Pokaż cytowaną wiadomość')
  const who = quoteAuthorName(re.au)
  if (who) { const w = document.createElement('div'); w.className = 'q-who'; w.textContent = who; b.appendChild(w) }
  const t = document.createElement('div'); t.className = 'q-text'; t.textContent = re.text
  b.appendChild(t)
  b.addEventListener('click', () => jumpToMessage(re.id))
  return b
}

/** Take the reader to the quoted message — when it is still here. Usually it is
 *  not (a reload takes the transcript), and saying so is better than a click
 *  that does nothing. The id is base64 of six bytes, so it needs no escaping. */
function jumpToMessage(id: string) {
  const row = $('messages').querySelector(`.mrow[data-mid="${id}"]`) as HTMLElement | null
  if (!row) { toast(tr('Cytowanej wiadomości nie ma już w tej rozmowie')); return }
  row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1600)
}

/** What this bubble says, for the quote — its text, or the file it holds. */
function rowQuoteText(row: HTMLElement): string {
  const txt = row.querySelector('.b-text')?.textContent?.trim()
  if (txt) return txt
  const file = row.querySelector('.f-name')?.textContent?.trim()
  return file ? '📄 ' + file : ''
}

function startReply(row: HTMLElement) {
  const id = row.dataset.mid; if (!id) return
  row.classList.remove('tapped')
  const who = row.classList.contains('out')
    ? tr('Ty')
    : (row.querySelector('.b-who')?.textContent?.trim() || (activeGid ? '' : activeRoom()?.contact.name) || '')
  cancelEdit()  // one strip, one job
  replyTo = { id, au: row.dataset.au, text: rowQuoteText(row), who }
  paintComposerBar()
  ;($('msg-input') as HTMLTextAreaElement).focus()
}
const cancelReply = () => { replyTo = null; paintComposerBar() }
/** One strip above the composer, two things it can be about — never both. */
function paintComposerBar() {
  $('reply-bar').hidden = !replyTo && !editing
  if (editing) {
    $('reply-ico').innerHTML = PENCIL_SVG
    $('reply-who').textContent = tr('Edytujesz wiadomość')
    $('reply-text').textContent = editing.orig
    return
  }
  if (!replyTo) return
  $('reply-ico').replaceChildren(document.createTextNode('↩'))
  $('reply-who').textContent = replyTo.who || tr('Wiadomość')
  $('reply-text').textContent = replyTo.text
}
/** The `re` field for the message being sent — and the reply state is spent by
 *  reading it, so one pick answers one message. */
function takeReply(): QuoteRef | undefined {
  if (!replyTo) return undefined
  const q = makeQuote(replyTo.id, replyTo.text, replyTo.au)
  cancelReply()
  return q
}
$('reply-cancel').addEventListener('click', () => { cancelReply(); cancelEdit() })



// ---- system notifications --------------------------------------------------
/**
 * The app is synchronous and has no store-and-forward, so the expensive moment
 * is not a missed message — it is a conversation that never happened because
 * the window was behind something. This is the only fix that does not require
 * inventing a server, and it is deliberately the smallest one: it fires only
 * while the window is hidden, and it never carries what was written
 * (`lib/notify.ts` says why).
 *
 * Permission is asked when the setting is switched on and never at startup: a
 * prompt nobody understands yet is a prompt that gets denied for good.
 */
const notifyKey = () => 'ec-notify-' + (session?.idKey ?? '')
/**
 * Not looking at this window. Reported as a bug by somebody who had the chat
 * open and got nothing: a visible tab behind another window is still a message
 * nobody sees, and `document.hidden` is false for all of those.
 */
const windowAway = () => document.hidden || !document.hasFocus()
let notifyMode: NotifyMode = 'off'
/** Live notifications by conversation, so ten messages replace each other
 *  instead of stacking ten banners for one room. */
const liveNotes = new Map<string, Banner>()

function loadNotifyMode() {
  const v = (() => { try { return localStorage.getItem(notifyKey()) } catch { return null } })()
  notifyMode = isNotifyMode(v) ? v : 'off'
  paintNotifySetting()
}
function paintNotifySetting() {
  const on = notifySupported()
  $('notify-section').hidden = !on
  $('notify-opts').hidden = !on
  $('notify-note').hidden = !on
  const pick = document.querySelector(`#notify-opts input[value="${notifyMode}"]`) as HTMLInputElement | null
  if (pick) pick.checked = true
}
for (const el of document.querySelectorAll('#notify-opts input')) {
  el.addEventListener('change', async () => {
    const v = (document.querySelector('#notify-opts input:checked') as HTMLInputElement | null)?.value
    const want: NotifyMode = isNotifyMode(v) ? v : 'off'
    if (want !== 'off' && notifySupported() && notifyPermission() !== 'granted') {
      // The gesture that asks is the same one that turns it on — browsers want a
      // user action, and this is the moment the user knows what it is for.
      const res = await notifyRequest()
      if (res !== 'granted') {
        notifyMode = 'off'; paintNotifySetting()
        toast(isDesktopShell()
          ? tr('System nie zgodził się na powiadomienia — trzeba ich pozwolić w ustawieniach systemu')
          : tr('Przeglądarka nie zgodziła się na powiadomienia — trzeba jej pozwolić w ustawieniach strony'))
        try { localStorage.setItem(notifyKey(), 'off') } catch {}
        return
      }
    }
    notifyMode = want
    try { localStorage.setItem(notifyKey(), want) } catch {}
    paintNotifySetting()
    toast(want === 'off' ? tr('Powiadomienia wyłączone') : tr('Powiadomienia włączone'))
  })
}

// ---- moving a profile to another browser -----------------------------------
/**
 * One window, two directions.
 *
 * Export and import are the same act seen from each end, and they share every
 * way of going wrong: a wrong password, a file that is not ours, a name already
 * taken here. Two windows would have meant two copies of those messages, and
 * one of the copies would have drifted.
 *
 * The import entry point is on the LOGIN card rather than in Settings, and that
 * is forced rather than chosen: the browser a profile arrives in is empty by
 * definition, so there is no Settings to reach yet.
 *
 * WARNING: A HEM identity has nothing to export — its key never leaves the device,
 * which is the point of the device — so the export appears for software
 * profiles only, instead of offering a rescue it cannot perform.
 */
let migMode: 'export' | 'import' = 'export'
const MIG_NOTE_EXPORT = 'Zapiszesz plik z całym profilem: tożsamością, kontaktami, grupami i ustawieniami. Otwiera go to samo hasło, którym logujesz się do profilu.'
const MIG_NOTE_IMPORT = 'Wczytany profil zastąpi ustawienia tej przeglądarki (język, motyw, lista węzłów). To PRZENIESIENIE, nie kopia — nie używaj obu kopii naraz, bo jedna tożsamość może mieć tylko jedną aktywną sesję.'

function openMigrate(mode: 'export' | 'import') {
  migMode = mode
  clr('mig-msg')
  ;($('mig-pass') as HTMLInputElement).value = ''
  ;($('mig-file') as HTMLInputElement).value = ''
  $('mig-file-wrap').hidden = mode === 'export'
  $('mig-title').textContent = tr(mode === 'export' ? 'Przenieś profil' : 'Wczytaj przeniesiony profil')
  $('mig-note').textContent = tr(mode === 'export' ? MIG_NOTE_EXPORT : MIG_NOTE_IMPORT)
  pushModal('mig-modal')
  $(mode === 'export' ? 'mig-pass' : 'mig-file').focus()
}
function closeMigrate() { dropModal('mig-modal') }
$('mig-cancel')?.addEventListener('click', closeMigrate)
$('go-migrate')?.addEventListener('click', () => openMigrate('import'))
$('btn-export')?.addEventListener('click', () => openMigrate('export'))

async function runExport(password: string): Promise<boolean> {
  const name = session?.handle ?? ''
  // The password is checked against the identity itself before anything is
  // written. A file sealed under a mistyped password opens for nobody, and its
  // owner would not find that out until the machine they moved to.
  const raw = localStorage.getItem('ec-soft-id-' + name)
  const blob = raw ? JSON.parse(raw) : null
  if (!isSealedProfile(blob)) throw new Error(tr('To nie jest profil software — tożsamości z HEM nie da się przenieść plikiem'))
  await unseal(password, blob) // throws BadPassword
  const file = await exportProfile(localKV(), name, session?.idKey ?? '', password, nowMs())
  const sink = await beginSave(`onchato-${name}-${new Date(nowMs()).toISOString().slice(0, 10)}.${FILE_EXT}`, saveEnv)
  if (!sink) return false   // the dialog was closed: nothing written, and the modal stays for another try
  await sink.write(new Blob([JSON.stringify(file)], { type: 'application/json' }))
  return true
}

async function runImport(password: string): Promise<string> {
  const f = ($('mig-file') as HTMLInputElement).files?.[0]
  if (!f) throw new Error(tr('Wskaż plik profilu'))
  let parsed: any
  try { parsed = JSON.parse(await f.text()) } catch { throw new Error(tr('To nie jest plik profilu onchato')) }
  const bundle = await openBundle(parsed, password)
  const clash = conflictsWith(localKV(), bundle)
  // Refused, never merged and never overwritten: what would be overwritten is
  // an identity, and one wrong click would end every conversation it has.
  if (clash) throw new Error(tr('Profil o nazwie „{name}” już tu jest — nie nadpiszę go', { name: clash }))
  applyBundle(localKV(), bundle)
  return bundle.name
}

$('mig-go')?.addEventListener('click', async () => {
  const btn = $('mig-go') as HTMLButtonElement
  const password = ($('mig-pass') as HTMLInputElement).value
  if (!password) { setMsg('mig-msg', tr('Hasło profilu'), 'err'); return }
  btn.disabled = true
  try {
    if (migMode === 'export') {
      if (!(await runExport(password))) return
      endModals() // the profile moved; nothing to step back into
      toast(tr('Zapisano plik z profilem — pamiętaj, że to przeniesienie, a nie kopia'))
    } else {
      const name = await runImport(password)
      endModals() // the profile moved; nothing to step back into
      // Straight into the login form with the name filled in: the password that
      // opens this profile has just been typed, and asking someone to go and
      // find the profile they have only now moved in is a strange end to a
      // rescue.
      openSoftModal()
      ;($('soft-name') as HTMLInputElement).value = name
      ;($('soft-pass') as HTMLInputElement).focus()
      toast(tr('Przeniesiono profil „{name}” — zaloguj się nim', { name }))
    }
  } catch (e: any) {
    setMsg('mig-msg', e instanceof BadPassword ? tr('Złe hasło') : (e?.message ?? tr('Nie udało się zapisać pliku')), 'err')
  } finally { btn.disabled = false }
})

// ---- the packaged desktop shell ------------------------------------------
/**
 * Two settings that only exist when the app is a window rather than a tab, and
 * one of them is here for a product reason rather than a preference: onchato
 * has no store-and-forward, so a closed window is not "later", it is a
 * conversation that cannot happen. Closing therefore hides to the tray by
 * default and the section says so in as many words.
 *
 * The section is hidden — not disabled — in a browser. A dead switch is worse
 * than an absent one: it invites the reader to look for the thing that turns it
 * on. Same rule as the QR scanner button and the notification modes.
 */
async function paintDesktopSettings() {
  const on = isDesktopShell()
  const sec = $('desk-section'), opts = $('desk-opts'), note = $('desk-note')
  if (sec) sec.hidden = !on
  if (opts) opts.hidden = !on
  if (note) note.hidden = !on
  if (!on) return
  // The close-to-tray row disappears where there is no tray to close INTO —
  // and the note says so, because the option's absence is otherwise a mystery
  // on a desktop that has a tray for other apps tomorrow. Hiding a window into
  // an icon nobody draws is a window you get back by killing the process.
  // A phone has neither a tray nor a login item, and saying that is better than
  // showing two switches that cannot do anything. What it has instead is the
  // foreground service, which is worth explaining once — the permanent
  // notification it needs looks like a bug to anyone who does not know why.
  const phone = isMobileShell()
  const trayRow = $('desk-tray')?.closest('label') as HTMLElement | null
  const autoRow = $('desk-autostart')?.closest('label') as HTMLElement | null
  const hasTray = trayAvailable()
  if (trayRow) trayRow.hidden = phone || !hasTray
  if (autoRow) autoRow.hidden = phone
  const trayNote = $('desk-no-tray')
  if (trayNote) trayNote.hidden = phone || hasTray
  const mobileNote = $('desk-mobile')
  if (mobileNote) mobileNote.hidden = !phone
  const tray = $('desk-tray') as HTMLInputElement | null
  if (tray) tray.checked = hasTray && closeToTray()
  if (phone) return
  const auto = $('desk-autostart') as HTMLInputElement | null
  // Read from the SYSTEM, not from a preference of ours — a desktop can refuse
  // a login item, and a checkbox showing what we asked for rather than what
  // happened is a checkbox that lies.
  if (auto) auto.checked = await autostartEnabled()
}
/**
 * Hand the shell its strings in the app's language. The tray menu is the only
 * part of onchato drawn outside the webview, so it is the only part that can
 * end up in a different language than everything around it — which is exactly
 * the seam that makes a packaged web app feel packaged. Called again on every
 * language change for the same reason.
 */
function initDesktopShell() {
  void initDesktop({
    show: tr('Pokaż onchato'),
    quit: tr('Zakończ'),
    hiddenTitle: tr('onchato działa dalej'),
    saveTitle: tr('Zapisz plik'),
    hiddenBody: tr('Okno zostało schowane do zasobnika — jesteś nadal osiągalny/a. Wyjście jest w menu ikony.'),
  }).then(() => {
    // The host answers about the notification permission asynchronously, so the
    // notification section was painted before the answer arrived.
    paintNotifySetting()
    void paintDesktopSettings()
  })
}
$('desk-tray')?.addEventListener('change', (e) => {
  setCloseToTray((e.target as HTMLInputElement).checked)
})
$('desk-autostart')?.addEventListener('change', async (e) => {
  const box = e.target as HTMLInputElement
  const want = box.checked
  const got = await setAutostart(want)
  box.checked = got
  if (got !== want) toast(tr('Nie udało się ustawić startu przy uruchomieniu systemu'))
})

// ---- diagnostics ----------------------------------------------------------
/**
 * What this platform can do, in a form that can be READ and PASTED.
 *
 * The boot probe has always existed and has always gone to the debug log, which
 * on a phone or in a packaged app is nowhere. Two separate questions get
 * answered here, and keeping them apart is the entire value:
 *
 * - **Does the app work at all here** — the boot report, drawn as it is.
 * - **Does WebRTC work here, and if not, whose fault is it** — on demand,
 *   because the honest test takes seconds and must not be paid for at every
 *   start. `lib/webrtc-probe.ts` connects this window to ITSELF, so a failure
 *   is the webview's; the STUN row is the only one about the network, and it
 *   says so. Until now a grey transport badge could mean either, and there was
 *   no way to tell.
 */
let lastWebrtcProbe: WebrtcProbeResult | null = null

function diagLine(mark: 'ok' | 'bad' | 'meh', text: string) {
  const cls = mark === 'ok' ? 'ok' : mark === 'bad' ? 'bad' : 'meh'
  const sign = mark === 'ok' ? '✓' : mark === 'bad' ? '✖' : '·'
  return `<span class="${cls}">${sign}</span> ${escapeHtml(text)}`
}

/**
 * Diagnostics are for whoever is diagnosing, and nobody else.
 *
 * The WebRTC self-test was built to settle one question and settled it:
 * WebKitGTK does not expose `RTCPeerConnection`, so the desktop runs on the
 * relay. The capability report beside it is a user agent and a list of ticks.
 * Neither is something to hand a person who opened Settings to change the
 * theme, so the whole section lives behind `?debug=1` now.
 *
 * The code stays in the build on purpose. The same WebRTC question is open on
 * Windows, macOS and Android, and the day somebody runs one of those this is a
 * URL parameter rather than a piece of work — and `Kopiuj raport` is still the
 * fastest way to turn "it does not work here" into something answerable.
 *
 * WARNING: What it costs: an ordinary user no longer has anywhere to read WHY the QR
 * button or the microphone is missing on their platform. The controls still
 * vanish rather than sitting there dead, but the explanation now needs asking
 * for.
 */
let diagOpen = DEBUG   // ?debug=1 opens it; anybody else presses the button
function paintDiagnostics() {
  const more = $('diag-more'); if (more) more.hidden = !diagOpen
  const chev = $('diag-chev'); if (chev) chev.textContent = diagOpen ? '\u25BE' : '\u25B8'
  const out = $('diag-webrtc'); if (out) out.hidden = !lastWebrtcProbe
}
$('btn-diag-toggle')?.addEventListener('click', () => {
  diagOpen = !diagOpen
  paintDiagnostics()
  if (diagOpen) paintCaps()   // the capability list is cheap, but only worth computing when it is looked at
})

function paintCaps() {
  const box = $('diag-caps'); if (!box || !capReport) return
  const rows = capReport.caps.map((c) => diagLine(
    c.ok ? 'ok' : c.required ? 'bad' : 'meh',
    c.id + (c.tries ? ` (${tr('{n} próby', { n: c.tries })})` : '') + (c.ok ? '' : ` — ${c.note ?? ''}${c.error ? ` [${c.error}]` : ''}`),
  ))
  // The user agent is the first thing anyone reading a bug report wants and the
  // last thing they can get out of a packaged app.
  // The capability list asks the webview, and on the Linux desktop the honest
  // answer is "no WebRTC here, but the host carries the channel" — without
  // this line the report would say the direct plane is missing while it works.
  if (rustRtc && typeof RTCPeerConnection === 'undefined') {
    rows.push(diagLine('ok', tr('Kanał bezpośredni: przez hosta (Rust, webrtc-rs) — webview nie ma WebRTC')))
  }
  box.innerHTML = [escapeHtml(capReport.ua), ...rows].join('<br>')
  paintDiagnostics()
}

const stageWord = (s: ProbeStage) => s.about === 'platform' ? tr('aplikacja') : tr('sieć')

$('btn-webrtc-probe')?.addEventListener('click', async () => {
  const btn = $('btn-webrtc-probe') as HTMLButtonElement
  const out = $('diag-webrtc')
  btn.disabled = true; btn.textContent = tr('Sprawdzam…')
  out.hidden = false; out.innerHTML = ''
  const rows: string[] = []
  try {
    // Drawn stage by stage: the loopback step alone can take seconds, and a box
    // that sits blank through it reads as a hang.
    lastWebrtcProbe = await probeWebrtc((st) => {
      rows.push(diagLine(st.ok ? 'ok' : 'bad',
        `${st.id} [${stageWord(st)}] ${st.ms} ms${st.detail ? ' — ' + st.detail : ''}${st.error ? ' — ' + st.error : ''}`))
      out.innerHTML = rows.join('<br>')
      // The self-test must dial what the app dials, or its verdict is about a
      // server nobody uses. Same derivation as the conversation path; `?stun=0`
      // leaves nothing to ask, so the stage falls back to the first node.
    }, (iceServersFor(location.search, chosenRelays())[0]?.urls),
      // No RTCPeerConnection but a host that has one: the loopback runs there.
      typeof RTCPeerConnection === 'undefined' && rustRtc ? tauriRtcSelftest : undefined)
    ecLog(formatWebrtcProbe(lastWebrtcProbe))
    ;(window as any).__webrtcProbe = lastWebrtcProbe // read by the browser harness; harmless elsewhere
  } finally {
    btn.disabled = false; btn.textContent = tr('Sprawdź WebRTC')
  }
})

$('btn-diag-copy')?.addEventListener('click', async () => {
  const text = [
    capReport ? formatReport(capReport) : 'platform: ' + tr('(sonda jeszcze nie skończyła)'),
    // The capability list only knows the webview; the report must carry the
    // same line the screen does, or it says the direct plane is missing on a
    // platform where the host carries it (the first Linux report did).
    ...(rustRtc && typeof RTCPeerConnection === 'undefined'
      ? ['[ok] ' + tr('Kanał bezpośredni: przez hosta (Rust, webrtc-rs) — webview nie ma WebRTC')] : []),
    lastWebrtcProbe ? formatWebrtcProbe(lastWebrtcProbe) : 'webrtc: (nie sprawdzano)',
    `build: ${$('build-id-settings')?.textContent ?? '?'}`,
  ].join('\n')
  try { await navigator.clipboard.writeText(text); toast(tr('Raport skopiowany')) }
  catch { toast(tr('Nie udało się skopiować — zaznacz i skopiuj ręcznie')) }
})

/**
 * Feedback (`feedback.ts`). Wired here because the technical attachment IS
 * the diagnostics report above — the same text `Kopiuj raport` produces, so a
 * tester never has to find `?debug=1` to give us the one thing a bug report
 * needs. The module gets the report as a function, never the session.
 *
 * The endpoint is the canonical host's, whatever origin the bundle runs from
 * (tauri://localhost, a phone, a dev server). `?fb=<url>` redirects it ONLY on
 * localhost — for pointing a dev page at a local `feedback.mjs`; a shared
 * link must not be able to choose where a report goes.
 */
const FEEDBACK_URL = (() => {
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  const q = local ? new URLSearchParams(location.search).get('fb') : null
  return q || `${CANONICAL_ORIGIN}/feedback`
})()
initFeedback({
  version: __EC_VERSION__,
  commit: __EC_COMMIT__,
  endpoint: FEEDBACK_URL,
  diagnostics: () => capReport
    ? formatReport(capReport) + (lastWebrtcProbe ? '\n' + formatWebrtcProbe(lastWebrtcProbe) : '')
    : null,
  toast,
})
$('btn-feedback')?.addEventListener('click', () => openFeedback('bug'))
// The two "ask about HEM" lines — the login card's empty state and Settings'
// software-profile section — open the same form on its HEM question. The
// Settings one closes the drawer first: the form takes the shared scrim down
// with it when it closes, and a drawer left open behind no backdrop is the
// same trap `ask()` callers repair by hand.
$('hem-ask-login')?.addEventListener('click', () => openFeedback('hem'))
$('hem-ask-settings-link')?.addEventListener('click', () => { closeDrawer(); openFeedback('hem') })

/**
 * Notify about one arriving event. `where` identifies the conversation twice
 * over: it is the notification tag (so a room replaces its own banner) and what
 * clicking it opens.
 */
function notifyArrival(ev: Ev, where: { pub?: string; gid?: string; name: string }) {
  if (ev.t !== 'msg' && ev.t !== 'file') return
  const plan = planNotification({
    mode: notifyMode,
    granted: notifySupported() && notifyPermission() === 'granted',
    away: windowAway(),
    mine: ev.kind === 'me',
    name: where.name,
  })
  if (!plan.show) return
  const tag = where.gid ?? where.pub ?? ''
  try {
    const n = notifyShow({
      title: plan.name ?? 'onchato', // the product name is not translated
      body: ev.t === 'file' ? tr('Przysłano plik') : tr('Nowa wiadomość'),
      tag, // one banner per conversation, replaced rather than stacked
      onClick: () => {
        liveNotes.delete(tag)
        if (where.gid) void activateGroup(where.gid)
        else if (where.pub) void activateRoom(where.pub)
      },
    })
    if (!n) return
    liveNotes.get(tag)?.close()
    liveNotes.set(tag, n)
  } catch (e: any) { ecLog('notification failed: ' + (e?.message ?? e), 'debug') }
}
/** Coming back to the window makes every banner stale — they were about being
 *  away. */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  for (const n of liveNotes.values()) { try { n.close() } catch {} }
  liveNotes.clear()
})

// ---- editing what you already said -----------------------------------------
/**
 * A correction replaces the text of a message you already sent (`lib/edits.ts`),
 * and it is **1:1 only**. The reason is not effort: a correction can only change
 * what a client is still holding, and here a transcript dies with the page — so
 * the sender has to be TOLD when it did not land. A 1:1 correction rides the
 * delivery tracking a message does and can say "they still see the old text"; a
 * group broadcast has no acknowledgements and could only ever say "sent", which
 * invites you to believe you fixed something you did not.
 *
 * Everything else follows from that:
 *
 * - **Nothing changes silently.** Both sides get "edytowano" on the bubble, and
 *   the sender additionally sees whether the correction arrived.
 * - **Fifteen minutes**, from the message, not from the last edit.
 * - **Only your own words.** An incoming correction may touch the messages of
 *   the peer that sent it and never ours (`acceptEdit`).
 * - **A pin is a snapshot** (decided): a kept copy is the text as it was pinned,
 *   so a correction does not rewrite the store, and a restored pin is not
 *   editable — the other side stopped holding that message long ago.
 */
let editing: { id: string; orig: string } | null = null

/** The pencil, drawn rather than typed: `` is emoji-presentation on most
 *  platforms and came out as a colour blob beside the line-art pin. Same
 *  geometry and stroke as `pinSvg`, so the bar reads as one set of controls. */
const PENCIL_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="M14 6l4 4"/></svg>'

/** The live (non-pinned) event for a message id in this room. */
const findMsgEv = (room: Room | null | undefined, id: string): MsgEv | undefined =>
  room?.log.find((e) => e.t === 'msg' && e.id === id && !e.pinned) as MsgEv | undefined

/** The "edytowano" span: what it says, and for our own correction, how it went. */
function editedMark(ev: MsgEv): HTMLElement {
  const s = document.createElement('span'); s.className = 'edited-mark'
  paintEditedMark(s, ev)
  return s
}
function paintEditedMark(s: HTMLElement, ev: MsgEv) {
  s.textContent = tr(' · edytowano')
  s.title = tr('Treść poprawiona przez autora o {t}', { t: localHHMM(ev.edited ?? nowMs()) })
  s.classList.remove('warn') // textContent above already dropped an old ↻ button
  if (ev.kind !== 'me' || !ev.editState) return
  if (ev.editState === 'sending') {
    s.textContent = tr(' · edytowano — wysyłam poprawkę…')
    s.title = tr('Czekam na potwierdzenie od klienta rozmówcy')
  } else if (ev.editState === 'lost') {
    // The message arrived; the CORRECTION did not. Saying "undelivered" here
    // would name the wrong thing — what is undelivered is the fix, and the
    // consequence is specific enough to spell out.
    s.textContent = tr(' · ⚠ poprawka nie dotarła')
    s.title = tr('Rozmówca wciąż widzi starą treść — mimo ponowień nie ma potwierdzenia')
    s.classList.add('warn')
    const again = document.createElement('button')
    again.type = 'button'; again.className = 'b-resend'; again.textContent = tr('↻')
    again.title = tr('Wyślij poprawkę ponownie')
    again.addEventListener('click', () => {
      if (!ev.editId || !activeRoom()?.conv?.resend(ev.editId)) return
      ev.editState = 'sending'; paintEditedMark(s, ev)
    })
    s.appendChild(again)
  } else if (ev.editState === 'late') {
    s.textContent = tr(' · edytowano (poprawka dotarła z opóźnieniem)')
  }
}

/** Redraw one bubble after its text changed. The body goes through the SAME
 *  renderer as the first time, so links and mentions in a corrected message are
 *  found again rather than left as the text they used to be. */
function repaintMsg(ev: MsgEv) {
  if (!ev.id) return
  const row = $('messages').querySelector(`.mrow[data-mid="${ev.id}"]`) as HTMLElement | null
  if (!row) return
  const body = row.querySelector('.b-text') as HTMLElement | null
  if (body) { body.replaceChildren(); renderBody(body, ev.text) }
  const meta = row.querySelector('.b-meta') as HTMLElement | null
  if (!meta || !ev.edited) return
  const mark = meta.querySelector('.edited-mark') as HTMLElement | null
  if (mark) paintEditedMark(mark, ev)
  else meta.appendChild(editedMark(ev))
}

/** Our own correction came back acknowledged, or did not. Handled where the room
 *  is known rather than through a delivery event, because the [ok] belongs to a
 *  bubble that already exists — and because the state has to survive a room
 *  switch, which it does by living on the event. */
function noteEditDelivery(room: Room, id: string, state: 'ok' | 'lost' | 'late'): boolean {
  const ev = room.log.find((e) => e.t === 'msg' && e.editId === id) as MsgEv | undefined
  if (!ev) return false
  ev.editState = state
  if (isViewing(room)) repaintMsg(ev)
  return true
}

function startEdit(row: HTMLElement) {
  const id = row.dataset.mid; if (!id) return
  const room = activeRoom()
  const ev = findMsgEv(room, id)
  if (!ev) return
  if (!canEdit(ev.ts)) { toast(tr('Poprawić można w ciągu {n} minut od wysłania', { n: Math.round(EDIT_WINDOW_MS / 60_000) })); return }
  row.classList.remove('tapped')
  cancelReply() // one strip, one job
  editing = { id, orig: ev.text }
  const inp = $('msg-input') as HTMLTextAreaElement
  inp.value = ev.text
  paintComposerBar()
  growComposer(); paintLength() // the message being corrected may be a paragraph
  inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length)
}
/** Leaving edit mode also empties the composer: what is in it is the old message,
 *  not a draft — carrying it into an ordinary send would say it twice. */
function cancelEdit() {
  if (!editing) return
  editing = null
  ;($('msg-input') as HTMLTextAreaElement).value = ''
  growComposer(); paintLength()
  paintComposerBar()
}

/** Send the correction the composer is holding. Returns false when there is
 *  nothing to correct, so the ordinary send path can carry on. */
function sendEditComposer(): boolean {
  if (!editing) return false
  const inp = $('msg-input') as HTMLTextAreaElement
  const text = inp.value.trim()
  const room = activeRoom()
  const ev = findMsgEv(room, editing.id)
  // An empty correction would be a deletion, and deleting for everybody is a
  // different promise with different failure modes — not this feature.
  if (!text || !room?.conv || !ev) { cancelEdit(); return true }
  if (!canEdit(ev.ts)) { toast(tr('Poprawić można w ciągu {n} minut od wysłania', { n: Math.round(EDIT_WINDOW_MS / 60_000) })); cancelEdit(); return true }
  if (text === ev.text) { cancelEdit(); return true } // nothing changed: do not tell the peer anything
  const eid = room.conv.sendEdit(editing.id, text)
  ecLog(`edited ${editing.id} → "${text.slice(0, 40)}" (correction id ${eid})`)
  ev.text = text; ev.edited = nowMs(); ev.editId = eid; ev.editState = 'sending'
  repaintMsg(ev)
  inp.value = ''; growComposer(); paintLength()
  editing = null
  paintComposerBar()
  return true
}

// ---- files ----------------------------------------------------------------
/** A file bubble: icon, name, size, and one action. Rendered like any other
 *  event so switching rooms replays it from the log. */
function appendFile(kind: 'me' | 'peer', env: FileEnv, ts: number, who?: string, au?: string) {
  const box = $('messages')
  const row = document.createElement('div'); row.className = 'mrow ' + (kind === 'me' ? 'out' : 'in')
  const bub = document.createElement('div'); bub.className = 'bubble'
  if (who && kind === 'peer') {
    const w = document.createElement('div'); w.className = 'b-who'; w.textContent = who; bub.appendChild(w)
  }
  if (env.re) bub.appendChild(quoteBlock(env.re))
  const wrap = document.createElement('div'); wrap.className = 'b-file' + (fileGone(env) ? ' gone' : '')
  const ico = document.createElement('span'); ico.className = 'f-ico'; ico.textContent = '📄'
  const info = document.createElement('div'); info.className = 'f-info'
  const name = document.createElement('div'); name.className = 'f-name'; name.textContent = env.name; name.title = env.name
  const sub = document.createElement('div'); sub.className = 'f-sub'
  sub.textContent = humanSize(env.size) + (fileGone(env) ? ' · ' + tr('wygasł') : '')
  info.append(name, sub)
  const act = document.createElement('button'); act.className = 'f-act'
  // The buttons travel as one group: on a narrow bubble the group drops to a
  // second line instead of squeezing the name to one letter (index.html).
  const acts = document.createElement('div'); acts.className = 'f-acts'; acts.appendChild(act)
  // Icon and name are one unit too, so a wrap never tears the icon off its name.
  const head = document.createElement('div'); head.className = 'f-head'; head.append(ico, info)
  const direct = directBlobs.has(env)
  if (direct) {
    // Same bubble on both sides — name, size, when — and ONE action, the same
    // one every other file bubble has. It says "Zapisz" rather than "Pobierz"
    // because both sides already hold the bytes (the receiver from the channel,
    // the sender from the file it picked): nothing expires and nothing is
    // fetched. That difference in the word is the only difference left.
    //
    // There WAS an "Otwórz" here, opening the blob in a new tab. It died
    // silently in the packaged app — the webview hands every `window.open` to
    // the host as a new-window request and the shell installs no handler (see
    // `desk_open_url` in lib.rs, which exists because this trap had already
    // eaten two other buttons). It could not be routed through that command
    // either: it refuses anything that is not http/https, deliberately, and a
    // blob: URL means nothing outside the webview anyway. Reported on macOS
    // 2026-09-18; removed rather than left as a button that does nothing on
    // three platforms out of four. Opening a file without writing it to disk
    // stays on the list as a nice-to-have; doing it honestly needs either an
    // in-app viewer or a temporary file written by the host.
    //
    // Nothing is lost for a picture or a voice note: `paintPreview` drew those
    // inline and removed this button on sight, so it only ever survived on the
    // files it could not show.
    // The word carries the whole difference between the two ways a file can
    // arrive, and as grey text the size line swallowed it. A span rather than
    // the whole line: the size stays quiet, the transport is the news.
    sub.textContent = humanSize(env.size) + ' \u00b7 '
    const how = document.createElement('span'); how.className = 'f-direct'
    how.textContent = tr('bezpośrednio')
    sub.appendChild(how)
    act.textContent = tr('Zapisz')
    act.addEventListener('click', () => { void saveDirect(env, act) })
    fileEls.set(env, { act, sub })
    wrap.append(head, acts)
    bub.appendChild(wrap)
    paintPreview(env)   // a picture or a voice note shows inline, like a sent one does
  } else {
    // No cid yet means it is still being encrypted or uploaded: the button shows
    // that state instead of offering a download that cannot work. attachFile
    // updates these two elements as it goes, via `fileEls`.
    const pending = !env.cid
    if (pending) { act.textContent = tr('Wysyłam…'); act.disabled = true }
    else setFileAction(act, env)
    if (!pending) act.addEventListener('click', () => void downloadFile(env, act))
    fileEls.set(env, { act, sub })
    wrap.append(head, acts)
    bub.appendChild(wrap)
  }

  // An image gets a second, quieter action. Not a replacement for Download:
  // showing a picture and saving it are different wants, and folding them into
  // one button means one of the two is unavailable.
  if (!direct && isPreviewable(env.mime) && env.cid && !fileGone(env)) {
    if (previews.has(env)) {
      paintPreview(env) // a replay after switching rooms — already decrypted
    } else {
      const see = document.createElement('button')
      see.className = 'f-see'
      // "Show" for a picture, "Play" for a voice note — the button says what
      // pressing it does, and both mean the same fetch underneath.
      see.textContent = previewKind(env.mime) === 'audio' ? tr('Odtwórz') : tr('Pokaż')
      see.addEventListener('click', () => void revealImage(env, see))
      acts.insertBefore(see, act)
      fileEls.get(env)!.see = see
      // The setting, and the cap that keeps it honest: a fetch nobody asked for
      // must not be able to pull eighty megabytes because a `mime` said so.
      //
      // WARNING: It fetches; it does not PLAY. Having a voice note ready the instant
      // you press play is a convenience; having somebody's voice come out of
      // your machine because a message arrived is not, and the difference is
      // one argument rather than a second setting.
      if (kind === 'peer' && mediaAuto && env.size <= AUTO_MEDIA_MAX) {
        void revealImage(env, see, false)
      }
    }
  }

  // The caption goes through the SAME renderer as a message body — text nodes
  // and link arrows, never markup. A second way of showing user text is how the
  // two drift apart and one of them ends up interpreting something.
  if (env.body) {
    const cap = document.createElement('div'); cap.className = 'b-text b-caption'
    renderBody(cap, env.body)
    bub.appendChild(cap)
  }

  const meta = document.createElement('div'); meta.className = 'b-meta'; stampTime(meta, ts)
  // Delivery, the same contract a sentence gets. The engine has ALWAYS run it
  // for files -- the receiver confirms a `file` envelope exactly as it confirms
  // a `msg` (`lib/room.ts`), and `sendFile` tracks and re-sends it -- but
  // nothing here drew the marker, so `setDelivery` looked the id up in
  // `stateEls`, found nothing and returned. The whole mechanism was talking to
  // an empty room.
  //
  // The half that actually cost something: `setDelivery` is also what puts the
  // RESEND button behind a failure. The bytes stay in `resendable`, so a file
  // that did not arrive was one click from going again -- with nothing to
  // click. It simply vanished. (Reported 2026-09-19.)
  if (kind === 'me') {
    const st = document.createElement('span'); st.className = 'b-state'
    if (direct) {
      // A direct transfer knows MORE than an ack does. This bubble is built on
      // the sender's `done`, and that arrives because the RECEIVER sent DONE,
      // which it sends only once it holds every chunk (`lib/xfer.ts`). So it is
      // proof of the whole payload rather than receipt of one frame, and it is
      // already true when the bubble appears -- hence no "wysylam..." stage and
      // nothing for `setDelivery` to update later.
      st.textContent = tr(' · ✓ ') + tr('dostarczone')
      st.title = tr('Druga strona potwierdziła cały plik — inaczej transfer by się nie zakończył')
      st.dataset.settled = '1'
    } else {
      const l = pendingLabel()
      st.textContent = l.text; st.title = l.title; st.dataset.pending = '1'
    }
    meta.appendChild(st)
  }
  // Reactions need both halves: somewhere to draw them, and an entry in msgEls
  // so an incoming reaction can find this bubble. appendFile had neither, which
  // is why files could not be reacted to at all.
  const rx = document.createElement('div'); rx.className = 'b-reactions'
  bub.append(meta, rx)
  if (au) row.dataset.au = au
  row.appendChild(bub)
  wireBubbleId(row, env.id)
  box.appendChild(row)
  refreshJump()
}

/**
 * Make a file bubble a message that can be answered: an id is what a reaction
 * or a reply names, and a bubble without one is inert.
 *
 * All four halves are here because they drifted apart twice. A file we SEND is
 * drawn before its id exists — the id is minted by the send, which happens
 * after the encrypt and the upload — so the bubble was wired a second time
 * afterwards, by hand, and that copy attached the reaction BAR without the
 * reveal that shows it. The bar is `display:none` until a press adds `.tapped`
 * (attachReveal), so a file or a voice note you sent through the node carried a
 * reaction bar no press could ever open, while one you received was fine and a
 * direct transfer was fine. Reported 2026-09-14: "transfer via node i IPFS tez
 * ma miec reakcje - jak Transfer direct".
 *
 * Idempotent, because the sending path calls it twice by construction: once at
 * draw time with no id yet, once when the send returns one.
 */
function wireBubbleId(row: HTMLElement, id: string) {
  if (!id || row.dataset.mid === id) return
  const bub = row.querySelector('.bubble') as HTMLElement | null
  const rx = row.querySelector('.b-reactions') as HTMLElement | null
  if (!bub || !rx) return
  msgEls.set(id, rx)          // where an incoming reaction is drawn
  row.dataset.mid = id        // what a reply and a scroll-to-quote look for
  attachReactionBar(row, id)  // the controls
  attachReveal(row, bub)      // and the press that shows them
  // And the delivery marker, for the same reason the rest of this helper
  // exists: a file we send is drawn BEFORE its id is minted, so registering it
  // at draw time would file it under the empty string and every later
  // confirmation would miss it. A direct transfer's marker is already final
  // (`settled`) and no delivery event will ever name its id, so it stays out.
  const st = row.querySelector('.b-state') as HTMLElement | null
  if (st && !st.dataset.settled) stateEls.set(id, st)
  paintRoute(id)
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
const fileEls = new WeakMap<FileEnv, { act: HTMLButtonElement; sub: HTMLElement; see?: HTMLButtonElement }>()

const humanSize = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} kB` : `${n} B`

// ---- images in a conversation ---------------------------------------------
/**
 * **Showing an image is downloading it.** There is no cheaper version of this:
 * a file bubble holds a CID and a key, the bytes sit encrypted in the store,
 * and drawing the picture means fetching and decrypting exactly what Download
 * fetches and decrypts. Everything below follows from that one fact.
 *
 * - **A file we SENT previews for free.** We encrypted it, so the bytes are
 *   already in hand — no fetch, nothing to decide. That is also the case that
 *   matters most, because it is the pasted screenshot: you should see what you
 *   are about to send.
 * - **An incoming image waits for a click.** Drawing it by itself would have
 *   the app reach out to the store for every picture anyone sends, before the
 *   person has decided they want it — the same shape of thing link previews
 *   are refused for (see `linkify.ts`). It would also be *us* keeping a file
 *   alive that the store drops in minutes.
 * - **...unless the setting says otherwise**, which is off by default and capped:
 *   an automatic fetch is a fetch nobody asked for, so it must not be able to
 *   pull eighty megabytes because a `mime` said `image/`.
 *
 * WARNING: **SVG is not an image here.** Everything else in this list is a bitmap the
 * browser decodes; an SVG is a DOCUMENT, with its own reference machinery, and
 * `mime` is a string the SENDER chose. It stays an ordinary file — the same
 * fail-closed rule the link renderer uses for schemes it does not know.
 */
type PreviewKind = 'image' | 'audio' | null
const previewKind = (mime: string): PreviewKind =>
  mime.startsWith('image/') && mime !== 'image/svg+xml' ? 'image'
  : mime.startsWith('audio/') ? 'audio'
  : null
const isPreviewable = (mime: string) => previewKind(mime) !== null
/** What an automatic fetch may cost when nobody asked for it. A manual Show has
 *  no cap: that one WAS asked for. */
const AUTO_MEDIA_MAX = 2 * 1024 * 1024

/**
 * Envelope -> a blob URL for its decrypted bytes.
 *
 * Keyed by the envelope OBJECT, like `fileEls`, so a room replayed after a
 * switch draws the picture again without re-fetching, and nothing survives the
 * page — which is the same lifetime as the transcript it belongs to. The URLs
 * are deliberately not revoked while the session lives: a replay needs them,
 * and revoking on a room switch is how a bubble comes back broken.
 */
const previews = new WeakMap<FileEnv, string>()
/**
 * Files that came (or went) over the direct channel (`lib/xfer.ts`): the bytes
 * are in THIS tab and nowhere else, so Save writes what is already here rather
 * than fetching anything. Keyed by the envelope object like `previews`, and for
 * the same reason: the room log holds that object, so a replay finds the file
 * again. Holding the blob is also what tells the bubble renderer which of the
 * two kinds of file it is drawing.
 *
 * An in-memory file cannot outlive its bubble — the transcript dies with the
 * page and files are not pinnable — which is what makes a bubble honest here.
 */
const directBlobs = new WeakMap<FileEnv, Blob>()
/**
 * The platform's ways to save (lib/saveas.ts): the phone app's host, a picker
 * where there is one, the anchor elsewhere. `host` is a getter because the
 * shell says what it is only after startup (`initDesktop`).
 */
const saveEnv: SaveEnv = { ...browserSaveEnv(), get host() { return hostSaveRoute() } }
/** `beginSave` that reports a host failure on the button instead of throwing out of a click. */
async function openSink(name: string, btn: HTMLButtonElement): Promise<SaveSink | null> {
  try { return await beginSave(name, saveEnv) }
  catch (e: any) {
    ecLog('save failed: ' + (e?.message ?? e))
    const was = btn.textContent
    btn.textContent = tr('Błąd')
    setTimeout(() => { if (btn.textContent === tr('Błąd')) btn.textContent = was }, 5000)
    return null
  }
}

/**
 * Save a transferred file. Where to is asked FIRST — the click is the gesture
 * the picker wants — and a closed dialog is an answer, not an error. That
 * question is the whole point: before it, Save and Open did the same silent
 * download, which is what the remark was about.
 */
async function saveDirect(env: FileEnv, btn: HTMLButtonElement) {
  const blob = directBlobs.get(env)
  if (!blob) return
  const sink = await openSink(env.name, btn)
  if (!sink) return
  btn.disabled = true
  try { await sink.write(blob); btn.textContent = tr('Zapisano') }
  catch (e: any) { btn.textContent = tr('Błąd'); ecLog('save failed: ' + (e?.message ?? e)) }
  setTimeout(() => { btn.textContent = tr('Zapisz'); btn.disabled = false }, 5000)
}
/**
 * The bubble's message id, derived from the transfer id on BOTH sides. A
 * reaction or a reply names a message by id and the other side must hold a
 * bubble under the same one; the transfer id is the only value about a direct
 * file that both ends already share (every frame carried it). The `x` keeps
 * it out of the space of ordinary message ids.
 */
const xferMsgId = (id: number) => 'x' + (id >>> 0).toString(16).padStart(8, '0')
function directFileEnv(f: { name: string; size: number; mime: string }, blob: Blob, xferId: number, body?: string): FileEnv {
  const env = {
    v: 1, t: 'file', id: xferMsgId(xferId), ts: nowMs(), seq: 0,
    cid: '', name: f.name, size: f.size, mime: f.mime || 'application/octet-stream',
    key: '', chunk: 0, chunks: 0, alg: 'direct',
    // Same field a file sent through the store uses, so the bubble renderer
    // draws the caption without knowing which transport brought it.
    ...(body ? { body } : {}),
  } as unknown as FileEnv
  directBlobs.set(env, blob)
  // The object URL is made only for something that will actually be drawn.
  // It used to be made for every transfer, because the Open button read it;
  // with that button gone an unpreviewable file was minting a URL nobody would
  // ever read, and an object URL lives until the page does.
  if (isPreviewable(env.mime)) previews.set(env, URL.createObjectURL(blob))
  return env
}

/** Per identity, like every other stored preference. The key still says `img`
 *  because it was written before the setting covered sound too, and renaming it
 *  would silently turn the preference off for everybody who had set it. */
const mediaAutoKey = () => 'ec-autoimg-' + (session?.idKey ?? '')
let mediaAuto = false
function loadMediaAuto() {
  try { mediaAuto = localStorage.getItem(mediaAutoKey()) === '1' } catch { mediaAuto = false }
  const box = $('img-auto') as HTMLInputElement | null
  if (box) box.checked = mediaAuto
}
$('img-auto')?.addEventListener('change', (e) => {
  mediaAuto = (e.target as HTMLInputElement).checked
  try { localStorage.setItem(mediaAutoKey(), mediaAuto ? '1' : '0') } catch {}
})

/**
 * A voice note's player.
 *
 * Deliberately not `<audio controls>`. The native player is a different size,
 * shape and colour in every browser, it is the element a conversation shows
 * most often once people start speaking instead of typing, and half of its
 * controls (volume, download, playback speed menu) are noise inside a message
 * bubble. This is the same three things every messenger settles on: play, where
 * you are, how long it is.
 *
 * The `<audio>` element still does the work — it is just not what is on screen.
 */
function voicePlayer(url: string): HTMLElement {
  const wrap = document.createElement('div'); wrap.className = 'b-voice'
  const audio = new Audio(url)
  // The bytes are already local — a blob URL — so there is nothing to save by
  // loading them lazily, and 'auto' means the whole take is decoded before the
  // first press rather than while it plays.
  audio.preload = 'auto'
  const play = document.createElement('button')
  play.className = 'v-play'; play.type = 'button'
  play.title = tr('Odtwórz'); play.setAttribute('aria-label', tr('Odtwórz'))
  const icon = (playing: boolean) => playing
    ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
    : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>'
  play.innerHTML = icon(false)
  const bar = document.createElement('div'); bar.className = 'v-bar'
  const fill = document.createElement('div'); fill.className = 'v-fill'
  bar.appendChild(fill)
  const time = document.createElement('span'); time.className = 'v-time'; time.textContent = '0:00'
  wrap.append(play, bar, time)

  const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

  /**
   * How long is it?
   *
   * WARNING: Nothing here seeks past the end any more. That trick — set `currentTime`
   * to 1e101 and read the duration on the first `timeupdate` — is a race, and it
   * lost. The engine answers while it is still seeking, so a seven-second note
   * came back as two seconds in one browser and as twenty hours in the desktop's
   * WebKitGTK, and the bar, the countdown and the seek all inherited the lie.
   *
   * Three sources, in the order they can be trusted:
   *
   * 1. **The file.** Our own recordings now carry their length in the container
   *    (`voice.ts` measures at Stop, `webm.ts` writes it), and an ordinary audio
   *    file someone sends has always had one.
   * 2. **`decodeAudioData`** — the sample count IS the length. It costs a decode
   *    of the whole blob, so it only runs when the file answered nothing.
   * 3. **Playback.** If the sound runs past what we believe, the belief was
   *    wrong and it is corrected where it is disproved.
   *
   * Until one of them answers, the label counts UP and the bar stays empty. An
   * unknown length shown as unknown is a small ugliness; an invented one makes
   * every part of the player wrong at once, which is what was reported.
   */
  let length = 0
  const setLength = (secs: number) => {
    if (!Number.isFinite(secs) || secs <= 0 || Math.abs(secs - length) < 0.01) return
    length = secs
    paint()
  }
  let decoding = false
  const measure = async () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) return setLength(audio.duration)
    if (decoding) return
    decoding = true
    try {
      const Ctx = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext
      if (!Ctx) return
      const bytes = await (await fetch(url)).arrayBuffer()
      const ctx = new Ctx()
      // Closed straight away: a page holds only a handful of audio contexts, and
      // a conversation can hold a great many voice notes.
      try { setLength((await ctx.decodeAudioData(bytes)).duration) } finally { void ctx.close?.() }
    } catch { /* length stays unknown, and the label says so by counting up */ }
  }

  /**
   * Paint on every frame WHILE PLAYING, not on `timeupdate`.
   *
   * Reported as "the playback stutters, there is no smoothness" — and it was the
   * bar, not the sound. `timeupdate` fires about four times a second, so the
   * fill advanced in visible steps while the audio ran perfectly. A progress
   * bar is an animation; it belongs on the frame clock.
   */
  let raf = 0
  const paint = () => {
    fill.style.width = length ? `${Math.min(100, (audio.currentTime / length) * 100)}%` : '0'
    time.textContent = clock(length ? (audio.paused ? length : length - audio.currentTime) : audio.currentTime)
  }
  const follow = () => {
    // Source 3: the sound is past where we thought it ended, so it does not end
    // there. Correcting here means one wrong-looking second, not a whole note
    // played against a bar that filled early and stopped.
    if (length && audio.currentTime > length) setLength(audio.currentTime)
    paint()
    raf = audio.paused ? 0 : requestAnimationFrame(follow)
  }
  const stopFollowing = () => { if (raf) cancelAnimationFrame(raf); raf = 0 }

  audio.addEventListener('loadedmetadata', () => void measure())
  audio.addEventListener('durationchange', () => setLength(audio.duration))
  audio.addEventListener('ended', () => {
    stopFollowing()
    // Where the sound actually ran out is the last word on how long it was.
    if (audio.currentTime > 0) setLength(audio.currentTime)
    play.innerHTML = icon(false); audio.currentTime = 0; paint()
  })
  audio.addEventListener('pause', () => { stopFollowing(); paint() })
  play.addEventListener('click', () => {
    if (audio.paused) {
      void audio.play().catch(() => {})
      play.innerHTML = icon(true)
      follow()
    } else { audio.pause(); play.innerHTML = icon(false) }
  })
  bar.addEventListener('click', (e) => {
    // WARNING: This called `total()`, a function deleted in the same commit that wrote
    // the line — so since 0.3.11 a click on the bar threw a ReferenceError
    // instead of seeking. Nothing caught it: the build strips types with Babel
    // and never typechecks, so an undefined name is a runtime surprise.
    if (!length) return
    const r = bar.getBoundingClientRect()
    audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * length
    paint()
  })
  paint()
  return wrap
}

/**
 * Draw the picture into a bubble that has one, and take the Show button away.
 *
 * Called both when the bytes arrive and from `appendFile` on a replay, so the
 * two paths cannot draw it differently.
 */
function paintPreview(env: FileEnv): HTMLElement | undefined {
  const url = previews.get(env); if (!url) return
  const els = fileEls.get(env); if (!els) return
  const bub = els.act.closest('.bubble') as HTMLElement | null
  const wrap = els.act.closest('.b-file') as HTMLElement | null
  if (!bub || !wrap || bub.querySelector('.b-thumb, .b-voice')) return
  const kind = previewKind(env.mime)
  let el: HTMLElement
  if (kind === 'audio') {
    el = voicePlayer(url)
  } else {
    const img = document.createElement('img')
    img.className = 'b-thumb'; img.alt = env.name; img.src = url
    el = img
  }
  // Above the file row, so the name, the size and Download stay exactly where
  // they were — what is added to the bubble does not replace it.
  bub.insertBefore(el, wrap)
  els.see?.remove()
  els.see = undefined
  refreshJump()
  return el
}

/** Fetch and decrypt one file's bytes. The single place that does it, so
 *  Download and Show cannot disagree about what a file is. */
async function fetchPlain(env: FileEnv): Promise<Uint8Array> {
  // The envelope is the store's business, not the crypto's: strip it here and
  // decryptBytes goes on seeing exactly the bytes it produced.
  const cipher = unwrapBlob(await getBlob(env.cid))
  return await decryptBytes(unb64(env.key),
    { alg: env.alg as any, chunk: env.chunk, chunks: env.chunks, size: env.size }, cipher)
}

/**
 * Reveal an incoming image: the same fetch a download does, ending in a picture
 * rather than a file on disk.
 */
async function revealImage(env: FileEnv, btn: HTMLButtonElement, play = true) {
  if (previews.has(env)) { paintPreview(env); return }
  btn.disabled = true; btn.textContent = tr('Pobieram…')
  try {
    const plain = await fetchPlain(env)
    previews.set(env, URL.createObjectURL(new Blob([plain as any], { type: env.mime })))
    const el = paintPreview(env)
    // Pressing Play and then having to press play again is a bug, not caution:
    // the click WAS the gesture, and it is the gesture browsers ask for. The
    // player draws its own button, so the way to start it is to press that.
    if (play) (el?.querySelector('.v-play') as HTMLButtonElement | null)?.click()
  } catch (e: any) {
    // Past its lifetime ANY failure is expiry — the same reading `downloadFile`
    // makes, and for the same reason: the store hunts the public network for a
    // file it swept, so what comes back is a timeout, not a 404.
    const gone = e?.name === 'ExpiredError' || fileGone(env)
    btn.disabled = false
    btn.textContent = gone ? tr('Wygasł') : tr('Pokaż')
    if (gone) { btn.disabled = true; btn.closest('.b-file')?.classList.add('gone') }
    else ecLog('image preview failed: ' + (e?.message ?? e))
  }
}

/**
 * Encrypt a file, upload the ciphertext, and send the metadata down whichever
 * conversation is on screen.
 *
 * The order is the point: the bytes are ciphertext before they leave the
 * device, and everything needed to read them — key, name, type, chunking —
 * travels in the envelope over the ratchet or a group sender key. The store
 * gets a nameless blob and its size, and holds it for minutes.
 */
async function attachFile(f: File, after?: Promise<unknown>) {
  const gid = activeGid
  const room = gid ? null : activeRoom()
  if (!gid && !room?.conv) return
  if (f.size > MAX_FILE) { toast(tr('Plik jest za duży — limit to {mb} MB', { mb: Math.floor(MAX_FILE / 1024 / 1024) })); return }

  // Whatever is in the composer travels WITH the file, as one message. Taken
  // and cleared now, before the encrypt/upload await, so what is sent is what
  // the user saw when they picked the file — not whatever they typed since.
  const inp = $('msg-input') as HTMLTextAreaElement
  // A caption is a body like any other, so its mentions close here too — a file
  // sent with "@Ala popatrz" must reach Ala the same way the sentence alone would.
  // A caption travels inside the file's envelope, so it meets the same ceiling.
  if (!fitsOnWire(inp.value)) {
    toast(tr('Podpis jest za długi o {n} — skróć go albo wyślij osobno', { n: kb(overBy(inp.value)) }))
    return
  }
  const gm = gid ? groupsUI.get(gid) : null
  const caption = gm
    ? closeMentions(inp.value.trim(), gm.members.filter((m) => m.pub !== session?.pub).map((m) => ({ pub: m.pub, name: memberName(m.pub) })), mentionPicks)
    : inp.value.trim()
  mentionPicks.clear()
  inp.value = ''; growComposer(); paintLength()
  // A file answers a message the same way a sentence does — same field, spent
  // here so the bar is gone by the time the upload starts.
  const re = takeReply()

  // The bubble appears NOW, before any work — on an 80 MB file the encrypt and
  // upload take long enough that a line of system text is indistinguishable
  // from a freeze. It is the same bubble that will hold the finished file; only
  // its action changes, from a progress label to Download.
  const pending: FileEnv = {
    v: 1, t: 'file', id: '', ts: nowMs(), seq: 0,
    cid: '', name: f.name, size: f.size, mime: f.type || 'application/octet-stream',
    key: '', chunk: 0, chunks: 0, alg: '',
    ...(caption ? { body: caption } : {}),
    ...(re ? { re } : {}),
  } as unknown as FileEnv
  // A file we are sending previews for FREE: we hold the plaintext, so there is
  // no fetch to justify and nothing to ask. Registered before the bubble is
  // recorded, so the picture is there in the same frame the bubble is.
  if (isPreviewable(pending.mime)) previews.set(pending, URL.createObjectURL(f))
  if (gid) recordGroup(groupsUI.get(gid)!, { t: 'file', kind: 'me', ts: pending.ts, file: pending, au: session?.pub })
  else record(room!, { t: 'file', kind: 'me', ts: pending.ts, file: pending, au: session?.pub })

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
      ...(re ? { re } : {}),
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
    // Files of one pick upload side by side but are SENT in pick order, so a
    // small one that finished first does not overtake a bigger one before it.
    if (after) await after.catch(() => {})
    pending.id = gid ? await groupsUI.get(gid)!.room!.sendFile(meta) : room!.conv!.sendFile(meta)
    // The bubble was drawn before the message had an id — it could not have
    // one, the send had not happened — so it is wired now, through the same
    // helper the draw path uses. Doing it by hand here is what left a file we
    // sent with a reaction bar and no way to open it.
    const idRow = fileEls.get(pending)?.act.closest('.mrow') as HTMLElement | null
    if (idRow) wireBubbleId(idRow, pending.id)
    show(tr('Pobierz'), humanSize(f.size))
    const els = fileEls.get(pending)
    if (els) {
      // Through setFileAction, not by hand. The receiver's bubble goes through
      // it at draw time and gets the one thing that matters here: a timer armed
      // for the moment the file expires. The sender's bubble used to set the
      // label and the handler directly, so nothing was ever watching its clock
      // and "Pobierz" stayed alive for good — pressed after five minutes it
      // learned from the store that the file was gone (reported 2026-09-14).
      setFileAction(els.act, pending)
      els.act.onclick = () => void downloadFile(pending, els.act)
    }
    // `appendFile` drew this bubble while the file was still uploading, and a
    // file with no cid has no preview to draw — so the sender was left with a
    // voice note they could not play back and a picture they could not see
    // until they switched rooms and came back (reported 2026-09-07). The bytes
    // never left this device: the player goes in now, with no fetch to make.
    paintPreview(pending)
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
  // Where to, BEFORE the fetch: the picker wants the click it was born from,
  // and the file is fetched and decrypted first. Asked afterwards it would
  // refuse, and the file would land in Downloads without a word.
  const sink = await openSink(env.name, btn)
  if (!sink) return
  btn.disabled = true; btn.textContent = tr('Pobieram…')
  // The same evidence line on the RECEIVING side, which is where it is most
  // useful: this is a file someone else encrypted, and the key arrived over the
  // ratchet rather than being ours to begin with.
  ecLog('file evidence · ' + JSON.stringify({
    cid: env.cid, name: env.name, size: env.size, mime: env.mime,
    key: env.key, chunk: env.chunk, chunks: env.chunks, alg: env.alg,
  }), 'debug')
  try {
    const plain = await fetchPlain(env)
    await sink.write(new Blob([plain as any], { type: env.mime }))
    btn.textContent = tr('Zapisano')
    // Saving once must not be the end of it: browsers put downloads in places
    // people do not find, and a second copy is a reasonable thing to want. The
    // label parks on "Zapisano" long enough to be read, then returns to whatever
    // the file's own state says — expiry included, since it may have run out
    // while the bubble sat there.
    setTimeout(() => setFileAction(btn, env), 5000)
  } catch (e: any) {
    // The picker created an empty file the moment a name was chosen; a fetch
    // that failed must not leave a zero-byte one where the person looked.
    void sink.discard()
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

// ---- a newer version ------------------------------------------------------
/**
 * Offer an update, and only where it can actually be taken.
 *
 * Not once per launch any more — that design met close-to-tray and lost: an
 * app built to live for WEEKS in the tray (no store-and-forward, the process
 * is meant to stay) asked about updates fifteen seconds into its life and
 * never again, so the machines that most needed the news were exactly the
 * ones that never got it. Reported live: a .deb launched minutes before the
 * release was published stayed silent about it indefinitely, and "I
 * restarted it" meant the window, not the process — X hides to the tray.
 * Now: at launch, every six hours after, and on coming back from the tray
 * (hourly at most — that is the moment somebody is actually looking).
 *
 * The restraints that stay, each of them a decision:
 *
 * - **It waits.** The first seconds of a launch are the handshake and the
 *   contact list; a dialog over that is a dialog in the way of the thing the
 *   app is for.
 * - **A failed check says NOTHING.** No network, or a release still in draft,
 *   is not news — and "could not check for updates" is a sentence that has
 *   never helped anybody. It goes to the debug log and no further.
 * - **A distro package is told, not updated.** `.deb` belongs to the package
 *   manager; the updater would download a bundle and fail at the last step. So
 *   that case gets the version, a link, and no promise.
 * - **"Później" means later.** A version the person has already answered
 *   about is not offered again this session — a six-hour nag loop about the
 *   same release would teach people to dismiss the dialog unread. The next
 *   LAUNCH asks again, which is what the old toast always promised.
 */
const RELEASES_URL_BASE = 'https://github.com/encedo/encedo-chat/releases'

/** Versions already answered about this session — see "Później" above. */
const answeredUpdates = new Set<string>()
/** One offer at a time: a periodic tick must not stack a second ask() onto
 *  the modal while the first is still open (the listeners would shred each
 *  other), and must not race a download already in progress. */
let updateBusy = false

async function offerUpdate() {
  if (updateBusy) return
  updateBusy = true
  try { await offerUpdateInner() } finally { updateBusy = false }
}

async function offerUpdateInner() {
  const kind = await updateKind()
  if (kind === 'web' || kind === 'store') return

  let info
  try { info = await updateCheck() } catch (e: any) {
    ecLog('update check failed: ' + (e?.message ?? e), 'debug'); return
  }
  if (!info || answeredUpdates.has(info.version)) return

  if (kind === 'system') {
    // The exact version's page, not /latest: its download section is the
    // thing the person was just told about, and /latest can have moved
    // between the check and the click.
    await ask(tr('Jest nowa wersja {v}', { v: info.version }),
      tr('Ta kopia pochodzi z pakietu systemowego, więc nie podmieni się sama. Nową wersję trzeba pobrać.'),
      tr('Pobierz'), undefined, `${RELEASES_URL_BASE}/tag/v${info.version}`, tr('Później'))
    // Either way answered: they went to the download page, or they said
    // later. Both mean "stop asking about this one until the next launch".
    answeredUpdates.add(info.version)
    return
  }

  // Ask, then LOOK AGAIN before fetching. A person reads "0.5.72 is available"
  // and presses the button whenever they get to it — by which time 0.5.73 and
  // 0.5.74 may have shipped, and the download command fetches whatever is
  // newest. Until 2026-09-14 that installed a version nobody had been shown,
  // and the next dialog went on naming the old one. So: if the release moved,
  // the dialog comes back with what is actually there, and only a click on a
  // version that is still the current one starts a download.
  for (;;) {
    const { ok } = await ask(tr('Jest nowa wersja {v}', { v: info.version }),
      tr('Pobrać ją teraz? Instalacja i restart przyjdą osobno, kiedy powiesz.'),
      tr('Pobierz'), undefined, undefined, tr('Później'))
    if (!ok) { answeredUpdates.add(info.version); return }
    let again: typeof info | null
    try { again = await updateCheck() } catch { again = null }
    if (!again) { toast(tr('Aktualizacja zniknęła z serwera — zaproponuję po następnym uruchomieniu')); return }
    if (again.version === info.version) break
    // "Later" said to THIS newer one earlier in the session still holds.
    if (answeredUpdates.has(again.version)) return
    info = again
  }

  // The bar exists because its absence was the reported bug: between the click
  // and the restart 0.5.16 showed NOTHING, and a person watching nothing
  // assumes a dead button. Progress is polled off the host (two atomics on the
  // other side) — no event channel, same two-sided ask as every other command.
  const bar = $('upd-bar'), txt = $('upd-txt'), fill = $('upd-fill')
  bar.hidden = false
  fill.style.width = '0%'
  txt.textContent = tr('Pobieram aktualizację…')
  const poll = setInterval(() => {
    void updateProgress().then(({ got, total }) => {
      if (total) {
        const pct = Math.min(100, Math.round((got / total) * 100))
        fill.style.width = pct + '%'
        txt.textContent = tr('Pobieram aktualizację…') + ' ' + pct + '%'
      } else if (got) {
        txt.textContent = tr('Pobieram aktualizację…') + ' ' + (got / 1048576).toFixed(1) + ' MB'
      }
    }).catch(() => {})
  }, 200)

  let fetched = ''
  try { fetched = await updateDownload() } catch (e: any) {
    // The app is still the old version and still working, so this is a toast
    // and not a stop.
    clearInterval(poll)
    bar.hidden = true
    ecLog('update download failed: ' + (e?.message ?? e))
    toast(tr('Nie udało się zaktualizować — pobierz nową wersję ręcznie'))
    return
  }
  clearInterval(poll)
  fill.style.width = '100%'
  txt.textContent = tr('Pobrane.')
  setTimeout(() => { bar.hidden = true }, 600)

  // The restart is the person's call, not the download's side effect. The
  // dialog names what is ON DISK — the version the host reported fetching —
  // and says so when that is not the one that was shown: the window between
  // the re-check above and the download is seconds, but it is not zero.
  const got = fetched || info.version
  const title = fetched && fetched !== info.version
    ? tr('Pobrana wersja {v} — nowsza niż pokazana {shown}', { v: fetched, shown: info.version })
    : tr('Aktualizacja {v} pobrana', { v: got })
  const go = await ask(title,
    tr('Zainstalować i uruchomić ponownie teraz?'),
    tr('Uruchom ponownie'), undefined, undefined, tr('Później'))
  if (!go.ok) { answeredUpdates.add(got); toast(tr('Dobrze — zaproponuję znów po następnym uruchomieniu.')); return }
  try { await updateApply() } catch (e: any) {
    ecLog('update install failed: ' + (e?.message ?? e))
    toast(tr('Nie udało się zaktualizować — pobierz nową wersję ręcznie'))
  }
}

// ---- an AppImage that is installed nowhere --------------------------------
/**
 * GNOME draws the dock icon and the menu entry from an INSTALLED .desktop
 * file; the AppImage carries its own inside, where the system never looks. So
 * an AppImage run from Downloads wears a generic gear icon and is in no menu —
 * reported as a bug, reasonably. On a yes the host moves the file to
 * ~/Applications and writes the entry + icon; a no with the checkbox is
 * remembered for good, a plain no is asked again next launch.
 */
const APPIMAGE_DECLINED_KEY = 'ec-appimage-declined'

async function offerAppimageInstall() {
  try { if (localStorage.getItem(APPIMAGE_DECLINED_KEY) === '1') return } catch {}
  if (await appimageStatus() !== 'offer') return
  const a = await ask(tr('Zainstalować onchato?'),
    tr('Plik AppImage zostanie przeniesiony do katalogu Applications w Twoim folderze domowym, a onchato pojawi się w menu aplikacji z właściwą ikoną.'),
    tr('Zainstaluj'), tr('Nie pytaj więcej'), undefined, tr('Nie teraz'))
  if (!a.ok) {
    if (a.remember) { try { localStorage.setItem(APPIMAGE_DECLINED_KEY, '1') } catch {} }
    return
  }
  try {
    await appimageInstall()
    toast(tr('Zainstalowano — onchato znajdziesz teraz w menu aplikacji. Ikona okna dopasuje się od następnego uruchomienia.'))
  } catch (e: any) {
    ecLog('appimage install failed: ' + (e?.message ?? e))
    toast(tr('Nie udało się zainstalować — aplikacja działa dalej z obecnego miejsca.'))
  }
}

// Chained, not parallel: both talk through the one `ask` modal, and two
// dialogs racing for it would tear each other's listeners down.
if (isDesktopShell()) {
  setTimeout(() => void offerAppimageInstall().then(() => offerUpdate()), 15_000)
  // The re-checks a tray-resident process needs (see offerUpdate's note):
  // every six hours flat, and on coming back into view — the tray reveal and
  // the minimize both surface here as visibilitychange — at most hourly, so
  // stepping out for coffee does not turn the badge click into a dialog.
  // Seeded "now": the launch check above already covers the first hour.
  setInterval(() => void offerUpdate(), 6 * 3600_000)
  let lastRevealCheck = Date.now()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - lastRevealCheck < 3600_000) return
    lastRevealCheck = Date.now()
    void offerUpdate()
  })
}

// ---- a newer WEB bundle ---------------------------------------------------
/**
 * The browser tab is the platform this product asks people to LEAVE OPEN — no
 * store-and-forward, a closed tab is unreachability — so "nobody sits in a
 * browser that long" is exactly backwards here, and a week-old tab runs a
 * week-old engine long after the host redeployed. That is not cosmetic: a
 * protocol cutover (the §5.4 per-pair rotation was one) leaves a stale tab
 * unable to meet an updated peer, with nothing anywhere saying why.
 *
 * Detection needs no infrastructure the deploy does not already have: bundle
 * names carry a content hash and index.html is served with a short cache, so
 * comparing the hash a fresh index.html names with the one this tab is
 * actually running answers "am I stale" in one no-store fetch. A failed fetch
 * says nothing (the updater's restraint, same reason); a dev build has no
 * hash in its bundle name and opts out via `runningBundleHash === null`.
 *
 * A banner, not a modal, and never a forced reload: reloading kills the
 * session's transcripts and ratchets BY DESIGN, so the moment belongs to the
 * person. Dismissing silences that hash — a later deploy banners again.
 */
const runningBundleHash = (() => {
  for (const s of document.querySelectorAll<HTMLScriptElement>('script[src]')) {
    const m = s.src.match(/app\.([a-f0-9]+)\.bundle\.js/)
    if (m) return m[1]
  }
  return null
})()
let webUpdOffered: string | null = null
let webUpdDismissed: string | null = null

async function checkWebUpdate() {
  if (!runningBundleHash) return
  let html = ''
  try {
    const r = await fetch('index.html', { cache: 'no-store' })
    if (!r.ok) return
    html = await r.text()
  } catch { return }
  const m = html.match(/app\.([a-f0-9]+)\.bundle\.js/)
  if (!m || m[1] === runningBundleHash || m[1] === webUpdDismissed) return
  webUpdOffered = m[1]
  $('web-upd').hidden = false
}

if (!isDesktopShell()) {
  // The desktop cadence, for the same reason: launch (a restored tab can
  // come back from cache already stale), every six hours, and on coming
  // back into view at most hourly.
  setTimeout(() => void checkWebUpdate(), 15_000)
  setInterval(() => void checkWebUpdate(), 6 * 3600_000)
  let lastTabCheck = Date.now()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - lastTabCheck < 3600_000) return
    lastTabCheck = Date.now()
    void checkWebUpdate()
  })
  $('web-upd-go')?.addEventListener('click', () => location.reload())
  $('web-upd-x')?.addEventListener('click', () => {
    webUpdDismissed = webUpdOffered
    $('web-upd').hidden = true
  })
}

// The shell starts the window HIDDEN so nobody sees the webview's white
// pre-paint (reported as a white or half-white flash at every launch of a
// dark desktop). Map it the moment this script runs: the bundle is deferred,
// so the document is parsed and the inline stylesheet applied by now — the
// first frame the compositor draws is already theme-correct. An animation
// frame was the obvious "after first paint" signal and the wrong one: a
// HIDDEN WebKitGTK window produces no frames, so the ping sat waiting for
// the shell's watchdog — reported as the app taking two seconds to appear.
// The watchdog stays, for a bundle that breaks before this line.
if (isDesktopShell()) showWindow()

// Every outward anchor in the desktop shell goes to the system browser.
// The webview turns `target="_blank"` into a new-window request for the host,
// no handler is installed for those, and the click DIES SILENTLY — which is
// what the .deb's update-download button did. Capture phase, so the anchors'
// own listeners (closing the ask modal, say) still run; the mobile shell is
// left to its platform, checked at click time because the platform answer
// arrives after this listener is registered.
if (isDesktopShell()) document.addEventListener('click', (e) => {
  if (isMobileShell()) return
  const a = (e.target as HTMLElement | null)?.closest?.('a[target="_blank"]') as HTMLAnchorElement | null
  if (!a?.href || !/^https?:/i.test(a.href) || a.dataset.invite) return
  e.preventDefault()
  openExternal(a.href)
}, true)
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
/** The roster a mention is resolved against: the group on screen, or nobody.
 *  A 1:1 has no roster and therefore no mentions — `@ala#3a7f1c02` is just what
 *  the other person typed. */
const mentionRoster = (): { pub: string }[] => (activeGid ? groupsUI.get(activeGid)?.members : null) ?? []

/**
 * Draw the mentions in a plain piece of a message.
 *
 * The chip carries MY name for that key (`memberName`), never the name that
 * travelled — see `lib/mentions.ts` for why that is the whole point. A hint
 * that is not exactly one member of this group stays the text it arrived as,
 * so no message can stage the presence of somebody who is not here.
 */
function renderMentions(into: HTMLElement, text: string) {
  const pubs = mentionRoster().map((m) => m.pub)
  for (const part of splitByMentions(text)) {
    const m = part.mention
    const pub = m && pubs.length ? resolveMention(m.hint, pubs) : null
    if (!pub) { into.appendChild(document.createTextNode(part.text)); continue }
    const me = pub === session?.pub
    const chip = document.createElement('span')
    // `.you`, not `.me`: the sidebar's own `.me` row is a flex box with padding,
    // and an unscoped class name would have handed all of it to this chip — it
    // did, and the chip came out as a bar across the bubble. Fourth time this
    // stylesheet has punished a name that was already taken.
    chip.className = 'mention' + (me ? ' you' : '')
    // textContent, like every other piece of a body: a mention is not markup.
    chip.textContent = '@' + (me ? (session?.handle || tr('Ty')) : memberName(pub))
    chip.title = me
      ? tr('To Ty — ktoś zwrócił się do Ciebie ({hint})', { hint: m!.hint })
      : tr('Wzmianka o {name} ({hint})', { name: memberName(pub), hint: m!.hint })
    into.appendChild(chip)
  }
}

function renderBody(into: HTMLElement, text: string) {
  for (const part of splitByLinks(text)) {
    // Mentions are looked for only OUTSIDE the links: `.../@ala#3a7f1c02` is a
    // fragment of somebody's URL, not a person in this conversation.
    if (!part.link) renderMentions(into, part.text)
    else into.appendChild(document.createTextNode(part.text))
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
    // An invite to THIS app is not a way out of it. It opened a new tab like
    // any other link, and on an iPhone that cost a conversation (2026-09-25:
    // "cos kliknalem i wcielo konwersacje") - the old tab went to the
    // background where Safari may drop it, or the new tab signed in and the
    // duplicate-window rule closed both. It opens the add-contact window here,
    // with nothing to warn about, since nothing is left.
    const inv = ownInvite(l.href)
    if (inv) {
      a.dataset.invite = '1' // the desktop shell's link catcher leaves it alone
      a.title = tr('Dodaj kontakt z tego zaproszenia')
      a.addEventListener('click', (e) => { e.preventDefault(); void showInvite(inv) })
      into.appendChild(a)
      continue
    }
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

/**
 * Did somebody just send us something?
 *
 * ONE rule, because the two places that ask were three lines apart and gave
 * different answers: the banner counted a file as an arrival and the unread
 * pill did not, so a file sent to a background room notified and then left the
 * contact list looking untouched (reported 2026-09-18). A file IS a message
 * here — it is how a photo, a scan or a voice note travels — and the only
 * thing that differs is what its bubble draws.
 */
const isArrival = (ev: Ev): boolean =>
  (ev.t === 'msg' || ev.t === 'file') && ev.kind === 'peer'

/** Record one event on a room's log; render it if that room is on screen,
 *  otherwise (background) just count it and light the dot. Replaying the log
 *  through applyEv reconstructs the transcript exactly. */
const record = (room: Room, ev: Ev) => {
  room.log.push(ev); if (room.log.length > LOG_CAP) room.log.shift()
  if (isViewing(room)) applyEv(ev)
  else if (isArrival(ev)) { room.unseen++; renderContacts() }
  // Independent of which room is on screen: what decides a notification is
  // whether the WINDOW is, and an open room in a hidden window is still missed.
  if (isArrival(ev)) notifyArrival(ev, { pub: room.contact.pub, name: room.contact.name })
}
function applyEv(ev: Ev) {
  if (ev.t === 'msg') appendMsg(ev)
  else if (ev.t === 'react') addReaction(ev.id, ev.emoji)
  else if (ev.t === 'delivery') setDelivery(ev.id, ev.state, ev.ms)
  else if (ev.t === 'file') appendFile(ev.kind, ev.file, ev.ts, ev.who, ev.au)
  else if (ev.t === 'pinhdr') {
    const n = roomPins(pinRoomId()).length
    if (n) {
      const s = document.createElement('div'); s.className = 'sysline pinhdr'
      s.textContent = tr('📌 Przypięte ({n})', { n })
      $('messages').appendChild(s)
    }
  }
  else appendSys(ev.text, ev.sid)
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
  if (!sameTarget) stashDraft() // belongs to the room being LEFT, so before the switch
  activePub = pub; activeGid = null // a 1:1 takes the screen — no group is active
  if (!sameTarget) { clearComposer(); restoreDraft() }
  $('members-cluster').hidden = true; $('members-pop').hidden = true // group-only UI
  closeEmojiPop() // the transcript is about to be replayed — its anchor is going away
  room.unseen = 0
  $('chat-empty').hidden = true; $('chat-view').hidden = false
  showChatPane(true)
  focusComposer() // AFTER the pane is on screen — see the note on focusComposer
  $('peer-avatar').textContent = initials(room.contact.name)
  $('peer-name').textContent = room.contact.name
  // The peer is identified the same way we identify ourselves: 8-byte
  // fingerprint (comparable out of band) plus the HSM key id when it has one.
  const peerFp = fpCache.get(room.contact.pub) ?? await fingerprint(room.contact.pub)
  fpCache.set(room.contact.pub, peerFp)
  // The fingerprint is NOT repeated in Settings: it is already on the contact
  // row and in the header's tooltip, and a third copy under "Sesja" told you
  // nothing you could act on there (the user's call). `peerFp` stays — the
  // tooltip below is what it is for.
  // The name leads the tooltip now that the header can cut it short; the
  // fingerprint (the out-of-band MITM check) follows, as before.
  $('peer-name').title = `${room.contact.name} · ` + tr('🔑 ') + peerFp + (room.contact.kid ? ` · KID ${room.contact.kid}` : '')
  $('sess-peerid').textContent = room.conv ? room.conv.peerId.slice(0, 16) + '…' : '…'
  // Rebuild the transcript from the log; the module render state (msgEls/stateEls)
  // now describes this room.
  // Read what was kept BEFORE the replay: the pins go to the head of the log, so
  // the replay itself puts them at the top with no special case.
  await loadPins(pub, room.log)
  $('messages').innerHTML = ''; msgEls.clear(); stateEls.clear(); setTyping(false); cancelReply(); cancelEdit()
  for (const ev of room.log) applyEv(ev)
  paintSecurity(room); paintTransport(room); paintStatus(); paintKnockButton()
  startRotation(); renderContacts()
  void syncPresence() // foreground changed → light-watch the contact we just left
  void room.conv?.refresh() // re-announce / flush pending — cheap, no teardown
}

/**
 * One line for a peer that keeps coming and going, not one line per bounce.
 *
 * Reported from a desktop while a phone was being tested in the background:
 *
 *     antek1 left / antek1 w pokoju / antek1 left / antek1 w pokoju / ...
 *
 * and that was only a fragment. Nothing was malfunctioning — a phone that the
 * system puts to sleep really does stop announcing and really does come back,
 * so each transition was true. But a transcript is a record of a conversation,
 * and forty true lines about the same radio drown it.
 *
 * So the FIRST change still gets its own line, exactly as before. A second
 * change soon after rewrites that line into what is actually going on, and
 * counts. Once things settle for a few minutes the next change starts a fresh
 * line again — the collapse is about a burst, not about hiding presence.
 */
const FLAP_WINDOW_MS = 5 * 60_000

function notePresenceLine(room: Room, label: string) {
  const now = nowMs()
  const last = room.presenceLine
  if (last && now - last.at < FLAP_WINDOW_MS) {
    last.at = now
    last.flaps++
    last.ev.text = tr('{name} — połączenie się rwie: wchodzi i wychodzi ({n}×)',
      { name: room.contact.name, n: last.flaps + 1 })
    if (isViewing(room)) repaintSys(last.ev)
    return
  }
  const line: Ev = { t: 'sys', text: `${room.contact.name} ${label}`, sid: 'p' + now.toString(36) }
  record(room, line)
  room.presenceLine = { ev: line as { t: 'sys'; text: string; sid?: string }, at: now, flaps: 0 }
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
      directOnly: directOnly(),
      makeLink: linkBuilder(),
      // STUN lives on the nodes, so the servers are whichever nodes this client
      // dials — no second list to drift, and editing Settings -> Network moves
      // this with it (`lib/ice.ts`).
      iceServers: iceServersFor(location.search, chosenRelays()),
      onWebrtcState: (s) => noteTransport(room, s),
      onXfer: (e) => onXferEvent(room, e),
      onSecurity: (peer, state) => noteSecurity(room, peer, state),
      onSentVia: (id, via) => noteVia(room, id, via),
      onLog: ecLog,
      onDelivered: (id, ms) => { if (!noteEditDelivery(room, id, 'ok')) record(room, { t: 'delivery', id, state: 'ok', ms }) },
      onUndelivered: (id) => { if (!noteEditDelivery(room, id, 'lost')) record(room, { t: 'delivery', id, state: 'lost' }) },
      onLateDelivered: (id, ms) => { if (!noteEditDelivery(room, id, 'late')) record(room, { t: 'delivery', id, state: 'late', ms }) },
      onMessage: (from, msg, meta) => {
        ecLog(`message from ${from.slice(0, 12)}…: "${msg.body.slice(0, 40)}"${meta.outOfOrder ? ' (out of order)' : ''}`)
        // A message IS activity: a peer that just wrote is not "away". Presence
        // announces lag (a backgrounded tab throttles them), so a stale away/quiet
        // label sat over a live conversation — clear it on any inbound message.
        if (room.lastPresence !== 'active' && room.lastPresence !== 'join') {
          room.lastPresence = 'active'; room.inRoom = true; room.peerLabel = tr('w pokoju')
          if (room === activeRoom()) paintStatus()
          renderContacts()
        }
        if (room === activeRoom()) { peerTyping = false; setTyping(false) }
        // `au` is the CONTACT's identity key, not `from`: in a 1:1 `from` is the
        // transport PeerId (`room.ts`), and a quote hint taken from it would
        // name nobody. In a group the same callback's `from` IS the identity key.
        noteVia(room, msg.id, meta.via)
        record(room, { t: 'msg', kind: 'peer', text: msg.body, ts: msg.ts, id: msg.id, ooo: meta.outOfOrder, re: msg.re, au: contact.pub })
      },
      onTyping: (_from, state) => { peerTyping = state === 'start'; if (room === activeRoom()) setTyping(peerTyping, contact.name) },
      onReaction: (_from, r) => record(room, { t: 'react', id: r.to, emoji: r.emoji }),
      // A correction for one of THEIR messages. `acceptEdit` is what keeps it to
      // their own words and inside the window; a correction for a message we no
      // longer hold (the usual case after a reload) simply has nothing to change.
      onKnock: () => knockReceived(room),
      onEdit: (_from, e) => {
        const ev = findMsgEv(room, e.to)
        if (!acceptEdit(ev ? { mine: ev.kind === 'me', ts: ev.ts } : undefined)) {
          ecLog(`edit for ${e.to} not applied (no such live message, ours, or past the window)`, 'debug')
          return
        }
        ev!.text = e.body; ev!.edited = nowMs()
        if (isViewing(room)) repaintMsg(ev!)
      },
      onFile: (_from, f, meta) => { noteVia(room, f.id, meta?.via ?? 'relay'); record(room, { t: 'file', kind: 'peer', ts: nowMs(), file: f, au: contact.pub }) },
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
        const label = ev === 'join' ? tr('w pokoju') : ev === 'active' ? tr('wrócił/a') : ev === 'away' ? tr('nieobecny/a')
          : ev === 'quiet' ? tr('brak sygnału') : tr('wyszedł/wyszła')
        // Presence belongs in the header, not in the transcript. Every tab switch
        // flips away->active; only entering and leaving are worth a line, and only
        // when the state really changed.
        if ((ev === 'join' || ev === 'leave') && room.lastPresence !== ev) notePresenceLine(room, label)
        room.lastPresence = ev
        room.peerLabel = ev === 'leave' ? tr('poza pokojem') : label
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
    const why = String(e?.message ?? e)
    record(room, { t: 'sys', text: tr('Błąd: ') + why })
    // "błąd połączenia" named neither what failed nor where to look, and it is
    // not a state of the network — it is this one conversation refusing to open.
    // The reason is already in the transcript; the badge now says so and carries
    // it, because a red badge you cannot act on only tells you to worry.
    if (room === activeRoom()) {
      const el = $('peer-status')
      el.textContent = tr('nie udało się otworzyć rozmowy')
      el.title = why
    }
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
  const inp = $('msg-input') as HTMLTextAreaElement
  // The relay drops a frame over its ceiling and tells nobody, so a message
  // that cannot travel is refused HERE — with the text left exactly where it
  // is. Losing what somebody wrote in order to enforce a limit would be the
  // worse half of the bargain.
  if (!fitsOnWire(inp.value)) {
    paintLength()
    toast(tr('Wiadomość jest za długa o {n} — wyślij ją jako plik', { n: kb(overBy(inp.value)) }))
    return
  }
  if (sendEditComposer()) return // the composer is holding a correction, not a message
  // A pending file takes the composer over. attachFile() reads the caption out
  // of this same input and clears it, so the text goes once, with the file —
  // and the chip is dropped BEFORE the awaits, so what is sent is what the user
  // saw when they pressed Send.
  if (pendingAttach) {
    const f = pendingAttach
    // startTransfer() reads and clears the composer itself, because every one
    // of its refusals has to leave the chip and the text exactly where they
    // are — its note has a much smaller ceiling than a chat message, and the
    // person needs what they wrote in order to shorten it.
    if (pendingDirect) { startTransfer(f); return }
    const more = pendingMore
    // All at once and in order: each call takes its room, its bubble and (the
    // first only) the caption and the reply before its first await, so the
    // bubbles land in pick order in THIS conversation even if the screen
    // moves on while they upload; each send waits for the one before it.
    showAttach(null)
    let prev = attachFile(f)
    for (const m of more) prev = attachFile(m, prev)
    return
  }
  const t = inp.value.trim(); if (!t) return
  if (activeGid) { // a group is on screen — broadcast to it
    const gu = groupsUI.get(activeGid); if (!gu?.room) return
    inp.value = ''; growComposer(); paintLength()
    const re = takeReply()
    // "@Ala" typed straight through becomes "@Ala#3a7f1c02" here — the picker
    // already writes whole tokens, this is for the message written in one go.
    // Myself out of the roster: nobody mentions themselves, and "Ty" is not a
    // name anybody else would recognise.
    const body = closeMentions(t, gu.members.filter((m) => m.pub !== session?.pub).map((m) => ({ pub: m.pub, name: memberName(m.pub) })), mentionPicks)
    mentionPicks.clear()
    gu.room.sendText(body, re).then((id) => recordGroup(gu, { t: 'msg', kind: 'me', text: body, ts: nowMs(), id, sent: true, re, au: session?.pub }))
      .catch((e) => ecLog('group send failed: ' + (e?.message ?? e)))
    return
  }
  const room = activeRoom(); if (!room?.conv) return
  const re = takeReply()
  const id = room.conv.sendText(t, re)
  ecLog(`sent "${t.slice(0, 40)}" (id ${id}); secured peers: ${room.conv.secured().length}`)
  record(room, { t: 'msg', kind: 'me', text: t, ts: nowMs(), id, re, au: session?.pub })
  inp.value = ''; growComposer(); paintLength()
}
;($('send') as HTMLButtonElement).onclick = sendComposer
;($('msg-input') as HTMLTextAreaElement).oninput = () => {
  activeRoom()?.conv?.noteActivity(); updateMentionPop(); growComposer(); paintLength()
}
;($('msg-input') as HTMLTextAreaElement).onkeydown = (e: any) => {
  if (mentionKey(e)) return // the picker is open: Enter picks a person, it does not send
  // out of the reply or the edit, not out of the room
  if (e.key === 'Escape' && (replyTo || editing)) { cancelReply(); cancelEdit(); return }
  if (e.key !== 'Enter' || !entersSend(e)) return
  e.preventDefault() // or the newline lands in the box we are about to empty
  sendComposer()
}

/** Which shell is answering — asked in one place, because two features now
 *  turn on it (the radio profile and what Enter does). */
const hostKind = (): 'mobile' | 'desktop' | 'browser' =>
  isMobileShell() ? 'mobile' : isDesktopShell() ? 'desktop' : 'browser'

/**
 * Is the keyboard on the screen — i.e. is Enter the only way to break a line?
 *
 * The packaged shells KNOW: one is a phone, the other is a window with a real
 * keyboard, and neither has to be inferred. Only a browser has to be guessed
 * at, and there `pointer:coarse` (touch is the primary pointer) is the honest
 * question.
 *
 * It was `pointer:fine` before, which looks equivalent and is not: a machine
 * with no pointing device the browser recognises matches NEITHER — headless
 * Chromium is one, and so is any desktop the query cannot classify. That made
 * Enter stop sending on a keyboard, which the browser harness caught before a
 * person did.
 */
const typesOnScreen = (): boolean => {
  const host = hostKind()
  if (host === 'mobile') return true
  if (host === 'desktop') return false
  return matchMedia('(pointer:coarse)').matches
}

/**
 * Does this Enter send, or does it break the line?
 *
 * On a keyboard it sends, and Shift+Enter breaks the line — the habit every
 * chat app has taught. Where the keyboard is on the screen it NEVER sends:
 * Enter is the only way to break a line there (nobody holds Shift on a phone),
 * and a message that leaves half-written because a paragraph was wanted is a
 * worse failure than one more press of Send.
 *
 * A key that is part of composing a character is not a key at all yet — an IME
 * confirming a candidate with Enter must not send the message underneath it.
 */
const entersSend = (e: KeyboardEvent): boolean =>
  !e.isComposing && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !typesOnScreen()

/**
 * How tall the message box is: as tall as what is in it, within limits.
 *
 * Reported 2026-09-08: "longer forms are awkward to write". They were — the
 * composer was a single-line `<input>`, so a paragraph scrolled sideways
 * through a slot one line high.
 *
 * The limits and the arithmetic are in `lib/composer.ts`, where they can be
 * tested; what is here is the part only a browser can do — read what the text
 * actually needs, and keep the transcript where the reader left it.
 */
let composerOpen = false

/**
 * How much room is left, said only when it matters.
 *
 * The relay drops a frame over 64 KB, and everything the app could say after
 * that is a guess — so the count is shown while the text still exists and the
 * person is still looking at it. Below nine tenths of the budget: nothing at
 * all, because a byte counter over a sentence teaches people to worry about a
 * limit they will never meet.
 */
function paintLength(): boolean {
  const text = (($('msg-input') as HTMLTextAreaElement).value)
  const used = bodyBytes(text)
  const el = $('msg-len')
  const over = used > MAX_BODY
  el.hidden = used < WARN_AT
  el.classList.toggle('over', over)
  if (!el.hidden) {
    el.textContent = over
      ? tr('za długa o {n} — wyślij jako plik', { n: kb(overBy(text)) })
      : tr('zostało {n}', { n: kb(MAX_BODY - used) })
  }
  return !over
}

function growComposer() {
  const ta = $('msg-input') as HTMLTextAreaElement
  const cs = getComputedStyle(ta)
  const stick = atBottom()
  // Released before measuring: `scrollHeight` on a box that is already tall
  // enough reports the height it HAS, so a shrinking message would never
  // shrink it back.
  ta.style.height = 'auto'
  const h = boxHeight({
    line: parseFloat(cs.lineHeight),
    pad: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
    scroll: ta.scrollHeight,
  }, composerOpen)
  ta.style.height = `${h}px`
  // The transcript just lost whatever the composer took. Somebody reading
  // history stays where they were; somebody at the bottom stays at the bottom,
  // which is where the message they are answering is.
  if (stick) $('messages').scrollTop = $('messages').scrollHeight
  refreshJump()
}

$('composer-grow').addEventListener('click', () => {
  composerOpen = !composerOpen
  const btn = $('composer-grow')
  btn.classList.toggle('open', composerOpen)
  btn.setAttribute('aria-expanded', String(composerOpen))
  const label = composerOpen ? tr('Zmniejsz pole') : tr('Powiększ pole')
  btn.setAttribute('title', label); btn.setAttribute('aria-label', label)
  growComposer(); paintLength()
  ;($('msg-input') as HTMLTextAreaElement).focus()
})
;($('msg-input') as HTMLTextAreaElement).addEventListener('click', updateMentionPop)
;($('msg-input') as HTMLTextAreaElement).addEventListener('blur', () => closeMentionPop())

// ---- the @ picker ---------------------------------------------------------
/**
 * Typing `@` in a group offers its members, and picking one writes `@Ala`.
 *
 * The key hint is attached at SEND time (`closeMentions`), not here. The first
 * version wrote the whole `@Ala#3a7f1c02` into the field so that what you see
 * would be exactly what travels — true, and worth nothing next to the fact that
 * you then have to write the rest of the sentence around eight characters of a
 * key. Nobody is composing a wire format; they are talking to Ala.
 *
 * What that costs is one piece of state: WHICH Ala was pointed at, for the case
 * where a group holds two. `mentionPicks` carries exactly that to the send, and
 * nothing else — an unpicked name is still resolved from the roster.
 */
let mentionAt = -1 // where the '@' being completed sits, -1 = the picker is closed
let mentionSel = 0
let mentionHits: Array<{ pub: string; name: string }> = []
/** lower-cased name the picker wrote -> the key it meant. Emptied with the composer. */
const mentionPicks = new Map<string, string>()

const closeMentionPop = () => { mentionAt = -1; $('mention-pop').hidden = true }

/** Members of the group on screen, myself excluded, that match what was typed. */
function mentionCandidates(query: string): Array<{ pub: string; name: string }> {
  const q = query.toLowerCase()
  return mentionRoster()
    .filter((m) => m.pub !== session?.pub)
    .map((m) => ({ pub: m.pub, name: memberName(m.pub) }))
    .filter((m) => !q || m.name.toLowerCase().includes(q))
    // What was typed first, then alphabetically: typing "an" should offer Anna
    // before Marianna, and both before nobody.
    .sort((a, b) => {
      const pa = a.name.toLowerCase().startsWith(q) ? 0 : 1, pb = b.name.toLowerCase().startsWith(q) ? 0 : 1
      return pa - pb || a.name.localeCompare(b.name)
    })
    .slice(0, 8)
}

function updateMentionPop() {
  const inp = $('msg-input') as HTMLTextAreaElement
  if (!activeGid) return closeMentionPop() // a 1:1 has no roster to offer
  const caret = inp.selectionStart ?? inp.value.length
  const upto = inp.value.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at < 0) return closeMentionPop()
  // The same word-opening rule the parser uses, so the picker cannot offer to
  // complete something that would never be read back as a mention.
  if (at > 0 && !/[\s([{"'„«]/.test(upto[at - 1])) return closeMentionPop()
  const query = upto.slice(at + 1)
  if (query.length > 24 || /[@#]/.test(query)) return closeMentionPop()
  mentionHits = mentionCandidates(query)
  if (!mentionHits.length) return closeMentionPop()
  mentionAt = at; mentionSel = 0
  paintMentionPop()
}

function paintMentionPop() {
  const pop = $('mention-pop'), inp = $('msg-input') as HTMLTextAreaElement
  pop.innerHTML = ''
  mentionHits.forEach((h, i) => {
    const row = document.createElement('button')
    row.className = 'mrow-pick' + (i === mentionSel ? ' on' : '')
    const av = document.createElement('span'); av.className = 'ga'; av.textContent = initials(h.name)
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = h.name
    row.append(av, nm)
    row.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(i) }) // mousedown: the input must not lose focus first
    pop.appendChild(row)
  })
  const r = inp.getBoundingClientRect()
  pop.style.left = Math.round(r.left) + 'px'
  pop.style.width = Math.round(Math.min(320, Math.max(180, r.width))) + 'px'
  pop.style.bottom = Math.round(window.innerHeight - r.top + 6) + 'px'
  pop.hidden = false
}

function pickMention(i: number) {
  const hit = mentionHits[i]
  const inp = $('msg-input') as HTMLTextAreaElement
  if (!hit || mentionAt < 0) return closeMentionPop()
  const caret = inp.selectionStart ?? inp.value.length
  // The same shape `closeMentions` looks for — a name it cannot find again is a
  // mention that silently loses its hint.
  const written = '@' + mentionName(hit.name) + ' '
  mentionPicks.set(mentionName(hit.name).toLowerCase(), hit.pub)
  inp.value = inp.value.slice(0, mentionAt) + written + inp.value.slice(caret)
  growComposer(); paintLength()
  const pos = mentionAt + written.length
  closeMentionPop()
  inp.focus(); inp.setSelectionRange(pos, pos)
}

/** Keys the picker owns while it is open. Returns true when it took the key. */
function mentionKey(e: KeyboardEvent): boolean {
  if (mentionAt < 0) return false
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    mentionSel = (mentionSel + (e.key === 'ArrowDown' ? 1 : mentionHits.length - 1)) % mentionHits.length
    paintMentionPop(); return true
  }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionSel); return true }
  if (e.key === 'Escape') { e.preventDefault(); closeMentionPop(); return true }
  return false
}

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
interface GroupUI { gid: string; name: string; epoch: number; members: { pub: string }[]; room: GroupRoom | null; log: Ev[]; unseen: number
  /** Among the unread ones, at least one says my name. Lives beside `unseen`
   *  and clears with it: a count says how much, this says whether it is for me. */
  called?: boolean }
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
// (roster[0]) also gets a remove "x" per other member and an add-member picker.
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
 * Admin changes the roster: rekey (epoch++, new group_secret -> new topic, fresh
 * sending key), re-open the group on the new topic, redistribute the SKD to the
 * NEW roster (a removed member is never sent it -> cannot derive the new topic or
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
 * members popover's x does.
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
  const filter = val('group-search').toLowerCase()
  const shown = [...groupsUI.values()].filter((g) => !filter || groupDisplay(g).toLowerCase().includes(filter))
  if (!shown.length) {
    const e = document.createElement('div'); e.className = 'pane-label'
    e.textContent = groupsUI.size ? tr('(brak dopasowań)') : tr('(brak grup — utwórz)')
    pane.appendChild(e); return
  }
  for (const gu of shown) {
    const b = document.createElement('button'); b.className = 'contact' + (activeGid === gu.gid && chatOnScreen() ? ' active' : '') + (gu.unseen ? ' unread' : '')
    const pill = (gu.called ? `<span class="c-at" title="${tr('Ktoś zwrócił się do Ciebie')}">@</span>` : '')
      + (gu.unseen ? `<span class="c-unread">${gu.unseen > 99 ? '99+' : gu.unseen}</span>` : '')
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
        const name = await promptName(tr('Zmień nazwę grupy'), tr('Nazwa zmieni się u wszystkich członków — klucze zostają bez zmian.'), gu.name, tr('Nazwa grupy'))
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
    wireRowActions(b)
    pane.appendChild(b)
  }
}

/** Record a group event: render if the group is on screen, else count it (dot). */
function recordGroup(gu: GroupUI, ev: Ev) {
  gu.log.push(ev); if (gu.log.length > LOG_CAP) gu.log.shift()
  // No system notification for a group, by decision (2026-08-25): five people
  // in a conversation is not five things a phone should announce, and the ONE
  // case worth interrupting for — being named — already lights `called` on the
  // group row. If that changes, this is the line, and `mentionsPub` is the test.
  if (activeGid === gu.gid && $('app').classList.contains('chat-open')) applyEv(ev)
  else if (isArrival(ev)) {
    gu.unseen++
    // A file's caption is a body like any other and goes through the same
    // `closeMentions` on the way out, so "@Ala popatrz" attached to a scan has
    // to light the group the way the sentence alone would.
    const said = ev.t === 'msg' ? ev.text : (ev.file as any).body ?? ''
    if (session && said && mentionsPub(said, session.pub)) gu.called = true
    renderGroups()
  }
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
  return cacheBaseFor(session.id, session.idKey)
}

/**
 * The same secret, derivable before a session exists — because the contact book
 * is verified at sign-in, which is earlier than everything else here.
 *
 * It caches into `cacheBase`, so the group cache does not pay for it twice: on a
 * HEM one ECDH is a device round trip of a second or two, and this is the same
 * `emp_pub` either way.
 */
async function cacheBaseFor(id: Identity, idKey: string): Promise<Uint8Array | null> {
  if (cacheBase) return cacheBase
  const key = 'ec-gcache-emp-' + idKey
  let empPub = localStorage.getItem(key)
  if (!empPub) { empPub = b64((await generateX25519()).pub); localStorage.setItem(key, empPub) }
  try { cacheBase = await id.ecdh(empPub) } catch (e: any) { ecLog('cache base: ecdh failed — ' + (e?.message ?? e), 'debug'); return null }
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
      const gu: GroupUI = { gid: gidHex, name: name || tr('Grupa'), epoch: snap.epoch, members, log: [], unseen: 0, room: null }
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

/** One-time upgrade: a B1 plaintext blob (ec-groups-<handle>) -> encrypt each group
 *  into the §10 cache, then delete the plaintext. Prevents groups vanishing on the
 *  B1->B2 upgrade the same way the identity change once broke 1:1. */
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
  // A group broadcast has no direct channel to ride — one channel per member
  // would be N channels, and the sender-key plane is built on the node. Opening
  // one here would send group content through the node while the setting says
  // it never does, so the honest answer is to refuse and name the setting.
  if (directOnly()) {
    toast(tr('Grupy nie działają w trybie „tylko bezpośrednio” — zmień transport w Ustawieniach'), 3500)
    return
  }
  const sameTarget = activeGid === gid // as in activateRoom: a new audience empties the composer, a repaint does not
  if (!sameTarget) stashDraft() // belongs to the room being LEFT, so before the switch
  activeGid = gid; activePub = null // a group takes over — no 1:1 is "active"
  if (!sameTarget) { clearComposer(); restoreDraft() }
  gu.unseen = 0; gu.called = false
  $('chat-empty').hidden = true; $('chat-view').hidden = false
  showChatPane(true)
  focusComposer() // AFTER the pane is on screen — as in activateRoom
  $('peer-avatar').textContent = tr('👥')
  $('peer-name').textContent = groupDisplay(gu); $('peer-name').title = ''
  $('peer-dot').className = 'dot ok'; $('peer-status').textContent = tr('{n} członków', { n: gu.members.length })
  // Participant cluster in the header -> click to see the full member list.
  const cluster = $('members-cluster'); cluster.hidden = false; cluster.innerHTML = avatarClusterHTML(gu.members)
  cluster.title = tr('Uczestnicy grupy')
  cluster.onclick = (e: any) => { e.stopPropagation(); openMembersPopFor(gu, cluster, e as MouseEvent) }
  $('members-pop').hidden = true
  setBadge($('e2e-badge'), 'badge direct', tr('🔐 Secure'), tr('Grupa — Sender Keys + per-recipient HMAC (deniable, §8)'))
  $('e2e-badge').title = tr('Grupa — Sender Keys + per-recipient HMAC (deniable, §8)')
  setBadge($('transport-badge'), 'badge relay', tr('⚪ Relay'), tr('Grupa idzie przez relay (GossipSub) — nie WebRTC'))
  $('transport-badge').title = tr('Grupa idzie przez relay (GossipSub) — nie WebRTC')
  $('sess-peerid').textContent = gid.slice(0, 12) + '…'
  await loadPins(gid, gu.log) // as in activateRoom: before the replay, so they land first
  $('messages').innerHTML = ''; msgEls.clear(); stateEls.clear(); setTyping(false); cancelReply(); cancelEdit()
  for (const ev of gu.log) applyEv(ev)
  startRotation(); renderGroups()
}

const groupHandlers = (gid: string) => ({
  onMessage: (from: string, env: { body: string; ts: number; id: string; re?: QuoteRef }) =>
    recordGroup(groupsUI.get(gid)!, { t: 'msg', kind: from === session?.pub ? 'me' : 'peer', text: env.body, ts: env.ts, id: env.id, who: memberName(from), re: env.re, au: from }),
  onReaction: (_from: string, r: { to: string; emoji: string }) =>
    recordGroup(groupsUI.get(gid)!, { t: 'react', id: r.to, emoji: r.emoji }),
  // A file in a group is the same envelope as in a 1:1 — every member holds the
  // key it carries, so each fetches the blob itself within its short life.
  onFile: (from: string, f: FileEnv) =>
    recordGroup(groupsUI.get(gid)!, { t: 'file', kind: from === session?.pub ? 'me' : 'peer', ts: nowMs(), file: f, who: memberName(from), au: from }),
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
    gu = { gid, name: skd.name || tr('Grupa'), epoch: skd.epoch, members, log: [], unseen: 0, room: null }
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
    // A newer epoch means a rekey -> a new group_secret -> a new topic, so the room
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
  pushModal('group-modal'); $('group-name').focus()
}
const closeGroupModal = () => dropModal('group-modal')
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
    endModals() // the group exists; the window that made it has nothing left to offer
    await activateGroup(gid)
    void distributeGroup(gid, name) // send the invite (keys) to each member over 1:1
    void persistGroups() // the new group must survive a reload immediately
    toast(tr('Grupa „{name}” utworzona — rozsyłam zaproszenia…', { name }))
  } catch (e: any) { setMsg('group-msg', tr('Błąd: ') + (e?.message ?? e), 'err') }
})

document.addEventListener('visibilitychange', () => {
  ecLog(document.hidden ? 'tab hidden — browser will throttle our timers' : 'tab visible — re-announcing')
  diag.note(`vis ${document.hidden ? 'hidden' : 'visible'}`)
  // Every open room, not just the visible one: a background conversation must
  // stay alive across the throttle too. Coming back, the tab's timers were
  // throttled while hidden, so our Announce heartbeat went quiet and the peer may
  // already have written us off — speak up now instead of waiting for the tick.
  // Coming back also SAYS so: refresh() alone revived the transport but left
  // the `away` flag set, so the peer saw "away" until the first keystroke —
  // raising the window is the "I'm back" (the phone already reads that way
  // on unlock, and the desktop should not be the quieter platform).
  for (const r of rooms.values()) { if (document.hidden) r.conv?.noteAway(); else { r.conv?.refresh(); r.conv?.noteBack() } }
  // The screen-off radio profile (lib/radiophase.ts): a pocketed phone
  // announces its dots and group keepalives at 60 s instead of 15 s — four
  // times fewer radio wakes where battery is actually spent. Open rooms keep
  // their cadence (their receivers' thresholds cannot be told about a
  // slowdown); coming back re-arms everything onto the next 15 s tick.
  //
  // A DESKTOP hidden in the tray does not slow down, and `profileFor` carries
  // the measurement that says why: there is no radio and no battery to save
  // there, and the saving cost exactly the thing a tray-resident app is for.
  const host = hostKind()
  const prof = profileFor(document.hidden, host)
  setRadioProfile(prof)
  diag.note(`radio ${prof} (${host})`)
  if (document.hidden) { void persistGroups(); diagFlush(); return } // best-effort flush on backgrounding (encrypt is async); sends are already durable
  // Back on screen. The rooms were refreshed above; the LIGHT presence watches
  // — the contact dots — were not, and neither was the transport. `refresh()`
  // re-dials if the socket died unseen and announces on every watch at once,
  // so the dots light up now instead of on the next heartbeat (up to a minute
  // away on a slowed link). Reported 2026-09-09: opening from the tray showed
  // no dot beside a peer that was there all along.
  void client?.refresh().catch((e: any) => ecLog('refresh on reveal failed: ' + (e?.message ?? e), 'debug'))
})
// Alt-tab back does not change visibility (the window never left the screen),
// but focus fires — and an idle-away person who returns that way deserves the
// same "I'm back". Idempotent: presence goes out only if `away` was set.
window.addEventListener('focus', () => { for (const r of rooms.values()) r.conv?.noteBack() })
/**
 * Phone layout: one pane at a time (see the <=720px rules in index.html). The
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
    // Where the visible area STARTS. A fixed element is placed against the
    // layout viewport, and the browser scrolls the page to reveal a focused
    // field — so a window centred without this lands under the keyboard even
    // when it is short enough to fit above it.
    document.documentElement.style.setProperty('--vv-top', typing && covered ? `${Math.round(vv?.offsetTop ?? 0)}px` : '0px')
    // Once the app is clamped to the visible area, the whole of it fits above
    // the keyboard, so any scroll of the DOCUMENT is left over from the moment
    // the WebView panned to reveal the field -- before the clamp. Left there,
    // it keeps the top of the app above the screen: on Android the header sat
    // under the status bar with the keyboard open (reported 2026-09-25). Put
    // the document back; this runs again on the scroll event it causes and
    // then finds nothing to do.
    if (typing && covered && (window.scrollY || document.scrollingElement?.scrollTop)) window.scrollTo(0, 0)
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
window.addEventListener('beforeunload', () => {
  void persistGroups()
  // WARNING: In the packaged shell a close REQUEST is not a departure. The shell
  // vetoes it and hides the window, but the webview has already fired this
  // event — so tearing the transport down here left a live window attached to
  // a STOPPED node, and the next room said "Pubsub has not started" with
  // nothing to explain it. Reported as a race; it was not one, it was this.
  //
  // Quitting for real takes the process with it, which takes the node too.
  if (isDesktopShell()) return
  for (const r of rooms.values()) r.conv?.leave()
  client?.close()
})

// ---- room rotation countdown — the ACTIVE pair's real instant (midnight+offset) ----
// The topic rotates per pair at `UTC-midnight + rotationOffsetSec` (§5.4), so the
// old "time to next UTC midnight" was both wrong and identical for every contact.
// Each tick reads the on-screen conversation's offset and counts to its rotation.
// Groups rotate per epoch (membership change), not daily, so the badge is hidden
// while a group is on screen.
function startRotation() {
  if (rotTimer) return
  const tick = () => {
    // No badge of its own any more (the user's call — header space is the
    // scarcest on a phone and the value is advisory): the countdown rides in
    // the security badge's tooltip, composed with the state text by
    // applyBadgeTitle so neither writer erases the other. Groups rotate per
    // epoch, not daily, so a group on screen carries no countdown.
    const b = document.getElementById('e2e-badge'); if (!b) return
    const conv = activeGid ? null : activeRoom()?.conv
    if (!conv) { delete b.dataset.rot; applyBadgeTitle(b); return }
    const now = Date.now()
    const next = nextRotationAfter(now, (conv.rotationOffsetSec ?? 0) * 1000)
    let s = Math.max(0, Math.floor((next - now) / 1000))
    const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60
    // Hours and minutes only: this counts to a DAILY rotation, and seconds are
    // precision nobody acts on. Rounded UP, so it never reads 00:00 while
    // there is still time left.
    const mm = s > 0 ? m + 1 : m
    const t = `${String(h + (mm === 60 ? 1 : 0)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`
    b.dataset.rot = tr('Rotacja pokoju tej pary (północ UTC + offset, §5.4) za {t}', { t })
    applyBadgeTitle(b)
  }
  // Still every second: the value changes on a minute boundary, and polling for
  // it is cheaper than computing when that boundary falls.
  tick(); rotTimer = setInterval(tick, 1000)
}

refreshStatus()
