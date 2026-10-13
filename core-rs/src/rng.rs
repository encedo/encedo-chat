//! Randomness comes from the host, typed by what it is for. A scripted
//! implementation reproduces the known-answer vectors (tests/kat.rs); the
//! native one reads the OS, the WASM one asks the JS host (ffi.rs).

/// The three kinds of secret randomness the engine draws.
pub trait Rng {
    /// An X25519 private scalar (clamped at use).
    fn x25519(&mut self) -> [u8; 32];
    /// An ML-KEM-768 keygen seed, d || z.
    fn kem_seed(&mut self) -> [u8; 64];
    /// The 32-byte message of an ML-KEM encapsulation.
    fn kem_m(&mut self) -> [u8; 32];
}

/// The operating system's CSPRNG (native builds: the CLI, the tests' live paths).
#[cfg(not(target_arch = "wasm32"))]
pub struct SysRng;

#[cfg(not(target_arch = "wasm32"))]
impl Rng for SysRng {
    fn x25519(&mut self) -> [u8; 32] { let mut b = [0u8; 32]; getrandom::fill(&mut b).expect("os rng"); b }
    fn kem_seed(&mut self) -> [u8; 64] { let mut b = [0u8; 64]; getrandom::fill(&mut b).expect("os rng"); b }
    fn kem_m(&mut self) -> [u8; 32] { let mut b = [0u8; 32]; getrandom::fill(&mut b).expect("os rng"); b }
}
