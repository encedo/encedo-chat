//! Double Ratchet with the hybrid step (SPEC.md 7.1-7.3), a port of
//! impl/eh2/ratchet.ts: same schedule, same header, same bounds, so the two
//! open each other's frames (impl/test/eh2-wasm.test.ts proves it) and the
//! known-answer vector of docs/kat/ratchet-hybrid.json is reproduced here.
//!
//! `decrypt` is transactional: every derivation runs on the side and state
//! moves only once the AEAD verified the frame.

use std::collections::BTreeMap;

use aes_gcm::{aead::{Aead, Payload}, Aes256Gcm, KeyInit, Nonce};
use zeroize::{Zeroize, Zeroizing};

use crate::handshake::{HandshakeResult, Role};
use crate::kdf::{aead_nonce, hkdf, kdf};
use crate::kem::{self, KemSecret};
use crate::rng::Rng;
use crate::x25519::Priv;

const RK_INFO: &[u8] = b"encedo-ratchet-dh-v1";
const RK_PQ_INFO: &[u8] = b"encedo-ratchet-hybrid-v1";
const MK_LABEL: &str = "encedo-msg-key";
const CK_LABEL: &str = "encedo-chain-key";

pub const T_DATA: u8 = 0x10;
pub const T_DATA_PQ: u8 = 0x11;
pub const VERSION: u8 = 3;
const HDR_LEN: usize = 2 + 32 + 4 + 4;
const PQ_CT: u8 = 0x01;
const PQ_PUB: u8 = 0x02;
pub const HDR_MAX: usize = HDR_LEN + 1 + 2 + kem::CT_LEN + 2 + kem::PK_LEN;

pub const PQ_EVERY_STEPS: u32 = 4;
pub const PQ_EVERY_MS: u64 = 30 * 60_000;
pub const MAX_SKIP_PER_CHAIN: u32 = 1000;
pub const MAX_CHAINS_BACK: usize = 5;
pub const SKIPPED_TTL_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RatchetError {
    /// A header claims a jump past the skip bound: drop the frame (7.3).
    SkipBound(u32),
}

