//! The page's origin answers only to its own names and its own pages.
//!
//! The device key lives in the origin, so a site that rebinds a name to this server, or a page on
//! another site that calls its routes, must get nothing back.

use crate::proxy::own_authority;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Arc;

/// `TLS_NAMES`, lowercase, without a trailing dot. `None` checks no name at all.
pub type Names = Option<Arc<[String]>>;

/// The page's own scripts and wasm, nothing injected, never framed. `blob:` scripts are the audio
/// worklets; `blob:` fetches and images, the art read from a host; `data:` images, its cursor;
/// `https:`, every host the page dials and every cover it shows. Inline styles are `index.html`'s
/// ground and what the UI libraries inject.
const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; \
                   style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; \
                   connect-src 'self' https: blob:; object-src 'none'; base-uri 'none'; \
                   form-action 'none'; frame-ancestors 'none'";

/// Every request: the name first, then this server's word on the origin. A host's reply keeps the
/// `sandbox` CSP the relay gave it; the rest is set over whatever the host sent.
pub async fn guard(State(names): State<Names>, req: Request, next: Next) -> Response {
    let name = own_authority(req.uri(), req.headers()).map(name_of);
    let mut res = match name {
        Some(name) if !answers(names.as_deref(), &name) => {
            tracing::warn!(name, "refused a name not in TLS_NAMES");
            let say = format!("Add {name} to TLS_NAMES to open the page at that name.");
            (StatusCode::MISDIRECTED_REQUEST, say).into_response()
        }
        _ => next.run(req).await,
    };
    let h = res.headers_mut();
    h.entry(header::CONTENT_SECURITY_POLICY)
        .or_insert(HeaderValue::from_static(CSP));
    for (name, value) in [
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
        (
            header::HeaderName::from_static("cross-origin-opener-policy"),
            "same-origin",
        ),
    ] {
        h.insert(name, HeaderValue::from_static(value));
    }
    res
}

/// Every route but the static files: only this server's own page, or no page at all.
pub async fn own_page(req: Request, next: Next) -> Response {
    if !same_origin(req.uri(), req.headers()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(req).await
}

/// Refuses what a browser marks as another site's, and an `Origin` that is not this server. A
/// caller that sends neither is no browser page, and could send the right ones anyway.
fn same_origin(uri: &Uri, headers: &HeaderMap) -> bool {
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    if matches!(get("sec-fetch-site"), Some("cross-site" | "same-site")) {
        return false;
    }
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let theirs = origin
        .to_str()
        .ok()
        .and_then(|o| o.split_once("://"))
        .map(|(_, authority)| authority);
    own_authority(uri, headers)
        .zip(theirs)
        .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
}

/// The host of `host[:port]`, lowercase, without a trailing dot. An IPv6 one keeps its brackets.
fn name_of(authority: &str) -> String {
    let host = match authority.parse::<axum::http::uri::Authority>() {
        Ok(a) => a.host().to_owned(),
        Err(_) => authority.to_owned(),
    };
    host.trim_end_matches('.').to_ascii_lowercase()
}

/// An address, a name no public DNS can hold, or one the operator listed. A rebinding site always
/// arrives under a public name of its own.
fn answers(listed: Option<&[String]>, name: &str) -> bool {
    let Some(listed) = listed else { return true };
    let ip = match name.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
        Some(v6) => v6.parse::<Ipv6Addr>().is_ok(),
        None => name.parse::<Ipv4Addr>().is_ok(),
    };
    ip || !name.contains('.')
        || [".local", ".home.arpa", ".internal"]
            .iter()
            .any(|zone| name.ends_with(zone))
        || listed.iter().any(|n| n == name)
}

