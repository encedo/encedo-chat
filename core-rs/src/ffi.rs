//! The WASM face of the crate: a handle registry and a flat C ABI, no
//! wasm-bindgen (one less tool in the reproducible build). The host supplies
//! randomness (`env.random_fill`) and the identity key's one DH per handshake;
//! every secret the engine makes stays in this module's linear memory.
//!
//! Calling convention: inputs are (ptr, len) pairs the host wrote into memory
//! it got from `ec_alloc` and frees with `ec_free` after the call; outputs
//! land in one per-call buffer (`ec_out_ptr`/`ec_out_len`, valid until the
//! next call); a negative return is an error whose text is `ec_err_ptr`/`len`.

use std::cell::RefCell;

use crate::handshake::{HandshakeError, HandshakeResult, Initiator, Responder, ResponderBegin, MAX_SKEW_MS};
use crate::kem::KemSecret;
use crate::ratchet::{Ratchet, RatchetError, RatchetOpts};
use crate::rng::Rng;
use crate::x25519::Priv;

#[link(wasm_import_module = "env")]
extern "C" {
    fn random_fill(ptr: *mut u8, len: usize);
}

struct HostRng;
impl Rng for HostRng {
    fn x25519(&mut self) -> [u8; 32] { let mut b = [0u8; 32]; unsafe { random_fill(b.as_mut_ptr(), 32) }; b }
    fn kem_seed(&mut self) -> [u8; 64] { let mut b = [0u8; 64]; unsafe { random_fill(b.as_mut_ptr(), 64) }; b }
    fn kem_m(&mut self) -> [u8; 32] { let mut b = [0u8; 32]; unsafe { random_fill(b.as_mut_ptr(), 32) }; b }
}

enum Obj { Init(Initiator), RespBegin(ResponderBegin), Resp(Responder), Done(HandshakeResult), Rt(Ratchet) }

thread_local! {
    static OUT: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    static ERR: RefCell<String> = RefCell::new(String::new());
    static HANDLES: RefCell<Vec<Option<Obj>>> = RefCell::new(Vec::new());
}

fn put(o: Obj) -> i32 {
    HANDLES.with(|h| {
        let mut h = h.borrow_mut();
        if let Some(i) = h.iter().position(|s| s.is_none()) { h[i] = Some(o); return i as i32 + 1 }
        h.push(Some(o)); h.len() as i32
    })
}
fn take(handle: i32) -> Option<Obj> {
    if handle <= 0 { return None }
    HANDLES.with(|h| h.borrow_mut().get_mut(handle as usize - 1).and_then(|s| s.take()))
}
fn give_back(handle: i32, o: Obj) { HANDLES.with(|h| h.borrow_mut()[handle as usize - 1] = Some(o)) }
fn set_out(v: Vec<u8>) { OUT.with(|o| *o.borrow_mut() = v) }
fn fail(msg: &str) -> i32 { ERR.with(|e| *e.borrow_mut() = msg.to_string()); -1 }
fn hs_err(e: HandshakeError) -> i32 {
    match e {
        HandshakeError::SecondWindow => { ERR.with(|x| *x.borrow_mut() = "initiator tag is our own identity: a second window, not the contact".into()); -2 }
        HandshakeError::NotTheContact => { ERR.with(|x| *x.borrow_mut() = "initiator tag does not match the contact".into()); -3 }
        HandshakeError::Skew => fail("timestamp outside the +/-5 min window"),
        HandshakeError::MacR => fail("mac_r does not verify"),
        HandshakeError::MacI => fail("mac_i does not verify"),
        HandshakeError::Kem => fail("ML-KEM input is malformed"),
        HandshakeError::Wire(w) => fail(w),
    }
}
unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] { if len == 0 { &[] } else { std::slice::from_raw_parts(ptr, len) } }
fn arr32(b: &[u8]) -> Result<[u8; 32], i32> { b.try_into().map_err(|_| fail("expected 32 bytes")) }