#[derive(Clone, Copy, Debug)]
pub struct RatchetOpts {
    pub max_skip_per_chain: u32,
    pub max_chains_back: usize,
    pub skipped_ttl_ms: u64,
    pub pq_every_steps: u32,
    pub pq_every_ms: u64,
}
impl Default for RatchetOpts {
    fn default() -> Self {
        Self { max_skip_per_chain: MAX_SKIP_PER_CHAIN, max_chains_back: MAX_CHAINS_BACK, skipped_ttl_ms: SKIPPED_TTL_MS, pq_every_steps: PQ_EVERY_STEPS, pq_every_ms: PQ_EVERY_MS }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats { pub n_send: u32, pub n_recv: u32, pub skipped: usize, pub pq_outstanding: bool, pub pq_steps: u32 }

type Key = Zeroizing<[u8; 32]>;

struct Header { dh_pub: [u8; 32], pn: u32, n: u32, pq_ct: Option<Vec<u8>>, pq_pub: Option<Vec<u8>> }

fn encode_header(h: &Header) -> Vec<u8> {
    let pq = h.pq_ct.is_some() || h.pq_pub.is_some();
    let mut b = Vec::with_capacity(HDR_MAX);
    b.push(if pq { T_DATA_PQ } else { T_DATA }); b.push(VERSION);
    b.extend_from_slice(&h.dh_pub);
    b.extend_from_slice(&h.pn.to_be_bytes()); b.extend_from_slice(&h.n.to_be_bytes());
    if pq {
        b.push(if h.pq_ct.is_some() { PQ_CT } else { 0 } | if h.pq_pub.is_some() { PQ_PUB } else { 0 });
        for f in [&h.pq_ct, &h.pq_pub].into_iter().flatten() {
            b.extend_from_slice(&(f.len() as u16).to_be_bytes()); b.extend_from_slice(f);
        }
    }
    b
}

fn decode_header(frame: &[u8]) -> Option<(Header, usize)> {
    if frame.len() < HDR_LEN + 16 || frame[1] != VERSION { return None }
    let mut dh_pub = [0u8; 32]; dh_pub.copy_from_slice(&frame[2..34]);
    let pn = u32::from_be_bytes(frame[34..38].try_into().unwrap());
    let n = u32::from_be_bytes(frame[38..42].try_into().unwrap());
    let mut h = Header { dh_pub, pn, n, pq_ct: None, pq_pub: None };
    if frame[0] == T_DATA { return Some((h, HDR_LEN)) }
    if frame[0] != T_DATA_PQ { return None }
    let flags = frame[42];
    if flags == 0 || flags & !(PQ_CT | PQ_PUB) != 0 { return None }
    let mut o = 43;
    for which in [PQ_CT, PQ_PUB] {
        if flags & which == 0 { continue }
        if o + 2 > frame.len() { return None }
        let len = u16::from_be_bytes([frame[o], frame[o + 1]]) as usize; o += 2;
        if len == 0 || o + len > frame.len() { return None }
        let field = frame[o..o + len].to_vec(); o += len;
        if which == PQ_CT { h.pq_ct = Some(field) } else { h.pq_pub = Some(field) }
    }
    if frame.len() < o + 16 { return None }
    Some((h, o))
}

fn dh_step(rk: &[u8; 32], ikm: &[u8], info: &[u8]) -> (Key, Key) {
    let mut out = Zeroizing::new([0u8; 64]);
    hkdf(ikm, rk, info, &mut out[..]);
    let mut r = Zeroizing::new([0u8; 32]); r.copy_from_slice(&out[..32]);
    let mut c = Zeroizing::new([0u8; 32]); c.copy_from_slice(&out[32..]);
    (r, c)
}
fn message_key(ck: &[u8; 32]) -> Key { let mut k = Zeroizing::new([0u8; 32]); kdf(MK_LABEL, ck, &[], &mut k[..]); k }
fn chain_next(ck: &[u8; 32]) -> Key { let mut k = Zeroizing::new([0u8; 32]); kdf(CK_LABEL, ck, &[], &mut k[..]); k }

fn seal(mk: &[u8; 32], n: u32, header: &[u8], pt: &[u8]) -> Vec<u8> {
    let nonce: Nonce<aes_gcm::aead::consts::U12> = aead_nonce(mk, n).into();
    Aes256Gcm::new_from_slice(mk).unwrap().encrypt(&nonce, Payload { msg: pt, aad: header }).expect("aes-gcm")
}
fn open(mk: &[u8; 32], n: u32, header: &[u8], ct: &[u8]) -> Option<Vec<u8>> {
    let nonce: Nonce<aes_gcm::aead::consts::U12> = aead_nonce(mk, n).into();
    Aes256Gcm::new_from_slice(mk).unwrap().decrypt(&nonce, Payload { msg: ct, aad: header }).ok()
}

/// Walk a chain key forward, handing back the keys passed over. Pure.
fn advance(ck: &[u8; 32], from: u32, to: u32, max_skip: u32) -> Result<(Vec<Key>, Key), RatchetError> {
    if to.saturating_sub(from) > max_skip { return Err(RatchetError::SkipBound(to - from)) }
    let mut keys = Vec::new();
    let mut cur = Zeroizing::new(*ck);
    for _ in from..to {
        keys.push(message_key(&cur));
        cur = chain_next(&cur);
    }
    Ok((keys, cur))
}

/// Skipped message keys, bounded per 7.3: chains in insertion order (the oldest evicted first).
struct Skipped { chains: Vec<([u8; 32], BTreeMap<u32, (Key, u64)>)>, ttl_ms: u64, max_chains: usize }
impl Skipped {
    fn put(&mut self, dh_pub: [u8; 32], n: u32, mk: Key, now: u64) {
        let idx = match self.chains.iter().position(|(p, _)| *p == dh_pub) {
            Some(i) => i,
            None => {
                self.chains.push((dh_pub, BTreeMap::new()));
                while self.chains.len() > self.max_chains { self.chains.remove(0); }
                self.chains.len() - 1
            }
        };
        self.chains[idx].1.insert(n, (mk, now));
    }
    fn peek(&self, dh_pub: &[u8; 32], n: u32) -> Option<&Key> {
        self.chains.iter().find(|(p, _)| p == dh_pub).and_then(|(_, m)| m.get(&n)).map(|(k, _)| k)
    }
    fn drop_key(&mut self, dh_pub: &[u8; 32], n: u32) {
        if let Some(i) = self.chains.iter().position(|(p, _)| p == dh_pub) {
            self.chains[i].1.remove(&n);
            if self.chains[i].1.is_empty() { self.chains.remove(i); }
        }
    }
    fn prune(&mut self, now: u64) {
        let ttl = self.ttl_ms;
        for (_, m) in self.chains.iter_mut() { m.retain(|_, (_, ts)| now.saturating_sub(*ts) <= ttl) }
        self.chains.retain(|(_, m)| !m.is_empty());
    }
    fn size(&self) -> usize { self.chains.iter().map(|(_, m)| m.len()).sum() }
}

pub struct Ratchet {
    opts: RatchetOpts,
    rk: Key,
    dh_self: Option<Priv>,
    dh_peer_pub: [u8; 32],
    ck_send: Option<Key>,
    ck_recv: Option<Key>,
    n_send: u32, n_recv: u32, pn: u32,
    step_before_send: bool,
    skipped: Skipped,
    // the hybrid step (7.2)
    pq_key: Option<KemSecret>,
    pending_ss: Option<Key>,
    pending_ct: Option<Vec<u8>>,
    ct_in_flight: Option<Vec<u8>>,
    seen_peer_pq_pub: Option<Vec<u8>>,
    steps_since_pq: u32,
    last_pq_at: u64,
    pq_steps_done: u32,
}

impl Ratchet {
    /// From a completed handshake (on R only after `finish`: the msg3 gate).
    pub fn from_handshake(hs: HandshakeResult, opts: RatchetOpts, now_ms: u64) -> Self {
        let (rk, ck) = dh_step(&hs.sk, &hs.first_step_ikm[..], RK_INFO);
        let initiator = hs.role == Role::Initiator;
        Self {
            opts, rk,
            dh_self: hs.ek_self, dh_peer_pub: hs.ek_peer_pub,
            ck_send: if initiator { Some(ck.clone()) } else { None },
            ck_recv: if initiator { None } else { Some(ck) },
            n_send: 0, n_recv: 0, pn: 0,
            step_before_send: !initiator,
            skipped: Skipped { chains: Vec::new(), ttl_ms: opts.skipped_ttl_ms, max_chains: opts.max_chains_back },
            pq_key: None, pending_ss: None, pending_ct: None, ct_in_flight: None, seen_peer_pq_pub: None,
            steps_since_pq: 0, last_pq_at: now_ms, pq_steps_done: 0,
        }
    }

    pub fn stats(&self) -> Stats {
        Stats { n_send: self.n_send, n_recv: self.n_recv, skipped: self.skipped.size(), pq_outstanding: self.pq_key.is_some(), pq_steps: self.pq_steps_done }
    }
    pub fn dh_pub(&self) -> Option<[u8; 32]> { self.dh_self.as_ref().map(|d| d.public()) }

    pub fn encrypt(&mut self, rng: &mut dyn Rng, now_ms: u64, plaintext: &[u8]) -> Vec<u8> {
        if self.step_before_send || self.ck_send.is_none() {
            let me = Priv::generate(rng);
            let dh = me.dh(&self.dh_peer_pub);
            let (rk, ck) = if let Some(ss) = self.pending_ss.take() {
                let mut ikm = Zeroizing::new([0u8; 64]);
                ikm[..32].copy_from_slice(&dh[..]); ikm[32..].copy_from_slice(&ss[..]);
                let step = dh_step(&self.rk, &ikm[..], RK_PQ_INFO);
                self.ct_in_flight = self.pending_ct.take();
                self.steps_since_pq = 0; self.last_pq_at = now_ms; self.pq_steps_done += 1;
                step
            } else {
                self.steps_since_pq += 1;
                dh_step(&self.rk, &dh[..], RK_INFO)
            };
            self.rk = rk;
            self.ck_send = Some(ck);
            self.dh_self = Some(me);
            self.pn = self.n_send;
            self.n_send = 0;
            self.step_before_send = false;
            if self.pq_key.is_none() && (self.steps_since_pq >= self.opts.pq_every_steps || now_ms.saturating_sub(self.last_pq_at) >= self.opts.pq_every_ms) {
                self.pq_key = Some(KemSecret::generate(rng));
            }
        }
        let ck = self.ck_send.as_ref().unwrap();
        let mk = message_key(ck);
        let next = chain_next(ck);
        self.ck_send = Some(next);
        let header = encode_header(&Header {
            dh_pub: self.dh_self.as_ref().unwrap().public(), pn: self.pn, n: self.n_send,
            pq_ct: self.ct_in_flight.clone(), pq_pub: self.pq_key.as_ref().map(|k| k.public().to_vec()),
        });
        let ct = seal(&mk, self.n_send, &header, plaintext);
        self.n_send += 1;
        let mut frame = header; frame.extend_from_slice(&ct);
        frame
    }

    /// The peer's encapsulation key arrived on a frame that opened: answer it once.
    fn note_peer_pq_pub(&mut self, pub_key: Option<Vec<u8>>, m: [u8; 32]) {
        let Some(p) = pub_key else { return };
        if self.seen_peer_pq_pub.as_ref() == Some(&p) { return }
        if let Some((ct, ss)) = kem::encapsulate(&p, m) {
            self.pending_ss = Some(ss); self.pending_ct = Some(ct); self.seen_peer_pq_pub = Some(p);
        }
    }

    /// Ok(None): not ours, tampered, or a replay. Err: a jump past the skip bound.
    pub fn decrypt(&mut self, rng: &mut dyn Rng, now_ms: u64, frame: &[u8]) -> Result<Option<Vec<u8>>, RatchetError> {
        let Some((h, hdr_len)) = decode_header(frame) else { return Ok(None) };
        let (header, ct) = frame.split_at(hdr_len);
        self.skipped.prune(now_ms);
        let max_skip = self.opts.max_skip_per_chain;

        // 1. A key derived for a message that overtook this one?
        if let Some(mk) = self.skipped.peek(&h.dh_pub, h.n) {
            let pt = open(mk, h.n, header, ct);
            if pt.is_some() {
                self.skipped.drop_key(&h.dh_pub, h.n);
                self.note_peer_pq_pub(h.pq_pub, rng.kem_m());
            }
            return Ok(pt)
        }

        let same_key = h.dh_pub == self.dh_peer_pub;
        if same_key && self.ck_recv.is_none() { return Ok(None) }

        // 2. Same chain: walk forward.
        if same_key {
            if h.n < self.n_recv { return Ok(None) }
            let ck = self.ck_recv.as_ref().unwrap();
            let (keys, at) = advance(ck, self.n_recv, h.n, max_skip)?;
            let mk = message_key(&at);
            let next = chain_next(&at);
            let Some(pt) = open(&mk, h.n, header, ct) else { return Ok(None) };
            let start = self.n_recv;
            for (i, k) in keys.into_iter().enumerate() { self.skipped.put(h.dh_pub, start + i as u32, k, now_ms) }
            self.ck_recv = Some(next);
            self.n_recv = h.n + 1;
            self.note_peer_pq_pub(h.pq_pub, rng.kem_m());
            return Ok(Some(pt))
        }

        // 3. The conversation turned: close the current receiving chain, step the root, walk the new chain.
        let Some(me) = self.dh_self.as_ref() else { return Ok(None) };
        if h.pq_ct.is_some() && self.pq_key.is_none() { return Ok(None) }
        let closing = match self.ck_recv.as_ref() { Some(ck) => Some(advance(ck, self.n_recv, h.pn, max_skip)?), None => None };
        let dh = me.dh(&h.dh_pub);
        let (rk, ck) = if let Some(pq_ct) = h.pq_ct.as_ref() {
            let Some(ss) = self.pq_key.as_ref().unwrap().decapsulate(pq_ct) else { return Ok(None) };
            let mut ikm = Zeroizing::new([0u8; 64]);
            ikm[..32].copy_from_slice(&dh[..]); ikm[32..].copy_from_slice(&ss[..]);
            dh_step(&self.rk, &ikm[..], RK_PQ_INFO)
        } else {
            dh_step(&self.rk, &dh[..], RK_INFO)
        };
        let (keys, at) = advance(&ck, 0, h.n, max_skip)?;
        let mk = message_key(&at);
        let next = chain_next(&at);
        let Some(pt) = open(&mk, h.n, header, ct) else { return Ok(None) };

        if let Some((ckeys, _)) = closing {
            let start = self.n_recv;
            let old_pub = self.dh_peer_pub;
            for (i, k) in ckeys.into_iter().enumerate() { self.skipped.put(old_pub, start + i as u32, k, now_ms) }
        }
        for (i, k) in keys.into_iter().enumerate() { self.skipped.put(h.dh_pub, i as u32, k, now_ms) }
        self.rk.zeroize();
        self.rk = rk;
        self.ck_recv = Some(next);
        self.dh_peer_pub = h.dh_pub;
        self.n_recv = h.n + 1;
        self.step_before_send = true;
        self.ct_in_flight = None;
        if h.pq_ct.is_some() {
            self.pq_key = None; self.steps_since_pq = 0; self.last_pq_at = now_ms; self.pq_steps_done += 1;
        }
        self.note_peer_pq_pub(h.pq_pub, rng.kem_m());
        Ok(Some(pt))
    }
}
