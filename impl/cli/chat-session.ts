/**
 * chat-session.ts — interactive IRC-style chat in a rendezvous room.
 *
 * Renders each envelope type; drives typing / away meta from local keyboard
 * activity; graceful leave (presence:leave last-will + clean libp2p stop) on
 * /quit and Ctrl+C. Shared by the bob / alice / ec CLIs once room keys are
 * derived. Timestamps shown in UTC (lib/time.ts).
 */

import { joinChat, type RoomKeys } from '../lib/room.ts'
import { startRepl } from './repl.ts'
import { nowMs, utcHHMM } from '../lib/time.ts'

const C = { peer: '\x1b[36m', me: '\x1b[33m', sys: '\x1b[90m', warn: '\x1b[31m', reset: '\x1b[0m' }
const short = (id: string) => id.slice(0, 10) + '…'
const time = (ts: number) => `${C.sys}${utcHHMM(ts)}${C.reset}`
const TYPING_STOP_MS = 4_000 // stop "typing" after this idle gap
const AWAY_MS = 60_000 // go "away" after this much no keyboard activity
const FLUSH_MS = 250 // let the leave reach the relay before we tear down

export function runChatSession(node, topic: string, keys: RoomKeys, meName: string, peerName: string) {
  console.log(`${C.sys}— room open (topic ${topic.slice(0, 12)}…). Type to chat.  /who  /me <a>  /react <emoji>  /quit${C.reset}`)
  console.log(`${C.sys}— waiting for ${peerName} to join…${C.reset}`)

  let room: ReturnType<typeof joinChat>
  let lastRecvId: string | null = null // last message id received → target for /react
  let peerTyping = false
  let leaving = false

  // ---- local keyboard activity → typing / away meta ----
  let typingSent = false
  let away = false
  let typingTimer: any
  let awayTimer: any
  const armAway = () => {
    clearTimeout(awayTimer)
    awayTimer = setTimeout(() => { away = true; stopTyping(); room.sendPresence('away') }, AWAY_MS)
  }
  const stopTyping = () => {
    clearTimeout(typingTimer)
    if (typingSent) { typingSent = false; room.sendTyping('stop') }
  }
  const onActivity = () => {
    if (!room || leaving) return
    if (away) { away = false; room.sendPresence('active') }
    if (!typingSent) { typingSent = true; room.sendTyping('start') }
    clearTimeout(typingTimer)
    typingTimer = setTimeout(stopTyping, TYPING_STOP_MS)
    armAway()
  }

  // ---- graceful shutdown: last-will + clean libp2p stop ----
  const shutdown = async () => {
    if (leaving) process.exit(0) // second Ctrl+C → hard exit
    leaving = true
    clearTimeout(typingTimer); clearTimeout(awayTimer)
    ui.print(`${C.sys}— logging out…${C.reset}`)
    try { await room.sendPresence('leave') } catch {}
    await new Promise((r) => setTimeout(r, FLUSH_MS))
    try { room.stop() } catch {}
    const wd = setTimeout(() => process.exit(0), 2_000)
    ;(wd as any).unref?.()
    try { await node.stop() } catch {}
    process.exit(0)
  }

  const ui = startRepl(`${meName}> `, (line) => {
    if (line === '/quit') { shutdown(); return }
    if (line === '/who') {
      const w = room.who()
      ui.print(`${C.sys}present: ${w.length ? w.map(short).join(', ') : '(nobody yet)'}${C.reset}`)
      return
    }
    if (line.startsWith('/me ')) {
      const action = line.slice(4)
      room.sendText(`ACTION ${action}`)
      ui.print(`${time(nowMs())} ${C.me}* ${meName} ${action}${C.reset}`)
      stopTyping()
      return
    }
    if (line.startsWith('/react ')) {
      const emoji = line.slice(7).trim()
      if (!lastRecvId) { ui.print(`${C.warn}nothing to react to yet${C.reset}`); return }
      if (!emoji) { ui.print(`${C.warn}usage: /react <emoji>${C.reset}`); return }
      room.sendReaction(lastRecvId, emoji)
      ui.print(`${time(nowMs())} ${C.me}* ${meName} reacted ${emoji}${C.reset}`)
      return
    }
    if (line === '/file') { ui.print(`${C.warn}/file: file share (IPFS) not implemented yet${C.reset}`); return }
    if (line.startsWith('/')) { ui.print(`${C.warn}unknown command: ${line}${C.reset}`); return }
    room.sendText(line)
    ui.print(`${time(nowMs())} ${C.me}[${meName}]${C.reset} ${line}`)
    stopTyping()
  }, { onSigint: shutdown, onActivity })

  room = joinChat(node, topic, keys, {
    heartbeatMs: 15_000,
    onMessage: (_from, m) => {
      lastRecvId = m.id
      peerTyping = false
      if (m.body.startsWith('ACTION ')) ui.print(`${time(m.ts)} ${C.peer}* ${peerName} ${m.body.slice(7)}${C.reset}`)
      else ui.print(`${time(m.ts)} ${C.peer}[${peerName}]${C.reset} ${m.body}`)
    },
    onTyping: (_from, state) => {
      if (state === 'start' && !peerTyping) { peerTyping = true; ui.print(`${C.sys}* ${peerName} is typing…${C.reset}`) }
      if (state === 'stop') peerTyping = false
    },
    onReaction: (_from, r) => ui.print(`${time(r.ts)} ${C.peer}* ${peerName} reacted ${r.emoji}${C.reset}`),
    onFile: (_from, f) => ui.print(`${time(f.ts)} ${C.peer}* ${peerName} shared a file: ${f.name} (${f.cid.slice(0, 12)}…) — interim: fetch TODO${C.reset}`),
    onPresence: (peer, ev) => {
      const what = ev === 'join' ? 'is in the room' : ev === 'active' ? 'is back' : ev === 'away' ? 'is away' : 'left'
      ui.print(`${C.sys}* ${peerName} ${what} (${short(peer)})${C.reset}`)
    },
  })
}
