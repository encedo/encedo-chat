//! ML-KEM-768 (FIPS 203) for the handshake's PQ half and the ratchet's hybrid
//! step. Keys are ephemeral and never from the HSM. Sizes: pk 1184, ct 1088.

use ml_kem::{array::Array, kem::{Decapsulate, KeyExport}, DecapsulationKey, EncapsulationKey, MlKem768, Seed, B32};
use zeroize::Zeroizing;

use crate::rng::Rng;

pub const PK_LEN: usize = 1184;
pub const CT_LEN: usize = 1088;

pub struct KemSecret {
    dk: DecapsulationKey<MlKem768>,
    pub_bytes: Vec<u8>,
}

impl KemSecret {
    pub fn from_seed(seed: [u8; 64]) -> Self {
        let dk = DecapsulationKey::<MlKem768>::from_seed(Seed::from(seed));
        let pub_bytes = dk.encapsulation_key().to_bytes().as_slice().to_vec();
        Self { dk, pub_bytes }
    }
    pub fn generate(rng: &mut dyn Rng) -> Self { Self::from_seed(rng.kem_seed()) }
    pub fn public(&self) -> &[u8] { &self.pub_bytes }
    /// FIPS 203 decapsulation never fails loudly: a bogus ciphertext yields an
    /// implicit-rejection secret, which the MAC or AEAD then refuses.
    pub fn decapsulate(&self, ct: &[u8]) -> Option<Zeroizing<[u8; 32]>> {
        if ct.len() != CT_LEN { return None }
        let ct: Array<u8, _> = Array::try_from(ct).ok()?;
        let ss = self.dk.decapsulate(&ct);
        Some(Zeroizing::new(ss.into()))
    }
}

/// Encapsulate to a peer's key with the 32-byte message `m` (random in
/// production, fixed in a known-answer test) -> (ct, ss).
pub fn encapsulate(peer_pub: &[u8], m: [u8; 32]) -> Option<(Vec<u8>, Zeroizing<[u8; 32]>)> {
    if peer_pub.len() != PK_LEN { return None }
    let key: Array<u8, _> = Array::try_from(peer_pub).ok()?;
    let ek = EncapsulationKey::<MlKem768>::new(&key).ok()?;
    let (ct, ss) = ek.encapsulate_deterministic(&B32::from(m));
    Some((ct.as_slice().to_vec(), Zeroizing::new(ss.into())))
}
