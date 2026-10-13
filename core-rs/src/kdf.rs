//! The one derivation convention (SPEC.md 1, 14): HKDF-SHA256 with the label
//! in `info` and the context in `salt`; HMAC-SHA256; SHA-256.

use hkdf::Hkdf;
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

pub fn sha256(data: &[u8]) -> [u8; 32] { Sha256::digest(data).into() }

/// `HKDF-SHA256(ikm, salt, info, L)` into `out`.
pub fn hkdf(ikm: &[u8], salt: &[u8], info: &[u8], out: &mut [u8]) {
    Hkdf::<Sha256>::new(Some(salt), ikm).expand(info, out).expect("hkdf length")
}

/// `kdf(label, ikm, ctx, L)` = HKDF(ikm, salt = ctx, info = label) - lib/wc.ts `kdf`.
pub fn kdf(label: &str, ikm: &[u8], ctx: &[u8], out: &mut [u8]) { hkdf(ikm, ctx, label.as_bytes(), out) }

/// The one AEAD nonce of 1:1 and group frames (7.2, 8.2): HKDF(MK, salt = u32be(n), info = "encedo-aead-nonce", 12).
pub fn aead_nonce(mk: &[u8; 32], n: u32) -> [u8; 12] {
    let mut out = [0u8; 12];
    kdf("encedo-aead-nonce", mk, &n.to_be_bytes(), &mut out);
    out
}

pub fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut m = HmacSha256::new_from_slice(key).expect("hmac key");
    for p in parts { m.update(p) }
    m.finalize().into_bytes().into()
}

/// Constant-time verification.
pub fn hmac_verify(key: &[u8], parts: &[&[u8]], tag: &[u8]) -> bool {
    let mut m = HmacSha256::new_from_slice(key).expect("hmac key");
    for p in parts { m.update(p) }
    m.verify_slice(tag).is_ok()
}

pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    use subtle::ConstantTimeEq;
    a.len() == b.len() && a.ct_eq(b).into()
}
