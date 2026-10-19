import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { qrMatrix } from '../lib/qr.ts'
import { openEnvelope, rootPubFor } from '../lib/netprofile.ts'
// @ts-ignore - plain .mjs, no types
import { signerFrom, newKeyFile } from '../../scripts/lib/signer.mjs'
// @ts-ignore
import { ed25519FromSpki } from '../../scripts/yubikey-sign.mjs'

const OPS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'onchato-ops.mjs')
const NODES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'nodes-other.json')
const ops = (cwd: string, ...a: string[]) => spawnSync(process.execPath, [OPS, ...a], { cwd, encoding: 'utf8' })
const PROFILE = {
  v: 1, networkId: 'acme-test', operator: 'ACME Test',
  app: { origin: 'https://chat.acme.example', path: '/' }, stores: ['https://files.acme.example'],
  profileUrls: ['https://acme.example/onchato/network.json'], feedback: null, home: 'https://acme.example/',
}
const withDir = (f: (d: string) => void) => { const d = mkdtempSync(join(tmpdir(), 'ec-ops-')); try { f(d) } finally { rmSync(d, { recursive: true, force: true }) } }

test('a key file signs what netprofile.ts accepts, under the key it reports', () => withDir((d) => {
  const pub = newKeyFile(join(d, 'k'))
  const s = signerFrom((n: string, def?: string) => (n === '--sign' ? join(d, 'k') : def), () => false)
  assert.equal(s.pub(), pub)
  const priv = readFileSync(join(d, 'k'), 'utf8').trim().split('\n').pop()!
  assert.equal(rootPubFor(priv), pub, 'the file is in the format the release scripts and lib read')
  assert.throws(() => newKeyFile(join(d, 'k')), /refusing to overwrite/)
}))

test('the public key is read from an Ed25519 SPKI and nothing else', () => {
  const { publicKey } = generateKeyPairSync('ed25519')
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64')
  assert.equal(ed25519FromSpki(publicKey.export({ format: 'der', type: 'spki' })), raw)
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' })
  assert.equal(ed25519FromSpki(ec), null)
  assert.equal(ed25519FromSpki(Buffer.alloc(44)), null)
})

test('network sign -> check: the file opens; seq climbs; rollback, another key and tampering are refused', () => withDir((d) => {
  writeFileSync(join(d, 'p.json'), JSON.stringify(PROFILE))
  assert.equal(ops(d, 'network', 'key', '--file', 'root.key').status, 0)
  const sign = (...a: string[]) => ops(d, 'network', 'sign', 'p.json', '--nodes', NODES, '--out', 'n.json', ...a)
  let r = sign('--sign', 'root.key'); assert.equal(r.status, 0, r.stderr)
  const one = openEnvelope(readFileSync(join(d, 'n.json'), 'utf8'), Date.now())
  assert.ok(one.ok && one.profile.seq === 1 && one.profile.nodes.length === 1)
  r = sign('--sign', 'root.key'); assert.equal(r.status, 0, r.stderr)
  const two = openEnvelope(readFileSync(join(d, 'n.json'), 'utf8'), Date.now())
  assert.ok(two.ok && two.profile.seq === 2, 'a re-sign goes one above the file it replaces')
  assert.match(sign('--sign', 'root.key', '--seq', '2').stderr, /rollback/)
  ops(d, 'network', 'key', '--file', 'other.key')
  assert.match(sign('--sign', 'other.key').stderr, /ANOTHER root key/)
  assert.match(sign('--sign', 'other.key', '--out', 'x.json', '--root-pub', two.ok ? two.profile.rootPub : '').stderr, /does not open/, 'a --root-pub that is not the signing key never writes a file')
  assert.equal(ops(d, 'network', 'check', 'n.json').status, 0)
  const env = JSON.parse(readFileSync(join(d, 'n.json'), 'utf8'))
  env.sig = (env.sig[0] === 'A' ? 'B' : 'A') + env.sig.slice(1)
  writeFileSync(join(d, 'bad.json'), JSON.stringify(env))
  assert.match(ops(d, 'network', 'check', 'bad.json').stderr, /refused \(signature\)/)
}))

