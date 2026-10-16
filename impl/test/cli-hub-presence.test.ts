import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hub, type HubEvent } from '../cli/hub.ts'

// The daemon's queue trusts `hub.online`. Once a conversation is open the light
// watch is retired, so the room's own presence must drive it - or a contact
// whose handshake beat its first Announce stays "offline" for good (bs2-bot and
// macMini1, 2026-10-16: three reports waiting next to a working ratchet).

function hubWithRoom() {
  const hub = new Hub({ id: { handle: 'bot', pub: 'me' } as any, contacts: {} as any, relays: [] })
  const contact = { name: 'ewa', pub: 'P-ewa' } as any
  hub.contactList = [contact]
  let opts: any = null
  hub.session = { open: async (_p: any, o: any) => { opts = o; return {} as any } } as any
  const events: HubEvent[] = []
  hub.on((e) => events.push(e))
  const presence = () => events.filter((e) => e.t === 'presence').map((e: any) => `${e.from}:${e.state}`)
  return { hub, contact, presence, room: async () => { await hub.room(contact); return opts } }
}

test('a room opened by their handshake, before any Announce, still brings them online', async () => {
  const { hub, contact, presence, room } = hubWithRoom()
  const o = await room()
  assert.equal(hub.online.has(contact.pub), false)
  o.onPresence('12D3peerA', 'join')
  assert.ok(hub.online.has(contact.pub), 'online once the room sees them')
  assert.deepEqual(presence(), ['ewa:online'])
})

test('online while any of their PeerIds is present; quiet and leave take it away', async () => {
  const { hub, contact, presence, room } = hubWithRoom()
  const o = await room()
  o.onPresence('A', 'join')
  o.onPresence('B', 'join')            // came back under a new PeerId
  o.onPresence('A', 'leave')           // the old one times out later
  assert.ok(hub.online.has(contact.pub), 'B is still there')
  o.onPresence('B', 'away')
  assert.ok(hub.online.has(contact.pub), 'away is present (a hidden tab)')
  o.onPresence('B', 'quiet')
  assert.equal(hub.online.has(contact.pub), false, 'quiet: nobody answering')
  o.onPresence('B', 'active')
  assert.ok(hub.online.has(contact.pub))
  o.onPresence('B', 'leave')
  assert.equal(hub.online.has(contact.pub), false)
  assert.deepEqual(presence(), ['ewa:online', 'ewa:offline', 'ewa:online', 'ewa:offline'], 'one event per change, not per PeerId')
})
