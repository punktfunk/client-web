//! A fake host for the tests: TLS on a loopback port, answering as a Punktfunk host would, or not.

use axum::extract::State;
use std::sync::{Arc, Mutex};

/// What a fake host's `/api/v1/webtransport` answers.
#[derive(PartialEq)]
pub enum Plane {
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
pub struct Up {
    pub port: u16,
    pub fp: [u8; 32],
    asked: Arc<Mutex<Vec<String>>>,
}

impl Up {
    pub fn asked(&self) -> Vec<String> {
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

/// The plane a fake host publishes unless a test names one.
const PLANE: (u16, [u8; 32]) = (9778, [0xab; 32]);

/// The host's `/api/v1/webtransport` answer for `plane`, signed by `key`, whose certificate is
/// `cert`.
fn published(
    cert: &rcgen::Certificate,
    key: &rcgen::KeyPair,
    plane: (u16, [u8; 32]),
) -> serde_json::Value {
    use base64::Engine as _;
    use rcgen::SigningKey as _;
    let hash = crate::hosts::hex(&plane.1);
    let msg = format!("{}{hash}", punktfunk_core::tls::PLANE_ATTESTATION_CONTEXT);
    let sig = key.sign(msg.as_bytes()).unwrap();
    serde_json::json!({
        "port": plane.0,
        "cert_hash_sha256": hash,
        "expires_at": 4_000_000_000u64,
        "allow_pooling": false,
        "cert_hash_sig": crate::hosts::hex(&sig),
        "host_cert_der": base64::engine::general_purpose::STANDARD.encode(cert.der()),
    })
}

pub async fn upstream(plane: Plane) -> Up {
    upstream_publishing(plane, PLANE).await
}

/// A fake host on a loopback port. `/api/v1/host` takes the token `Bearer good` and no other.
pub async fn upstream_publishing(plane: Plane, publish: (u16, [u8; 32])) -> Up {
    let (cert, key) = identity();
    let fp = punktfunk_core::tls::cert_fingerprint(cert.der());
    let answer = match plane {
        Plane::Attested => Some(published(&cert, &key, publish)),
        Plane::Borrowed => {
            let (other, other_key) = identity();
            Some(published(&other, &other_key, publish))
        }
        Plane::Unattested => {
            let mut plane = published(&cert, &key, publish);
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
            axum::routing::get(|h: axum::http::HeaderMap| async move {
                match h.get("authorization").and_then(|v| v.to_str().ok()) {
                    Some("Bearer good") => (axum::http::StatusCode::OK, "{}"),
                    _ => (axum::http::StatusCode::UNAUTHORIZED, "{}"),
                }
            }),
        )
        .route(
            "/api/v1/compositors",
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
