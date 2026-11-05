//! `/h/<id>/…` to `https://<host>:<port>/…`: pinned, streamed both ways.
//!
//! The only thing added is `pf-client-addr`, who the visitor is. The browser's own device token is
//! the only credential that reaches a host, so this server can never do more than the page could.

use crate::hosts::Hosts;
use crate::proof::Outcome;
use crate::visitor::Visitor;
use axum::body::{Body, Bytes, HttpBody as _};
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use punktfunk_core::mgmt_routes::{open_route, paired_may_access};
use punktfunk_core::provenance::{CLIENT_ADDR_HEADER, CLIENT_ADDR_UNKNOWN};
use punktfunk_core::tls::PinVerify;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

type Seen = Arc<Mutex<Option<[u8; 32]>>>;

/// Requests in flight to one host. A host drops connections past 32 per IP, and over HTTP/1.1
/// each request is a connection; 16 leaves room for the other clients on this machine.
const IN_FLIGHT: usize = 16;

/// One kept client per host and pin. HTTP/2 to a host that offers it puts every request on one
/// connection; `gate` holds an HTTP/1.1 host under its ceiling.
struct Upstream {
    client: reqwest::Client,
    seen: Seen,
    gate: Arc<Semaphore>,
}

type UpstreamKey = (String, u16, Option<[u8; 32]>);
/// Kept clients, with when each was last used; at most [`KEPT`](crate::proof::KEPT).
type Kept = HashMap<UpstreamKey, (Arc<Upstream>, Instant)>;
static UPSTREAMS: LazyLock<Mutex<Kept>> = LazyLock::new(Default::default);

fn upstream(addr: &str, port: u16, pin: Option<[u8; 32]>) -> anyhow::Result<Arc<Upstream>> {
    let mut all = UPSTREAMS.lock().unwrap();
    let key = (addr.to_string(), port, pin);
    if let Some((up, used)) = all.get_mut(&key) {
        *used = Instant::now();
        return Ok(up.clone());
    }
    if all.len() >= crate::proof::KEPT {
        let oldest = all.iter().min_by_key(|(_, (_, used))| *used);
        if let Some(oldest) = oldest.map(|(k, _)| k.clone()) {
            all.remove(&oldest);
        }
    }
    let seen: Seen = Arc::default();
    let up = Arc::new(Upstream {
        client: client(pin, seen.clone())?,
        seen,
        gate: Arc::new(Semaphore::new(IN_FLIGHT)),
    });
    all.insert(key, (up.clone(), Instant::now()));
    Ok(up)
}

/// A host this server lists: `/h/<id>/…`. One the operator listed is relayed to as it is; one
/// mDNS found, once proven.
pub async fn listed(
    State(hosts): State<Arc<Hosts>>,
    Path((id, _)): Path<(String, String)>,
    req: Request,
) -> Response {
    let Some(host) = hosts.get(&id) else {
        return (StatusCode::NOT_FOUND, "This server has no such host.").into_response();
    };
    let url = match upstream_url(&host.addr, host.port, &req) {
        Ok(url) => url,
        Err((status, why)) => return api_error(status, why),
    };
    if host.fullname.is_some() {
        return unlisted(&hosts, &host.addr, host.port, host.pin, url, req).await;
    }
    let learn = host.pin.is_none().then_some(host.id);
    relay(&hosts, &host.addr, host.port, host.pin, learn, url, req).await
}

/// A host the page names by address: `/a/<ip[:port]>/…`. Only a home-network address that is
/// not loopback, and only once proven.
pub async fn typed(
    State(hosts): State<Arc<Hosts>>,
    Path((target, _)): Path<(String, String)>,
    req: Request,
) -> Response {
    if !hosts.add_hosts {
        return (
            StatusCode::NOT_FOUND,
            "This server only reaches the hosts it lists.",
        )
            .into_response();
    }
    // The page's own server, named as a host, would answer itself with the page.
    let own = own_authority(req.uri(), req.headers()) == Some(target.as_str());
    let (ip, port) = match typed_target(&hosts, &target) {
        Ok(_) if own => return (StatusCode::BAD_REQUEST, OWN_ADDRESS).into_response(),
        Ok(target) => target,
        Err(say) => return (StatusCode::BAD_REQUEST, say).into_response(),
    };
    let addr = url_host(ip);
    let url = match upstream_url(&addr, port, &req) {
        Ok(url) => url,
        Err((status, why)) => return api_error(status, why),
    };
    let pin = hosts.pin_at(&format!("{addr}:{port}"));
    unlisted(&hosts, &addr, port, pin, url, req).await
}

