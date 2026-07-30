/**
 * chat-session.ts — interactive IRC-style chat UI. Pure front-end over the core
 * facade: opens a Conversation (lib/core.ts) and renders its events; feeds user
 * intent (input → noteActivity / sendText, Ctrl+C & /quit → leave). Shared by the
 * bob / alice / ec CLIs. Timestamps in UTC.
 */

import { openConversation, type Identity, type RoomParams } from '../lib/core.ts'
import { startRepl } from './repl.ts'
import { nowMs, utcHHMM } from '../lib/time.ts'

const C = { peer: '\x1b[36m', me: '\x1b[33m', sys: '\x1b[90m', warn: '\x1b[31m', reset: '\x1b[0m' }
const short = (id: string) => id.slice(0, 10) + '…'
const time = (ts: number) => `${C.sys}${utcHHMM(ts)}${C.reset}`

export async function runChatSession(
  id: Identity, peerPub: string, meName: string, peerName: string, relay: string,
  params?: RoomParams,
  /** Seal content with EH-2 + ratchet (§6–7); `false` picks the interim key. Both sides must agree. */
  eh2 = true,
) {
  console.log(`${C.sys}— connecting via relay…${C.reset}`)

  let conv: Awaited<ReturnType<typeof openConversation>> | null = null
  let lastRecvId: string | null = null
  let peerTyping = false
  let leaving = false

  const shutdown = async () => {
    if (leaving) process.exit(0) // second Ctrl+C → hard exit
    leaving = true
    ui.print(`${C.sys}— logging out…${C.reset}`)
    const wd = setTimeout(() => process.exit(0), 2_000)
    ;(wd as any).unref?.()
    try { await conv?.leave() } catch {}
    process.exit(0)
  }

  const ui = startRepl(`${meName}> `, (line) => {
    if (!conv) return
    if (line === '/quit') { shutdown(); return }
    if (line === '/who') {
      const w = conv.who()
      ui.print(`${C.sys}present: ${w.length ? w.map(short).join(', ') : '(nobody yet)'}${C.reset}`)
      return
    }
    if (line.startsWith('/me ')) { const a = line.slice(4); conv.sendText(`ACTION ${a}`); ui.print(`${time(nowMs())} ${C.me}* ${meName} ${a}${C.reset}`); return }
    if (line.startsWith('/react ')) {
      const emoji = line.slice(7).trim()
      if (!lastRecvId) { ui.print(`${C.warn}nothing to react to yet${C.reset}`); return }
      if (!emoji) { ui.print(`${C.warn}usage: /react <emoji>${C.reset}`); return }
      conv.sendReaction(lastRecvId, emoji); ui.print(`${time(nowMs())} ${C.me}* ${meName} reacted ${emoji}${C.reset}`)
      return
    }
    if (line === '/file') { ui.print(`${C.warn}/file: file share (IPFS) not implemented yet${C.reset}`); return }
    if (line.startsWith('/')) { ui.print(`${C.warn}unknown command: ${line}${C.reset}`); return }
    conv.sendText(line); ui.print(`${time(nowMs())} ${C.me}[${meName}]${C.reset} ${line}`)
  }, { onSigint: shutdown, onActivity: () => conv?.noteActivity() })

  try {
    conv = await openConversation(id, { pub: peerPub }, {
      relay,
      params,
      eh2,
      onSecurity: (peer, state) => ui.print(
        state === 'established'
          ? `${C.sys}* EH-2 established with ${short(peer)} — ratchet active (PQ hybrid)${C.reset}`
          : `${C.sys}* EH-2 ${state} with ${short(peer)}${C.reset}`,
      ),
      onMessage: (_from, m, meta) => {
        lastRecvId = m.id; peerTyping = false
        // A terminal cannot re-thread what it has already printed, so it says so
        // instead: the timestamp is the sender's, and ⏱ marks the jump backwards.
        const late = meta.outOfOrder ? `${C.warn} ⏱ spóźniona${C.reset}` : ''
        if (m.body.startsWith('ACTION ')) ui.print(`${time(m.ts)} ${C.peer}* ${peerName} ${m.body.slice(7)}${C.reset}${late}`)
        else ui.print(`${time(m.ts)} ${C.peer}[${peerName}]${C.reset} ${m.body}${late}`)
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
    ui.print(`${C.sys}— room open (topic ${conv.topic.slice(0, 12)}…) as ${short(conv.peerId)}. Type to chat.  /who  /me <a>  /react <emoji>  /quit${C.reset}`)
    ui.print(`${C.sys}— waiting for ${peerName} to join…${C.reset}`)
  } catch (e: any) {
    ui.print(`${C.warn}connection failed: ${e?.message ?? e}${C.reset}`)
    process.exit(1)
  }
}
