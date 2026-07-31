/**
 * mqtt.ts — a minimal MQTT 3.1.1 client, written by hand, no dependencies.
 *
 * MQTT is the **fall-back transport** (libp2p stays the main one), so what is
 * implemented here is exactly the subset a rendezvous needs and nothing else:
 * CONNECT, SUBSCRIBE, UNSUBSCRIBE, PUBLISH at QoS 0, PING and DISCONNECT.
 *
 * The subset is deliberate rather than lazy. QoS 1/2, retained messages and
 * persistent sessions are the features that make a broker STORE things — and
 * "no server-side storage" is a product decision here, not an oversight (see
 * README). Not implementing them is the cheapest way to guarantee we never
 * accidentally turn them on. Everything above this layer already assumes an
 * unreliable, fire-and-forget channel: acks, re-sends and ordering live in
 * `lib/room.ts` and work the same over GossipSub.
 *
 * Two link types, one protocol: `ws://` / `wss://` (the browser, and how the
 * relay is reached in production through nginx) and `mqtt://` / `tcp://` (Node
 * only, for local development and tests).
 */

const enc = new TextEncoder()
const dec = new TextDecoder()

// packet types (high nibble of byte 0)
const CONNECT = 0x10, CONNACK = 0x20, PUBLISH = 0x30, SUBSCRIBE = 0x82, SUBACK = 0x90
const UNSUBSCRIBE = 0xa2, UNSUBACK = 0xb0, PINGREQ = 0xc0, PINGRESP = 0xd0, DISCONNECT = 0xe0

/** MQTT's variable-length integer: 7 bits per byte, high bit = "more". */
function encodeLength(n: number): number[] {
  const out: number[] = []
  do {
    let b = n % 128
    n = Math.floor(n / 128)
    if (n > 0) b |= 0x80
    out.push(b)
  } while (n > 0)
  return out
}

function decodeLength(buf: Uint8Array, at: number): { value: number; next: number } | null {
  let mult = 1, value = 0, i = at
  for (;;) {
    if (i >= buf.length) return null // packet still incomplete
    const b = buf[i++]
    value += (b & 0x7f) * mult
    if ((b & 0x80) === 0) return { value, next: i }
    mult *= 128
    if (mult > 128 ** 3) throw new Error('malformed remaining length')
  }
}

const str = (s: string): number[] => {
  const b = enc.encode(s)
  return [b.length >> 8, b.length & 0xff, ...b]
}

function packet(type: number, body: number[]): Uint8Array {
  return Uint8Array.from([type, ...encodeLength(body.length), ...body])
}

/** The byte pipe underneath: a WebSocket in the browser, a TCP socket in Node. */
export interface MqttLink {
  send(bytes: Uint8Array): void
  close(): void
  readonly open: boolean
}

export interface MqttOpts {
  url: string
  clientId: string
  keepAliveSec?: number
  onMessage: (topic: string, payload: Uint8Array) => void
  onOpen?: () => void
  onClose?: (why: string) => void
  onLog?: (msg: string) => void
}

export interface MqttClient {
  subscribe(topic: string): Promise<void>
  unsubscribe(topic: string): Promise<void>
  publish(topic: string, payload: Uint8Array): void
  readonly connected: boolean
  close(): void
}

/** Open the byte pipe for a URL. Node gets TCP for `mqtt://`; browsers only ws. */
async function connectLink(url: string, onData: (b: Uint8Array) => void, onClose: (why: string) => void): Promise<MqttLink> {
  if (/^wss?:\/\//.test(url)) {
    const ws = new WebSocket(url, 'mqtt')
    ws.binaryType = 'arraybuffer'
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true })
      ws.addEventListener('error', () => rej(new Error(`cannot reach ${url}`)), { once: true })
    })
    ws.addEventListener('message', (e: any) => onData(new Uint8Array(e.data as ArrayBuffer)))
    ws.addEventListener('close', () => onClose('websocket closed'))
    return { send: (b) => ws.send(b), close: () => ws.close(), get open() { return ws.readyState === 1 } }
  }
  // Node-only TCP path (development, tests, and a CLI that does not need a proxy).
  const { createConnection } = await import('node:net')
  const m = /^(?:mqtt|tcp):\/\/([^:/]+)(?::(\d+))?/.exec(url)
  if (!m) throw new Error(`unsupported MQTT url: ${url}`)
  const sock = createConnection({ host: m[1], port: Number(m[2] ?? 1883) })
  await new Promise<void>((res, rej) => {
    sock.once('connect', () => res())
    sock.once('error', (e) => rej(e))
  })
  sock.on('data', (b: Buffer) => onData(new Uint8Array(b)))
  sock.on('close', () => onClose('socket closed'))
  sock.on('error', () => {})
  return { send: (b) => sock.write(b), close: () => sock.destroy(), get open() { return !sock.destroyed } }
}

