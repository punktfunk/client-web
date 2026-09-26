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
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Seen = Arc<Mutex<Option<[u8; 32]>>>;

pub async fn forward(
    State(hosts): State<Arc<Hosts>>,
    Path((id, rest)): Path<(String, String)>,
    req: Request,
) -> Response {
    let Some(host) = hosts.get(&id) else {
        return (StatusCode::NOT_FOUND, "This server has no such host.").into_response();
    };
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let url = format!("https://{}:{}/{rest}{query}", host.addr, host.port);
    let seen: Seen = Arc::default();
    // ponytail: a client per request, so a TLS handshake each time (ms on a LAN). A pool keyed by
    // pin is the upgrade if a library of hundreds of covers ever loads slowly.
    let client = match client(host.pin, seen.clone()) {
        Ok(c) => c,
        Err(e) => return gateway(&id, "the proxy client did not build", &e.to_string()),
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
            if host.pin.is_none() {
                if let Some(fp) = *seen.lock().unwrap() {
                    hosts.learned(&host.id, fp);
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
            if host.pin.is_some() && presented.is_some() && presented != host.pin {
                tracing::warn!(
                    host = %id,
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
            gateway(&id, "host did not answer", &e.to_string())
        }
    }
}

fn gateway(id: &str, what: &str, cause: &str) -> Response {
    tracing::warn!(host = %id, cause, "{what}");
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
    use axum::routing::get;
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
        let app = axum::Router::new().route("/api/v1/health", get(|| async { "ok" }));
        let server = axum_server::from_tcp_rustls(listener, tls).unwrap();
        tokio::spawn(server.serve(app.into_make_service()));
        (port, fp)
    }

    async fn get_health(hosts: std::sync::Arc<Hosts>) -> (StatusCode, String) {
        let app = crate::router(hosts, std::env::temp_dir());
        let res = app
            .oneshot(
                Request::get("/h/desk/api/v1/health")
                    .body(Body::empty())
                    .unwrap(),
            )
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

        let pinned = Hosts::new(desk(Some(fp)), &dir.join("a")).unwrap();
        assert_eq!(get_health(pinned).await, (StatusCode::OK, "ok".into()));

        let wrong = Hosts::new(desk(Some([0; 32])), &dir.join("b")).unwrap();
        let (status, body) = get_health(wrong).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(body.contains("certificate changed"), "{body}");

        let first = Hosts::new(desk(None), &dir.join("c")).unwrap();
        assert_eq!(get_health(first.clone()).await.0, StatusCode::OK);
        assert_eq!(first.get("desk").unwrap().pin, Some(fp));
        let _ = std::fs::remove_dir_all(dir);
    }
}
