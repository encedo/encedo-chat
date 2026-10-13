//! The EH-2 state machines (SPEC.md 6). The one DH with the long-term IK is
//! not computed here: the host (an HSM, or a software identity) does it and
//! hands the 32 bytes in - `need_*` says which public key to DH against.
//!
//!   I: Initiator::new(..)            -> msg1
//!      peer_ek_of(msg2) -> ek_r_pub  (host: dh2 = IK_i.dh(ek_r_pub))
//!      complete(msg2, dh2)           -> msg3 + HandshakeResult
//!   R: ResponderBegin::new(.., msg1) -> ek_i_pub (host: dh1 = IK_r.dh(ek_i_pub))
//!      complete(dh1)                 -> msg2 + Responder (SK held, I unauthenticated)
//!      Responder::finish(msg3)       -> HandshakeResult   <- the msg3 gate

use zeroize::{Zeroize, Zeroizing};

use crate::kdf::{ct_eq, hkdf, hmac, hmac_verify};
use crate::kem::{self, KemSecret};
use crate::wire::{self, Msg1, Msg2, Msg3};
use crate::x25519::Priv;

pub const MAX_SKEW_MS: u64 = 5 * 60_000;
const SK_INFO: &[u8] = b"encedo-handshake-v2";
const LABEL_R: &[u8] = b"responder";
const LABEL_I: &[u8] = b"initiator";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeError {
    Wire(&'static str),
    Skew,
    /// The initiator tag verifies under OUR identity key: a second window of our own identity.
    SecondWindow,
    /// The initiator tag is neither the contact's nor ours.
    NotTheContact,
    MacR,
    MacI,
    Kem,
}
impl From<wire::WireError> for HandshakeError { fn from(e: wire::WireError) -> Self { HandshakeError::Wire(e.0) } }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role { Initiator, Responder }

pub struct HandshakeResult {
    pub role: Role,
    pub sk: Zeroizing<[u8; 32]>,
    /// Initiator: EK_i, its first ratchet private key. Responder: None.
    pub ek_self: Option<Priv>,
    pub ek_peer_pub: [u8; 32],
    /// DH(EK_r, EK_i): the first ratchet step's ikm, both sides.
    pub first_step_ikm: Zeroizing<[u8; 32]>,
}

/// `k_tag = HMAC(announce_key, "encedo-eh2-initiator-tag-v1")` is the host's
/// (it holds the Announce key); this is the tag itself.
pub fn initiator_tag(tag_key: &[u8; 32], ik_pub: &[u8; 32]) -> [u8; 32] { hmac(tag_key, &[ik_pub]) }

fn check_skew(ts: u64, now: u64, max: u64) -> Result<(), HandshakeError> {
    if ts.abs_diff(now) > max { Err(HandshakeError::Skew) } else { Ok(()) }
}

fn derive_sk(dh1: &[u8; 32], dh2: &[u8; 32], dh3: &[u8; 32], ss: &[u8; 32], h1: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    let mut ikm = Zeroizing::new([0u8; 128]);
    ikm[..32].copy_from_slice(dh1); ikm[32..64].copy_from_slice(dh2); ikm[64..96].copy_from_slice(dh3); ikm[96..].copy_from_slice(ss);
    let mut sk = Zeroizing::new([0u8; 32]);
    hkdf(&ikm[..], h1, SK_INFO, &mut sk[..]);
    sk
}

// ---------------------------------------------------------------------------

pub struct Initiator {
    ik_pub: [u8; 32],
    peer_ik_pub: [u8; 32],
    ek: Priv,
    pq: KemSecret,
    msg1: Vec<u8>,
    max_skew_ms: u64,
}

impl Initiator {
    /// `ek` and `pq` are fresh per handshake (from the Rng in production; fixed in a KAT).
    pub fn new(ik_pub: [u8; 32], peer_ik_pub: [u8; 32], tag_key: &[u8; 32], ek: Priv, pq: KemSecret, now_ms: u64) -> Self {
        let msg1 = wire::encode_msg1(&Msg1 { ek_pub: ek.public(), pq_pub: pq.public().to_vec(), ts: now_ms, initiator_tag: initiator_tag(tag_key, &ik_pub) });
        Self { ik_pub, peer_ik_pub, ek, pq, msg1, max_skew_ms: MAX_SKEW_MS }
    }
    pub fn with_max_skew(mut self, ms: u64) -> Self { self.max_skew_ms = ms; self }
    pub fn msg1(&self) -> &[u8] { &self.msg1 }
    pub fn ik_pub(&self) -> [u8; 32] { self.ik_pub }
    /// The responder's ephemeral public key in msg2: the host computes DH(IK_i, EK_r) against it.
    pub fn peer_ek_of(&self, msg2: &[u8]) -> Result<[u8; 32], HandshakeError> { Ok(wire::decode_msg2(msg2)?.ek_pub) }

    /// `dh2 = DH(EK_r, IK_i)`, from the host. Verifies mac_r (R is authenticated), returns msg3.
    pub fn complete(self, msg2_bytes: &[u8], dh2: &[u8; 32], now_ms: u64) -> Result<(Vec<u8>, HandshakeResult), HandshakeError> {
        let msg2: Msg2 = wire::decode_msg2(msg2_bytes)?;
        check_skew(msg2.ts, now_ms, self.max_skew_ms)?;
        let dh1 = self.ek.dh(&self.peer_ik_pub);          // DH(IK_r, EK_i)
        let dh3 = self.ek.dh(&msg2.ek_pub);               // DH(EK_r, EK_i)
        let ss = self.pq.decapsulate(&msg2.pq_ct).ok_or(HandshakeError::Kem)?;
        let h1 = wire::h1(&self.msg1);
        let sk = derive_sk(&dh1, dh2, &dh3, &ss, &h1);
        let h2p = wire::h2_partial(&self.msg1, &msg2.ek_pub, &msg2.pq_ct, msg2.ts);
        if !hmac_verify(&sk[..], &[LABEL_R, &h2p], &msg2.mac_r) { return Err(HandshakeError::MacR) }
        let h3 = wire::h3(&h2p, &msg2.mac_r);
        let mac_i = hmac(&sk[..], &[LABEL_I, &h3]);
        let msg3 = wire::encode_msg3(&Msg3 { mac_i });
        Ok((msg3, HandshakeResult { role: Role::Initiator, sk, ek_self: Some(self.ek), ek_peer_pub: msg2.ek_pub, first_step_ikm: dh3 }))
    }
}

// ---------------------------------------------------------------------------

pub struct ResponderBegin {
    peer_ik_pub: [u8; 32],
    msg1_bytes: Vec<u8>,
    msg1: Msg1,
    now_ms: u64,
}

impl ResponderBegin {
    /// Decodes msg1 and checks the initiator tag BEFORE any DH (6.1): the
    /// contact's tag proceeds; our own tag is a second window; anything else
    /// is not the contact.
    pub fn new(ik_pub: [u8; 32], peer_ik_pub: [u8; 32], tag_key: &[u8; 32], msg1_bytes: &[u8], now_ms: u64, max_skew_ms: u64) -> Result<Self, HandshakeError> {
        let msg1 = wire::decode_msg1(msg1_bytes)?;
        check_skew(msg1.ts, now_ms, max_skew_ms)?;
        if !ct_eq(&msg1.initiator_tag, &initiator_tag(tag_key, &peer_ik_pub)) {
            if ct_eq(&msg1.initiator_tag, &initiator_tag(tag_key, &ik_pub)) { return Err(HandshakeError::SecondWindow) }
            return Err(HandshakeError::NotTheContact)
        }
        Ok(Self { peer_ik_pub, msg1_bytes: msg1_bytes.to_vec(), msg1, now_ms })
    }
    /// The initiator's ephemeral public key: the host computes DH(IK_r, EK_i) against it.
    pub fn peer_ek(&self) -> [u8; 32] { self.msg1.ek_pub }

    /// `dh1 = DH(IK_r, EK_i)` from the host; `ek` and `m` fresh (Rng in production, fixed in a KAT).
    pub fn complete(self, dh1: &[u8; 32], ek: Priv, kem_m: [u8; 32]) -> Result<(Vec<u8>, Responder), HandshakeError> {
        let (ct, ss) = kem::encapsulate(&self.msg1.pq_pub, kem_m).ok_or(HandshakeError::Kem)?;
        let dh2 = ek.dh(&self.peer_ik_pub);      // DH(EK_r, IK_i)
        let dh3 = ek.dh(&self.msg1.ek_pub);      // DH(EK_r, EK_i)
        let h1 = wire::h1(&self.msg1_bytes);
        let sk = derive_sk(dh1, &dh2, &dh3, &ss, &h1);
        let ts_r = self.now_ms;
        let ek_pub = ek.public();
        let h2p = wire::h2_partial(&self.msg1_bytes, &ek_pub, &ct, ts_r);
        let mac_r = hmac(&sk[..], &[LABEL_R, &h2p]);
        let msg2 = wire::encode_msg2(&Msg2 { ek_pub, pq_ct: ct, ts: ts_r, mac_r });
        // EK_r_priv is dropped here: dh3 carries what the first ratchet step needs.
        drop(ek);
        Ok((msg2, Responder { sk, h3: wire::h3(&h2p, &mac_r), ek_peer_pub: self.msg1.ek_pub, first_step_ikm: dh3 }))
    }
}

pub struct Responder {
    sk: Zeroizing<[u8; 32]>,
    h3: [u8; 32],
    ek_peer_pub: [u8; 32],
    first_step_ikm: Zeroizing<[u8; 32]>,
}

impl Responder {
    /// The msg3 gate: only after this may R accept ratchet data from I.
    pub fn finish(mut self, msg3_bytes: &[u8]) -> Result<HandshakeResult, HandshakeError> {
        let msg3 = wire::decode_msg3(msg3_bytes)?;
        if !hmac_verify(&self.sk[..], &[LABEL_I, &self.h3], &msg3.mac_i) {
            self.sk.zeroize(); self.first_step_ikm.zeroize();
            return Err(HandshakeError::MacI)
        }
        Ok(HandshakeResult { role: Role::Responder, sk: self.sk, ek_self: None, ek_peer_pub: self.ek_peer_pub, first_step_ikm: self.first_step_ikm })
    }
}
