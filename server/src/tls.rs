//! The page's own certificate: one minted here, the operator's files, or none behind a proxy.

use crate::config::{Config, Tls};
use anyhow::{Context, Result};
use axum_server::tls_rustls::RustlsConfig;
use std::path::Path;
use time::{Duration, OffsetDateTime};

/// 397 days: the longest lifetime Apple platforms accept for a TLS server certificate.
const LIFETIME: Duration = Duration::days(397);

pub async fn config(cfg: &Config) -> Result<Option<RustlsConfig>> {
    Ok(match &cfg.tls {
        Tls::Off => None,
        Tls::Files { cert, key } => Some(
            RustlsConfig::from_pem_file(cert, key)
                .await
                .with_context(|| format!("load {} and {}", cert.display(), key.display()))?,
        ),
        Tls::SelfSigned => {
            let (cert, key) = self_signed(&cfg.data, &cfg.tls_names)?;
            Some(
                RustlsConfig::from_pem(cert, key)
                    .await
                    .context("load the self-signed certificate")?,
            )
        }
    })
}

/// Reused across restarts, so a browser's one exception keeps working; minted again when the names
/// change or it has a month left.
fn self_signed(data: &Path, extra: &[String]) -> Result<(Vec<u8>, Vec<u8>)> {
    let dir = data.join("tls");
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let mut names = vec!["localhost".to_string()];
    names.extend(extra.iter().cloned());
    let stamp = format!(
        "{}\n{}",
        names.join(","),
        (OffsetDateTime::now_utc() + LIFETIME).unix_timestamp()
    );
    if let (Ok(cert), Ok(key), Ok(old)) = (
        std::fs::read(dir.join("cert.pem")),
        std::fs::read(dir.join("key.pem")),
        std::fs::read_to_string(dir.join("issued")),
    ) {
        let (old_names, expires) = old.split_once('\n').unwrap_or_default();
        let fresh = expires.parse::<i64>().is_ok_and(|t| {
            t - OffsetDateTime::now_utc().unix_timestamp() > Duration::days(30).whole_seconds()
        });
        if old_names == names.join(",") && fresh {
            return Ok((cert, key));
        }
    }
    let key = rcgen::KeyPair::generate().context("generate a key")?;
    let mut params = rcgen::CertificateParams::new(names.clone()).context("certificate names")?;
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "punktfunk client-web");
    params.not_before = OffsetDateTime::now_utc() - Duration::days(1);
    params.not_after = OffsetDateTime::now_utc() + LIFETIME;
    let cert = params.self_signed(&key).context("sign the certificate")?;
    let (cert, key) = (cert.pem().into_bytes(), key.serialize_pem().into_bytes());
    std::fs::write(dir.join("cert.pem"), &cert)?;
    std::fs::write(dir.join("key.pem"), &key)?;
    std::fs::write(dir.join("issued"), stamp)?;
    tracing::info!(names = %names.join(", "), "issued a self-signed certificate");
    Ok((cert, key))
}
