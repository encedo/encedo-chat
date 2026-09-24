/**
 * second-joiner.ts — a client that joins a topic the relay ALREADY carries can
 * speak in it, not just listen.
 *
 * The case `--leaf-announce` (relay/leaf.mjs) got wrong in production on
 * 2026-09-24. When client 2 subscribes to T after client 1, the relay is
 * already in T, so `subscribe(T)` is not called again and nothing is announced
 * by that path; the hook's own answer ("I hold T too") was addressed by a
 * PeerId object where the stream lookup needs a string, and went nowhere.
 * Client 2 then heard T and, with floodPublish, published to nobody -- a
 * room that looked formed from one side. Neither shard-test nor pick-test
 * see this, because in both the relay subscribes BECAUSE of the client under
 * test. This one waits before the second client joins, on purpose.
 *
 *   node net/second-joiner.ts <relay multiaddr>
 *
 * Exit 0 = the late joiner's message reached the early one AND the early
 * one's message reached the late joiner. Run it against a local relay
 * started with `--leaf-announce` before that flag goes back on a node.
 */
import { multiaddr } from '@multiformats/multiaddr'
import { randomBytes } from 'node:crypto'
import { createPeer } from './peer.ts'

const addr = process.argv[2]
if (!addr) { console.error('usage: node net/second-joiner.ts <relay multiaddr>'); process.exit(2) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const utf8 = new TextEncoder(), dec = new TextDecoder()
const topic = 'late-' + randomBytes(8).toString('hex')

const early = await createPeer()
await early.dial(multiaddr(addr))
const heardByEarly: string[] = []
early.services.pubsub.addEventListener('message', (e: any) => { if (e.detail.topic === topic) heardByEarly.push(dec.decode(e.detail.data)) })
early.services.pubsub.subscribe(topic)
// Long enough for the relay to join T for the early client and settle its
// mesh, so the late one really is late.
await sleep(4000)

const late = await createPeer()
await late.dial(multiaddr(addr))
const heardByLate: string[] = []
late.services.pubsub.addEventListener('message', (e: any) => { if (e.detail.topic === topic) heardByLate.push(dec.decode(e.detail.data)) })
late.services.pubsub.subscribe(topic)
await sleep(3000)

// What the late client believes: does it know anybody on T at all?
const knownToLate = late.services.pubsub.getSubscribers(topic).length
const tokenLate = 'from-late-' + randomBytes(4).toString('hex')
const r1: any = await late.services.pubsub.publish(topic, utf8.encode(tokenLate)).catch((e) => ({ err: String(e) }))
const tokenEarly = 'from-early-' + randomBytes(4).toString('hex')
const r2: any = await early.services.pubsub.publish(topic, utf8.encode(tokenEarly)).catch((e) => ({ err: String(e) }))
for (let i = 0; i < 40 && !(heardByEarly.includes(tokenLate) && heardByLate.includes(tokenEarly)); i++) await sleep(250)

const lateToEarly = heardByEarly.includes(tokenLate)
const earlyToLate = heardByLate.includes(tokenEarly)
console.log(`spozniony zna kogos na T      : ${knownToLate > 0 ? 'TAK' : 'NIE'} (${knownToLate})`)
console.log(`spozniony -> wczesny dotarlo  : ${lateToEarly ? 'TAK' : 'NIE'} (publish recipients: ${r1?.recipients?.length ?? r1?.err ?? '?'})`)
console.log(`wczesny -> spozniony dotarlo  : ${earlyToLate ? 'TAK' : 'NIE'} (publish recipients: ${r2?.recipients?.length ?? r2?.err ?? '?'})`)
const ok = lateToEarly && earlyToLate
console.log(ok ? 'PRZESZLO' : 'NIE PRZESZLO — spozniony klient jest gluchy albo niemy w pokoju, ktory przekaznik juz niesie')
await early.stop(); await late.stop()
process.exit(ok ? 0 : 1)
