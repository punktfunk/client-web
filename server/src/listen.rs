//! The listener's own limits, the host's numbers: the part that faces the internet is no softer
//! than the host behind it.

use axum::Router;
use axum_server::accept::Accept;
use axum_server::tls_rustls::{RustlsAcceptor, RustlsConfig};
use axum_server::Handle;
use std::collections::HashMap;
use std::future::Future as _;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::{Instant, Sleep};

pub const CONNS: usize = 256;
pub const PER_PEER: usize = 32;
/// A connection that moves no byte either way for this long is closed. A live bridge never
/// gets near it: the page pings every second, the server every ten.
pub const IDLE: Duration = Duration::from_secs(30);
const HANDSHAKE: Duration = Duration::from_secs(10);
/// Per request on a kept-alive connection: a peer that never finishes its headers holds nothing.
const HEADERS: Duration = Duration::from_secs(30);

type Open = Arc<Mutex<HashMap<IpAddr, usize>>>;

/// Admits a connection while there is room: `total` at once, `per_peer` from one TCP peer (an
/// IPv6 peer by its /64). One past either is dropped at accept, before TLS. One admitted is
/// closed once it has moved no byte for `idle`.
#[derive(Clone)]
pub struct Capped {
    total: Arc<Semaphore>,
    per_peer: usize,
    idle: Duration,
    open: Open,
}

impl Capped {
    pub fn new(total: usize, per_peer: usize, idle: Duration) -> Capped {
        Capped {
            total: Arc::new(Semaphore::new(total)),
            per_peer,
            idle,
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
        let now = Instant::now();
        Ok(Guarded {
            inner: stream,
            idle: self.idle,
            moved: now,
            deadline: Box::pin(tokio::time::sleep_until(now + self.idle)),
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

/// A connection holding its place until it closes, or until it has been silent for `idle`.
/// The silence ceiling covers what the header timeout cannot: a peer that sends nothing after
/// TLS, an HTTP/2 connection left open, a body that stops arriving.
pub struct Guarded {
    inner: TcpStream,
    idle: Duration,
    /// When a byte last moved either way.
    moved: Instant,
    /// Fires at or before `moved + idle`, and is moved on only when it fires.
    deadline: Pin<Box<Sleep>>,
    _held: (OwnedSemaphorePermit, Peer),
}

impl Guarded {
    /// What a read or write that would wait says: wait, or the connection has been silent too
    /// long. The deadline is moved lazily, so a busy stream does not touch the timer per packet.
    fn silent<T>(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<T>> {
        while self.deadline.as_mut().poll(cx).is_ready() {
            let due = self.moved + self.idle;
            if due <= Instant::now() {
                return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
            }
            self.deadline.as_mut().reset(due);
        }
        Poll::Pending
    }
}

impl AsyncRead for Guarded {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        match Pin::new(&mut self.inner).poll_read(cx, buf) {
            Poll::Pending => self.silent(cx),
            Poll::Ready(Ok(())) if buf.filled().len() > before => {
                self.moved = Instant::now();
                Poll::Ready(Ok(()))
            }
            done => done,
        }
    }
}

impl AsyncWrite for Guarded {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match Pin::new(&mut self.inner).poll_write(cx, buf) {
            Poll::Pending => self.silent(cx),
            Poll::Ready(Ok(n)) if n > 0 => {
                self.moved = Instant::now();
                Poll::Ready(Ok(n))
            }
            done => done,
        }
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
        let at = listening(Capped::new(CONNS, PER_PEER, IDLE)).await;
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

        let at = listening(Capped::new(3, PER_PEER, IDLE)).await;
        let mut three = Vec::new();
        for _ in 0..3 {
            three.push(TcpStream::connect(at).await.unwrap());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut fourth = TcpStream::connect(at).await.unwrap();
        assert!(!admitted(&mut fourth).await, "past the ceiling");
    }

    #[tokio::test]
    async fn a_silent_connection_closes_and_a_busy_one_stays() {
        let idle = Duration::from_millis(200);
        let at = listening(Capped::new(CONNS, PER_PEER, idle)).await;
        let mut silent = TcpStream::connect(at).await.unwrap();
        let mut b = [0u8; 1];
        let read = tokio::time::timeout(Duration::from_secs(2), silent.read(&mut b)).await;
        assert!(matches!(read, Ok(Ok(0) | Err(_))), "closed for its silence");

        // A few bytes every 100 ms keep it open well past `idle`, and the request is answered.
        let mut busy = TcpStream::connect(at).await.unwrap();
        for part in b"GET / HTTP/1.1\r\nhost: x\r\n\r\n".chunks(5) {
            busy.write_all(part).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let mut answer = [0u8; 12];
        busy.read_exact(&mut answer).await.unwrap();
        assert_eq!(&answer, b"HTTP/1.1 200");
    }
}