#[no_mangle] pub extern "C" fn ec_alloc(len: usize) -> *mut u8 { let mut v = Vec::<u8>::with_capacity(len.max(1)); let p = v.as_mut_ptr(); std::mem::forget(v); p }
#[no_mangle] pub extern "C" fn ec_free(ptr: *mut u8, len: usize) { unsafe { drop(Vec::from_raw_parts(ptr, 0, len.max(1))) } }
#[no_mangle] pub extern "C" fn ec_out_ptr() -> *const u8 { OUT.with(|o| o.borrow().as_ptr()) }
#[no_mangle] pub extern "C" fn ec_out_len() -> usize { OUT.with(|o| o.borrow().len()) }
#[no_mangle] pub extern "C" fn ec_err_ptr() -> *const u8 { ERR.with(|e| e.borrow().as_ptr()) }
#[no_mangle] pub extern "C" fn ec_err_len() -> usize { ERR.with(|e| e.borrow().len()) }
#[no_mangle] pub extern "C" fn ec_drop(handle: i32) { drop(take(handle)) }
/// Wire version and crate version, so the host can check what it loaded.
#[no_mangle] pub extern "C" fn ec_version() -> i32 { crate::wire::VERSION as i32 }

/// I: fresh EK and ML-KEM key from the host's randomness; out = msg1.
#[no_mangle]
pub extern "C" fn ec_hs_initiate(ik_pub: *const u8, peer_ik_pub: *const u8, tag_key: *const u8, now_ms: f64) -> i32 {
    let (ik, peer, tag) = unsafe { (bytes(ik_pub, 32), bytes(peer_ik_pub, 32), bytes(tag_key, 32)) };
    let (Ok(ik), Ok(peer), Ok(tag)) = (arr32(ik), arr32(peer), arr32(tag)) else { return -1 };
    let mut rng = HostRng;
    let init = Initiator::new(ik, peer, &tag, Priv::generate(&mut rng), KemSecret::generate(&mut rng), now_ms as u64);
    set_out(init.msg1().to_vec());
    put(Obj::Init(init))
}
/// I: out = EK_r_pub of msg2, for the host's DH(IK_i, EK_r).
#[no_mangle]
pub extern "C" fn ec_hs_peer_ek(handle: i32, msg2: *const u8, msg2_len: usize) -> i32 {
    let Some(Obj::Init(init)) = take(handle) else { return fail("not an initiator handle") };
    let r = init.peer_ek_of(unsafe { bytes(msg2, msg2_len) });
    give_back(handle, Obj::Init(init));
    match r { Ok(ek) => { set_out(ek.to_vec()); 0 } Err(e) => hs_err(e) }
}
/// I: dh2 = DH(EK_r, IK_i) from the host; out = msg3; the handle now holds the result.
#[no_mangle]
pub extern "C" fn ec_hs_initiator_complete(handle: i32, msg2: *const u8, msg2_len: usize, dh2: *const u8, now_ms: f64) -> i32 {
    let Some(Obj::Init(init)) = take(handle) else { return fail("not an initiator handle") };
    let Ok(dh2) = arr32(unsafe { bytes(dh2, 32) }) else { return -1 };
    match init.complete(unsafe { bytes(msg2, msg2_len) }, &dh2, now_ms as u64) {
        Ok((msg3, res)) => { set_out(msg3); give_back(handle, Obj::Done(res)); 0 }
        Err(e) => hs_err(e),
    }
}
/// R: decodes msg1, checks the initiator tag; out = EK_i_pub for the host's DH(IK_r, EK_i).
/// Returns a handle, or -2 (a second window of our own identity) / -3 (not the contact) / -1.
#[no_mangle]
pub extern "C" fn ec_hs_respond(ik_pub: *const u8, peer_ik_pub: *const u8, tag_key: *const u8, msg1: *const u8, msg1_len: usize, now_ms: f64, max_skew_ms: f64) -> i32 {
    let (ik, peer, tag) = unsafe { (bytes(ik_pub, 32), bytes(peer_ik_pub, 32), bytes(tag_key, 32)) };
    let (Ok(ik), Ok(peer), Ok(tag)) = (arr32(ik), arr32(peer), arr32(tag)) else { return -1 };
    let skew = if max_skew_ms > 0.0 { max_skew_ms as u64 } else { MAX_SKEW_MS };
    match ResponderBegin::new(ik, peer, &tag, unsafe { bytes(msg1, msg1_len) }, now_ms as u64, skew) {
        Ok(rb) => { set_out(rb.peer_ek().to_vec()); put(Obj::RespBegin(rb)) }
        Err(e) => hs_err(e),
    }
}
/// R: dh1 = DH(IK_r, EK_i) from the host; out = msg2 (SK held, I unauthenticated).
#[no_mangle]
pub extern "C" fn ec_hs_responder_complete(handle: i32, dh1: *const u8) -> i32 {
    let Some(Obj::RespBegin(rb)) = take(handle) else { return fail("not a responder handle") };
    let Ok(dh1) = arr32(unsafe { bytes(dh1, 32) }) else { return -1 };
    let mut rng = HostRng;
    match rb.complete(&dh1, Priv::generate(&mut rng), rng.kem_m()) {
        Ok((msg2, resp)) => { set_out(msg2); give_back(handle, Obj::Resp(resp)); 0 }
        Err(e) => hs_err(e),
    }
}
/// R: the msg3 gate; the handle now holds the result.
#[no_mangle]
pub extern "C" fn ec_hs_responder_finish(handle: i32, msg3: *const u8, msg3_len: usize) -> i32 {
    let Some(Obj::Resp(resp)) = take(handle) else { return fail("not a responder handle") };
    match resp.finish(unsafe { bytes(msg3, msg3_len) }) {
        Ok(res) => { give_back(handle, Obj::Done(res)); 0 }
        Err(e) => hs_err(e),
    }
}
/// Turn a completed handshake into a ratchet: a new handle; the handshake handle is consumed.
#[no_mangle]
pub extern "C" fn ec_session(handle: i32, pq_every_steps: u32, pq_every_ms: f64, max_skip: u32, now_ms: f64) -> i32 {
    let Some(Obj::Done(res)) = take(handle) else { return fail("handshake not complete") };
    let mut opts = RatchetOpts::default();
    if pq_every_steps > 0 { opts.pq_every_steps = pq_every_steps }
    if pq_every_ms > 0.0 { opts.pq_every_ms = pq_every_ms as u64 }
    if max_skip > 0 { opts.max_skip_per_chain = max_skip }
    put(Obj::Rt(Ratchet::from_handshake(res, opts, now_ms as u64)))
}
#[no_mangle]
pub extern "C" fn ec_rt_encrypt(handle: i32, now_ms: f64, pt: *const u8, pt_len: usize) -> i32 {
    let Some(Obj::Rt(mut rt)) = take(handle) else { return fail("not a session handle") };
    let frame = rt.encrypt(&mut HostRng, now_ms as u64, unsafe { bytes(pt, pt_len) });
    give_back(handle, Obj::Rt(rt));
    set_out(frame); 0
}
/// 0 = out holds the plaintext; 1 = not ours / tampered / replay; -1 = a jump past the skip bound.
#[no_mangle]
pub extern "C" fn ec_rt_decrypt(handle: i32, now_ms: f64, frame: *const u8, frame_len: usize) -> i32 {
    let Some(Obj::Rt(mut rt)) = take(handle) else { return fail("not a session handle") };
    let r = rt.decrypt(&mut HostRng, now_ms as u64, unsafe { bytes(frame, frame_len) });
    give_back(handle, Obj::Rt(rt));
    match r {
        Ok(Some(pt)) => { set_out(pt); 0 }
        Ok(None) => 1,
        Err(RatchetError::SkipBound(n)) => fail(&format!("peer skipped {n} messages, over the bound - drop the frame")),
    }
}
/// out = "nSend nRecv skipped pqOutstanding pqSteps dhPubHex" as ASCII.
#[no_mangle]
pub extern "C" fn ec_rt_stats(handle: i32) -> i32 {
    let Some(Obj::Rt(rt)) = take(handle) else { return fail("not a session handle") };
    let s = rt.stats();
    let pubhex = rt.dh_pub().map(|p| p.iter().map(|b| format!("{b:02x}")).collect::<String>()).unwrap_or_default();
    let line = format!("{} {} {} {} {} {}", s.n_send, s.n_recv, s.skipped, s.pq_outstanding as u8, s.pq_steps, pubhex);
    give_back(handle, Obj::Rt(rt));
    set_out(line.into_bytes()); 0
}
