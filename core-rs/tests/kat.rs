//! The known-answer vectors of docs/kat/ reproduced by the Rust port: the
//! same fixed keys and seeds as scripts/export-kat.mjs, the same bytes out.

use encedo_core::handshake::{Initiator, ResponderBegin, MAX_SKEW_MS};
use encedo_core::kem::KemSecret;
use encedo_core::ratchet::{Ratchet, RatchetOpts};
use encedo_core::rng::Rng;
use encedo_core::x25519::Priv;

fn fill(v: u8) -> [u8; 32] { [v; 32] }
fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
fn unhex(s: &str) -> Vec<u8> { (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect() }
fn b64(b: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char); out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}
fn kat(name: &str) -> serde_json::Value {
    let p = format!("{}/../docs/kat/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// The scripted randomness of the vectors: ratchet keys 0x50, 0x51, ... in
/// generation order (shared by both sides), ML-KEM seed 0x55 x 64, encapsulation message 0x66 x 32.
struct Script { next: u8 }
impl Rng for Script {
    fn x25519(&mut self) -> [u8; 32] { let v = self.next; self.next += 1; fill(v) }
    fn kem_seed(&mut self) -> [u8; 64] { [0x55; 64] }
    fn kem_m(&mut self) -> [u8; 32] { fill(0x66) }
}

fn handshake(now: u64) -> (encedo_core::handshake::HandshakeResult, encedo_core::handshake::HandshakeResult, Vec<u8>, Vec<u8>, Vec<u8>) {
    let tag = fill(0x7a);
    let ik_i = Priv::from_bytes(fill(0x11)); let ik_r = Priv::from_bytes(fill(0x22));
    let init = Initiator::new(ik_i.public(), ik_r.public(), &tag, Priv::from_bytes(fill(0x33)), KemSecret::from_seed([0x55; 64]), now);
    let msg1 = init.msg1().to_vec();
    let rb = ResponderBegin::new(ik_r.public(), ik_i.public(), &tag, &msg1, now, MAX_SKEW_MS).unwrap();
    let dh1 = ik_r.dh(&rb.peer_ek());                       // the HSM's DH on R
    let (msg2, resp) = rb.complete(&dh1, Priv::from_bytes(fill(0x44)), fill(0x66)).unwrap();
    let dh2 = ik_i.dh(&init.peer_ek_of(&msg2).unwrap());    // the HSM's DH on I
    let (msg3, ri) = init.complete(&msg2, &dh2, now).unwrap();
    let rr = resp.finish(&msg3).unwrap();
    assert_eq!(&ri.sk[..], &rr.sk[..], "SK_i == SK_r");
    (ri, rr, msg1, msg2, msg3)
}

#[test]
fn eh2_handshake_mlkem_matches_the_vector() {
    let v = kat("eh2-handshake-mlkem");
    let now = v["now_ms"].as_u64().unwrap();
    let (ri, _, msg1, msg2, msg3) = handshake(now);
    assert_eq!(hex(&msg1), v["msg1"].as_str().unwrap());
    assert_eq!(hex(&msg2), v["msg2"].as_str().unwrap());
    assert_eq!(hex(&msg3), v["msg3"].as_str().unwrap());
    assert_eq!(b64(&ri.sk[..]), v["sk_b64"].as_str().unwrap());
}

#[test]
fn ratchet_hybrid_matches_the_vector() {
    let v = kat("ratchet-hybrid");
    let now = v["now_ms"].as_u64().unwrap();
    let (ri, rr, _, _, _) = handshake(now);
    let opts = RatchetOpts { pq_every_steps: v["pq_every_steps"].as_u64().unwrap() as u32, ..RatchetOpts::default() };
    let mut i = Ratchet::from_handshake(ri, opts, now);
    let mut r = Ratchet::from_handshake(rr, opts, now);
    let mut rng = Script { next: 0x50 };
    let mut frames = Vec::new();
    for step in v["script"].as_array().unwrap() {
        let who = step[0].as_str().unwrap(); let text = step[1].as_str().unwrap();
        let (from, to) = if who == "I" { (&mut i, &mut r) } else { (&mut r, &mut i) };
        let f = from.encrypt(&mut rng, now, text.as_bytes());
        frames.push(hex(&f));
        assert_eq!(to.decrypt(&mut rng, now, &f).unwrap().unwrap(), text.as_bytes());
    }
    let want: Vec<String> = v["frames"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect();
    assert_eq!(frames, want);
    let pq = v["pq_steps"].as_u64().unwrap() as u32;
    assert_eq!(i.stats().pq_steps, pq); assert_eq!(r.stats().pq_steps, pq);
}

#[test]
fn a_recorded_frame_opens_and_a_tampered_one_does_not() {
    let v = kat("ratchet-hybrid");
    let now = v["now_ms"].as_u64().unwrap();
    let (_, rr, _, _, _) = handshake(now);
    let opts = RatchetOpts { pq_every_steps: 1, ..RatchetOpts::default() };
    let mut r = Ratchet::from_handshake(rr, opts, now);
    let mut rng = Script { next: 0x50 };
    let first = unhex(v["frames"][0].as_str().unwrap());
    let mut bad = first.clone(); let last = bad.len() - 1; bad[last] ^= 1;
    assert_eq!(r.decrypt(&mut rng, now, &bad).unwrap(), None, "a tampered frame opens nothing and burns nothing");
    assert_eq!(r.decrypt(&mut rng, now, &first).unwrap().unwrap(), b"a", "the chain was untouched");
    assert_eq!(r.decrypt(&mut rng, now, &first).unwrap(), None, "a replay of a spent key opens nothing");
}

#[test]
fn the_responder_refuses_a_wrong_tag_and_a_wrong_mac() {
    use encedo_core::handshake::HandshakeError;
    let now = 1_784_000_000_000u64;
    let tag = fill(0x7a);
    let ik_i = Priv::from_bytes(fill(0x11)); let ik_r = Priv::from_bytes(fill(0x22)); let stranger = Priv::from_bytes(fill(0x99));
    let init = Initiator::new(stranger.public(), ik_r.public(), &tag, Priv::from_bytes(fill(0x33)), KemSecret::from_seed([0x55; 64]), now);
    assert_eq!(ResponderBegin::new(ik_r.public(), ik_i.public(), &tag, init.msg1(), now, MAX_SKEW_MS).err(), Some(HandshakeError::NotTheContact));
    let second = Initiator::new(ik_r.public(), ik_r.public(), &tag, Priv::from_bytes(fill(0x33)), KemSecret::from_seed([0x55; 64]), now);
    assert_eq!(ResponderBegin::new(ik_r.public(), ik_i.public(), &tag, second.msg1(), now, MAX_SKEW_MS).err(), Some(HandshakeError::SecondWindow));
    // an initiator that cannot do the IK DH (hands in garbage) fails mac_i on R
    let init = Initiator::new(ik_i.public(), ik_r.public(), &tag, Priv::from_bytes(fill(0x33)), KemSecret::from_seed([0x55; 64]), now);
    let rb = ResponderBegin::new(ik_r.public(), ik_i.public(), &tag, init.msg1(), now, MAX_SKEW_MS).unwrap();
    let dh1 = ik_r.dh(&rb.peer_ek());
    let (msg2, resp) = rb.complete(&dh1, Priv::from_bytes(fill(0x44)), fill(0x66)).unwrap();
    assert_eq!(init.complete(&msg2, &fill(0x00), now).err(), Some(HandshakeError::MacR), "a wrong IK DH on I shows as mac_r failing");
    assert_eq!(resp.finish(&[0x03, 3, 0, 0]).err().map(|e| matches!(e, HandshakeError::Wire(_))), Some(true));
}


#[test]
fn group_senderkey_matches_the_vector() {
    use encedo_core::senderkey::{SendChain, SenderReceiver};
    let v = kat("group-senderkey");
    let key0: [u8; 32] = unhex(v["chain_key"].as_str().unwrap()).try_into().unwrap();
    let header = unhex(v["header_aad"].as_str().unwrap());
    let pt = v["plaintext"].as_str().unwrap().as_bytes();
    let mut chain = SendChain::from_key(key0);
    let (n, ct) = chain.seal(&header, pt);
    assert_eq!(n as u64, v["ctr"].as_u64().unwrap());
    assert_eq!(hex(&ct), v["ct"].as_str().unwrap(), "the recorded group frame ciphertext");
    // and a fresh receiver on the same key opens it
    let mut r = SenderReceiver::new(key0);
    assert_eq!(r.open(0, 0, &header, &ct).unwrap().unwrap(), pt);
    // a replay of the spent counter opens nothing
    assert_eq!(r.open(0, 0, &header, &ct).unwrap(), None);
}

#[test]
fn group_receiver_walks_out_of_order_and_refuses_a_jump() {
    use encedo_core::senderkey::{SendChain, SenderReceiver, SenderKeyError};
    let key0 = [0x33u8; 32];
    let header = [0xaa, 0xbb];
    let mut send = SendChain::from_key(key0);
    let frames: Vec<(u32, Vec<u8>)> = (0..5).map(|i| send.seal(&header, format!("m{i}").as_bytes())).collect();
    let mut r = SenderReceiver::new(key0);
    // deliver 2, then 0, 1 (skipped keys held), then 4, then 3
    assert_eq!(r.open(0, 2, &header, &frames[2].1).unwrap().unwrap(), b"m2");
    assert_eq!(r.open(0, 0, &header, &frames[0].1).unwrap().unwrap(), b"m0");
    assert_eq!(r.open(0, 1, &header, &frames[1].1).unwrap().unwrap(), b"m1");
    assert_eq!(r.open(0, 4, &header, &frames[4].1).unwrap().unwrap(), b"m4");
    assert_eq!(r.open(0, 3, &header, &frames[3].1).unwrap().unwrap(), b"m3");
    assert_eq!(r.open(0, 2, &header, &frames[2].1).unwrap(), None, "a spent key is a replay");
    // a forged frame at a fresh counter burns nothing
    let mut r2 = SenderReceiver::new(key0);
    let mut bad = frames[0].1.clone(); let last = bad.len() - 1; bad[last] ^= 1;
    assert_eq!(r2.open(0, 0, &header, &bad).unwrap(), None);
    assert_eq!(r2.open(0, 0, &header, &frames[0].1).unwrap().unwrap(), b"m0", "the chain was untouched");
    // a jump past the bound is refused
    let mut r3 = SenderReceiver::new(key0).with_bounds(10, 1_000);
    assert_eq!(r3.open(0, 11, &header, &frames[0].1).unwrap_err(), SenderKeyError::SkipBound(11));
}

#[test]
fn the_per_recipient_mac_is_insider_unforgeable() {
    use encedo_core::senderkey::{tag, verify};
    // mk_ij is the caller's pairwise key; a third party with a different one cannot forge.
    let mk_ab = [0x11u8; 32];
    let mk_ac = [0x22u8; 32];
    let header = [1, 2, 3];
    let ct = [4, 5, 6, 7];
    let t = tag(&mk_ab, &header, &ct);
    assert!(verify(&mk_ab, &header, &ct, &t));
    assert!(!verify(&mk_ac, &header, &ct, &t), "another member's key does not verify A's MAC");
    let mut bad = t; bad[0] ^= 1;
    assert!(!verify(&mk_ab, &header, &ct, &bad));
}