const OWN_ADDRESS: &str = "That is this server's own address, not a host.";

/// A host's address as it goes in a URL: an IPv6 one in brackets.
pub(crate) fn url_host(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => format!("[{v6}]"),
    }
}

/// A host the operator did not list: relayed to once proven, and the page's own plane request
/// answered from a fresh proof.
async fn unlisted(
    hosts: &Hosts,
    addr: &str,
    port: u16,
    pin: Option<[u8; 32]>,
    url: reqwest::Url,
    req: Request,
) -> Response {
    let plane = req.method() == Method::GET && url.path() == "/api/v1/webtransport";
    match crate::proof::prove(hosts, addr, port, pin, plane).await {
        Outcome::Host { body, .. } if plane => host_reply(StatusCode::OK, body),
        Outcome::NoPlane(body) if plane => host_reply(StatusCode::NOT_FOUND, body),
        Outcome::Host { fp, .. } => relay(hosts, addr, port, Some(fp), None, url, req).await,
        refused => refused
            .refusal()
            .unwrap_or_else(|| StatusCode::BAD_GATEWAY.into_response()),
    }
}

/// A host's JSON answer, served as [`relay`] serves one.
fn host_reply(status: StatusCode, body: Bytes) -> Response {
    let mut res = (status, body).into_response();
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox"),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    res
}

/// The host's URL for `/<route>/<segment>/<rest>`: the rest and query as the browser sent them,
/// still percent-encoded, so a decoded `%2f` or `%3f` cannot reshape the path. Only a route in
/// core's table goes out, checked on the URL after `..` and `%2e%2e` have collapsed: the open
/// four, and a paired device's own with its token.
fn upstream_url(
    addr: &str,
    port: u16,
    req: &Request,
) -> Result<reqwest::Url, (StatusCode, &'static str)> {
    let rest = req.uri().path().splitn(4, '/').nth(3);
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let url = rest
        .and_then(|rest| reqwest::Url::parse(&format!("https://{addr}:{port}/{rest}{query}")).ok())
        .ok_or((StatusCode::BAD_REQUEST, "not a path a host serves"))?;
    let (method, path) = (req.method().as_str(), url.path());
    if open_route(method, path) {
        return Ok(url);
    }
    let token = req.headers().contains_key(header::AUTHORIZATION);
    match paired_may_access(method, path) {
        true if token => Ok(url),
        true => Err((
            StatusCode::UNAUTHORIZED,
            "a paired device's token is needed",
        )),
        false => Err((
            StatusCode::NOT_FOUND,
            "the page server does not relay this route",
        )),
    }
}

/// An answer in the host's error shape, for a request that never reached one.
fn api_error(status: StatusCode, message: &str) -> Response {
    (status, axum::Json(serde_json::json!({ "error": message }))).into_response()
}

/// This server's `host[:port]` as the browser addressed it: the URI authority over HTTP/2, `Host`
/// over HTTP/1.1.
pub(crate) fn own_authority<'a>(uri: &'a Uri, headers: &'a HeaderMap) -> Option<&'a str> {
    uri.authority()
        .map(|a| a.as_str())
        .or_else(|| headers.get(header::HOST).and_then(|h| h.to_str().ok()))
}

/// `ip`, `ip:port` or `[v6]:port`; the management port when none is given.
fn parse_target(s: &str) -> Option<(IpAddr, u16)> {
    match s.parse::<SocketAddr>() {
        Ok(sa) => Some((sa.ip(), sa.port())),
        Err(_) => Some((
            s.trim_matches(|c| c == '[' || c == ']').parse().ok()?,
            crate::config::MGMT_PORT,
        )),
    }
}

