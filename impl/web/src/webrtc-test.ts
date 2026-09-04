/**
 * webrtc-test.ts — no-HEM WebRTC probe. Open this page in TWO browser tabs; each
 * is a libp2p peer on the onchato relay, subscribed to a fixed topic. They
 * discover each other, exchange WebRTC signaling over GossipSub, and establish a
 * direct DataChannel — then swap a "hello". No HEM, no our message crypto.
 */

import { createPeer, dial } from '../../net/peer.ts'
import { webrtcLink, type Signal, type WebRTCLink } from '../../net/webrtc.ts'

const RELAY = '/dns4/bs1.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3KooWP6SpQxgcUDdAU1CdY3dcvSrkxHPki7FRtMLLYiGxcDmp'
const TOPIC = 'onchato-webrtc-test-v6'
const enc = new TextEncoder()
const dec = new TextDecoder()
const logEl = document.getElementById('log') as HTMLElement
const log = (m: string) => { logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight }

const node = await createPeer()
const me = node.peerId.toString()
log(`me: ${me.slice(0, 20)}...`)
await dial(node, RELAY)
log('dialed onchato relay [ok]')

let link: WebRTCLink | null = null
let connected = false
const pub = (obj: any) => node.services.pubsub.publish(TOPIC, enc.encode(JSON.stringify(obj))).catch(() => {})

function startLink(peer: string, initiator: boolean) {
  if (link) return
  log(`-> WebRTC with ${peer.slice(0, 16)}...  (initiator=${initiator})`)
  link = webrtcLink({
    initiator,
    sendSignal: (sig) => { log(`  -> signal ${sig.kind}`); pub({ t: 'rtc', from: me, to: peer, sig }) },
    onData: (bytes) => log(`[ok] RECV over DataChannel: "${dec.decode(bytes)}"`),
    onOpen: () => {
      connected = true
      log('[ok] DataChannel OPEN — direct P2P established')
      const msg = `hello from ${me.slice(0, 12)}...`
      link!.send(enc.encode(msg)); log(`sent: "${msg}"`)
    },
    onClose: () => log('DataChannel closed'),
    onState: (s) => log(`  [${s}]`),
  })
}

node.services.pubsub.addEventListener('message', async (evt: any) => {
  if (evt.detail.topic !== TOPIC) return
  let m: any
  try { m = JSON.parse(dec.decode(evt.detail.data)) } catch { return }
  if (m.from === me) return
  if (m.t === 'hello') {
    if (!link) startLink(m.from, me < m.from) // lower PeerId initiates
  } else if (m.t === 'rtc' && m.to === me) {
    log(`  <- signal ${m.sig?.kind}`)
    if (!link) startLink(m.from, me < m.from) // signal may arrive before we saw their hello
    await link!.handleSignal(m.sig as Signal)
  }
})
node.services.pubsub.subscribe(TOPIC)

// keep announcing until the DataChannel is up (avoids a discovery race where a
// peer stops announcing right before the other one sees it)
setTimeout(() => pub({ t: 'hello', from: me }), 800)
const hb = setInterval(() => { if (!connected) pub({ t: 'hello', from: me }) }, 2000)
setTimeout(() => clearInterval(hb), 90_000)
log('subscribed + announcing... open this page in a SECOND tab to connect')
