//! core-rs in the Tauri host (T15 stage 2, SPEC.md 3.2). The webview drives the
//! EH-2 handshake and the ratchet through these commands instead of the WASM
//! module, so SK, the ML-KEM keys, the ephemeral DHs and every ratchet key live
//! in THIS process - a webview compromise (XSS, a bad dependency) cannot read
//! them, which the WASM-in-page engine, sharing the page's realm, cannot offer.
//!
//! The one DH with the long-term identity key stays with the webview (it holds
//! the software key, or talks to the HEM): a command returns the peer public key
//! to DH against, the webview computes it and hands the 32 bytes back. So the
//! host holds everything ephemeral; the identity key never crosses into it.
//!
//! IPC TRAP (CLAUDE.md, Android/Linux): a raw `Vec<u8>` invoke body becomes a
//! JSON array and does not survive. Every byte field here is base64 TEXT.

use std::sync::{LazyLock, Mutex};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use encedo_core::handshake::{HandshakeError, HandshakeResult, Initiator, Responder, ResponderBegin, MAX_SKEW_MS};
use encedo_core::kem::KemSecret;
use encedo_core::ratchet::{Ratchet, RatchetError, RatchetOpts};
use encedo_core::rng::SysRng;
use encedo_core::x25519::Priv;
use serde::Serialize;

enum Obj { Init(Initiator), RespBegin(ResponderBegin), Resp(Responder), Done(HandshakeResult), Rt(Ratchet) }

static REG: LazyLock<Mutex<Vec<Option<Obj>>>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn put(o: Obj) -> i32 {
    let mut h = REG.lock().unwrap();
    if let Some(i) = h.iter().position(|s| s.is_none()) { h[i] = Some(o); return i as i32 + 1 }
    h.push(Some(o)); h.len() as i32
}
fn take(handle: i32) -> Option<Obj> {
    if handle <= 0 { return None }
    REG.lock().unwrap().get_mut(handle as usize - 1).and_then(|s| s.take())
}
fn give_back(handle: i32, o: Obj) { REG.lock().unwrap()[handle as usize - 1] = Some(o) }

fn b(s: &str) -> Result<Vec<u8>, String> { B64.decode(s).map_err(|_| "bad base64".to_string()) }
fn a32(s: &str) -> Result<[u8; 32], String> { b(s)?.try_into().map_err(|_| "expected 32 bytes".to_string()) }
fn enc(v: &[u8]) -> String { B64.encode(v) }

fn hs_err(e: HandshakeError) -> String {
    match e {
        HandshakeError::SecondWindow => "second-window".into(),
        HandshakeError::NotTheContact => "not-the-contact".into(),
        HandshakeError::Skew => "timestamp outside the +/-5 min window".into(),
        HandshakeError::MacR => "mac_r does not verify".into(),
        HandshakeError::MacI => "mac_i does not verify".into(),
        HandshakeError::Kem => "ML-KEM input is malformed".into(),
        HandshakeError::Wire(w) => w.into(),
    }
}

#[derive(Serialize)]
pub struct Started { pub handle: i32, pub out: String }

/// The wire version the host speaks (must equal the TS engine's; 3).
#[tauri::command]
pub fn core_version() -> i32 { encedo_core::wire::VERSION as i32 }

/// I: fresh EK and ML-KEM key from the OS CSPRNG; returns a handle + msg1 (b64).
#[tauri::command]
pub fn core_initiate(ik_pub: String, peer_ik_pub: String, tag_key: String, now_ms: f64) -> Result<Started, String> {
    let (ik, peer, tag) = (a32(&ik_pub)?, a32(&peer_ik_pub)?, a32(&tag_key)?);
    let mut rng = SysRng;
    let init = Initiator::new(ik, peer, &tag, Priv::generate(&mut rng), KemSecret::generate(&mut rng), now_ms as u64);
    let out = enc(init.msg1());
    Ok(Started { handle: put(Obj::Init(init)), out })
}

/// I: the responder EK pub of msg2, for the webview's DH(IK_i, EK_r).
#[tauri::command]
pub fn core_peer_ek(handle: i32, msg2: String) -> Result<String, String> {
    let Some(Obj::Init(init)) = take(handle) else { return Err("not an initiator handle".into()) };
    let r = init.peer_ek_of(&b(&msg2)?).map(|ek| enc(&ek)).map_err(hs_err);
    give_back(handle, Obj::Init(init));
    r
}

