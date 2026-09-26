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

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
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
    let hosts = Hosts::new(cfg.hosts.clone(), &cfg.data)?;
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
        .route("/h/{id}/{*rest}", any(proxy::forward))
        .with_state(hosts)
        .fallback_service(tower_http::services::ServeDir::new(dist))
        .layer(axum::middleware::from_fn(cache))
}

/// The hosts the page lists. `api` is relative, so a page served under a path still resolves it.
async fn config_json(State(hosts): State<Arc<Hosts>>) -> impl IntoResponse {
    let hosts: Vec<_> = hosts
        .all()
        .into_iter()
        .map(|h| serde_json::json!({ "id": h.id, "name": h.name, "api": format!("h/{}", h.id), "plane": h.addr }))
        .collect();
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({ "hosts": hosts })),
    )
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
