//! The dial a browser would make to the plane, made from here.

use anyhow::{Context, Result};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use wtransport::endpoint::ConnectOptions;
use wtransport::tls::Sha256Digest;
use wtransport::{ClientConfig, Connection, Endpoint};

/// The plane the page fetched and verified: the bridge dials exactly this and fetches nothing.
pub struct Target {
    /// As it goes in a URL: an IPv6 address in brackets, or a name.
    pub addr: String,
    pub port: u16,
    pub hash: [u8; 32],
    /// The browser's `Origin`, so the host's origin list applies as on a direct dial.
    pub origin: Option<String>,
    /// The WebSocket peer, so the host classifies the knock by the real client.
    pub client: IpAddr,
}

/// `https://<addr>:<port>/pf2`, pinned to `hash`. One endpoint per dial: wtransport binds the
/// certificate check to the endpoint, and each session pins its own hash.
pub async fn dial(t: &Target) -> Result<Connection> {
    let to = tokio::net::lookup_host(format!("{}:{}", t.addr, t.port))
        .await?
        .next()
        .context("resolve the host")?;
    let any: IpAddr = match to {
        SocketAddr::V4(_) => Ipv4Addr::UNSPECIFIED.into(),
        SocketAddr::V6(_) => Ipv6Addr::UNSPECIFIED.into(),
    };
    let endpoint = Endpoint::client(
        ClientConfig::builder()
            .with_bind_address(SocketAddr::new(any, 0))
            .with_server_certificate_hashes([Sha256Digest::new(t.hash)])
            .build(),
    )?;
    let mut opts = ConnectOptions::builder(format!("https://{to}/pf2"))
        .add_header("pf-client-addr", t.client.to_string());
    if let Some(origin) = &t.origin {
        opts = opts.add_header("origin", origin);
    }
    Ok(endpoint.connect(opts.build()).await?)
}
