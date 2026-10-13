//! EH-2 handshake frames and transcript hashes (SPEC.md 6.1-6.2). Canonical by
//! construction: fixed order and widths, explicit lengths, no trailing bytes.

use crate::kdf::sha256;
use crate::kem::{CT_LEN, PK_LEN};

pub const VERSION: u8 = 3;
pub const T_MSG1: u8 = 0x01;
pub const T_MSG2: u8 = 0x02;
pub const T_MSG3: u8 = 0x03;
pub const MSG1_LEN: usize = 2 + 32 + 2 + PK_LEN + 8 + 32;
pub const MSG2_LEN: usize = 2 + 32 + 2 + CT_LEN + 8 + 32;
pub const MSG3_LEN: usize = 2 + 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireError(pub &'static str);

pub struct Msg1 { pub ek_pub: [u8; 32], pub pq_pub: Vec<u8>, pub ts: u64, pub initiator_tag: [u8; 32] }
pub struct Msg2 { pub ek_pub: [u8; 32], pub pq_ct: Vec<u8>, pub ts: u64, pub mac_r: [u8; 32] }
pub struct Msg3 { pub mac_i: [u8; 32] }

fn header(b: &[u8], want: u8, len: usize) -> Result<(), WireError> {
    if b.len() < 2 { return Err(WireError("truncated header")) }
    if b[0] != want { return Err(WireError("wrong frame type")) }
    if b[1] != VERSION { return Err(WireError("unsupported version")) }
    if b.len() != len { return Err(WireError("length does not fit")) }
    Ok(())
}
fn arr32(b: &[u8]) -> [u8; 32] { let mut a = [0u8; 32]; a.copy_from_slice(b); a }

pub fn encode_msg1(m: &Msg1) -> Vec<u8> {
    let mut b = Vec::with_capacity(MSG1_LEN);
    b.extend_from_slice(&[T_MSG1, VERSION]);
    b.extend_from_slice(&m.ek_pub);
    b.extend_from_slice(&(m.pq_pub.len() as u16).to_be_bytes());
    b.extend_from_slice(&m.pq_pub);
    b.extend_from_slice(&m.ts.to_be_bytes());
    b.extend_from_slice(&m.initiator_tag);
    b
}
pub fn decode_msg1(b: &[u8]) -> Result<Msg1, WireError> {
    header(b, T_MSG1, MSG1_LEN)?;
    let ek_pub = arr32(&b[2..34]);
    let n = u16::from_be_bytes([b[34], b[35]]) as usize;
    if n != PK_LEN { return Err(WireError("msg1.pq_pub must be ML-KEM-768")) }
    let pq_pub = b[36..36 + n].to_vec();
    let o = 36 + n;
    let ts = u64::from_be_bytes(b[o..o + 8].try_into().unwrap());
    let initiator_tag = arr32(&b[o + 8..o + 40]);
    Ok(Msg1 { ek_pub, pq_pub, ts, initiator_tag })
}

pub fn encode_msg2(m: &Msg2) -> Vec<u8> {
    let mut b = Vec::with_capacity(MSG2_LEN);
    b.extend_from_slice(&[T_MSG2, VERSION]);
    b.extend_from_slice(&m.ek_pub);
    b.extend_from_slice(&(m.pq_ct.len() as u16).to_be_bytes());
    b.extend_from_slice(&m.pq_ct);
    b.extend_from_slice(&m.ts.to_be_bytes());
    b.extend_from_slice(&m.mac_r);
    b
}
pub fn decode_msg2(b: &[u8]) -> Result<Msg2, WireError> {
    header(b, T_MSG2, MSG2_LEN)?;
    let ek_pub = arr32(&b[2..34]);
    let n = u16::from_be_bytes([b[34], b[35]]) as usize;
    if n != CT_LEN { return Err(WireError("msg2.pq_ct must be ML-KEM-768")) }
    let pq_ct = b[36..36 + n].to_vec();
    let o = 36 + n;
    let ts = u64::from_be_bytes(b[o..o + 8].try_into().unwrap());
    let mac_r = arr32(&b[o + 8..o + 40]);
    Ok(Msg2 { ek_pub, pq_ct, ts, mac_r })
}

pub fn encode_msg3(m: &Msg3) -> Vec<u8> {
    let mut b = Vec::with_capacity(MSG3_LEN);
    b.extend_from_slice(&[T_MSG3, VERSION]);
    b.extend_from_slice(&m.mac_i);
    b
}
pub fn decode_msg3(b: &[u8]) -> Result<Msg3, WireError> {
    header(b, T_MSG3, MSG3_LEN)?;
    Ok(Msg3 { mac_i: arr32(&b[2..34]) })
}

/// `h1 = SHA-256(serialize(msg1))`
pub fn h1(msg1: &[u8]) -> [u8; 32] { sha256(msg1) }
/// `h2_partial = SHA-256(serialize(msg1) || EK_r_pub || pq_ct || u64be(ts_r))`
pub fn h2_partial(msg1: &[u8], ek_r_pub: &[u8; 32], pq_ct: &[u8], ts_r: u64) -> [u8; 32] {
    let mut v = Vec::with_capacity(msg1.len() + 32 + pq_ct.len() + 8);
    v.extend_from_slice(msg1); v.extend_from_slice(ek_r_pub); v.extend_from_slice(pq_ct); v.extend_from_slice(&ts_r.to_be_bytes());
    sha256(&v)
}
/// `h3 = SHA-256(h2_partial || mac_r)`
pub fn h3(h2p: &[u8; 32], mac_r: &[u8; 32]) -> [u8; 32] {
    let mut v = [0u8; 64]; v[..32].copy_from_slice(h2p); v[32..].copy_from_slice(mac_r);
    sha256(&v)
}