#[cfg(test)]
mod tests {
    use crate::config::Listed;
    use crate::hosts::Hosts;
    use axum::body::Body;
    use axum::http::Request;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn app(name: &str, names: super::Names) -> axum::Router {
        let dir = std::env::temp_dir().join(format!("pf-origin-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<!doctype html>").unwrap();
        let desk = Listed {
            name: "desk".into(),
            addr: "10.0.0.2".into(),
            port: 47990,
            pin: None,
        };
        let hosts = Hosts::new(vec![desk], &dir, true).unwrap();
        crate::router(hosts, dir, names)
    }

    async fn send(app: &axum::Router, req: Request<Body>) -> axum::response::Response {
        app.clone().oneshot(req).await.unwrap()
    }

    fn at(host: &str, path: &str) -> Request<Body> {
        Request::get(path)
            .header("host", host)
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn a_rebinding_name_gets_421() {
        let listed = app("names", Some(Arc::from(["play.example.com".to_string()])));
        for (host, status) in [
            ("evil.example:8443", 421),
            ("play.example.com.evil.example", 421),
            ("PLAY.example.com:8443", 200),
            ("play.example.com.", 200),
            ("192.168.1.5:8443", 200),
            ("[fd00::5]:8443", 200),
            ("desk.local", 200),
            ("desk.home.arpa", 200),
            ("box.internal:8443", 200),
            ("localhost:8443", 200),
            ("desk", 200),
        ] {
            let res = send(&listed, at(host, "/")).await;
            assert_eq!(res.status(), status, "{host}");
        }
        let res = send(&listed, at("evil.example", "/config.json")).await;
        let body = axum::body::to_bytes(res.into_body(), 1 << 16)
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&body).contains("TLS_NAMES"));
        // HTTP/2 names the server in the URI rather than in `Host`.
        let h2 = Request::get("https://evil.example/").body(Body::empty());
        assert_eq!(send(&listed, h2.unwrap()).await.status(), 421);

        // `TLS=off` or self-signed with no names: addresses and local names only.
        let none = app("no-names", Some(Arc::from([])));
        assert_eq!(send(&none, at("play.example.com", "/")).await.status(), 421);
        assert_eq!(send(&none, at("desk.local", "/")).await.status(), 200);
        // The operator's own certificate with no names: the browser has checked the name.
        let any = app("any-name", None);
        assert_eq!(send(&any, at("evil.example", "/")).await.status(), 200);
    }

    #[tokio::test]
    async fn another_site_reaches_no_route_but_the_page() {
        let app = app("sites", Some(Arc::from([])));
        for (method, path) in [
            ("GET", "/config.json"),
            ("GET", "/h/desk/api/v1/health"),
            ("GET", "/a/10.0.0.9/api/v1/health"),
            ("POST", "/wake/desk"),
            ("GET", "/w/desk?port=1&hash=00"),
            ("GET", "/wa/10.0.0.9?port=1&hash=00"),
        ] {
            for (name, value) in [
                ("sec-fetch-site", "cross-site"),
                ("sec-fetch-site", "same-site"),
                ("origin", "https://evil.example"),
                ("origin", "null"),
            ] {
                let req = Request::builder()
                    .method(method)
                    .uri(path)
                    .header("host", "192.168.1.5:8443")
                    .header(name, value)
                    .body(Body::empty())
                    .unwrap();
                let res = send(&app, req).await;
                assert_eq!(res.status(), 403, "{method} {path} {name}: {value}");
            }
        }
        let own = Request::get("/config.json")
            .header("host", "192.168.1.5:8443")
            .header("sec-fetch-site", "same-origin")
            .header("origin", "https://192.168.1.5:8443")
            .body(Body::empty())
            .unwrap();
        assert_eq!(send(&app, own).await.status(), 200);
        for site in ["cross-site", "same-site"] {
            let page = Request::get("/")
                .header("host", "192.168.1.5:8443")
                .header("sec-fetch-site", site)
                .body(Body::empty())
                .unwrap();
            assert_eq!(send(&app, page).await.status(), 200, "{site}");
        }
    }

    #[tokio::test]
    async fn the_page_carries_its_policy() {
        let app = app("headers", Some(Arc::from([])));
        for req in [
            at("192.168.1.5", "/"),
            at("192.168.1.5", "/config.json"),
            at("evil.example", "/"),
        ] {
            let res = send(&app, req).await;
            let h = res.headers();
            let csp = h["content-security-policy"].to_str().unwrap();
            for part in [
                "script-src 'self' 'wasm-unsafe-eval' blob:",
                "frame-ancestors 'none'",
                "base-uri 'none'",
                "form-action 'none'",
                "object-src 'none'",
            ] {
                assert!(csp.contains(part), "{csp}");
            }
            assert_eq!(h["x-content-type-options"], "nosniff");
            assert_eq!(h["referrer-policy"], "no-referrer");
            assert_eq!(h["cross-origin-opener-policy"], "same-origin");
        }
    }
}
