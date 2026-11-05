//! `/w/<id>` and `/wa/<ip:port>`: a browser's `punktfunk/2` session carried over a WebSocket, for
//! networks that block the plane's UDP (`web-client-tcp-bridge.md` §3).
//!
//! The bridge dials the plane the way the page would, pinned to the hash the page verified, and
//! moves bytes. It reads one thing, the tag that says which of the session's streams a message
//! belongs to. A datagram the WebSocket cannot take in time is dropped, as UDP would drop it; the
//! client already recovers from that.

mod frame;
mod plane;

use crate::hosts::Hosts;
use crate::lanes::{Slot, PAIRING_LIFE};
#[cfg(test)]
use crate::lanes::{PAIRING_FULL, PAIRING_HOURLY};
use crate::proof::Outcome;
use crate::proxy;
use crate::visitor::Visitor;
use axum::body::Bytes;
use axum::extract::ws::{close_code, CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Path, Query, Request, State};
use axum::http::{header, request::Parts, StatusCode};
use axum::response::{IntoResponse, Response};
use frame::Frame;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{FutureExt, SinkExt, StreamExt};
use punktfunk_core::provenance::CLIENT_ADDR_UNKNOWN;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{self, Receiver, Sender};
use tokio::task::JoinSet;
use tokio::time::timeout;
use wtransport::error::ConnectionError;
use wtransport::{Connection, RecvStream, SendStream, VarInt};

const MAX_MESSAGE: usize = 1 << 20;
const DIAL_TIMEOUT: Duration = Duration::from_secs(5);
/// A WebSocket ping this often; three unanswered and the TCP leg is dead.
const PING: Duration = Duration::from_secs(10);
/// Host-to-page datagrams waiting for the socket. 32 × ~1.2 KB is under one frame at 50 Mbps, so
/// a stalled TCP leg shows as loss within a frame rather than as a growing delay.
const QUEUE: usize = 32;
/// How long a closing session waits for what is already in flight.
const GRACE: Duration = Duration::from_secs(2);

#[derive(serde::Deserialize)]
struct Dial {
    port: u16,
    hash: String,
}

/// The first message's deadline. Before it the plane is not dialled.
const FIRST: Duration = Duration::from_secs(5);

/// Where the bridge dials: a host at its management port and pin. One the operator did not
/// list must be proven first; `typed` is one the page named, whose proof a stranger pays for.
struct To {
    addr: String,
    mgmt: u16,
    pin: Option<[u8; 32]>,
    listed: bool,
    typed: bool,
}

/// A host this server lists; one mDNS found, once proven.
pub async fn listed(
    State(hosts): State<Arc<Hosts>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let to = hosts.get(&id).ok_or(StatusCode::NOT_FOUND).map(|h| To {
        listed: h.fullname.is_none(),
        typed: false,
        addr: h.addr,
        mgmt: h.port,
        pin: h.pin,
    });
    open(hosts, to, id, req).await
}

/// A host the page names by its address, as `/a/` reaches one.
pub async fn typed(
    State(hosts): State<Arc<Hosts>>,
    Path(target): Path<String>,
    req: Request,
) -> Response {
    let to = match proxy::typed_target(&hosts, &target) {
        _ if !hosts.add_hosts => Err(StatusCode::NOT_FOUND),
        Ok((ip, mgmt)) => {
            let addr = proxy::url_host(ip);
            let pin = hosts.pin_at(&format!("{addr}:{mgmt}"));
            Ok(To {
                addr,
                mgmt,
                pin,
                listed: false,
                typed: true,
            })
        }
        Err(_) => Err(StatusCode::BAD_REQUEST),
    };
    open(hosts, to, target, req).await
}

/// What admission needs once the socket is open: the host's identity, the plane it published
/// when that is known, and who is asking.
struct Admit {
    hosts: Arc<Hosts>,
    to: To,
    identity: Option<[u8; 32]>,
    published: Option<(u16, [u8; 32])>,
    who: Option<IpAddr>,
}

