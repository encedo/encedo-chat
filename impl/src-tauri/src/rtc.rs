//! rtc — the direct plane for Linux, where WebKitGTK has no `RTCPeerConnection`.
//!
//! A DataChannel opened in Rust (`webrtc-rs`) and driven from the webview
//! through plain commands, so that `net/webrtc-tauri.ts` can implement the
//! same link interface the browser does (`net/webrtc.ts`) and nothing above it
//! — room, ratchet, signalling, file transfer — learns that the channel lives
//! in another language. Proven first by `examples/rtc-spike.rs`: a real
//! Chromium, our signalling shape, 32 MiB counted identically on both sides.
//!
//! **Polling, not events**, like the updater's progress: the webview asks
//! `rtc_poll` for whatever happened since last time. No event plugin, no npm
//! package, and — the reason that matters here — no channel object whose
//! serialisation we would have to reproduce from the internals object the app
//! already uses instead of the JS API. Idle cost is a small IPC call a few
//! times a second per open link; data frames ride back base64 inside JSON,
//! which is good enough to ship and easy to replace with a raw response later.
//!
//! **Outbound order is sacred.** Tauri runs async commands concurrently, so two
//! `rtc_send` calls in flight could reach the channel in either order — and
//! a file transfer reads a gap as corruption and stops. Every send therefore
//! goes into a per-connection queue synchronously, and ONE writer task drains
//! it in order. That queue is also what `buffered` reports, so backpressure in
//! the webview sees bytes we have not yet handed to SCTP.
//!
//! **One long-lived runtime.** The spike found that the tokio runtime this
//! crate hands out builds a fresh executor on every `block_on`, killing what a
//! peer connection spawned during `build()`. Nothing here calls `block_on`:
//! the crate spawns its drivers on its own lazily created reactor thread, and
//! our loops are spawned there too.
//!
//! Linux only. WebView2 and WKWebView do WebRTC themselves (measured on Windows
//! 11 ARM and macOS, 2026-09-14), and this is ~390 crates those builds do not
//! need. The other targets get stubs with the same names, so the command table
//! in `lib.rs` is one list.

#![allow(clippy::module_name_repetitions)]

#[cfg(target_os = "linux")]
mod imp {
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use bytes::BytesMut;
    use serde_json::{json, Value};
    use webrtc::data_channel::{DataChannel, DataChannelEvent};
    use webrtc::peer_connection::{
        PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
        RTCIceCandidateInit, RTCIceServer, RTCPeerConnectionIceEvent, RTCPeerConnectionState,
        RTCSessionDescription,
    };
    use webrtc::runtime::{default_runtime, Runtime};

    /// Where SCTP tells us it has room again (`OnBufferedAmountLow`). The
    /// high-water mark lives in the webview (`net/webrtc-tauri.ts`), which is
    /// the side that decides when to pause a transfer; this side only reports
    /// how much is still waiting.
    const LOW_WATER: u32 = 1024 * 1024;
    /// The label the browser link uses; a peer running the browser stack
    /// announces this exact channel.
    const LABEL: &str = "onchato";

    pub struct Conn {
        pc: Arc<dyn PeerConnection>,
        dc: Mutex<Option<Arc<dyn DataChannel>>>,
        events: Mutex<VecDeque<Value>>,
        outbox: Mutex<VecDeque<Vec<u8>>>,
        outbox_bytes: AtomicU64,
        sctp_bytes: AtomicU64,
        notify: tokio::sync::Notify,
        closed: AtomicBool,
    }

    impl Conn {
        fn push(&self, ev: Value) {
            let mut q = self.events.lock().unwrap();
            // A webview that stopped polling must not grow this without bound;
            // a link that nobody reads for a while is a link that is being
            // torn down, and the newest events are the ones that matter.
            if q.len() > 4096 { q.pop_front(); }
            q.push_back(ev);
        }
        fn buffered(&self) -> u64 {
            self.outbox_bytes.load(Ordering::Relaxed) + self.sctp_bytes.load(Ordering::Relaxed)
        }
    }

    /// Everything the peer connection reports, queued for the webview.
    struct Handler { conn: Arc<Conn>, runtime: Arc<dyn Runtime> }

