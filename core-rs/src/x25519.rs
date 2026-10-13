//! X25519 as a DH capability over a private scalar the engine holds. The
//! long-term IK is NOT one of these: its one DH per handshake is done by the
//! identity backend (an HSM or a software key in the host) and handed in.

use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::rng::Rng;

pub struct Priv {
    secret: StaticSecret,
    pub_bytes: [u8; 32],
}

impl Priv {
    pub fn from_bytes(scalar: [u8; 32]) -> Self {
        let secret = StaticSecret::from(scalar);
        let pub_bytes = PublicKey::from(&secret).to_bytes();
        Self { secret, pub_bytes }
    }
    pub fn generate(rng: &mut dyn Rng) -> Self { Self::from_bytes(rng.x25519()) }
    pub fn public(&self) -> [u8; 32] { self.pub_bytes }
    /// Raw X25519 shared secret with a peer's raw public key.
    pub fn dh(&self, peer_pub: &[u8; 32]) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.secret.diffie_hellman(&PublicKey::from(*peer_pub)).to_bytes())
    }
}