async fn open(
    hosts: Arc<Hosts>,
    to: Result<To, StatusCode>,
    host: String,
    req: Request,
) -> Response {
    let (mut parts, _) = req.into_parts();
    let to = match to {
        Ok(to) => to,
        Err(status) => return status.into_response(),
    };
    let Some((port, hash)) = Query::<Dial>::try_from_uri(&parts.uri)
        .ok()
        .and_then(|Query(d)| Some((d.port, crate::config::parse_fp(&d.hash).ok()?)))
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let (mut identity, mut published) = (to.pin, None);
    if !to.listed {
        let key = format!("{}:{}", to.addr, to.mgmt);
        if to.typed {
            if let Some(refused) = crate::proof::over_meter(&hosts, &parts.extensions, &key, false)
            {
                return refused;
            }
        }
        match crate::proof::prove(&hosts, &to.addr, to.mgmt, to.pin, false).await {
            Outcome::Host {
                fp,
                plane_port,
                plane_hash,
                ..
            } => (identity, published) = (Some(fp), Some((plane_port, plane_hash))),
            refused => {
                return refused
                    .refusal()
                    .unwrap_or_else(|| StatusCode::BAD_GATEWAY.into_response())
            }
        }
    }
    let ws = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(ws) => ws,
        Err(refused) => return refused.into_response(),
    };
    let visitor = parts.extensions.get::<Visitor>();
    let target = plane::Target {
        addr: to.addr.clone(),
        port,
        hash,
        origin: header_str(&parts, header::ORIGIN.as_str()).map(str::to_owned),
        client: visitor.map_or_else(|| CLIENT_ADDR_UNKNOWN.into(), Visitor::header),
    };
    let admit = Admit {
        who: visitor.and_then(|v| v.addr),
        hosts,
        to,
        identity,
        published,
    };
    ws.max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
        .on_upgrade(move |socket| session(socket, target, host, admit))
}

const PASS_REFUSED: &str =
    "this page doesn't know this browser's pass for the host. Reload the page and connect again";
const PAIRING_OVER: &str =
    "this page gives a browser three minutes to pair with a host. Connect again to try once more";
const NOT_PUBLISHED: &str =
    "this page reaches only the host's own streaming port for a browser that isn't paired with it";

/// The first message picks the pool: tag 5 with a pass for this host, any port on it; or tag 6
/// to pair, only to the plane the host published. The refusal is a close code and the page's
/// sentence.
async fn admission(
    socket: &mut WebSocket,
    target: &plane::Target,
    a: &Admit,
) -> Result<(Slot, bool), (u16, &'static str)> {
    let first = match timeout(FIRST, socket.recv()).await {
        Ok(Some(Ok(Message::Binary(m)))) => m,
        _ => return Err((close_code::POLICY, "no pool asked for")),
    };
    let pools = &a.hosts.lanes.pools;
    match frame::decode(&first) {
        Some(Frame::Pass(pass)) => {
            let pass = crate::hosts::hex(pass);
            if !a.hosts.lanes.passes.hosts(&pass).covers(a.identity) {
                return Err((close_code::POLICY, PASS_REFUSED));
            }
            let slot = pools.paired().map_err(|say| (close_code::AGAIN, say))?;
            Ok((slot, false))
        }
        Some(Frame::Pair) => {
            let published = match a.published {
                Some(p) => Some(p),
                None => crate::proof::published(&a.to.addr, a.to.mgmt, a.to.pin).await,
            };
            if published != Some((target.port, target.hash)) {
                return Err((close_code::POLICY, NOT_PUBLISHED));
            }
            let slot = pools
                .pairing(a.who)
                .map_err(|say| (close_code::AGAIN, say))?;
            Ok((slot, true))
        }
        _ => Err((close_code::PROTOCOL, "unknown message")),
    }
}

fn header_str<'a>(parts: &'a Parts, name: &str) -> Option<&'a str> {
    parts.headers.get(name).and_then(|v| v.to_str().ok())
}

#[derive(Default)]
struct Counts {
    to_host: AtomicU64,
    to_host_dropped: AtomicU64,
    to_page: AtomicU64,
    to_page_dropped: AtomicU64,
}

