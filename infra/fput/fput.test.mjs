// Caly serwis przeciw udawanemu Kubo: co przyjdzie od klienta, ma dotrzec do
// magazynu z prefiksem i z nietknieta reszta ramki. Offline, bez sieci.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'

const HDR = Buffer.from([0x45, 0x43, 0x46, 0x31, 1, 0, 0, 0])

let kubo, seen, fput, base

before(async () => {
  // Udawane Kubo: zbiera cale cialo i zapamietuje sciezke, ktora dostalo.
  kubo = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen = { path: req.url, body: Buffer.concat(chunks), headers: req.headers }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"Name":"b","Hash":"QmTest","Size":"1"}\n')
    })
  })
  kubo.listen(0, '127.0.0.1')
  await once(kubo, 'listening')

  process.env.IPFS_RPC = `http://127.0.0.1:${kubo.address().port}`
  process.env.PORT = '0'
  ;({ server: fput } = await import('./fput.mjs'))
  if (!fput.listening) await once(fput, 'listening')
  base = `http://127.0.0.1:${fput.address().port}/`
})

after(() => { fput?.close(); kubo?.close() })

const upload = (payload) => {
  const form = new FormData()
  form.append('file', new Blob([payload]), 'b')
  return fetch(base, { method: 'POST', body: form })
}

test('the store receives the payload with the header in front of it', async () => {
  const res = await upload(Buffer.from('SZYFROGRAM'))
  assert.equal(res.status, 200)
  assert.match(await res.text(), /QmTest/)

  const at = seen.body.indexOf('\r\n\r\n') + 4
  assert.deepEqual([...seen.body.subarray(at, at + 8)], [...HDR])
  assert.equal(seen.body.subarray(at + 8, at + 18).toString(), 'SZYFROGRAM')
  // The multipart frame must survive, or Kubo answers 400 and files stop working.
  assert.match(seen.body.toString('latin1'), /--\r\n$|--\r\n/)
})

test('the ledger name is in SECONDS, which is the unit the sweeper compares', async () => {
  // The bug this pins, found in production rather than here: milliseconds read
  // as a date fifty thousand years out, so `now - ts` is negative, the entry
  // never reaches its deadline, and ipfs-ttl.sh says nothing — it leaves names
  // it does not understand alone on purpose. The blob stays on the node forever.
  await upload(Buffer.from('x'))
  const to = new URL(`http://x${seen.path}`).searchParams.get('to-files')
  const m = /^\/ec\/(\d{10})-([0-9a-f]{16})$/.exec(to)
  assert.ok(m, `to-files was ${to}`)
  assert.ok(Math.abs(Math.floor(Date.now() / 1000) - Number(m[1])) < 60)
  assert.match(seen.path, /pin=false/)
})

test('nothing reaches the store with our own length or user agent', async () => {
  await upload(Buffer.from('x'))
  // The prefix makes the body longer, so a forwarded content-length would cut
  // eight bytes off the end. Chunked is the only correct answer here.
  assert.equal(seen.headers['content-length'], undefined)
  assert.equal(seen.headers['transfer-encoding'], 'chunked')
  assert.equal(seen.headers['user-agent'], 'encedo-proxy')
})

test('a body that is not multipart is refused before the store sees it', async () => {
  seen = undefined
  const res = await fetch(base, { method: 'POST', body: 'plain bytes' })
  assert.equal(res.status, 415)
  assert.equal(seen, undefined)
})

test('GET is not an upload', async () => {
  const res = await fetch(base)
  assert.equal(res.status, 405)
})

test('a megabyte survives byte for byte', async () => {
  const payload = Buffer.alloc(1024 * 1024, 0x5a)
  await upload(payload)
  const at = seen.body.indexOf('\r\n\r\n') + 4
  assert.deepEqual([...seen.body.subarray(at, at + 8)], [...HDR])
  assert.ok(seen.body.subarray(at + 8, at + 8 + payload.length).equals(payload))
})
