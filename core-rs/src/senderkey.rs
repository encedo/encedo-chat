//! Group Sender Keys (SPEC.md 8, impl/lib/senderkey.ts) in Rust. One member's
//! sending chain: a symmetric hash-ratchet, a fresh message key per message,
//! no DH ratchet (post-compromise recovery for a group comes from epoch
//! rotation, not the chain). The per-recipient MAC key `mk_ij` is derived by
//! the caller (it needs the identities); this module applies and verifies the
//! HMAC over `header || ct`, and the receiver walks a copy of the chain.
//!
//! The known-answer vector docs/kat/group-senderkey.json is reproduced in
//! core-rs/tests/kat.rs, the same bytes as the TypeScript engine.

use std::collections::BTreeMap;

use aes_gcm::{aead::{Aead, Payload}, Aes256Gcm, KeyInit, Nonce};
use zeroize::{Zeroize, Zeroizing};

use crate::kdf::{aead_nonce, ct_eq, hmac, kdf};

const MK_LABEL: &str = "encedo-group-msg";
const CK_LABEL: &str = "encedo-group-chain";

pub const MAX_SKIP: u32 = 2000;
pub const SKIPPED_TTL_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SenderKeyError {
    /// A header claims a jump past the skip bound: drop the frame (8.2).
    SkipBound(u32),
}

type Key = Zeroizing<[u8; 32]>;

fn msg_key(ck: &[u8; 32]) -> Key { let mut k = Zeroizing::new([0u8; 32]); kdf(MK_LABEL, ck, &[], &mut k[..]); k }
fn chain_next(ck: &[u8; 32]) -> Key { let mut k = Zeroizing::new([0u8; 32]); kdf(CK_LABEL, ck, &[], &mut k[..]); k }

fn seal_body(mk: &[u8; 32], n: u32, header: &[u8], pt: &[u8]) -> Vec<u8> {
    let nonce: Nonce<aes_gcm::aead::consts::U12> = aead_nonce(mk, n).into();
    Aes256Gcm::new_from_slice(mk).unwrap().encrypt(&nonce, Payload { msg: pt, aad: header }).expect("aes-gcm")
}
fn open_body(mk: &[u8; 32], n: u32, header: &[u8], ct: &[u8]) -> Option<Vec<u8>> {
    let nonce: Nonce<aes_gcm::aead::consts::U12> = aead_nonce(mk, n).into();
    Aes256Gcm::new_from_slice(mk).unwrap().decrypt(&nonce, Payload { msg: ct, aad: header }).ok()
}

/// MAC over `header || ct` for one recipient, under `mk_ij`.
pub fn tag(mk_ij: &[u8], header: &[u8], ct: &[u8]) -> [u8; 32] { hmac(mk_ij, &[header, ct]) }
/// Constant-time verify.
pub fn verify(mk_ij: &[u8], header: &[u8], ct: &[u8], mac: &[u8]) -> bool { ct_eq(&tag(mk_ij, header, ct), mac) }

/// A member's own sending chain.
pub struct SendChain { key: Key, n: u32 }
impl SendChain {
    pub fn from_key(key: [u8; 32]) -> Self { Self { key: Zeroizing::new(key), n: 0 } }
    pub fn position(&self) -> u32 { self.n }
    /// Seal at the current position, then advance. Returns (counter, ciphertext).
    pub fn seal(&mut self, header: &[u8], plaintext: &[u8]) -> (u32, Vec<u8>) {
        let mk = msg_key(&self.key);
        let n = self.n;
        let ct = seal_body(&mk, n, header, plaintext);
        self.key = chain_next(&self.key);
        self.n += 1;
        (n, ct)
    }
}

/// A copy of one sender's chain. Walks forward to a counter, holding skipped
/// keys (bounded), transactional: state moves only once the AEAD opens.
pub struct SenderReceiver {
    key: Key,
    n: u32,
    skipped: BTreeMap<u32, (Key, u64)>,
    max_skip: u32,
    ttl_ms: u64,
}

impl SenderReceiver {
    pub fn new(chain_key: [u8; 32]) -> Self {
        Self { key: Zeroizing::new(chain_key), n: 0, skipped: BTreeMap::new(), max_skip: MAX_SKIP, ttl_ms: SKIPPED_TTL_MS }
    }
    pub fn at(chain_key: [u8; 32], n: u32) -> Self { let mut r = Self::new(chain_key); r.n = n; r }
    pub fn with_bounds(mut self, max_skip: u32, ttl_ms: u64) -> Self { self.max_skip = max_skip; self.ttl_ms = ttl_ms; self }

    fn prune(&mut self, now: u64) {
        let ttl = self.ttl_ms;
        self.skipped.retain(|_, (_, ts)| now.saturating_sub(*ts) <= ttl);
    }

    /// Ok(Some): plaintext; Ok(None): foreign, tampered, or a replay of a spent
    /// key; Err: a jump past the skip bound.
    pub fn open(&mut self, now: u64, n: u32, header: &[u8], ct: &[u8]) -> Result<Option<Vec<u8>>, SenderKeyError> {
        self.prune(now);

        // 1. A key derived for a message that overtook this one.
        if self.skipped.contains_key(&n) {
            let pt = open_body(&self.skipped[&n].0, n, header, ct);
            if pt.is_some() { self.skipped.remove(&n); }
            return Ok(pt);
        }
        if n < self.n { return Ok(None); } // passed and not stashed -> replay
        if n - self.n > self.max_skip { return Err(SenderKeyError::SkipBound(n - self.n)); }

        // 2. Walk forward to n, deriving the keys passed over. Pure until the AEAD verifies.
        let mut cur = self.key.clone();
        let mut passed: Vec<(u32, Key)> = Vec::new();
        for i in self.n..n {
            passed.push((i, msg_key(&cur)));
            cur = chain_next(&cur);
        }
        let mk_n = msg_key(&cur);
        let next_ck = chain_next(&cur);
        let Some(pt) = open_body(&mk_n, n, header, ct) else { return Ok(None) }; // forged -> burn nothing

        let t = now;
        for (i, mk) in passed { self.skipped.insert(i, (mk, t)); }
        self.key = next_ck;
        self.n = n + 1;
        Ok(Some(pt))
    }

    pub fn position(&self) -> u32 { self.n }
    pub fn skipped_len(&self) -> usize { self.skipped.len() }
    /// The live chain position for persistence (SPEC.md 10); skipped keys dropped.
    pub fn snapshot(&self) -> ([u8; 32], u32) { (*self.key, self.n) }
}

impl Drop for SenderReceiver {
    fn drop(&mut self) { for (_, (k, _)) in self.skipped.iter_mut() { k.zeroize() } }
}
