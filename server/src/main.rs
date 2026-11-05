//! Serves the punktfunk browser client and proxies each host's management API on the page's own
//! origin.
//!
//! Same origin is the point: Safari will not let a page `fetch` a self-signed host cross-origin,
//! whatever the user clicks. The WebTransport plane goes straight from the browser to the host,
//! pinned to the hash the host signs with its identity. Where UDP is blocked, `bridge` carries
//! that same session over a WebSocket to this server, which dials the plane under the same pin.

mod bridge;
mod config;
mod hosts;
mod lanes;
mod listen;
mod origin;
mod proof;
mod proxy;
#[cfg(test)]
mod testing;
mod tls;
mod visitor;

use anyhow::Context as _;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Extension, Json, Router};
use hosts::Hosts;
use lanes::Pass;
use punktfunk_core::provenance::KnockSource;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use visitor::Visitor;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    punktfunk_core::tls::install_default_provider();
    let cfg = config::Config::from_env()?;
    let machine = visitor::Machine::REAL;
    let hosts = Hosts::new(cfg.hosts.clone(), &cfg.data, cfg.add_hosts, machine)?;
    for h in hosts.all() {
        tracing::info!(host = %h.id, addr = %h.addr, port = h.port, pinned = h.pin.is_some(), "listed");
        // Through loopback every visitor reaches the host as one on its own machine.
        let ip = h.addr.trim_matches(['[', ']']).parse::<std::net::IpAddr>();
        if ip.is_ok_and(|ip| ip.is_loopback()) {
            tracing::warn!(host = %h.id, "listed at loopback; list it at its LAN address instead");
        }
    }
    if cfg.discover {
        hosts::discover(hosts.clone());
    }
    let front = origin::Front {
        names: cfg.names(),
        proxied: matches!(cfg.tls, config::Tls::Off),
    };
    let app = router(hosts, cfg.dist.clone(), front);

    let handle = axum_server::Handle::new();
    tokio::spawn(shutdown(handle.clone()));
    let tls = tls::config(&cfg).await?;
    let scheme = if tls.is_some() { "https" } else { "http" };
    tracing::info!("serving the browser client at {scheme}://{}", cfg.listen);
    let listener =
        std::net::TcpListener::bind(cfg.listen).with_context(|| format!("bind {}", cfg.listen))?;
    // Behind a proxy (`TLS=off`) every connection is the proxy's: only the total holds.
    let per_peer = if tls.is_some() {
        listen::PER_PEER
    } else {
        listen::CONNS
    };
    let caps = listen::Capped::new(listen::CONNS, per_peer);
    listen::serve(listener, app, tls, handle, caps).await?;
    Ok(())
}

/// Every route but the static files answers only this server's own page; every response, the
/// files included, answers only the names `front` allows, and knows its visitor.
pub(crate) fn router(hosts: Arc<Hosts>, dist: PathBuf, front: origin::Front) -> Router {
    let visitor = (hosts.clone(), front.proxied);
    let gate = (front.names, hosts.clone());
    Router::new()
        .route("/config.json", get(config_json))
        .route("/h/{id}/{*rest}", any(proxy::listed))
        .route("/a/{target}/{*rest}", any(proxy::typed))
        .route("/wake/{id}", post(wake))
        .route("/w/{id}", get(bridge::listed))
        .route("/wa/{target}", get(bridge::typed))
        .route("/pass/h/{id}", post(proxy::pass_listed))
        .route("/pass/a/{target}", post(proxy::pass_typed))
        .route_layer(axum::middleware::from_fn(origin::own_page))
        .with_state(hosts)
        .fallback_service(tower_http::services::ServeDir::new(dist))
        .layer(axum::middleware::from_fn(cache))
        .layer(axum::middleware::from_fn_with_state(gate, origin::gate))
        .layer(axum::middleware::from_fn_with_state(visitor, visitor::find))
        .layer(axum::middleware::from_fn(origin::headers))
}

/// The hosts the page lists, and whether it may reach others by address through `/a/`. `api` and
/// `bridge` are relative, so a page served under a path still resolves them. A typed host's bridge
/// is `wa/<ip:port>`, which the page composes itself, as it does `a/<ip:port>`.
///
/// A host's LAN address (`plane`) goes to a browser with a pass for it, or one at home; `wake`
/// only to the first.
async fn config_json(
    State(state): State<Arc<Hosts>>,
    Extension(pass): Extension<Pass>,
    Extension(visitor): Extension<Visitor>,
) -> impl IntoResponse {
    let home = visitor.class == KnockSource::Lan;
    let hosts: Vec<_> = state
        .all()
        .into_iter()
        .map(|h| {
            let mut j = serde_json::json!({ "id": h.id, "name": h.name, "api": format!("h/{}", h.id), "bridge": format!("w/{}", h.id) });
            let ours = pass.covers(h.pin);
            if ours || home {
                j["plane"] = h.addr.clone().into();
            }
            if ours && !state.macs(&h.id).is_empty() {
                j["wake"] = format!("wake/{}", h.id).into();
            }
            j
        })
        .collect();
    let body = serde_json::json!({ "hosts": hosts, "add": state.add_hosts });
    ([(header::CACHE_CONTROL, "no-store")], Json(body))
}