async fn session(mut socket: WebSocket, target: plane::Target, host: String, admit: Admit) {
    let (_slot, pairing) = match admission(&mut socket, &target, &admit).await {
        Ok(admitted) => admitted,
        Err((code, reason)) => {
            tracing::info!(host = %host, reason, "bridge session refused");
            let _ = socket.send(close(code, reason)).await;
            return;
        }
    };
    let started = Instant::now();
    let conn = match timeout(DIAL_TIMEOUT, plane::dial(&target)).await {
        Ok(Ok(conn)) => conn,
        dialed => {
            let (reason, cause) = match dialed {
                Ok(Err(e)) => ("host refused the session", format!("{e:#}")),
                _ => ("host did not answer", "timed out".into()),
            };
            tracing::warn!(host = %host, cause, "bridge dial did not connect");
            let _ = socket.send(close(close_code::ERROR, reason)).await;
            return;
        }
    };
    let counts = Arc::new(Counts::default());
    // A stranger's session lasts as long as the host parks a knock, and no longer.
    let relay = relay(socket, &conn, &counts);
    tokio::pin!(relay);
    let code = tokio::select! {
        code = &mut relay => code,
        _ = tokio::time::sleep(PAIRING_LIFE), if pairing => {
            conn.close(VarInt::from_u32(0), b"");
            relay.await
        }
    };
    tracing::info!(
        host = %host,
        secs = started.elapsed().as_secs(),
        to_host = counts.to_host.load(Relaxed),
        to_host_dropped = counts.to_host_dropped.load(Relaxed),
        to_page = counts.to_page.load(Relaxed),
        to_page_dropped = counts.to_page_dropped.load(Relaxed),
        code,
        "bridge session ended"
    );
}

/// How the page side ended.
enum End {
    /// The page left: with its tag-3 code and reason, or the plain leave (0) when it just went.
    Left(u32, Bytes),
    /// A message outside the framing.
    Protocol,
}

const LEAVE: End = End::Left(0, Bytes::new());

/// Four pumps (§3.4): page → host here, host datagrams and host streams each in a task, and one
/// writer onto the socket. Returns the session's close code.
async fn relay(socket: WebSocket, conn: &Connection, counts: &Arc<Counts>) -> u32 {
    let (sink, mut page) = socket.split();
    let (datagrams, datagrams_rx) = mpsc::channel(QUEUE);
    let (reliable, reliable_rx) = mpsc::channel(QUEUE);
    let writer = tokio::spawn(to_page(sink, datagrams_rx, reliable_rx));
    let mut pumps = JoinSet::new();
    pumps.spawn(host_datagrams(conn.clone(), datagrams, counts.clone()));
    pumps.spawn(host_unis(conn.clone(), reliable.clone()));

    let end = tokio::select! {
        biased;
        e = conn.closed() => Err(e),
        // A page side that ends because the host went is the host's close.
        end = from_page(&mut page, conn, &reliable, &mut pumps, counts) => {
            conn.closed().now_or_never().map_or(Ok(end), Err)
        }
    };
    let (code, last) = match end {
        Err(ConnectionError::ApplicationClosed(c)) => {
            let code = c.code().into_inner() as u32;
            // The pumps end with the connection. What they read goes ahead of the close.
            let _ = timeout(GRACE, async { while pumps.join_next().await.is_some() {} }).await;
            let tag3 = frame::encode(&Frame::Close {
                code,
                reason: c.reason(),
            });
            (
                code,
                vec![Message::Binary(tag3.into()), close(close_code::NORMAL, "")],
            )
        }
        // Only the pairing session's deadline closes the connection from outside `relay`.
        Err(ConnectionError::LocallyClosed) => (0, vec![close(close_code::AGAIN, PAIRING_OVER)]),
        Err(_) => (0, vec![close(close_code::ERROR, "host connection lost")]),
        Ok(End::Left(code, reason)) => {
            conn.close(VarInt::from_u32(code), &reason);
            (code, vec![close(close_code::NORMAL, "")])
        }
        Ok(End::Protocol) => {
            conn.close(VarInt::from_u32(0), b"");
            (0, vec![close(close_code::PROTOCOL, "unknown message")])
        }
    };
    drop(pumps);
    // Bounded: a page that stopped reading must not hold the session open.
    let stop = writer.abort_handle();
    let flush = async {
        for m in last {
            let _ = reliable.send(m).await;
        }
        let _ = writer.await;
    };
    if timeout(GRACE, flush).await.is_err() {
        stop.abort();
    }
    code
}

