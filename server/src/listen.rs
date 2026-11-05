//! The listener's own limits, the host's numbers: the part that faces the internet is no softer
//! than the host behind it.

use axum::Router;
use axum_server::accept::Accept;
use axum_server::tls_rustls::{RustlsAcceptor, RustlsConfig};
use axum_server::Handle;
use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub const CONNS: usize = 256;
pub const PER_PEER: usize = 32;
const HANDSHAKE: Duration = Duration::from_secs(10);
/// Per request on a kept-alive connection: a peer that never finishes its headers holds nothing.
const HEADERS: Duration = Duration::from_secs(30);

type Open = Arc<Mutex<HashMap<IpAddr, usize>>>;

/// Admits a connection while there is room: `total` at once, `per_peer` from one TCP peer (an
/// IPv6 peer by its /64). One past either is dropped at accept, before TLS.
#[derive(Clone)]
pub struct Capped {
    total: Arc<Semaphore>,
    per_peer: usize,
    open: Open,
}

impl Capped {
    pub fn new(total: usize, per_peer: usize) -> Capped {
        Capped {
            total: Arc::new(Semaphore::new(total)),
            per_peer,
            open: Open::default(),
        }
    }

    fn admit(&self, stream: TcpStream) -> io::Result<Guarded> {
        let peer = crate::lanes::subscriber(stream.peer_addr()?.ip());
        let permit = self.total.clone().try_acquire_owned();
        let permit = permit.map_err(|_| io::Error::other("connection ceiling"))?;
        let mut open = self.open.lock().unwrap();
        let n = open.entry(peer).or_insert(0);
        if *n >= self.per_peer {
            return Err(io::Error::other("per-peer connection ceiling"));
        }
        *n += 1;
        let peer = Peer(self.open.clone(), peer);
        Ok(Guarded {
            inner: stream,
            _held: (permit, peer),
        })
    }
}

impl<S> Accept<TcpStream, S> for Capped {
    type Stream = Guarded;
    type Service = S;
    type Future = std::future::Ready<io::Result<(Guarded, S)>>;

    fn accept(&self, stream: TcpStream, service: S) -> Self::Future {
        std::future::ready(self.admit(stream).map(|s| (s, service)))
    }
}

/// One peer's count, given back with the connection.
struct Peer(Open, IpAddr);

impl Drop for Peer {
    fn drop(&mut self) {
        let mut open = self.0.lock().unwrap();
        if let Some(n) = open.get_mut(&self.1) {
            *n -= 1;
            if *n == 0 {
                open.remove(&self.1);
            }
        }
    }
}

/// A connection holding its place until it closes.
pub struct Guarded {
    inner: TcpStream,
    _held: (OwnedSemaphorePermit, Peer),
}

impl AsyncRead for Guarded {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for Guarded {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Serve `app` on `listener` under `caps`, over TLS when there is a certificate.
pub async fn serve(
    listener: std::net::TcpListener,
    app: Router,
    tls: Option<RustlsConfig>,
    handle: Handle<SocketAddr>,
    caps: Capped,
) -> io::Result<()> {
    listener.set_nonblocking(true)?;
    // Who the visitor is starts from the TCP peer.
    let service = app.into_make_service_with_connect_info::<SocketAddr>();
    let server = axum_server::from_tcp(listener)?.handle(handle);
    match tls {
        Some(tls) => {
            let tls = RustlsAcceptor::new(tls).handshake_timeout(HANDSHAKE);
            let mut server = server.acceptor(tls.acceptor(caps));
            timeouts(server.http_builder());
            server.serve(service).await
        }
        None => {
            let mut server = server.acceptor(caps);
            timeouts(server.http_builder());
            server.serve(service).await
        }
    }
}

fn timeouts(b: &mut hyper_util::server::conn::auto::Builder<hyper_util::rt::TokioExecutor>) {
    b.http1()
        .timer(hyper_util::rt::TokioTimer::new())
        .header_read_timeout(HEADERS);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    async fn listening(caps: Capped) -> SocketAddr {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = listener.local_addr().unwrap();
        let app = Router::new().route("/", axum::routing::get(|| async { "ok" }));
        tokio::spawn(serve(listener, app, None, Handle::new(), caps));
        at
    }

    /// Held open by the server (the read waits), or dropped at accept (the read ends).
    async fn admitted(conn: &mut TcpStream) -> bool {
        let mut b = [0u8; 1];
        let read = tokio::time::timeout(Duration::from_millis(300), conn.read(&mut b)).await;
        read.is_err()
    }

    #[tokio::test]
    async fn one_peer_holds_thirty_two_and_all_hold_the_ceiling() {
        let at = listening(Capped::new(CONNS, PER_PEER)).await;
        let mut held = Vec::new();
        for _ in 0..PER_PEER {
            held.push(TcpStream::connect(at).await.unwrap());
        }
        // Accepted in order, admitted in tasks: let all 32 settle before the next.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(admitted(held.last_mut().unwrap()).await);
        let mut over = TcpStream::connect(at).await.unwrap();
        assert!(!admitted(&mut over).await, "the 33rd from one peer");
        drop(held.pop());
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut again = TcpStream::connect(at).await.unwrap();
        assert!(admitted(&mut again).await, "room once one closed");

        let at = listening(Capped::new(3, PER_PEER)).await;
        let mut three = Vec::new();
        for _ in 0..3 {
            three.push(TcpStream::connect(at).await.unwrap());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut fourth = TcpStream::connect(at).await.unwrap();
        assert!(!admitted(&mut fourth).await, "past the ceiling");
    }
}