export async function mqttConnect(opts: MqttOpts): Promise<MqttClient> {
  const log = opts.onLog ?? (() => {})
  const keepAlive = opts.keepAliveSec ?? 30
  let closed = false
  let acked = false
  let nextId = 1
  const waiting = new Map<number, () => void>()
  let buf = new Uint8Array(0)

  const onClose = (why: string) => {
    if (closed) return
    closed = true
    clearInterval(ping)
    opts.onClose?.(why)
  }

  const handle = (type: number, flags: number, body: Uint8Array) => {
    switch (type) {
      case CONNACK: {
        if (body[1] !== 0) { onClose(`broker refused the connection (code ${body[1]})`); return }
        acked = true
        opts.onOpen?.()
        break
      }
      case PUBLISH: {
        // QoS 0 only: no packet id in the variable header.
        const tlen = (body[0] << 8) | body[1]
        const topic = dec.decode(body.subarray(2, 2 + tlen))
        opts.onMessage(topic, body.subarray(2 + tlen))
        break
      }
      case SUBACK:
      case UNSUBACK: {
        const id = (body[0] << 8) | body[1]
        waiting.get(id)?.()
        waiting.delete(id)
        break
      }
      case PINGRESP: break
      default: log(`ignoring MQTT packet type 0x${type.toString(16)} (flags ${flags})`)
    }
  }

  /** Feed bytes; a TCP stream splits and coalesces packets freely. */
  const onData = (chunk: Uint8Array) => {
    const merged = new Uint8Array(buf.length + chunk.length)
    merged.set(buf); merged.set(chunk, buf.length)
    buf = merged
    for (;;) {
      if (buf.length < 2) return
      const len = decodeLength(buf, 1)
      if (!len || buf.length < len.next + len.value) return
      const first = buf[0]
      handle(first & 0xf0, first & 0x0f, buf.subarray(len.next, len.next + len.value))
      buf = buf.subarray(len.next + len.value)
    }
  }

  const link = await connectLink(opts.url, onData, onClose)

  // CONNECT: clean session, no will, no credentials. Clean session matters —
  // a persistent one asks the broker to queue messages for us while we are away,
  // which is precisely the storage we do not want it doing.
  link.send(packet(CONNECT, [
    ...str('MQTT'), 4, 0x02, keepAlive >> 8, keepAlive & 0xff, ...str(opts.clientId),
  ]))
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('broker did not answer CONNECT')), 10_000)
    const started = Date.now()
    const check = setInterval(() => {
      if (acked) { clearInterval(check); clearTimeout(t); res() }
      else if (closed) { clearInterval(check); clearTimeout(t); rej(new Error('connection closed during CONNECT')) }
      else if (Date.now() - started > 10_000) { clearInterval(check); clearTimeout(t); rej(new Error('CONNECT timed out')) }
    }, 10)
  })

  const ping = setInterval(() => { if (!closed && link.open) link.send(packet(PINGREQ, [])) }, keepAlive * 500)
  ;(ping as any).unref?.()

  const await_ = (id: number) => new Promise<void>((res) => {
    waiting.set(id, res)
    setTimeout(() => { if (waiting.delete(id)) res() }, 5_000) // a broker that stays silent is the room's problem, not ours
  })

  return {
    get connected() { return !closed && link.open && acked },
    async subscribe(topic: string) {
      const id = nextId++ & 0xffff
      link.send(packet(SUBSCRIBE, [id >> 8, id & 0xff, ...str(topic), 0]))
      await await_(id)
    },
    async unsubscribe(topic: string) {
      const id = nextId++ & 0xffff
      link.send(packet(UNSUBSCRIBE, [id >> 8, id & 0xff, ...str(topic)]))
      await await_(id)
    },
    publish(topic: string, payload: Uint8Array) {
      if (closed || !link.open) return
      link.send(packet(PUBLISH, [...str(topic), ...payload]))
    },
    close() {
      if (!closed) { try { link.send(packet(DISCONNECT, [])) } catch {} }
      onClose('closed by us')
      try { link.close() } catch {}
    },
  }
}
