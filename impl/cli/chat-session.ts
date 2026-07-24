/**
 * chat-session.ts — run an interactive IRC-style chat in a rendezvous room.
 * Shared by the bob (software) and alice (HEM) CLIs once they've derived the
 * room keys. Presence + interim encrypted messages + slash commands.
 */

import { joinChat, type RoomKeys } from '../lib/room.ts'
import { startRepl } from './repl.ts'

const C = { peer: '\x1b[36m', me: '\x1b[33m', sys: '\x1b[90m', warn: '\x1b[31m', reset: '\x1b[0m' }
const short = (id: string) => id.slice(0, 10) + '…'

export function runChatSession(node, topic: string, keys: RoomKeys, meName: string, peerName: string) {
  console.log(`${C.sys}— room open (topic ${topic.slice(0, 12)}…). Type to chat.  /who  /me <action>  /quit${C.reset}`)
  console.log(`${C.sys}— waiting for ${peerName} to join…${C.reset}`)

  let room: ReturnType<typeof joinChat>

  const ui = startRepl(`${meName}> `, (line) => {
    if (line === '/quit') { room.stop(); process.exit(0) }
    if (line === '/who') {
      const w = room.who()
      ui.print(`${C.sys}present: ${w.length ? w.map(short).join(', ') : '(nobody yet)'}${C.reset}`)
      return
    }
    if (line.startsWith('/me ')) {
      const action = line.slice(4)
      room.send(`ACTION ${action}`)
      ui.print(`${C.me}* ${meName} ${action}${C.reset}`)
      return
    }
    if (line.startsWith('/')) { ui.print(`${C.warn}unknown command: ${line}${C.reset}`); return }
    room.send(line)
    ui.print(`${C.me}[${meName}]${C.reset} ${line}`)
  })

  room = joinChat(node, topic, keys, {
    heartbeatMs: 15_000,
    onMessage: (_from, text) => {
      if (text.startsWith('ACTION ')) ui.print(`${C.peer}* ${peerName} ${text.slice(8)}${C.reset}`)
      else ui.print(`${C.peer}[${peerName}]${C.reset} ${text}`)
    },
    onPresence: (peer, ev) => {
      ui.print(`${C.sys}* ${peerName} ${ev === 'join' ? 'is in the room' : 'left'} (${short(peer)})${C.reset}`)
    },
  })
}