/// An address a home network or this machine uses: RFC 1918, loopback, link-local, the 100.64/10
/// range Tailscale hands out, or IPv6 unique-local.
pub(crate) fn home_range(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || (v.octets()[0] == 100 && v.octets()[1] & 0xc0 == 64)
        }
        IpAddr::V6(v) => v.is_loopback() || v.is_unique_local() || v.is_unicast_link_local(),
    }
}

/// A target the page typed: a home-network address that is not loopback. The error is the page's
/// sentence.
pub(crate) fn typed_target(hosts: &Hosts, s: &str) -> Result<(IpAddr, u16), &'static str> {
    let (ip, port) = parse_target(s)
        .filter(|(ip, _)| home_range(*ip))
        .ok_or("Add a host by its IP address on this network, like 192.168.1.25.")?;
    if (hosts.machine.loopback)(ip) {
        return Err(OWN_ADDRESS);
    }
    Ok((ip, port))
}

/// `learn`: the listed host whose first-contact certificate becomes its pin.
async fn relay(
    hosts: &Hosts,
    addr: &str,
    port: u16,
    pin: Option<[u8; 32]>,
    learn: Option<String>,
    url: reqwest::Url,
    req: Request,
) -> Response {
    let up = match upstream(addr, port, pin) {
        Ok(up) => up,
        Err(e) => return gateway(addr, "the proxy client did not build", &format!("{e:#}")),
    };
    let slot = up
        .gate
        .clone()
        .acquire_owned()
        .await
        .expect("the gate is never closed");
    let (parts, body) = req.into_parts();
    // HTTP/2 can carry a body with neither header.
    let has_body = !body.is_end_stream();
    let mut sent = only(&parts.headers, &UP);
    let visitor = parts.extensions.get::<Visitor>();
    let named = visitor.map_or_else(|| CLIENT_ADDR_UNKNOWN.into(), Visitor::header);
    if let Ok(v) = HeaderValue::from_str(&named) {
        sent.insert(CLIENT_ADDR_HEADER, v);
    }
    let mut out = up.client.request(parts.method, url).headers(sent);
    if has_body {
        out = out.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }
    match out.send().await {
        Ok(resp) => {
            if let (None, Some(id)) = (pin, learn) {
                if let Some(fp) = *up.seen.lock().unwrap() {
                    hosts.learned(&id, fp);
                    // Pinned from here on: the next request builds that client instead.
                    UPSTREAMS
                        .lock()
                        .unwrap()
                        .remove(&(addr.to_string(), port, None));
                }
            }
            let (status, mut headers) = (resp.status(), only(resp.headers(), &DOWN));
            // A host's reply is served on the page's origin: never as a document that runs there.
            headers.insert(
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static("sandbox"),
            );
            headers.insert(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            // The slot rides the body: over HTTP/1.1 the connection is busy until the last byte.
            let body = resp.bytes_stream().map(move |chunk| {
                let _ = &slot;
                chunk
            });
            let mut res = Response::new(Body::from_stream(body));
            *res.status_mut() = status;
            *res.headers_mut() = headers;
            res
        }
        Err(e) => {
            // Kept clients are for hosts that answer; an address that never does keeps none.
            UPSTREAMS
                .lock()
                .unwrap()
                .remove(&(addr.to_string(), port, pin));
            let presented = *up.seen.lock().unwrap();
            if pin.is_some() && presented.is_some() && presented != pin {
                tracing::warn!(
                    host = %addr,
                    presented = %crate::hosts::hex(&presented.unwrap_or_default()),
                    "certificate does not match the pin"
                );
                return (StatusCode::BAD_GATEWAY, PIN_CHANGED).into_response();
            }
            // The chain, not the top line: reqwest's own message is only "error sending request".
            gateway(
                addr,
                "host did not answer",
                &format!("{:#}", anyhow::Error::new(e)),
            )
        }
    }
}

pub(crate) const PIN_CHANGED: &str =
    "This host's certificate changed since it was pinned. If you reinstalled it or moved it to a \
     new identity, remove its entry from pins.json and restart the server.";

/// 504, so the page reads it as "nothing answered". A 502 carries a refusal the page shows as said.
fn gateway(host: &str, what: &str, cause: &str) -> Response {
    tracing::warn!(host, cause, "{what}");
    (StatusCode::GATEWAY_TIMEOUT, "Couldn't reach this host.").into_response()
}

pub(crate) fn client(pin: Option<[u8; 32]>, seen: Seen) -> anyhow::Result<reqwest::Client> {
    let mut tls = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinVerify::with_observed(pin, seen)))
        .with_no_client_auth();
    // reqwest leaves a preconfigured TLS config alone, ALPN included.
    tls.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    // A redirect is relayed, not followed: following it would leave the pin and the private range.
    Ok(reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()?)
}

