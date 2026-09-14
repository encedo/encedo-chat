//! rtc-spike — can `webrtc-rs` open a DataChannel with a real browser, through
//! OUR signalling shape, and carry a megabyte? Nothing else. This is the
//! question that decides whether the Linux desktop gets the direct plane from
//! Rust, and it is asked here before a line of it touches the app.
//!
//! Wire: JSON lines. stdin carries what the browser sent, stdout what the
//! browser should receive — the same three kinds `net/webrtc.ts` uses:
//!   {"kind":"offer","sdp":...} / {"kind":"answer","sdp":...} /
//!   {"kind":"ice","candidate":{...}}
//! plus {"kind":"state",...} and a final {"kind":"result",...} for the driver.
//! `net/rtc-spike.ts` is the other half: it spawns this, drives a headless
//! Chromium, and shuttles the lines.
//!
//! webrtc-rs 0.20 is a sans-io core behind a runtime abstraction: events come
//! through a handler trait, a data channel is polled for events, and every
//! call is async on the crate's own runtime (tokio underneath, by default).
//!
//!   cargo run --example rtc-spike        (from impl/src-tauri)

use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use bytes::BytesMut;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
    RTCIceCandidateInit, RTCPeerConnectionIceEvent, RTCPeerConnectionState, RTCSessionDescription,
};
use webrtc::runtime::{default_runtime, Runtime};

fn out(v: serde_json::Value) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{}", v);
    let _ = o.flush();
}

/// Everything the peer connection tells us, turned into stdout lines.
struct Handler {
    runtime: Arc<dyn Runtime>,
    got: Arc<AtomicU64>,
    started: Arc<Mutex<Option<Instant>>>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_candidate(&self, ev: RTCPeerConnectionIceEvent) {
        if let Ok(j) = ev.candidate.to_json() {
            out(serde_json::json!({ "kind": "ice", "candidate": {
                "candidate": j.candidate, "sdpMid": j.sdp_mid,
                "sdpMLineIndex": j.sdp_mline_index, "usernameFragment": j.username_fragment } }));
        }
    }
    async fn on_connection_state_change(&self, s: RTCPeerConnectionState) {
        out(serde_json::json!({ "kind": "state", "conn": s.to_string() }));
    }
    async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
        let got = self.got.clone();
        let started = self.started.clone();
        self.runtime.spawn(Box::pin(async move {
            let label = dc.label().await.unwrap_or_default();
            out(serde_json::json!({ "kind": "state", "dc": "announced", "label": label }));
            while let Some(ev) = dc.poll().await {
                match ev {
                    DataChannelEvent::OnOpen => out(serde_json::json!({ "kind": "state", "dc": "open" })),
                    DataChannelEvent::OnClose => { out(serde_json::json!({ "kind": "state", "dc": "closed" })); break }
                    DataChannelEvent::OnMessage(m) => {
                        if started.lock().unwrap().is_none() { *started.lock().unwrap() = Some(Instant::now()); }
                        // The browser link's liveness probe: 0x00 0x50 -> 0x00 0x4f.
                        if !m.is_string && m.data.len() == 2 && m.data[0] == 0 && m.data[1] == 0x50 {
                            let _ = dc.send(BytesMut::from(&[0u8, 0x4f][..])).await;
                            continue;
                        }
                        if m.is_string && m.data.as_ref() == b"done" {
                            let ms = started.lock().unwrap().map(|t| t.elapsed().as_millis()).unwrap_or(0);
                            let n = got.load(Ordering::Relaxed);
                            out(serde_json::json!({ "kind": "result", "bytes": n, "ms": ms }));
                            // Echo the count, so the BROWSER side can assert it too.
                            let _ = dc.send_text(&format!("got {}", n)).await;
                            continue;
                        }
                        got.fetch_add(m.data.len() as u64, Ordering::Relaxed);
                    }
                    _ => {}
                }
            }
        }));
    }
}

fn main() {
    let runtime = default_runtime().expect("webrtc runtime (runtime-tokio) not enabled");
    let got = Arc::new(AtomicU64::new(0));
    let started = Arc::new(Mutex::new(None));
    let handler = Arc::new(Handler { runtime: runtime.clone(), got, started });

    // ONE block_on for the whole program, like the crate's own examples. The
    // first version called block_on once per stdin line, and the runtime the
    // crate hands out builds a fresh executor per call — so everything the
    // peer connection had spawned during build() died the moment that call
    // returned, and the first offer met a gathering task that no longer
    // existed ("SendError(IceGathering)"). stdin is read on a plain thread and
    // handed in through a channel instead.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line { Ok(l) => { if tx.send(l).is_err() { break } }, Err(_) => break }
        }
    });

    let rt = runtime.clone();
    runtime.block_on(Box::pin(async move {
        // No STUN on purpose: the browser is on this machine, host candidates
        // are enough, and the question is the stack, not the network.
        let pc: Arc<dyn PeerConnection> = Arc::new(
            PeerConnectionBuilder::new()
                .with_configuration(RTCConfigurationBuilder::new().build())
                .with_handler(handler)
                .with_runtime(rt.clone())
                .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
                .build()
                .await
                .expect("peer connection"),
        );
        out(serde_json::json!({ "kind": "state", "pc": "built" }));

        loop {
            let line = match rx.try_recv() {
                Ok(l) => l,
                Err(std::sync::mpsc::TryRecvError::Empty) => { rt.sleep(std::time::Duration::from_millis(5)).await; continue }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
            };
            if line.trim().is_empty() { continue; }
            let v: serde_json::Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
            match v["kind"].as_str() {
                Some("offer") => {
                    let sdp = v["sdp"].as_str().unwrap_or("").to_string();
                    let r: Result<(), String> = async {
                        let offer = RTCSessionDescription::offer(sdp).map_err(|e| e.to_string())?;
                        pc.set_remote_description(offer).await.map_err(|e| e.to_string())?;
                        let answer = pc.create_answer(None).await.map_err(|e| e.to_string())?;
                        pc.set_local_description(answer.clone()).await.map_err(|e| e.to_string())?;
                        out(serde_json::json!({ "kind": "answer", "sdp": answer.sdp }));
                        Ok(())
                    }.await;
                    if let Err(e) = r { out(serde_json::json!({ "kind": "state", "offer-failed": e })); }
                }
                Some("ice") => {
                    let c = &v["candidate"];
                    let init = RTCIceCandidateInit {
                        candidate: c["candidate"].as_str().unwrap_or("").to_string(),
                        sdp_mid: c["sdpMid"].as_str().map(|s| s.to_string()),
                        sdp_mline_index: c["sdpMLineIndex"].as_u64().map(|n| n as u16),
                        username_fragment: c["usernameFragment"].as_str().map(|s| s.to_string()),
                        url: None,
                    };
                    if let Err(e) = pc.add_ice_candidate(init).await {
                        out(serde_json::json!({ "kind": "state", "ice-add-failed": e.to_string() }));
                    }
                }
                Some("quit") => break,
                _ => {}
            }
        }
        let _ = pc.close().await;
    }));
}