/// Page → host, by tag. The control stream opens on the page's first control bytes.
async fn from_page(
    page: &mut SplitStream<WebSocket>,
    conn: &Connection,
    reliable: &Sender<Message>,
    pumps: &mut JoinSet<()>,
    counts: &Counts,
) -> End {
    let mut control: Option<SendStream> = None;
    loop {
        let msg = match timeout(PING * 3, page.next()).await {
            Ok(Some(Ok(Message::Binary(m)))) => m,
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
            Ok(Some(Ok(Message::Text(_)))) => return End::Protocol,
            _ => return LEAVE,
        };
        match frame::decode(&msg) {
            Some(Frame::Datagram(d)) => {
                // `TooLarge` is the host's own rule too: drop and count.
                let n = match conn.send_datagram(d) {
                    Ok(()) => &counts.to_host,
                    Err(_) => &counts.to_host_dropped,
                };
                n.fetch_add(1, Relaxed);
            }
            Some(Frame::Control(bytes)) => {
                let tx = match control.as_mut() {
                    Some(tx) => tx,
                    None => {
                        let Ok((tx, rx)) = open_control(conn).await else {
                            return LEAVE;
                        };
                        pumps.spawn(host_control(rx, reliable.clone()));
                        control.insert(tx)
                    }
                };
                if tx.write_all(bytes).await.is_err() {
                    return LEAVE;
                }
            }
            Some(Frame::Close { code, reason }) => {
                return End::Left(code, Bytes::copy_from_slice(reason))
            }
            Some(Frame::Ping(sent)) => {
                let rtt_us = u32::try_from(conn.rtt().as_micros()).unwrap_or(u32::MAX);
                let pong = frame::encode(&Frame::Pong { sent, rtt_us });
                if reliable.send(Message::Binary(pong.into())).await.is_err() {
                    return LEAVE;
                }
            }
            Some(Frame::Pong { .. }) => {}
            Some(Frame::Uni(_) | Frame::Pass(_) | Frame::Pair) | None => return End::Protocol,
        }
    }
}

/// Host datagrams → the writer. Never awaited: a full queue means the socket is behind, and the
/// datagram is dropped.
async fn host_datagrams(conn: Connection, out: Sender<Bytes>, counts: Arc<Counts>) {
    while let Ok(d) = conn.receive_datagram().await {
        let n = match out.try_reserve() {
            Ok(slot) => {
                slot.send(frame::encode(&Frame::Datagram(&d)).into());
                &counts.to_page
            }
            Err(_) => &counts.to_page_dropped,
        };
        n.fetch_add(1, Relaxed);
    }
}

/// Each stream the host opens (a `Refused`), whole, as one message.
async fn host_unis(conn: Connection, out: Sender<Message>) {
    while let Ok(mut rx) = conn.accept_uni().await {
        let mut all = Vec::new();
        let mut buf = [0; 16 * 1024];
        let whole = loop {
            match rx.read(&mut buf).await {
                Ok(None) => break true,
                Ok(Some(n)) if all.len() + n < MAX_MESSAGE => all.extend_from_slice(&buf[..n]),
                _ => break false,
            }
        };
        let msg = frame::encode(&Frame::Uni(&all));
        if whole && out.send(Message::Binary(msg.into())).await.is_err() {
            return;
        }
    }
}

async fn open_control(conn: &Connection) -> anyhow::Result<(SendStream, RecvStream)> {
    Ok(conn.open_bi().await?.await?)
}

async fn host_control(mut rx: RecvStream, out: Sender<Message>) {
    let mut buf = vec![0; 64 * 1024];
    while let Ok(Some(n)) = rx.read(&mut buf).await {
        let msg = frame::encode(&Frame::Control(&buf[..n]));
        if out.send(Message::Binary(msg.into())).await.is_err() {
            return;
        }
    }
}