/// What crosses the relay, by name; nothing else does, either way. Going up, what the page's API
/// calls carry, as the host's own tunnel passes them, and the body's length. Coming back, what
/// describes the body and its caching: a host cannot set a cookie, a prompt, a redirect target,
/// CORS or anything else on the page's origin.
const UP: [HeaderName; 5] = [
    header::AUTHORIZATION,
    header::CONTENT_TYPE,
    header::ACCEPT,
    header::IF_NONE_MATCH,
    header::CONTENT_LENGTH,
];
const DOWN: [HeaderName; 13] = [
    header::CONTENT_TYPE,
    header::CONTENT_LENGTH,
    header::CONTENT_ENCODING,
    header::CONTENT_DISPOSITION,
    header::CONTENT_RANGE,
    header::ACCEPT_RANGES,
    header::CACHE_CONTROL,
    header::ETAG,
    header::LAST_MODIFIED,
    header::EXPIRES,
    header::VARY,
    header::DATE,
    header::RETRY_AFTER,
];

fn only(from: &HeaderMap, names: &[HeaderName]) -> HeaderMap {
    let mut out = HeaderMap::new();
    for name in names {
        for value in from.get_all(name) {
            out.append(name.clone(), value.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use crate::config::Listed;
    use crate::hosts::Hosts;
    use crate::visitor::{Machine, TEST};
    use axum::body::Body;
    use axum::extract::State;
    use axum::http::{Request, StatusCode};
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    /// What a fake host's `/api/v1/webtransport` answers.
    #[derive(PartialEq)]
    enum Plane {
        /// Nothing: an older host, or a test that never asks.
        Off,
        /// Its plane, signed by the identity that serves its TLS.
        Attested,
        /// A plane signed by some other identity.
        Borrowed,
        /// A plane and no signature: an RSA identity.
        Unattested,
        /// Not a host at all: `200` to anything.
        Decoy,
    }

    /// A TLS server on a loopback port: its port, its certificate's pin, and what it was asked.
    struct Up {
        port: u16,
        fp: [u8; 32],
        asked: Arc<Mutex<Vec<String>>>,
    }

    impl Up {
        fn asked(&self) -> Vec<String> {
            self.asked.lock().unwrap().clone()
        }
    }

    fn identity() -> (rcgen::Certificate, rcgen::KeyPair) {
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec!["localhost".into()])
            .unwrap()
            .self_signed(&key)
            .unwrap();
        (cert, key)
    }

    /// The host's `/api/v1/webtransport` answer, signed by `key`, whose certificate is `cert`.
    fn published(cert: &rcgen::Certificate, key: &rcgen::KeyPair) -> serde_json::Value {
        use base64::Engine as _;
        use rcgen::SigningKey as _;
        let hash = "ab".repeat(32);
        let msg = format!("{}{hash}", punktfunk_core::tls::PLANE_ATTESTATION_CONTEXT);
        let sig = key.sign(msg.as_bytes()).unwrap();
        serde_json::json!({
            "port": 9778,
            "cert_hash_sha256": hash,
            "expires_at": 4_000_000_000u64,
            "allow_pooling": false,
            "cert_hash_sig": crate::hosts::hex(&sig),
            "host_cert_der": base64::engine::general_purpose::STANDARD.encode(cert.der()),
        })
    }

    async fn upstream(plane: Plane) -> Up {
        let (cert, key) = identity();
        let fp = punktfunk_core::tls::cert_fingerprint(cert.der());
        let answer = match plane {
            Plane::Attested => Some(published(&cert, &key)),
            Plane::Borrowed => {
                let (other, other_key) = identity();
                Some(published(&other, &other_key))
            }
            Plane::Unattested => {
                let mut plane = published(&cert, &key);
                let fields = plane.as_object_mut().unwrap();
                fields.remove("cert_hash_sig");
                fields.remove("host_cert_der");
                Some(plane)
            }
            Plane::Off | Plane::Decoy => None,
        };
        let asked: Arc<Mutex<Vec<String>>> = Arc::default();
        let mut app = axum::Router::new()
            .route("/api/v1/health", axum::routing::get(|| async { "ok" }))
            .route(
                "/api/v1/host",
                axum::routing::get(|| async { axum::response::Redirect::to("/secret") }),
            )
            .route("/secret", axum::routing::get(|| async { "secret" }))
            .route(
                "/api/v1/status",
                axum::routing::get(|h: axum::http::HeaderMap| async move {
                    let seen: Vec<_> = h
                        .iter()
                        .map(|(k, v)| format!("{k}={}", v.to_str().unwrap_or("?")))
                        .collect();
                    let reply = [
                        ("content-type", "text/plain"),
                        ("etag", "\"v1\""),
                        ("clear-site-data", "\"storage\""),
                        ("www-authenticate", "Basic realm=\"desk\""),
                        ("alt-svc", "h3=\":443\""),
                        ("location", "https://elsewhere.example/"),
                        ("set-cookie", "a=b"),
                        ("access-control-allow-origin", "*"),
                    ];
                    (reply, seen.join("\n"))
                }),
            );
        if let Some(answer) = answer {
            let answer = axum::Json(answer);
            app = app.route(
                "/api/v1/webtransport",
                axum::routing::get(move || async move { answer }),
            );
        }
        if plane == Plane::Decoy {
            app = axum::Router::new().fallback(|| async { "hello" });
        }
        let app = app.layer(axum::middleware::from_fn_with_state(
            asked.clone(),
            |State(asked): State<Arc<Mutex<Vec<String>>>>,
             req: axum::extract::Request,
             next: axum::middleware::Next| async move {
                let line = format!("{} {}", req.method(), req.uri().path());
                asked.lock().unwrap().push(line);
                next.run(req).await
            },
        ));
        let tls = axum_server::tls_rustls::RustlsConfig::from_pem(
            cert.pem().into(),
            key.serialize_pem().into(),
        )
        .await
        .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = axum_server::from_tcp_rustls(listener, tls).unwrap();
        tokio::spawn(server.serve(app.into_make_service()));
        Up { port, fp, asked }
    }

    fn hosts(name: &str, listed: Vec<Listed>, machine: Machine) -> Arc<Hosts> {
        let dir = std::env::temp_dir().join(format!("pf-proxy-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Hosts::new(listed, &dir, true, machine).unwrap()
    }

    fn desk(port: u16, pin: Option<[u8; 32]>) -> Vec<Listed> {
        vec![Listed {
            name: "desk".into(),
            addr: "127.0.0.1".into(),
            port,
            pin,
        }]
    }

    async fn send(hosts: &Arc<Hosts>, req: Request<Body>) -> (StatusCode, String) {
        let app = crate::router(hosts.clone(), std::env::temp_dir(), Default::default());
        let res = app.oneshot(req).await.unwrap();
        let status = res.status();
        let body = axum::body::to_bytes(res.into_body(), 1 << 16)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    async fn get(hosts: &Arc<Hosts>, path: &str) -> (StatusCode, String) {
        send(hosts, Request::get(path).body(Body::empty()).unwrap()).await
    }

    async fn get_with_token(hosts: &Arc<Hosts>, path: &str) -> (StatusCode, String) {
        let req = Request::get(path).header("authorization", "Bearer x");
        send(hosts, req.body(Body::empty()).unwrap()).await
    }

    /// The operator's list holds at any address, loopback included.
    #[tokio::test]
    async fn a_listed_host_is_reached_only_under_its_pin() {
        punktfunk_core::tls::install_default_provider();
        let up = upstream(Plane::Off).await;
        let health = "/h/desk/api/v1/health";

        let pinned = hosts("pinned", desk(up.port, Some(up.fp)), Machine::REAL);
        assert_eq!(get(&pinned, health).await, (StatusCode::OK, "ok".into()));

        let wrong = hosts("wrong", desk(up.port, Some([0; 32])), Machine::REAL);
        let (status, body) = get(&wrong, health).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(body.contains("certificate changed"), "{body}");

        let first = hosts("first", desk(up.port, None), Machine::REAL);
        assert_eq!(get(&first, health).await.0, StatusCode::OK);
        assert_eq!(first.get("desk").unwrap().pin, Some(up.fp));

        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let gone = closed.local_addr().unwrap().port();
        drop(closed);
        let silent = hosts("silent", desk(gone, None), Machine::REAL);
        assert_eq!(get(&silent, health).await.0, StatusCode::GATEWAY_TIMEOUT);
    }

    #[tokio::test]
    async fn only_the_route_table_reaches_a_host() {
        punktfunk_core::tls::install_default_provider();
        let up = upstream(Plane::Off).await;
        let hosts = hosts("table", desk(up.port, Some(up.fp)), TEST);
        // A paired route without a token, and routes off the table with or without one.
        assert_eq!(get(&hosts, "/h/desk/api/v1/status").await.0, 401);
        for path in [
            "/h/desk/metrics",
            "/h/desk/secret",
            "/h/desk/api/v1/clients",
            "/h/desk/api/v1/pairing/pending",
            "/h/desk/api/v1/%2e%2e/secret",
            "/h/desk/api/..%2fsecret",
            "/h/desk/api/v1/health/../../../secret",
        ] {
            let (status, body) = get_with_token(&hosts, path).await;
            assert_ne!(body, "secret", "{path}");
            assert!(matches!(status.as_u16(), 400 | 404), "{path}: {status}");
        }
        let pin = Request::post("/h/desk/api/v1/pairing/pin").header("authorization", "Bearer x");
        assert_eq!(send(&hosts, pin.body(Body::empty()).unwrap()).await.0, 404);
        assert_eq!(up.asked(), Vec::<String>::new());

        // A redirect is relayed as its status, without a target, and never followed.
        let (status, body) = get_with_token(&hosts, "/h/desk/api/v1/host").await;
        assert!(status.is_redirection(), "{status}");
        assert_ne!(body, "secret");
        assert_eq!(up.asked(), ["GET /api/v1/host"]);
    }

    #[tokio::test]
    async fn a_decoy_hears_one_fixed_request() {
        punktfunk_core::tls::install_default_provider();
        let decoy = upstream(Plane::Decoy).await;
        let hosts = hosts("decoy", Vec::new(), TEST);
        let at = format!("127.0.0.1:{}", decoy.port);
        let hash = "00".repeat(32);
        for _ in 0..2 {
            for (path, token) in [
                (format!("/a/{at}/api/v1/health"), false),
                (format!("/a/{at}/api/v1/webtransport"), false),
                (format!("/a/{at}/api/v1/status"), true),
                (format!("/a/{at}/api/v1/library"), true),
                (format!("/wa/{at}?port=9778&hash={hash}"), false),
            ] {
                let (status, body) = if token {
                    get_with_token(&hosts, &path).await
                } else {
                    get(&hosts, &path).await
                };
                assert_eq!(status, StatusCode::BAD_GATEWAY, "{path}");
                assert!(body.is_empty() || body.contains("Punktfunk host"), "{body}");
            }
            let challenge = Request::post(format!("/a/{at}/api/v1/auth/device/challenge"));
            let (status, _) = send(&hosts, challenge.body(Body::empty()).unwrap()).await;
            assert_eq!(status, StatusCode::BAD_GATEWAY);
        }
        assert_eq!(decoy.asked(), ["GET /api/v1/webtransport"]);
        assert_eq!(hosts.pin_at(&at), None);
    }

    #[tokio::test]
    async fn a_proven_host_is_relayed_to() {
        punktfunk_core::tls::install_default_provider();
        let up = upstream(Plane::Attested).await;
        let hosts = hosts("proven", Vec::new(), TEST);
        let at = format!("127.0.0.1:{}", up.port);

        let (status, plane) = get(&hosts, &format!("/a/{at}/api/v1/webtransport")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(plane.contains("cert_hash_sig"), "{plane}");
        assert_eq!(hosts.pin_at(&at), Some(up.fp));
        let health = format!("/a/{at}/api/v1/health");
        assert_eq!(get(&hosts, &health).await, (StatusCode::OK, "ok".into()));
        let res = crate::router(hosts.clone(), std::env::temp_dir(), Default::default())
            .oneshot(Request::get(&health).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.headers()["content-security-policy"], "sandbox");
        // The page's own plane request proves again: a host that restarted has a new plane.
        assert_eq!(
            get(&hosts, &format!("/a/{at}/api/v1/webtransport")).await.0,
            200
        );
        let want = [
            "GET /api/v1/webtransport",
            "GET /api/v1/health",
            "GET /api/v1/health",
            "GET /api/v1/webtransport",
        ];
        assert_eq!(up.asked(), want);
    }

    #[tokio::test]
    async fn an_attestation_by_another_identity_is_refused() {
        punktfunk_core::tls::install_default_provider();
        let up = upstream(Plane::Borrowed).await;
        let hosts = hosts("borrowed", Vec::new(), TEST);
        let at = format!("127.0.0.1:{}", up.port);
        let (status, body) = get(&hosts, &format!("/a/{at}/api/v1/health")).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(body.contains("Punktfunk host"), "{body}");
        assert_eq!(up.asked(), ["GET /api/v1/webtransport"]);
        assert_eq!(hosts.pin_at(&at), None);
    }

    #[tokio::test]
    async fn an_unattested_host_is_reached_only_when_listed() {
        punktfunk_core::tls::install_default_provider();
        let up = upstream(Plane::Unattested).await;
        let hosts = hosts("unattested", Vec::new(), TEST);
        let at = format!("127.0.0.1:{}", up.port);
        for path in ["api/v1/health", "api/v1/webtransport"] {
            let (status, body) = get(&hosts, &format!("/a/{at}/{path}")).await;
            assert_eq!(status, StatusCode::BAD_GATEWAY, "{path}");
            assert!(body.contains("List it on this page's server"), "{body}");
        }
        assert_eq!(up.asked(), ["GET /api/v1/webtransport"]);
        assert_eq!(hosts.pin_at(&at), None);
    }

    #[tokio::test]
    async fn a_typed_address_must_be_a_home_one() {
        let hosts = hosts("typed", Vec::new(), Machine::REAL);
        for path in [
            "/a/8.8.8.8/api/v1/health",
            "/a/example.com/api/v1/health",
            "/a/127.0.0.1/api/v1/health",
            "/a/[::1]:47990/api/v1/health",
            "/wa/127.0.0.1?port=9778&hash=00",
        ] {
            assert_eq!(get(&hosts, path).await.0, StatusCode::BAD_REQUEST, "{path}");
        }
        let own = Request::get("/a/192.168.1.233:8443/api/v1/health")
            .header("host", "192.168.1.233:8443")
            .body(Body::empty())
            .unwrap();
        let own_h2 = Request::get("https://192.168.1.233:8443/a/192.168.1.233:8443/api/v1/health")
            .body(Body::empty())
            .unwrap();
        for req in [own, own_h2] {
            assert_eq!(send(&hosts, req).await.0, StatusCode::BAD_REQUEST);
        }
        let dir = std::env::temp_dir().join(format!("pf-closed-{}", std::process::id()));
        let closed = Hosts::new(Vec::new(), &dir, false, TEST).unwrap();
        assert_eq!(get(&closed, "/a/10.0.0.9/api/v1/health").await.0, 404);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_visitor_vouches_for_nothing_and_a_host_opens_nothing() {
        punktfunk_core::tls::install_default_provider();
        let up = upstream(Plane::Off).await;
        let hosts = hosts("scrub", desk(up.port, Some(up.fp)), TEST);
        let mut req = Request::get("/h/desk/api/v1/status")
            .header("host", "192.168.1.5:8443")
            .header("origin", "https://192.168.1.5:8443");
        for (name, value) in [
            ("authorization", "Bearer x"),
            ("accept", "application/json"),
            ("if-none-match", "\"v0\""),
            ("cookie", "a=b"),
            ("pf-client-addr", "10.9.9.9"),
            ("x-punktfunk-device", "x"),
            ("x-forwarded-for", "203.0.113.9"),
            ("accept-encoding", "gzip"),
            ("user-agent", "visitor"),
        ] {
            req = req.header(name, value);
        }
        let mut req = req.body(Body::empty()).unwrap();
        let peer: std::net::SocketAddr = "127.0.0.1:50000".parse().unwrap();
        req.extensions_mut()
            .insert(axum::extract::ConnectInfo(peer));
        let front = crate::origin::Front {
            names: Some([].into()),
            proxied: true,
        };
        let res = crate::router(hosts, std::env::temp_dir(), front)
            .oneshot(req)
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let h = res.headers();
        for gone in [
            "clear-site-data",
            "www-authenticate",
            "alt-svc",
            "location",
            "set-cookie",
            "access-control-allow-origin",
        ] {
            assert!(h.get(gone).is_none(), "{gone} reached the caller");
        }
        assert_eq!(h["content-type"], "text/plain");
        assert_eq!(h["etag"], "\"v1\"");
        assert_eq!(h["content-security-policy"], "sandbox");
        let body = axum::body::to_bytes(res.into_body(), 1 << 16)
            .await
            .unwrap();
        let seen = String::from_utf8_lossy(&body).into_owned();
        let mut seen: Vec<_> = seen.lines().collect();
        // The upstream's own `Host`, which the HTTP client adds for HTTP/1.1, is not the visitor's.
        seen.retain(|n| !n.starts_with("host="));
        seen.sort_unstable();
        let want = [
            "accept=application/json",
            "authorization=Bearer x",
            "if-none-match=\"v0\"",
            "pf-client-addr=203.0.113.9",
        ];
        assert_eq!(seen, want);
    }

    #[test]
    fn typed_targets_are_home_addresses_and_not_this_machine() {
        let dir = std::env::temp_dir().join(format!("pf-targets-{}", std::process::id()));
        let hosts = Hosts::new(Vec::new(), &dir, true, Machine::REAL).unwrap();
        for ok in [
            "192.168.1.21",
            "10.0.0.5:47991",
            "172.16.4.2",
            "100.101.102.103",
            "[fd00::5]:47990",
            "[fe80::5]",
            // This machine's own LAN address is a home address like any other.
            "10.0.0.77",
        ] {
            assert!(super::typed_target(&hosts, ok).is_ok(), "{ok}");
        }
        for no in [
            "8.8.8.8",
            "100.128.0.1",
            "[2001:db8::1]:47990",
            "desk.local",
            "192.168.1.21:notaport",
            "0.0.0.0",
            "[::ffff:127.0.0.1]",
            // Loopback: this machine to itself.
            "127.0.0.1",
            "[::1]",
        ] {
            assert!(super::typed_target(&hosts, no).is_err(), "{no}");
        }
        assert_eq!(
            super::typed_target(&hosts, "192.168.1.21").unwrap().1,
            crate::config::MGMT_PORT
        );

        let _ = std::fs::remove_dir_all(dir);
    }
}