/// Wake a listed host: a magic packet to every MAC it announced while awake, from this machine,
/// which is on the host's network where a browser cannot send one. Only for a pass for that host.
async fn wake(
    State(state): State<Arc<Hosts>>,
    Path(id): Path<String>,
    Extension(pass): Extension<Pass>,
) -> StatusCode {
    let Some(host) = state.get(&id) else {
        return StatusCode::NOT_FOUND;
    };
    if !pass.covers(host.pin) {
        return StatusCode::FORBIDDEN;
    }
    let macs: Vec<_> = state
        .macs(&id)
        .iter()
        .filter_map(|m| punktfunk_core::wol::parse_mac(m))
        .collect();
    if macs.is_empty() {
        return StatusCode::CONFLICT;
    }
    let ip = host.addr.parse().ok();
    match tokio::task::spawn_blocking(move || punktfunk_core::wol::send_magic_packet(&macs, ip))
        .await
    {
        Ok(Ok(())) => {
            tracing::info!(host = %id, "sent a wake packet");
            StatusCode::NO_CONTENT
        }
        _ => {
            tracing::warn!(host = %id, "wake packet did not go out");
            StatusCode::BAD_GATEWAY
        }
    }
}

/// Vite hashes everything under `/assets`, so those never change; the page itself always might.
/// A missing asset is not cached: mid-deploy it may be one the next request finds.
async fn cache(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let (asset, proxied) = (path.starts_with("/assets/"), path.starts_with("/h/"));
    let mut res = next.run(req).await;
    let value = if asset && res.status().is_success() {
        Some("public, max-age=31536000, immutable")
    } else if proxied {
        None
    } else {
        Some("no-cache")
    };
    if let Some(v) = value {
        res.headers_mut()
            .entry(header::CACHE_CONTROL)
            .or_insert(HeaderValue::from_static(v));
    }
    res
}

/// Docker stops a container with SIGTERM, which a process running as PID 1 must handle itself.
async fn shutdown(handle: axum_server::Handle<std::net::SocketAddr>) {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install the SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
    handle.graceful_shutdown(Some(Duration::from_secs(5)));
}

#[cfg(test)]
mod tests {
    use crate::config::Listed;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn desk() -> Listed {
        Listed {
            name: "Desk".into(),
            addr: "10.0.0.2".into(),
            port: 47990,
            pin: Some([7; 32]),
        }
    }

    /// From `peer`, with `pass` when there is one.
    fn from(path: &str, peer: &str, pass: Option<&str>) -> Request<Body> {
        let mut req = Request::get(path);
        if let Some(pass) = pass {
            req = req.header("pf-pass", pass);
        }
        let mut req = req.body(Body::empty()).unwrap();
        let peer: std::net::SocketAddr = format!("{peer}:50000").parse().unwrap();
        req.extensions_mut()
            .insert(axum::extract::ConnectInfo(peer));
        req
    }

    #[tokio::test]
    async fn config_tells_a_stranger_names_and_a_pass_holder_everything() {
        let dir = std::env::temp_dir().join(format!("pf-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for add in [true, false] {
            let hosts = crate::Hosts::new(vec![desk()], &dir, add, crate::visitor::TEST).unwrap();
            let pass = hosts.lanes.passes.prove(None, [7; 32]);
            let elsewhere = hosts.lanes.passes.prove(None, [8; 32]);
            let config = |req: Request<Body>| {
                let app = crate::router(hosts.clone(), dir.clone(), Default::default());
                async move {
                    let res = app.oneshot(req).await.unwrap();
                    let body = axum::body::to_bytes(res.into_body(), 1 << 16).await;
                    let json: serde_json::Value = serde_json::from_slice(&body.unwrap()).unwrap();
                    assert_eq!(json["add"], add);
                    assert_eq!(json["hosts"][0]["api"], "h/desk");
                    assert_eq!(json["hosts"][0]["bridge"], "w/desk");
                    json["hosts"][0]["plane"].as_str().map(str::to_owned)
                }
            };
            let plane = Some("10.0.0.2".to_string());
            assert_eq!(
                config(from("/config.json", "203.0.113.9", None)).await,
                None
            );
            let at_home = from("/config.json", "192.168.1.20", None);
            assert_eq!(config(at_home).await, plane);
            let theirs = from("/config.json", "203.0.113.9", Some(&elsewhere));
            assert_eq!(config(theirs).await, None);
            let ours = from("/config.json", "203.0.113.9", Some(&pass));
            assert_eq!(config(ours).await, plane);
            let forged = from("/config.json", "203.0.113.9", Some(&"ab".repeat(32)));
            assert_eq!(config(forged).await, None);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn wake_goes_only_to_a_known_host_for_a_pass_holder() {
        let dir = std::env::temp_dir().join(format!("pf-wake-route-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let hosts = crate::Hosts::new(vec![desk()], &dir, true, crate::visitor::TEST).unwrap();
        let pass = hosts.lanes.passes.prove(None, [7; 32]);
        let wake = |path: &str, site: &str, pass: Option<&str>| {
            let mut req = Request::post(path).header("sec-fetch-site", site);
            if let Some(pass) = pass {
                req = req.header("pf-pass", pass);
            }
            req.body(Body::empty()).unwrap()
        };
        let status = |req: Request<Body>| {
            let app = crate::router(hosts.clone(), dir.clone(), Default::default());
            async move { app.oneshot(req).await.unwrap().status() }
        };
        let ours = Some(pass.as_str());
        assert_eq!(status(wake("/wake/desk", "cross-site", ours)).await, 403);
        assert_eq!(status(wake("/wake/desk", "same-origin", None)).await, 403);
        assert_eq!(
            status(wake("/wake/nowhere", "same-origin", ours)).await,
            404
        );
        let known = status(wake("/wake/desk", "same-origin", ours)).await;
        assert_eq!(known, 409, "no MAC known yet");
        let _ = std::fs::remove_dir_all(dir);
    }
}