    #[async_trait::async_trait]
    impl PeerConnectionEventHandler for Handler {
        async fn on_ice_candidate(&self, ev: RTCPeerConnectionIceEvent) {
            if let Ok(j) = ev.candidate.to_json() {
                self.conn.push(json!({ "t": "ice", "candidate": {
                    "candidate": j.candidate, "sdpMid": j.sdp_mid,
                    "sdpMLineIndex": j.sdp_mline_index, "usernameFragment": j.username_fragment } }));
            }
        }
        async fn on_connection_state_change(&self, s: RTCPeerConnectionState) {
            self.conn.push(json!({ "t": "state", "conn": s.to_string() }));
        }
        async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
            attach(self.conn.clone(), self.runtime.clone(), dc).await;
        }
    }

    /// Wire a channel to its connection: one reader loop, one writer loop.
    async fn attach(conn: Arc<Conn>, runtime: Arc<dyn Runtime>, dc: Arc<dyn DataChannel>) {
        let _ = dc.set_buffered_amount_low_threshold(LOW_WATER).await;
        *conn.dc.lock().unwrap() = Some(dc.clone());

        // Reader: channel events become queue entries. Data goes base64 —
        // the poll answer is JSON, and this is the honest cost of that choice.
        {
            let conn = conn.clone();
            let dc = dc.clone();
            runtime.spawn(Box::pin(async move {
                while let Some(ev) = dc.poll().await {
                    match ev {
                        DataChannelEvent::OnOpen => conn.push(json!({ "t": "open" })),
                        DataChannelEvent::OnClose => { conn.push(json!({ "t": "close" })); break }
                        DataChannelEvent::OnBufferedAmountLow => {
                            conn.sctp_bytes.store(dc.outstanding_bytes().await.unwrap_or(0) as u64, Ordering::Relaxed);
                            conn.push(json!({ "t": "low" }));
                        }
                        DataChannelEvent::OnMessage(m) => conn.push(json!({ "t": "data", "b64": b64(&m.data) })),
                        _ => {}
                    }
                    if conn.closed.load(Ordering::Relaxed) { break }
                }
            }));
        }
        // Writer: the ONLY place bytes reach the channel, in the order they
        // were queued. `send` waits for SCTP room itself (the crate's own
        // backpressure), so a slow peer stalls this loop and not the webview.
        {
            let conn = conn.clone();
            runtime.spawn(Box::pin(async move {
                loop {
                    let next = conn.outbox.lock().unwrap().pop_front();
                    match next {
                        Some(bytes) => {
                            conn.outbox_bytes.fetch_sub(bytes.len() as u64, Ordering::Relaxed);
                            if dc.send(BytesMut::from(&bytes[..])).await.is_err() {
                                conn.push(json!({ "t": "close" }));
                                break;
                            }
                            conn.sctp_bytes.store(dc.outstanding_bytes().await.unwrap_or(0) as u64, Ordering::Relaxed);
                        }
                        None => {
                            if conn.closed.load(Ordering::Relaxed) { break }
                            conn.notify.notified().await;
                        }
                    }
                }
            }));
        }
    }

    pub struct Rtc {
        runtime: Arc<dyn Runtime>,
        conns: Mutex<HashMap<u32, Arc<Conn>>>,
    }

    impl Rtc {
        pub fn new() -> Self {
            Self { runtime: default_runtime().expect("webrtc runtime"), conns: Mutex::new(HashMap::new()) }
        }
        fn get(&self, id: u32) -> Result<Arc<Conn>, String> {
            self.conns.lock().unwrap().get(&id).cloned().ok_or_else(|| format!("no connection {id}"))
        }
        async fn make(&self, initiator: bool, ice: Vec<String>) -> Result<Arc<Conn>, String> {
            // The connection needs its handler at build time and the handler
            // needs the connection: build the shared record first, with the
            // peer connection slot filled in a moment later.
            let servers = ice.into_iter().map(|u| RTCIceServer { urls: vec![u], ..Default::default() }).collect::<Vec<_>>();
            let config = RTCConfigurationBuilder::new().with_ice_servers(servers).build();
            let pending: Arc<Mutex<Option<Arc<Conn>>>> = Arc::new(Mutex::new(None));
            let proxy = Arc::new(ProxyHandler { target: pending.clone(), runtime: self.runtime.clone() });
            let pc: Arc<dyn PeerConnection> = Arc::new(
                PeerConnectionBuilder::new()
                    .with_configuration(config)
                    .with_handler(proxy)
                    .with_runtime(self.runtime.clone())
                    .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
                    .build()
                    .await
                    .map_err(|e| e.to_string())?,
            );
            let conn = Arc::new(Conn {
                pc, dc: Mutex::new(None), events: Mutex::new(VecDeque::new()),
                outbox: Mutex::new(VecDeque::new()), outbox_bytes: AtomicU64::new(0),
                sctp_bytes: AtomicU64::new(0), notify: tokio::sync::Notify::new(), closed: AtomicBool::new(false),
            });
            *pending.lock().unwrap() = Some(conn.clone());
            if initiator {
                let dc = conn.pc.create_data_channel(LABEL, None).await.map_err(|e| e.to_string())?;
                attach(conn.clone(), self.runtime.clone(), dc).await;
            }
            Ok(conn)
        }
    }

    /// The handler the builder gets before the connection record exists.
    struct ProxyHandler { target: Arc<Mutex<Option<Arc<Conn>>>>, runtime: Arc<dyn Runtime> }
    impl ProxyHandler {
        fn conn(&self) -> Option<Arc<Conn>> { self.target.lock().unwrap().clone() }
    }
    #[async_trait::async_trait]
    impl PeerConnectionEventHandler for ProxyHandler {
        async fn on_ice_candidate(&self, ev: RTCPeerConnectionIceEvent) {
            if let Some(c) = self.conn() { Handler { conn: c, runtime: self.runtime.clone() }.on_ice_candidate(ev).await }
        }
        async fn on_connection_state_change(&self, s: RTCPeerConnectionState) {
            if let Some(c) = self.conn() { Handler { conn: c, runtime: self.runtime.clone() }.on_connection_state_change(s).await }
        }
        async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
            if let Some(c) = self.conn() { Handler { conn: c, runtime: self.runtime.clone() }.on_data_channel(dc).await }
        }
    }

    fn candidate_from(v: &Value) -> RTCIceCandidateInit {
        RTCIceCandidateInit {
            candidate: v["candidate"].as_str().unwrap_or("").to_string(),
            sdp_mid: v["sdpMid"].as_str().map(|s| s.to_string()),
            sdp_mline_index: v["sdpMLineIndex"].as_u64().map(|n| n as u16),
            username_fragment: v["usernameFragment"].as_str().map(|s| s.to_string()),
            url: None,
        }
    }

    /// Standard base64, no padding tricks — the webview decodes with atob.
    fn b64(data: &[u8]) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
        for chunk in data.chunks(3) {
            let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            out.push(T[(n >> 18) as usize & 63] as char);
            out.push(T[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
            out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
        }
        out
    }

    // ---- commands ----------------------------------------------------------

    #[tauri::command]
    pub fn rtc_available() -> bool { true }

    #[tauri::command]
    pub async fn rtc_create(state: tauri::State<'_, Rtc>, id: u32, initiator: bool, ice: Vec<String>) -> Result<(), String> {
        let conn = state.make(initiator, ice).await?;
        state.conns.lock().unwrap().insert(id, conn);
        Ok(())
    }

    #[tauri::command]
    pub async fn rtc_offer(state: tauri::State<'_, Rtc>, id: u32) -> Result<String, String> {
        let c = state.get(id)?;
        let offer = c.pc.create_offer(None).await.map_err(|e| e.to_string())?;
        c.pc.set_local_description(offer.clone()).await.map_err(|e| e.to_string())?;
        Ok(offer.sdp)
    }

    #[tauri::command]
    pub async fn rtc_answer(state: tauri::State<'_, Rtc>, id: u32, sdp: String) -> Result<String, String> {
        let c = state.get(id)?;
        let offer = RTCSessionDescription::offer(sdp).map_err(|e| e.to_string())?;
        c.pc.set_remote_description(offer).await.map_err(|e| e.to_string())?;
        let answer = c.pc.create_answer(None).await.map_err(|e| e.to_string())?;
        c.pc.set_local_description(answer.clone()).await.map_err(|e| e.to_string())?;
        Ok(answer.sdp)
    }

    #[tauri::command]
    pub async fn rtc_set_answer(state: tauri::State<'_, Rtc>, id: u32, sdp: String) -> Result<(), String> {
        let c = state.get(id)?;
        let answer = RTCSessionDescription::answer(sdp).map_err(|e| e.to_string())?;
        c.pc.set_remote_description(answer).await.map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn rtc_ice(state: tauri::State<'_, Rtc>, id: u32, candidate: Value) -> Result<(), String> {
        let c = state.get(id)?;
        c.pc.add_ice_candidate(candidate_from(&candidate)).await.map_err(|e| e.to_string())
    }

    /// Raw body in, queued in order. `x-id` names the connection, because a
    /// raw request carries no JSON arguments.
    #[tauri::command]
    pub fn rtc_send(state: tauri::State<'_, Rtc>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
        let id: u32 = request.headers().get("x-id").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok())
            .ok_or("x-id header missing")?;
        let bytes: Vec<u8> = match request.body() {
            tauri::ipc::InvokeBody::Raw(b) => b.clone(),
            tauri::ipc::InvokeBody::Json(_) => return Err("rtc_send wants a raw body".into()),
        };
        let c = state.get(id)?;
        c.outbox_bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        c.outbox.lock().unwrap().push_back(bytes);
        c.notify.notify_one();
        Ok(())
    }

    /// Everything since the last call, plus how much is still waiting to go out.
    #[tauri::command]
    pub fn rtc_poll(state: tauri::State<'_, Rtc>, id: u32) -> Result<Value, String> {
        let c = state.get(id)?;
        let events: Vec<Value> = c.events.lock().unwrap().drain(..).collect();
        Ok(json!({ "events": events, "buffered": c.buffered() }))
    }

    #[tauri::command]
    pub async fn rtc_close(state: tauri::State<'_, Rtc>, id: u32) -> Result<(), String> {
        let c = state.conns.lock().unwrap().remove(&id);
        if let Some(c) = c {
            c.closed.store(true, Ordering::Relaxed);
            c.notify.notify_one();
            let dc = c.dc.lock().unwrap().clone();
            if let Some(dc) = dc { let _ = dc.close().await; }
            let _ = c.pc.close().await;
        }
        Ok(())
    }

    /// Two connections in this process, a channel between them, 64 KiB across.
    /// The Diagnostyka probe's `loopback` stage for this platform: it needs no
    /// network and no peer, so a pass means the stack works and any failure to
    /// reach a real peer is about the network.
    #[tauri::command]
    pub async fn rtc_selftest(state: tauri::State<'_, Rtc>) -> Result<Value, String> {
        let t0 = Instant::now();
        let a = state.make(true, vec![]).await?;
        let b = state.make(false, vec![]).await?;
        let offer = a.pc.create_offer(None).await.map_err(|e| e.to_string())?;
        a.pc.set_local_description(offer.clone()).await.map_err(|e| e.to_string())?;
        b.pc.set_remote_description(offer).await.map_err(|e| e.to_string())?;
        let answer = b.pc.create_answer(None).await.map_err(|e| e.to_string())?;
        b.pc.set_local_description(answer.clone()).await.map_err(|e| e.to_string())?;
        a.pc.set_remote_description(answer).await.map_err(|e| e.to_string())?;

        let payload = vec![0x5au8; 64 * 1024];
        a.outbox_bytes.fetch_add(payload.len() as u64, Ordering::Relaxed);
        a.outbox.lock().unwrap().push_back(payload.clone());
        a.notify.notify_one();

        // Shuttle ICE between the two by hand, and watch B's queue for the bytes.
        let mut got = 0usize;
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        while Instant::now() < deadline {
            for (from, to) in [(&a, &b), (&b, &a)] {
                let evs: Vec<Value> = from.events.lock().unwrap().drain(..).collect();
                for ev in evs {
                    if ev["t"] == "ice" { let _ = to.pc.add_ice_candidate(candidate_from(&ev["candidate"])).await; }
                    if ev["t"] == "data" && std::ptr::eq(from, &b) {
                        got += ev["b64"].as_str().map(|s| s.len() / 4 * 3).unwrap_or(0);
                    }
                }
            }
            if got >= payload.len() { break }
            state.runtime.sleep(std::time::Duration::from_millis(10)).await;
        }
        let _ = a.pc.close().await;
        let _ = b.pc.close().await;
        if got < payload.len() { return Err(format!("loopback carried {got} of {} bytes in 10 s", payload.len())) }
        Ok(json!({ "ok": true, "bytes": got, "ms": t0.elapsed().as_millis() as u64 }))
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use serde_json::Value;
    pub struct Rtc;
    impl Rtc { pub fn new() -> Self { Rtc } }
    const NO: &str = "the Rust DataChannel exists only on Linux; this webview does WebRTC itself";
    #[tauri::command] pub fn rtc_available() -> bool { false }
    #[tauri::command] pub async fn rtc_create(_s: tauri::State<'_, Rtc>, _id: u32, _initiator: bool, _ice: Vec<String>) -> Result<(), String> { Err(NO.into()) }
    #[tauri::command] pub async fn rtc_offer(_s: tauri::State<'_, Rtc>, _id: u32) -> Result<String, String> { Err(NO.into()) }
    #[tauri::command] pub async fn rtc_answer(_s: tauri::State<'_, Rtc>, _id: u32, _sdp: String) -> Result<String, String> { Err(NO.into()) }
    #[tauri::command] pub async fn rtc_set_answer(_s: tauri::State<'_, Rtc>, _id: u32, _sdp: String) -> Result<(), String> { Err(NO.into()) }
    #[tauri::command] pub async fn rtc_ice(_s: tauri::State<'_, Rtc>, _id: u32, _candidate: Value) -> Result<(), String> { Err(NO.into()) }
    #[tauri::command] pub fn rtc_send(_s: tauri::State<'_, Rtc>, _request: tauri::ipc::Request<'_>) -> Result<(), String> { Err(NO.into()) }
    #[tauri::command] pub fn rtc_poll(_s: tauri::State<'_, Rtc>, _id: u32) -> Result<Value, String> { Err(NO.into()) }
    #[tauri::command] pub async fn rtc_close(_s: tauri::State<'_, Rtc>, _id: u32) -> Result<(), String> { Err(NO.into()) }
    #[tauri::command] pub async fn rtc_selftest(_s: tauri::State<'_, Rtc>) -> Result<Value, String> { Err(NO.into()) }
}

pub use imp::*;
