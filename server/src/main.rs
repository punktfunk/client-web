//! Serves the punktfunk browser client and proxies each host's management API on the page's own
//! origin.
//!
//! Same origin is the point: Safari will not let a page `fetch` a self-signed host cross-origin,
//! whatever the user clicks. The WebTransport plane is not proxied and cannot be: the browser pins
//! the plane's certificate hash, which the host signs with its identity, so video, audio and input
//! go straight from the browser to the host.

mod config;
mod hosts;
mod proxy;
mod tls;

use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use hosts::Hosts;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    punktfunk_core::tls::install_default_provider();
    let cfg = config::Config::from_env()?;
    let hosts = Hosts::new(cfg.hosts.clone(), &cfg.data, cfg.add_hosts)?;
    for h in hosts.all() {
        tracing::info!(host = %h.id, addr = %h.addr, port = h.port, pinned = h.pin.is_some(), "listed");
    }
    if cfg.discover {
        hosts::discover(hosts.clone());
    }
    let app = router(hosts, cfg.dist.clone());

    let handle = axum_server::Handle::new();
    tokio::spawn(shutdown(handle.clone()));
    let service = app.into_make_service();
    match tls::config(&cfg).await? {
        Some(tls) => {
            tracing::info!("serving the browser client at https://{}", cfg.listen);
            axum_server::bind_rustls(cfg.listen, tls)
                .handle(handle)
                .serve(service)
                .await?;
        }
        None => {
            tracing::info!(
                "serving the browser client at http://{} (TLS is off)",
                cfg.listen
            );
            axum_server::bind(cfg.listen)
                .handle(handle)
                .serve(service)
                .await?;
        }
    }
    Ok(())
}

pub(crate) fn router(hosts: Arc<Hosts>, dist: PathBuf) -> Router {
    Router::new()
        .route("/config.json", get(config_json))
        .route("/h/{id}/{*rest}", any(proxy::listed))
        .route("/a/{target}/{*rest}", any(proxy::typed))
        .route("/wake/{id}", post(wake))
        .with_state(hosts)
        .fallback_service(tower_http::services::ServeDir::new(dist))
        .layer(axum::middleware::from_fn(cache))
}

/// The hosts the page lists, and whether it may reach others by address through `/a/`. `api` is
/// relative, so a page served under a path still resolves it.
async fn config_json(State(state): State<Arc<Hosts>>) -> impl IntoResponse {
    let hosts: Vec<_> = state
        .all()
        .into_iter()
        .map(|h| {
            let mut j = serde_json::json!({ "id": h.id, "name": h.name, "api": format!("h/{}", h.id), "plane": h.addr });
            if !state.macs(&h.id).is_empty() {
                j["wake"] = format!("wake/{}", h.id).into();
            }
            j
        })
        .collect();
    let body = serde_json::json!({ "hosts": hosts, "add": state.add_hosts });
    ([(header::CACHE_CONTROL, "no-store")], Json(body))
}

/// Wake a listed host: a magic packet to every MAC it announced while awake, from this machine,
/// which is on the host's network where a browser cannot send one. Only this page may ask, not one
/// on another site: a cross-site request is refused.
async fn wake(
    State(state): State<Arc<Hosts>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> StatusCode {
    if headers
        .get("sec-fetch-site")
        .is_some_and(|v| v == "cross-site")
    {
        return StatusCode::FORBIDDEN;
    }
    let Some(host) = state.get(&id) else {
        return StatusCode::NOT_FOUND;
    };
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
async fn cache(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let value = if path.starts_with("/assets/") {
        Some("public, max-age=31536000, immutable")
    } else if path.starts_with("/h/") {
        None
    } else {
        Some("no-cache")
    };
    let mut res = next.run(req).await;
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

    #[tokio::test]
    async fn config_lists_hosts_and_whether_typed_ones_are_proxied() {
        let dir = std::env::temp_dir().join(format!("pf-config-{}", std::process::id()));
        let desk = Listed {
            name: "Desk".into(),
            addr: "10.0.0.2".into(),
            port: 47990,
            pin: None,
        };
        for add in [true, false] {
            let hosts = crate::Hosts::new(vec![desk.clone()], &dir, add).unwrap();
            let res = crate::router(hosts, dir.clone())
                .oneshot(Request::get("/config.json").body(Body::empty()).unwrap())
                .await
                .unwrap();
            let body = axum::body::to_bytes(res.into_body(), 1 << 16)
                .await
                .unwrap();
            let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(json["add"], add);
            assert_eq!(json["hosts"][0]["api"], "h/desk");
            assert_eq!(json["hosts"][0]["plane"], "10.0.0.2");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn wake_goes_only_to_a_known_host_from_this_page() {
        let dir = std::env::temp_dir().join(format!("pf-wake-route-{}", std::process::id()));
        let desk = Listed {
            name: "Desk".into(),
            addr: "10.0.0.2".into(),
            port: 47990,
            pin: None,
        };
        let hosts = crate::Hosts::new(vec![desk], &dir, true).unwrap();
        let wake = |path: &str, site: &str| {
            Request::post(path)
                .header("sec-fetch-site", site)
                .body(Body::empty())
                .unwrap()
        };
        let status = |req: Request<Body>| {
            let app = crate::router(hosts.clone(), dir.clone());
            async move { app.oneshot(req).await.unwrap().status() }
        };
        assert_eq!(status(wake("/wake/desk", "cross-site")).await, 403);
        assert_eq!(status(wake("/wake/nowhere", "same-origin")).await, 404);
        assert_eq!(
            status(wake("/wake/desk", "same-origin")).await,
            409,
            "no MAC known yet"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
