//! onchato v6 core-rs: the EH-2 handshake and the Double Ratchet with the
//! hybrid step (docs/SPEC.md 6-7), native and WASM. The identity key's one DH
//! per handshake stays with the identity backend (an HSM, or a software key
//! in the host); everything ephemeral - EK, the ML-KEM keys, the ratchet
//! state - lives in this crate's memory.

pub mod rng;
pub mod kdf;
pub mod x25519;
pub mod kem;
pub mod wire;
pub mod handshake;
pub mod ratchet;
pub mod senderkey;
#[cfg(target_arch = "wasm32")]
pub mod ffi;
