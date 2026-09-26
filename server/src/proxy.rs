//! `/h/<id>/…` to `https://<host>:<port>/…`: pinned, streamed both ways, adding nothing.
//!
//! Nothing is injected. The browser's own device token is the only credential that reaches a
//! host, so this server can never do more than the page could.

use crate::hosts::Hosts;
use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, HeaderName, StatusCode};
use axum::response::{IntoResponse, Response};
use punktfunk_core::tls::PinVerify;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Seen = Arc<Mutex<Option<[u8; 32]>>>;

/// A host this server lists: `/h/<id>/…`.
pub async fn listed(
    State(hosts): State<Arc<Hosts>>,
    Path((id, rest)): Path<(String, String)>,
    req: Request,
) -> Response {
    let Some(host) = hosts.get(&id) else {
        return (StatusCode::NOT_FOUND, "This server has no such host.").into_response();
    };
    let learn = Learn::Listed(host.id.clone());
    relay(&hosts, &host.addr, host.port, host.pin, learn, &rest, req).await
}

/// A host the page names by address: `/a/<ip[:port]>/api/…`. Only a private address, and only
/// the management API, so the route cannot be aimed anywhere else on or off the network.
pub async fn typed(
    State(hosts): State<Arc<Hosts>>,
    Path((target, rest)): Path<(String, String)>,
    req: Request,
) -> Response {
    if !hosts.add_hosts {
        return (
            StatusCode::NOT_FOUND,
            "This server only reaches the hosts it lists.",
        )
            .into_response();
    }
    let Some((ip, port)) = private_target(&target) else {
        return (
            StatusCode::BAD_REQUEST,
            "Add a host by its IP address on this network, like 192.168.1.25.",
        )
            .into_response();
    };
    if !rest.starts_with("api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let addr = match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => format!("[{v6}]"),
    };
    let key = format!("{addr}:{port}");
    let pin = hosts.pin_at(&key);
    relay(&hosts, &addr, port, pin, Learn::Address(key), &rest, req).await
}

/// Where a first-contact pin is kept.
enum Learn {
    Listed(String),
    Address(String),
}

/// `ip`, `ip:port` or `[v6]:port`, when the address is one a home network uses: RFC 1918,
/// loopback, link-local, the 100.64/10 range Tailscale hands out, or IPv6 unique-local.
fn private_target(s: &str) -> Option<(IpAddr, u16)> {
    let (ip, port) = match s.parse::<SocketAddr>() {
        Ok(sa) => (sa.ip(), sa.port()),
        Err(_) => (
            s.trim_matches(|c| c == '[' || c == ']').parse().ok()?,
            crate::config::MGMT_PORT,
        ),
    };
    let private = match ip {
        IpAddr::V4(v) => {
            v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || (v.octets()[0] == 100 && v.octets()[1] & 0xc0 == 64)
        }
        IpAddr::V6(v) => v.is_loopback() || v.is_unique_local() || v.is_unicast_link_local(),
    };
    private.then_some((ip, port))
}

async fn relay(
    hosts: &Hosts,
    addr: &str,
    port: u16,
    pin: Option<[u8; 32]>,
    learn: Learn,
    rest: &str,
    req: Request,
) -> Response {
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let url = format!("https://{addr}:{port}/{rest}{query}");
    let seen: Seen = Arc::default();
    // ponytail: a client per request, so a TLS handshake each time (ms on a LAN). A pool keyed by
    // pin is the upgrade if a library of hundreds of covers ever loads slowly.
    let client = match client(pin, seen.clone()) {
        Ok(c) => c,
        Err(e) => return gateway(addr, "the proxy client did not build", &e.to_string()),
    };
    let (parts, body) = req.into_parts();
    let has_body = parts.headers.contains_key(header::CONTENT_LENGTH)
        || parts.headers.contains_key(header::TRANSFER_ENCODING);
    let mut out = client
        .request(parts.method, url)
        .headers(strip(parts.headers));
    if has_body {
        out = out.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }
    match out.send().await {
        Ok(resp) => {
            if pin.is_none() {
                if let Some(fp) = *seen.lock().unwrap() {
                    match learn {
                        Learn::Listed(id) => hosts.learned(&id, fp),
                        Learn::Address(key) => hosts.keep(&key, fp),
                    }
                }
            }
            let (status, headers) = (resp.status(), strip(resp.headers().clone()));
            let mut res = Response::new(Body::from_stream(resp.bytes_stream()));
            *res.status_mut() = status;
            *res.headers_mut() = headers;
            res
        }
        Err(e) => {
            let presented = *seen.lock().unwrap();
            if pin.is_some() && presented.is_some() && presented != pin {
                tracing::warn!(
                    host = %addr,
                    presented = %crate::hosts::hex(&presented.unwrap_or_default()),
                    "certificate does not match the pin"
                );
                return (
                    StatusCode::BAD_GATEWAY,
                    "This host's certificate changed since it was pinned. If the host was \
                     reinstalled, remove its entry from pins.json and restart the server.",
                )
                    .into_response();
            }
            gateway(addr, "host did not answer", &e.to_string())
        }
    }
}