/// The one writer onto the socket: stream bytes first, then datagrams, and a ping every
/// [`PING`]. Ends after a close.
async fn to_page(
    mut sink: SplitSink<WebSocket, Message>,
    mut datagrams: Receiver<Bytes>,
    mut reliable: Receiver<Message>,
) {
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING, PING);
    loop {
        let msg = tokio::select! {
            biased;
            Some(m) = reliable.recv() => m,
            Some(d) = datagrams.recv() => Message::Binary(d),
            _ = ping.tick() => Message::Ping(Bytes::new()),
        };
        let last = matches!(msg, Message::Close(_));
        if sink.send(msg).await.is_err() || last {
            return;
        }
    }
}

fn close(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Listed;
    use std::net::SocketAddr;
    use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, Message as Ws};
    use wtransport::endpoint::endpoint_side::Server;
    use wtransport::{Endpoint, Identity, ServerConfig};

    type Page = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    /// A plane on loopback: its endpoint, port and certificate hash.
    fn plane() -> (Endpoint<Server>, u16, [u8; 32]) {
        let identity = Identity::self_signed(["localhost"]).unwrap();
        let hash = *identity.certificate_chain().as_slice()[0].hash().as_ref();
        let server = Endpoint::server(
            ServerConfig::builder()
                .with_bind_address("127.0.0.1:0".parse().unwrap())
                .with_identity(identity)
                .build(),
        )
        .unwrap();
        let port = server.local_addr().unwrap().port();
        (server, port, hash)
    }

    /// This server on loopback, and a pass for its one host.
    struct Served {
        at: SocketAddr,
        pass: [u8; 32],
    }

    async fn page_server(name: &str) -> Served {
        serve_desk(name, crate::config::MGMT_PORT, [7; 32]).await
    }

    /// This server on loopback, listing `desk` at 127.0.0.1:`mgmt` pinned to `fp`.
    async fn serve_desk(name: &str, mgmt: u16, fp: [u8; 32]) -> Served {
        let dir = std::env::temp_dir().join(format!("pf-bridge-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let desk = Listed {
            name: "desk".into(),
            addr: "127.0.0.1".into(),
            port: mgmt,
            pin: Some(fp),
        };
        let hosts = Hosts::new(vec![desk], &dir, true, crate::visitor::TEST).unwrap();
        let pass = hosts.lanes.passes.prove(None, fp);
        let pass = crate::config::parse_fp(&pass).unwrap();
        let app = crate::router(hosts, dir, Default::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let at = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
        });
        Served { at, pass }
    }

    /// The bridge opened in the paired pool.
    async fn paired(s: &Served, path: &str, headers: &[(&'static str, &str)]) -> Page {
        let mut ws = open(s.at, path, headers).await.unwrap();
        send(&mut ws, Frame::Pass(&s.pass)).await;
        ws
    }

    /// The bridge opened in the pairing pool, as a stranger at `from`.
    async fn pairing(s: &Served, path: &str, from: &str) -> Page {
        let mut ws = open(s.at, path, &[("x-forwarded-for", from)])
            .await
            .unwrap();
        send(&mut ws, Frame::Pair).await;
        ws
    }

    /// The session dialled the plane: a ping comes back as a pong.
    async fn admitted(ws: &mut Page) -> bool {
        send(ws, Frame::Ping(1f64.to_be_bytes())).await;
        match next(ws).await {
            Ws::Binary(b) => matches!(frame::decode(&b), Some(Frame::Pong { .. })),
            _ => false,
        }
    }

    /// A plane that takes every session and holds it until the other side goes.
    fn plane_accepting() -> (u16, [u8; 32]) {
        let (server, port, hash) = plane();
        tokio::spawn(async move {
            loop {
                let conn = server.accept().await.await.unwrap().accept().await.unwrap();
                tokio::spawn(async move { conn.closed().await });
            }
        });
        (port, hash)
    }

    /// Open the bridge as a page would; the refusal's status when it is not upgraded.
    async fn open(
        at: SocketAddr,
        path: &str,
        headers: &[(&'static str, &str)],
    ) -> Result<Page, u16> {
        let mut req = format!("ws://{at}{path}").into_client_request().unwrap();
        for (name, value) in headers {
            req.headers_mut().insert(*name, value.parse().unwrap());
        }
        match tokio_tungstenite::connect_async(req).await {
            Ok((ws, _)) => Ok(ws),
            Err(tungstenite::Error::Http(res)) => Err(res.status().as_u16()),
            Err(e) => panic!("{e}"),
        }
    }

    fn own(at: SocketAddr) -> String {
        format!("http://{at}")
    }

    async fn send(ws: &mut Page, f: Frame<'_>) {
        ws.send(Ws::Binary(frame::encode(&f).into())).await.unwrap();
    }

    /// The next message that is not a protocol ping.
    async fn next(ws: &mut Page) -> Ws {
        loop {
            let m = timeout(Duration::from_secs(10), ws.next())
                .await
                .expect("a message in time")
                .expect("the socket open")
                .unwrap();
            if !matches!(m, Ws::Ping(_) | Ws::Pong(_)) {
                return m;
            }
        }
    }

    async fn next_binary(ws: &mut Page) -> Vec<u8> {
        match next(ws).await {
            Ws::Binary(b) => b.to_vec(),
            other => panic!("{other:?}"),
        }
    }

    async fn close_code(ws: &mut Page) -> (u16, String) {
        match next(ws).await {
            Ws::Close(Some(f)) => (f.code.into(), f.reason.to_string()),
            other => panic!("{other:?}"),
        }
    }

    async fn read_exact(rx: &mut RecvStream, n: usize) -> Vec<u8> {
        let mut buf = vec![0; n];
        rx.read_exact(&mut buf).await.unwrap();
        buf
    }

    #[tokio::test]
    async fn a_session_crosses_whole_and_ends_with_the_host_code() {
        let (server, port, hash) = plane();
        let host = tokio::spawn(async move {
            let req = server.accept().await.await.unwrap();
            let seen = (
                req.path().to_owned(),
                req.origin().map(str::to_owned),
                req.headers().get("pf-client-addr").cloned(),
            );
            let conn = req.accept().await.unwrap();
            let (mut tx, mut rx) = conn.accept_bi().await.unwrap();
            assert_eq!(read_exact(&mut rx, 5).await, b"hello");
            tx.write_all(b"welcome").await.unwrap();
            assert_eq!(&conn.receive_datagram().await.unwrap()[..], b"in");
            conn.send_datagram(b"out").unwrap();
            let mut uni = conn.open_uni().await.unwrap().await.unwrap();
            uni.write_all(b"refused").await.unwrap();
            uni.finish().await.unwrap();
            assert_eq!(read_exact(&mut rx, 4).await, b"done");
            conn.close(VarInt::from_u32(0x51), b"bye");
            seen
        });
        let s = page_server("whole").await;
        let path = format!("/w/desk?port={port}&hash={}", crate::hosts::hex(&hash));
        let origin = own(s.at);
        let mut ws = paired(&s, &path, &[("origin", &origin)]).await;

        send(&mut ws, Frame::Control(b"hello")).await;
        let mut ctl = Vec::new();
        while ctl.len() < 7 {
            let m = next_binary(&mut ws).await;
            assert_eq!(m[0], 1);
            ctl.extend_from_slice(&m[1..]);
        }
        assert_eq!(ctl, b"welcome");

        send(&mut ws, Frame::Ping(7.5f64.to_be_bytes())).await;
        let pong = next_binary(&mut ws).await;
        assert!(
            matches!(frame::decode(&pong), Some(Frame::Pong { sent, rtt_us }) if sent == 7.5f64.to_be_bytes() && rtt_us > 0),
            "{pong:?}"
        );

        send(&mut ws, Frame::Datagram(b"in")).await;
        let mut got = [next_binary(&mut ws).await, next_binary(&mut ws).await];
        got.sort();
        assert_eq!(got, [b"\x00out".to_vec(), b"\x02refused".to_vec()]);
        send(&mut ws, Frame::Control(b"done")).await;

        let tag3 = next_binary(&mut ws).await;
        assert_eq!(
            frame::decode(&tag3),
            Some(Frame::Close {
                code: 0x51,
                reason: b"bye"
            })
        );
        assert_eq!(close_code(&mut ws).await.0, 1000);

        let (path, origin_seen, client) = host.await.unwrap();
        assert_eq!(path, "/pf2");
        assert_eq!(origin_seen.as_deref(), Some(origin.as_str()));
        assert_eq!(client.as_deref(), Some("127.0.0.1"));
    }

    #[tokio::test]
    async fn the_page_close_reaches_the_host() {
        let (server, port, hash) = plane();
        let host = tokio::spawn(async move {
            let mut codes = Vec::new();
            for _ in 0..2 {
                let conn = server.accept().await.await.unwrap().accept().await.unwrap();
                codes.push(match conn.closed().await {
                    ConnectionError::ApplicationClosed(c) => {
                        (c.code().into_inner(), c.reason().to_vec())
                    }
                    other => panic!("{other}"),
                });
            }
            codes
        });
        let s = page_server("page-close").await;
        let path = format!("/w/desk?port={port}&hash={}", crate::hosts::hex(&hash));

        let mut quit = paired(&s, &path, &[]).await;
        send(
            &mut quit,
            Frame::Close {
                code: 0x51,
                reason: b"quit",
            },
        )
        .await;
        assert_eq!(close_code(&mut quit).await.0, 1000);

        let gone = paired(&s, &path, &[]).await;
        drop(gone);

        let codes = host.await.unwrap();
        assert_eq!(codes, [(0x51, b"quit".to_vec()), (0, Vec::new())]);
    }

    #[tokio::test]
    async fn a_full_queue_drops_and_counts() {
        let (server, port, hash) = plane();
        tokio::spawn(async move {
            let conn = server.accept().await.await.unwrap().accept().await.unwrap();
            conn.receive_datagram().await.unwrap();
            for i in 0..40u8 {
                conn.send_datagram([i]).unwrap();
            }
            conn.closed().await;
        });
        let conn = plane::dial(&plane::Target {
            addr: "127.0.0.1".into(),
            port,
            hash,
            origin: None,
            client: "127.0.0.1".into(),
        })
        .await
        .unwrap();
        let counts = Arc::new(Counts::default());
        let (out, _unread) = mpsc::channel(QUEUE);
        tokio::spawn(host_datagrams(conn.clone(), out, counts.clone()));
        conn.send_datagram(b"go").unwrap();
        let seen = || counts.to_page.load(Relaxed) + counts.to_page_dropped.load(Relaxed);
        timeout(Duration::from_secs(5), async {
            while seen() < 40 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(counts.to_page.load(Relaxed), 32);
        assert_eq!(counts.to_page_dropped.load(Relaxed), 8);
    }

    #[tokio::test]
    async fn only_this_page_with_a_good_hash_gets_in() {
        let (_server, port, hash) = plane();
        let at = page_server("admission").await.at;
        let good = format!("/w/desk?port={port}&hash={}", crate::hosts::hex(&hash));
        assert_eq!(
            open(at, &good, &[("sec-fetch-site", "cross-site")])
                .await
                .err(),
            Some(403)
        );
        assert_eq!(
            open(at, &good, &[("origin", "https://elsewhere.example")])
                .await
                .err(),
            Some(403)
        );
        for bad in [
            format!("/w/desk?port={port}&hash=abc"),
            format!("/w/desk?hash={}", crate::hosts::hex(&hash)),
            format!(
                "/wa/8.8.8.8:47990?port={port}&hash={}",
                crate::hosts::hex(&hash)
            ),
        ] {
            assert_eq!(open(at, &bad, &[]).await.err(), Some(400), "{bad}");
        }
        assert_eq!(
            open(at, "/w/nowhere?port=1&hash=00", &[]).await.err(),
            Some(404)
        );
    }

    #[tokio::test]
    async fn a_host_that_does_not_answer_or_match_closes_1011() {
        let (server, port, _) = plane();
        tokio::spawn(async move { server.accept().await.await });
        let silent = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let s = page_server("dial").await;

        let wrong = format!("/w/desk?port={port}&hash={}", "00".repeat(32));
        let mut ws = paired(&s, &wrong, &[]).await;
        assert_eq!(
            close_code(&mut ws).await,
            (1011, "host refused the session".into())
        );

        let quiet = format!(
            "/w/desk?port={}&hash={}",
            silent.local_addr().unwrap().port(),
            "00".repeat(32)
        );
        let mut ws = paired(&s, &quiet, &[]).await;
        assert_eq!(
            close_code(&mut ws).await,
            (1011, "host did not answer".into())
        );
    }

    #[tokio::test]
    async fn strangers_holding_sockets_leave_a_paired_stream_running() {
        let (port, hash) = plane_accepting();
        let s = page_server("strangers").await;
        let path = format!("/w/desk?port={port}&hash={}", crate::hosts::hex(&hash));
        let mut held = Vec::new();
        for i in 0..16 {
            let from = format!("203.0.113.{i}");
            held.push(
                open(s.at, &path, &[("x-forwarded-for", &from)])
                    .await
                    .unwrap(),
            );
        }
        let mut ws = paired(&s, &path, &[]).await;
        assert!(admitted(&mut ws).await);
        // A socket that never says which pool goes after five seconds, undialled.
        assert_eq!(close_code(&mut held[0]).await.0, 1008);
        // A pass for another host is a stranger's.
        let mut other = open(s.at, &path, &[]).await.unwrap();
        send(&mut other, Frame::Pass(&[9; 32])).await;
        assert_eq!(close_code(&mut other).await, (1008, PASS_REFUSED.into()));
    }

    /// A fake host's management API publishing this plane, and this server listing it.
    async fn published_desk(name: &str) -> (Served, String) {
        let (port, hash) = plane_accepting();
        let mgmt =
            crate::testing::upstream_publishing(crate::testing::Plane::Attested, (port, hash))
                .await;
        let s = serve_desk(name, mgmt.port, mgmt.fp).await;
        (
            s,
            format!("/w/desk?port={port}&hash={}", crate::hosts::hex(&hash)),
        )
    }

    #[tokio::test]
    async fn the_pairing_pool_holds_four_at_once_and_twenty_an_hour() {
        punktfunk_core::tls::install_default_provider();
        let (s, path) = published_desk("pairing").await;
        let mut four = Vec::new();
        for i in 1..=4 {
            let mut ws = pairing(&s, &path, &format!("10.0.0.{i}")).await;
            assert!(admitted(&mut ws).await, "{i}");
            four.push(ws);
        }
        let mut fifth = pairing(&s, &path, "10.0.0.5").await;
        assert_eq!(close_code(&mut fifth).await, (1013, PAIRING_FULL.into()));
        // One at a time per address.
        drop(four.pop());
        tokio::time::sleep(Duration::from_millis(200)).await;
        let mut again = pairing(&s, &path, "10.0.0.1").await;
        assert_eq!(close_code(&mut again).await.0, 1013);
        for ws in &mut four {
            let _ = ws.close(None).await;
        }
        drop(four);
        // Four have started; sixteen more make the hour's twenty.
        for i in 10..26 {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let mut ws = pairing(&s, &path, &format!("10.0.1.{i}")).await;
            assert!(admitted(&mut ws).await, "{i}");
            let _ = ws.close(None).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let mut late = pairing(&s, &path, "10.0.2.1").await;
        assert_eq!(close_code(&mut late).await, (1013, PAIRING_HOURLY.into()));
    }

    #[tokio::test]
    async fn a_stranger_reaches_only_the_published_plane() {
        punktfunk_core::tls::install_default_provider();
        let (s, path) = published_desk("published").await;
        let hash = path.split("&hash=").nth(1).unwrap();
        let elsewhere = format!("/w/desk?port=9&hash={hash}");
        let mut ws = pairing(&s, &elsewhere, "10.0.0.1").await;
        assert_eq!(close_code(&mut ws).await, (1008, NOT_PUBLISHED.into()));
        let mut ws = pairing(&s, &path, "10.0.0.2").await;
        assert!(admitted(&mut ws).await);
        // A pass holder may name any port on the host: this one is dialled, and nothing answers.
        let mut ws = paired(&s, &elsewhere, &[]).await;
        assert_eq!(close_code(&mut ws).await.0, 1011);
    }
}
