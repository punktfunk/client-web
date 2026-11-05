//! A host the operator did not list is reached only once this server has proven it is one.
//!
//! The proof is one fixed request, `GET /api/v1/webtransport`, carrying nothing of a visitor's. A
//! Punktfunk host answers with its plane's certificate hash, signed by the identity that served
//! the request. Anything else has received that one request, and receives nothing more.

use crate::hosts::Hosts;
use crate::lanes::Pass;
use crate::visitor::Visitor;
use axum::body::Bytes;
use axum::http::{header, Extensions, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use punktfunk_core::tls::verify_plane_attestation;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// How long an address that is not a host, or has its plane off, is left alone.
const REFUSED_FOR: Duration = Duration::from_secs(60);
/// Proven hosts, kept clients and unlisted pins at once; the least recently used goes first.
pub const KEPT: usize = 64;
/// The answer is under a kilobyte. A server that sends more is not a host.
const MAX_BODY: usize = 64 << 10;
const TIMEOUT: Duration = Duration::from_secs(5);
/// The longest a browser pins a plane certificate by hash. The attestation does not sign
/// `expires_at`, so a later one is not believed.
const PLANE_LIFE: Duration = Duration::from_secs(14 * 24 * 60 * 60);

const NOT_A_HOST: &str =
    "Nothing at this address answered as a Punktfunk host. Check the address and that the host is \
     running.";
const UNATTESTED: &str = "This host's identity is too old to reach by its address. List it on \
                          this page's server instead.";
const NO_PLANE: &str = "Browser streaming is off on this host. Turn it on in the host's console, \
                        under Host → Settings, then restart the host.";

/// What one address turned out to be.
#[derive(Clone)]
pub enum Outcome {
    /// A Punktfunk host: its identity's fingerprint, and the plane it published, until `expires`
    /// (Unix seconds). `body` is its answer, verified.
    Host {
        fp: [u8; 32],
        plane_port: u16,
        plane_hash: [u8; 32],
        expires: u64,
        body: Bytes,
    },
    /// A host with its browser plane off: its own `404`.
    NoPlane(Bytes),
    /// Not a host this server relays to. The sentence is the page's.
    Refused(&'static str),
    /// A pinned address that presented another certificate.
    PinChanged,
    /// Nothing answered. Not remembered: a host that is asleep is woken and asked again.
    Unreachable,
}

impl Outcome {
    /// The page's answer when this is not a host it may reach.
    pub fn refusal(&self) -> Option<Response> {
        let say = match self {
            Outcome::Host { .. } => return None,
            Outcome::NoPlane(_) => NO_PLANE,
            Outcome::Refused(say) => say,
            Outcome::PinChanged => crate::proxy::PIN_CHANGED,
            Outcome::Unreachable => {
                let nothing = (StatusCode::GATEWAY_TIMEOUT, "Couldn't reach this host.");
                return Some(nothing.into_response());
            }
        };
        Some((StatusCode::BAD_GATEWAY, say).into_response())
    }
}

struct Entry {
    outcome: Outcome,
    until: Instant,
    used: Instant,
}

/// What each address turned out to be, while it holds.
#[derive(Default)]
pub struct Proofs(Mutex<HashMap<String, Entry>>);

impl Proofs {
    /// Whether proving `key` now would send the address its request.
    pub fn would_ask(&self, key: &str, fresh: bool) -> bool {
        let all = self.0.lock().unwrap();
        all.get(key).is_none_or(|e| {
            e.until <= Instant::now() || (fresh && matches!(e.outcome, Outcome::Host { .. }))
        })
    }

    fn recall(&self, key: &str, fresh: bool) -> Option<Outcome> {
        let mut all = self.0.lock().unwrap();
        let entry = all.get_mut(key)?;
        let stale = entry.until <= Instant::now();
        if stale || (fresh && matches!(entry.outcome, Outcome::Host { .. })) {
            return None;
        }
        entry.used = Instant::now();
        Some(entry.outcome.clone())
    }

    fn remember(&self, key: &str, outcome: &Outcome) {
        let now = Instant::now();
        let until = match outcome {
            Outcome::Host { expires, .. } => now + secs_until(*expires).min(PLANE_LIFE),
            Outcome::NoPlane(_) | Outcome::Refused(_) => now + REFUSED_FOR,
            Outcome::PinChanged | Outcome::Unreachable => return,
        };
        let mut all = self.0.lock().unwrap();
        all.retain(|_, e| e.until > now);
        let entry = Entry {
            outcome: outcome.clone(),
            until,
            used: now,
        };
        all.insert(key.to_owned(), entry);
        let host = |e: &Entry| matches!(e.outcome, Outcome::Host { .. });
        while all.values().filter(|e| host(e)).count() > KEPT {
            let oldest = all
                .iter()
                .filter(|(_, e)| host(e))
                .min_by_key(|(_, e)| e.used);
            let Some(oldest) = oldest.map(|(k, _)| k.clone()) else {
                break;
            };
            all.remove(&oldest);
        }
    }
}

/// A stranger pays the proof meter for each request proving an address they typed would send.
/// The `429` when they are over it.
pub fn over_meter(hosts: &Hosts, ext: &Extensions, key: &str, fresh: bool) -> Option<Response> {
    let stranger = ext.get::<Pass>().is_none_or(Pass::stranger);
    if !stranger || !hosts.proofs.would_ask(key, fresh) {
        return None;
    }
    let who = ext.get::<Visitor>().and_then(|v| v.addr);
    hosts
        .lanes
        .proofs
        .take(who)
        .err()
        .map(crate::origin::too_many)
}

/// The proof for `addr:port`: remembered, or fetched now under `pin`. `fresh` passes over a
/// remembered host, for the page's own plane request: a host that restarted has a new plane.
pub async fn prove(
    hosts: &Hosts,
    addr: &str,
    port: u16,
    pin: Option<[u8; 32]>,
    fresh: bool,
) -> Outcome {
    let key = format!("{addr}:{port}");
    if let Some(known) = hosts.proofs.recall(&key, fresh) {
        return known;
    }
    let outcome = fetch(addr, port, pin).await;
    match &outcome {
        Outcome::Host {
            fp,
            plane_port,
            plane_hash,
            ..
        } => {
            let plane_hash = crate::hosts::hex(plane_hash);
            tracing::info!(
                host = key,
                plane_port,
                plane_hash,
                "proven a punktfunk host"
            );
            hosts.keep(&key, *fp);
        }
        Outcome::Refused(_) | Outcome::NoPlane(_) => {
            tracing::info!(
                host = key,
                "refused an address that is not a host to relay to"
            );
        }
        Outcome::PinChanged | Outcome::Unreachable => {}
    }
    hosts.proofs.remember(&key, &outcome);
    outcome
}

/// One `GET /api/v1/webtransport` under `pin`, with nothing of a visitor's in it.
struct Answer {
    status: StatusCode,
    json: bool,
    body: Bytes,
    /// The TLS leaf the address presented.
    presented: Option<[u8; 32]>,
}

async fn ask(addr: &str, port: u16, pin: Option<[u8; 32]>) -> Result<Answer, Outcome> {
    let seen: Arc<Mutex<Option<[u8; 32]>>> = Arc::default();
    let client = crate::proxy::client(pin, seen.clone()).map_err(|e| {
        tracing::warn!(host = %addr, cause = %format!("{e:#}"), "proof client did not build");
        Outcome::Unreachable
    })?;
    let url = format!("https://{addr}:{port}/api/v1/webtransport");
    let sent = client.get(url).timeout(TIMEOUT).send().await;
    let presented = *seen.lock().unwrap();
    let mut res = match sent {
        Ok(res) => res,
        Err(_) if pin.is_some() && presented.is_some() && presented != pin => {
            return Err(Outcome::PinChanged)
        }
        Err(e) => {
            let cause = format!("{:#}", anyhow::Error::new(e));
            tracing::warn!(host = %addr, cause, "host did not answer the proof");
            return Err(Outcome::Unreachable);
        }
    };
    let json = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.starts_with("application/json"));
    let status = res.status();
    let mut body = Vec::new();
    loop {
        match res.chunk().await {
            Ok(Some(c)) if body.len() + c.len() <= MAX_BODY => body.extend_from_slice(&c),
            Ok(None) => break,
            _ => return Err(Outcome::Refused(NOT_A_HOST)),
        }
    }
    Ok(Answer {
        status,
        json,
        body: body.into(),
        presented,
    })
}

async fn fetch(addr: &str, port: u16, pin: Option<[u8; 32]>) -> Outcome {
    let a = match ask(addr, port, pin).await {
        Ok(a) => a,
        Err(outcome) => return outcome,
    };
    match a.status {
        StatusCode::OK if a.json => attested(a.body, a.presented),
        StatusCode::NOT_FOUND if a.json && host_error(&a.body) => Outcome::NoPlane(a.body),
        _ => Outcome::Refused(NOT_A_HOST),
    }
}

/// The plane a listed host publishes, as it says: the operator's list vouches for the host, so
/// no signature is asked for.
pub async fn published(addr: &str, port: u16, pin: Option<[u8; 32]>) -> Option<(u16, [u8; 32])> {
    let a = ask(addr, port, pin).await.ok()?;
    let p = (a.status == StatusCode::OK && a.json)
        .then(|| serde_json::from_slice::<Published>(&a.body).ok())??;
    Some((p.port, crate::config::parse_fp(&p.cert_hash_sha256).ok()?))
}

/// The host's error shape: `{"error": "…"}`.
fn host_error(body: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(body)
        .is_ok_and(|v| v.get("error").is_some_and(|e| e.is_string()))
}

#[derive(serde::Deserialize)]
struct Published {
    port: u16,
    cert_hash_sha256: String,
    expires_at: u64,
    cert_hash_sig: Option<String>,
    host_cert_der: Option<String>,
}

/// A host's plane, signed by the identity that `presented` the TLS leaf: anything less is not a
/// host. One without a signature has an RSA identity, which only an operator's list reaches.
fn attested(body: Bytes, presented: Option<[u8; 32]>) -> Outcome {
    let Ok(p) = serde_json::from_slice::<Published>(&body) else {
        return Outcome::Refused(NOT_A_HOST);
    };
    let (Some(sig), Some(der)) = (&p.cert_hash_sig, &p.host_cert_der) else {
        return Outcome::Refused(UNATTESTED);
    };
    let checked = || {
        let hash = crate::config::parse_fp(&p.cert_hash_sha256).ok()?;
        let sig = unhex(sig)?;
        let der = base64::engine::general_purpose::STANDARD.decode(der).ok()?;
        let fp = verify_plane_attestation(&p.cert_hash_sha256, &sig, &der).ok()?;
        (Some(fp) == presented).then_some((fp, hash))
    };
    match checked() {
        Some((fp, plane_hash)) => Outcome::Host {
            fp,
            plane_port: p.port,
            plane_hash,
            expires: p.expires_at,
            body,
        },
        None => Outcome::Refused(NOT_A_HOST),
    }
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || !s.is_ascii() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

fn secs_until(unix: u64) -> Duration {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    Duration::from_secs(unix).saturating_sub(now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_attested_expiry_is_believed_for_fourteen_days_at_most() {
        let proofs = Proofs::default();
        let host = Outcome::Host {
            fp: [1; 32],
            plane_port: 9778,
            plane_hash: [2; 32],
            expires: u64::MAX,
            body: Bytes::new(),
        };
        proofs.remember("10.0.0.2:47990", &host);
        let until = proofs.0.lock().unwrap()["10.0.0.2:47990"].until;
        assert!(until <= Instant::now() + PLANE_LIFE);
        assert!(proofs.recall("10.0.0.2:47990", false).is_some());
    }
}