fn gateway(host: &str, what: &str, cause: &str) -> Response {
    tracing::warn!(host, cause, "{what}");
    (StatusCode::BAD_GATEWAY, "Couldn't reach this host.").into_response()
}

fn client(pin: Option<[u8; 32]>, seen: Seen) -> anyhow::Result<reqwest::Client> {
    let tls = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinVerify::with_observed(pin, seen)))
        .with_no_client_auth();
    Ok(reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .connect_timeout(Duration::from_secs(5))
        .no_proxy()
        .build()?)
}

/// Headers about one connection rather than the message; never forwarded either way.
fn strip(mut h: HeaderMap) -> HeaderMap {
    for name in [
        header::CONNECTION,
        header::HOST,
        header::PROXY_AUTHENTICATE,
        header::PROXY_AUTHORIZATION,
        header::TE,
        header::TRAILER,
        header::TRANSFER_ENCODING,
        header::UPGRADE,
        HeaderName::from_static("keep-alive"),
    ] {
        h.remove(name);
    }
    h
}

#[cfg(test)]
mod tests {
    use crate::config::Listed;
    use crate::hosts::Hosts;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    /// A host with a self-signed certificate on a loopback port, and that certificate's pin.
    async fn upstream() -> (u16, [u8; 32]) {
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec!["localhost".into()])
            .unwrap()
            .self_signed(&key)
            .unwrap();
        let fp = punktfunk_core::tls::cert_fingerprint(cert.der());
        let tls = axum_server::tls_rustls::RustlsConfig::from_pem(
            cert.pem().into(),
            key.serialize_pem().into(),
        )
        .await
        .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let app =
            axum::Router::new().route("/api/v1/health", axum::routing::get(|| async { "ok" }));
        let server = axum_server::from_tcp_rustls(listener, tls).unwrap();
        tokio::spawn(server.serve(app.into_make_service()));
        (port, fp)
    }

    async fn get_health(hosts: std::sync::Arc<Hosts>) -> (StatusCode, String) {
        get(hosts, "/h/desk/api/v1/health").await
    }

    async fn get(hosts: std::sync::Arc<Hosts>, path: &str) -> (StatusCode, String) {
        let app = crate::router(hosts, std::env::temp_dir());
        let res = app
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let body = axum::body::to_bytes(res.into_body(), 1 << 16)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    #[tokio::test]
    async fn a_host_is_reached_only_under_its_pin() {
        punktfunk_core::tls::install_default_provider();
        let (port, fp) = upstream().await;
        let dir = std::env::temp_dir().join(format!("pf-proxy-{}", std::process::id()));
        let desk = |pin| {
            vec![Listed {
                name: "desk".into(),
                addr: "127.0.0.1".into(),
                port,
                pin,
            }]
        };

        let pinned = Hosts::new(desk(Some(fp)), &dir.join("a"), true).unwrap();
        assert_eq!(get_health(pinned).await, (StatusCode::OK, "ok".into()));

        let wrong = Hosts::new(desk(Some([0; 32])), &dir.join("b"), true).unwrap();
        let (status, body) = get_health(wrong).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(body.contains("certificate changed"), "{body}");

        let first = Hosts::new(desk(None), &dir.join("c"), true).unwrap();
        assert_eq!(get_health(first.clone()).await.0, StatusCode::OK);
        assert_eq!(first.get("desk").unwrap().pin, Some(fp));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_typed_address_reaches_only_a_private_host_api() {
        punktfunk_core::tls::install_default_provider();
        let (port, fp) = upstream().await;
        let dir = std::env::temp_dir().join(format!("pf-typed-{}", std::process::id()));
        let hosts = Hosts::new(Vec::new(), &dir, true).unwrap();

        let health = format!("/a/127.0.0.1:{port}/api/v1/health");
        assert_eq!(
            get(hosts.clone(), &health).await,
            (StatusCode::OK, "ok".into())
        );
        assert_eq!(hosts.pin_at(&format!("127.0.0.1:{port}")), Some(fp));

        let off_api = format!("/a/127.0.0.1:{port}/metrics");
        assert_eq!(get(hosts.clone(), &off_api).await.0, StatusCode::NOT_FOUND);
        assert_eq!(
            get(hosts.clone(), "/a/8.8.8.8/api/v1/health").await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            get(hosts.clone(), "/a/example.com/api/v1/health").await.0,
            StatusCode::BAD_REQUEST
        );

        let closed = Hosts::new(Vec::new(), &dir.join("closed"), false).unwrap();
        assert_eq!(get(closed, &health).await.0, StatusCode::NOT_FOUND);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn private_means_a_home_network() {
        for ok in [
            "192.168.1.21",
            "10.0.0.5:47991",
            "172.16.4.2",
            "100.101.102.103",
            "[fd00::5]:47990",
            "127.0.0.1",
        ] {
            assert!(super::private_target(ok).is_some(), "{ok}");
        }
        for no in [
            "8.8.8.8",
            "100.128.0.1",
            "[2001:db8::1]:47990",
            "desk.local",
            "192.168.1.21:notaport",
        ] {
            assert!(super::private_target(no).is_none(), "{no}");
        }
        assert_eq!(
            super::private_target("192.168.1.21").unwrap().1,
            crate::config::MGMT_PORT
        );
    }
}