/// I: dh2 = DH(EK_r, IK_i) from the webview; returns msg3 (b64); the handle now holds the result.
#[tauri::command]
pub fn core_initiator_complete(handle: i32, msg2: String, dh2: String, now_ms: f64) -> Result<String, String> {
    let Some(Obj::Init(init)) = take(handle) else { return Err("not an initiator handle".into()) };
    let dh2 = a32(&dh2)?;
    match init.complete(&b(&msg2)?, &dh2, now_ms as u64) {
        Ok((msg3, res)) => { give_back(handle, Obj::Done(res)); Ok(enc(&msg3)) }
        Err(e) => Err(hs_err(e)),
    }
}

/// R: decode msg1, check the initiator tag; returns handle + EK_i pub for DH(IK_r, EK_i).
#[tauri::command]
pub fn core_respond(ik_pub: String, peer_ik_pub: String, tag_key: String, msg1: String, now_ms: f64, max_skew_ms: f64) -> Result<Started, String> {
    let (ik, peer, tag) = (a32(&ik_pub)?, a32(&peer_ik_pub)?, a32(&tag_key)?);
    let skew = if max_skew_ms > 0.0 { max_skew_ms as u64 } else { MAX_SKEW_MS };
    match ResponderBegin::new(ik, peer, &tag, &b(&msg1)?, now_ms as u64, skew) {
        Ok(rb) => { let out = enc(&rb.peer_ek()); Ok(Started { handle: put(Obj::RespBegin(rb)), out }) }
        Err(e) => Err(hs_err(e)),
    }
}

/// R: dh1 = DH(IK_r, EK_i) from the webview; returns msg2 (SK held, I unauthenticated).
#[tauri::command]
pub fn core_responder_complete(handle: i32, dh1: String) -> Result<String, String> {
    let Some(Obj::RespBegin(rb)) = take(handle) else { return Err("not a responder handle".into()) };
    let mut rng = SysRng;
    use encedo_core::rng::Rng;
    match rb.complete(&a32(&dh1)?, Priv::generate(&mut rng), rng.kem_m()) {
        Ok((msg2, resp)) => { give_back(handle, Obj::Resp(resp)); Ok(enc(&msg2)) }
        Err(e) => Err(hs_err(e)),
    }
}

/// R: the msg3 gate; the handle now holds the result.
#[tauri::command]
pub fn core_responder_finish(handle: i32, msg3: String) -> Result<(), String> {
    let Some(Obj::Resp(resp)) = take(handle) else { return Err("not a responder handle".into()) };
    match resp.finish(&b(&msg3)?) {
        Ok(res) => { give_back(handle, Obj::Done(res)); Ok(()) }
        Err(e) => Err(hs_err(e)),
    }
}

/// Turn a completed handshake into a ratchet; returns a new session handle.
#[tauri::command]
pub fn core_session(handle: i32, pq_every_steps: u32, pq_every_ms: f64, max_skip: u32, now_ms: f64) -> Result<i32, String> {
    let Some(Obj::Done(res)) = take(handle) else { return Err("handshake not complete".into()) };
    let mut opts = RatchetOpts::default();
    if pq_every_steps > 0 { opts.pq_every_steps = pq_every_steps }
    if pq_every_ms > 0.0 { opts.pq_every_ms = pq_every_ms as u64 }
    if max_skip > 0 { opts.max_skip_per_chain = max_skip }
    Ok(put(Obj::Rt(Ratchet::from_handshake(res, opts, now_ms as u64))))
}

#[tauri::command]
pub fn core_encrypt(handle: i32, now_ms: f64, pt: String) -> Result<String, String> {
    let Some(Obj::Rt(mut rt)) = take(handle) else { return Err("not a session handle".into()) };
    let frame = rt.encrypt(&mut SysRng, now_ms as u64, &b(&pt)?);
    give_back(handle, Obj::Rt(rt));
    Ok(enc(&frame))
}

#[derive(Serialize)]
pub struct Opened { pub status: u8, pub pt: String } // 0 = pt; 1 = not ours / tampered / replay

#[tauri::command]
pub fn core_decrypt(handle: i32, now_ms: f64, frame: String) -> Result<Opened, String> {
    let Some(Obj::Rt(mut rt)) = take(handle) else { return Err("not a session handle".into()) };
    let r = rt.decrypt(&mut SysRng, now_ms as u64, &b(&frame)?);
    give_back(handle, Obj::Rt(rt));
    match r {
        Ok(Some(pt)) => Ok(Opened { status: 0, pt: enc(&pt) }),
        Ok(None) => Ok(Opened { status: 1, pt: String::new() }),
        Err(RatchetError::SkipBound(n)) => Err(format!("peer skipped {n} messages, over the bound")),
    }
}

#[tauri::command]
pub fn core_drop(handle: i32) { let _ = take(handle); }