test('network link prints a pointer the app parses, and a QR code', () => withDir((d) => {
  writeFileSync(join(d, 'p.json'), JSON.stringify(PROFILE))
  ops(d, 'network', 'key', '--file', 'root.key')
  ops(d, 'network', 'sign', 'p.json', '--nodes', NODES, '--sign', 'root.key', '--out', 'n.json')
  const r = ops(d, 'network', 'link', 'https://acme.example/onchato/network.json', 'n.json', '--svg', 'q.svg', '--png', 'q.png')
  assert.equal(r.status, 0, r.stderr)
  const link = r.stdout.split('\n')[0]
  assert.match(link, /^https:\/\/acme\.example\/onchato\/network\.json#onchato-net=b[a-z2-7]{50,}$/)
  assert.match(readFileSync(join(d, 'q.svg'), 'utf8'), /^<svg/)
  // The PNG: a real one, the size of the matrix + quiet zone at 10 px, the same
  // modules as the matrix (top-left finder dark, quiet zone light).
  const png = readFileSync(join(d, 'q.png'))
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  const w = png.readUInt32BE(16), n = qrMatrix(link).length
  assert.equal(w, (n + 8) * 10)
  const idat = png.indexOf('IDAT'), len = png.readUInt32BE(idat - 4)
  const px = inflateSync(png.subarray(idat + 4, idat + 4 + len))
  const at = (x: number, y: number) => px[y * (w + 1) + 1 + x]
  assert.equal(at(5, 5), 255, 'the quiet zone is not light')
  assert.equal(at(45, 45), 0, 'the finder corner is not dark')
  assert.equal(at(40 + 15, 40 + 15), qrMatrix(link)[1][1] ? 0 : 255)
}))

test('a passphrase key: weak refused, the same passphrase signs, a wrong one never does, nothing secret on disk', () => withDir((d) => {
  const run = (input: string, ...a: string[]) => spawnSync(process.execPath, [OPS, ...a], { cwd: d, encoding: 'utf8', input })
  writeFileSync(join(d, 'p.json'), JSON.stringify(PROFILE))
  assert.match(run('haslo123\n', 'network', 'key', '--passphrase-new', 'root.kdf').stderr, /too weak/)
  const PASS = 'zielony kubek dwa tramwaje nad Wisla'
  const made = run(PASS + '\n', 'network', 'key', '--passphrase-new', 'root.kdf')
  assert.equal(made.status, 0, made.stderr)
  const kdf = JSON.parse(readFileSync(join(d, 'root.kdf'), 'utf8'))
  assert.deepEqual(Object.keys(kdf).sort(), ['alg', 'memoryKiB', 'parallelism', 'passes', 'pub', 'salt', 'v'], 'the file holds a secret it should not')
  assert.ok(kdf.memoryKiB >= 262144 && kdf.passes >= 4, 'weak Argon2 parameters')
  assert.match(run(PASS + '\n', 'network', 'key', '--passphrase-new', 'root.kdf').stderr, /refusing to replace/)
  const sign = (pw: string) => run(pw + '\n', 'network', 'sign', 'p.json', '--nodes', NODES, '--sign-passphrase', 'root.kdf', '--out', 'n.json')
  assert.match(sign('zle haslo zupelnie inne niz tamto').stderr, /wrong passphrase/)
  assert.throws(() => readFileSync(join(d, 'n.json')), 'a wrong passphrase wrote a file')
  assert.equal(sign(PASS).status, 0)
  const env = openEnvelope(readFileSync(join(d, 'n.json'), 'utf8'), Date.now())
  assert.ok(env.ok && env.profile.rootPub === kdf.pub, 'signed under another key than the file names')
}))
