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
use crate::proxy;
use axum::body::Bytes;
use axum::extract::ws::{close_code, CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, FromRequestParts, Path, Query, Request, State};
use axum::http::{header, request::Parts, StatusCode};
use axum::response::{IntoResponse, Response};
use frame::Frame;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{FutureExt, SinkExt, StreamExt};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{self, Receiver, Sender};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tokio::time::timeout;
use wtransport::error::ConnectionError;
use wtransport::{Connection, RecvStream, SendStream, VarInt};

/// Bridged sessions at once: each is a QUIC connection and a relay.
pub const SESSIONS: usize = 16;
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

/// A host this server lists.
pub async fn listed(
    State(hosts): State<Arc<Hosts>>,
    Path(id): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let addr = hosts.get(&id).map(|h| h.addr).ok_or(StatusCode::NOT_FOUND);
    open(addr, id, peer, req).await
}

/// A host the page names by its private address, as `/a/` reaches one.
pub async fn typed(
    State(hosts): State<Arc<Hosts>>,
    Path(target): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let addr = if !hosts.add_hosts {
        Err(StatusCode::NOT_FOUND)
    } else {
        match proxy::private_target(&target) {
            Some((IpAddr::V4(v4), _)) => Ok(v4.to_string()),
            Some((IpAddr::V6(v6), _)) => Ok(format!("[{v6}]")),
            None => Err(StatusCode::BAD_REQUEST),
        }
    };
    open(addr, target, peer, req).await
}

async fn open(
    addr: Result<String, StatusCode>,
    host: String,
    peer: SocketAddr,
    req: Request,
) -> Response {
    let (mut parts, _) = req.into_parts();
    if !same_origin(&parts) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let addr = match addr {
        Ok(a) => a,
        Err(status) => return status.into_response(),
    };
    let Some((port, hash)) = Query::<Dial>::try_from_uri(&parts.uri)
        .ok()
        .and_then(|Query(d)| Some((d.port, crate::config::parse_fp(&d.hash).ok()?)))
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(slots) = parts.extensions.get::<Arc<Semaphore>>().cloned() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let Ok(slot) = slots.try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let ws = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(ws) => ws,
        Err(refused) => return refused.into_response(),
    };
    let target = plane::Target {
        addr,
        port,
        hash,
        origin: header_str(&parts, header::ORIGIN.as_str()).map(str::to_owned),
        client: peer.ip().to_canonical(),
    };
    ws.max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
        .on_upgrade(move |socket| session(socket, target, host, slot))
}

/// The `wake` route's rule, and an `Origin`, when sent, that names this server: a page on another
/// site that could open the bridge could drive a host it has no right to.
fn same_origin(parts: &Parts) -> bool {
    if header_str(parts, "sec-fetch-site") == Some("cross-site") {
        return false;
    }
    let Some(origin) = header_str(parts, header::ORIGIN.as_str()) else {
        return true;
    };
    let own = proxy::own_authority(&parts.uri, &parts.headers);
    let theirs = origin.split_once("://").map(|(_, authority)| authority);
    own.zip(theirs)
        .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
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

async fn session(
    mut socket: WebSocket,
    target: plane::Target,
    host: String,
    _slot: OwnedSemaphorePermit,
) {
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
    let code = relay(socket, &conn, &counts).await;
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
            Some(Frame::Uni(_)) | None => return End::Protocol,
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

    /// This server on loopback, listing `desk` at 127.0.0.1.
    async fn page_server(name: &str) -> SocketAddr {
        let dir = std::env::temp_dir().join(format!("pf-bridge-{name}-{}", std::process::id()));
        let desk = Listed {
            name: "desk".into(),
            addr: "127.0.0.1".into(),
            port: crate::config::MGMT_PORT,
            pin: None,
        };
        let hosts = Hosts::new(vec![desk], &dir, true).unwrap();
        let app = crate::router(hosts, dir);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let at = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
        });
        at
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
        let at = page_server("whole").await;
        let path = format!("/w/desk?port={port}&hash={}", crate::hosts::hex(&hash));
        let origin = own(at);
        let mut ws = open(at, &path, &[("origin", &origin)]).await.unwrap();

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
        let at = page_server("page-close").await;
        let path = format!("/w/desk?port={port}&hash={}", crate::hosts::hex(&hash));

        let mut quit = open(at, &path, &[]).await.unwrap();
        send(
            &mut quit,
            Frame::Close {
                code: 0x51,
                reason: b"quit",
            },
        )
        .await;
        assert_eq!(close_code(&mut quit).await.0, 1000);

        let gone = open(at, &path, &[]).await.unwrap();
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
            client: [127, 0, 0, 1].into(),
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
        let at = page_server("admission").await;
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
        let at = page_server("dial").await;

        let wrong = format!("/wa/127.0.0.1:47990?port={port}&hash={}", "00".repeat(32));
        let mut ws = open(at, &wrong, &[]).await.unwrap();
        assert_eq!(
            close_code(&mut ws).await,
            (1011, "host refused the session".into())
        );

        let quiet = format!(
            "/w/desk?port={}&hash={}",
            silent.local_addr().unwrap().port(),
            "00".repeat(32)
        );
        let mut ws = open(at, &quiet, &[]).await.unwrap();
        assert_eq!(
            close_code(&mut ws).await,
            (1011, "host did not answer".into())
        );
    }

    #[tokio::test]
    async fn the_seventeenth_session_is_refused() {
        let (server, port, hash) = plane();
        tokio::spawn(async move {
            loop {
                let conn = server.accept().await.await.unwrap().accept().await.unwrap();
                tokio::spawn(async move { conn.closed().await });
            }
        });
        let at = page_server("cap").await;
        let path = format!("/w/desk?port={port}&hash={}", crate::hosts::hex(&hash));
        let mut held = Vec::new();
        for _ in 0..SESSIONS {
            held.push(open(at, &path, &[]).await.unwrap());
        }
        assert_eq!(open(at, &path, &[]).await.err(), Some(503));
    }
}
