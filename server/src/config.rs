//! What the server is told. All of it comes from the environment, which is where compose puts it.

use anyhow::{bail, Context, Result};
use std::net::SocketAddr;
use std::path::PathBuf;

/// The default management port, as the host and every client assume it.
pub const MGMT_PORT: u16 = 47990;

pub struct Config {
    pub listen: SocketAddr,
    pub tls: Tls,
    /// Names the self-signed certificate is issued for, beyond `localhost`.
    pub tls_names: Vec<String>,
    pub hosts: Vec<Listed>,
    /// Browse mDNS for hosts. Needs the container on the host's network to see anything.
    pub discover: bool,
    /// The built client (`apps/web/dist`).
    pub dist: PathBuf,
    /// Where pins and the self-signed certificate live across restarts.
    pub data: PathBuf,
}

pub enum Tls {
    /// A certificate minted here: the browser warns once per device.
    SelfSigned,
    /// Plain HTTP, for a reverse proxy or `tailscale serve` in front that does TLS.
    Off,
    Files {
        cert: PathBuf,
        key: PathBuf,
    },
}

/// A host named in `PUNKTFUNK_HOSTS`.
#[derive(Clone, Debug, PartialEq)]
pub struct Listed {
    pub name: String,
    /// As it goes in a URL: an IPv6 address in brackets.
    pub addr: String,
    pub port: u16,
    pub pin: Option<[u8; 32]>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Self::from_lookup(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
    }

    fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let tls = match get("TLS").as_deref().map(str::trim) {
            None | Some("self-signed") => Tls::SelfSigned,
            Some("off") => Tls::Off,
            Some(files) => {
                let (cert, key) = files
                    .split_once(',')
                    .context("TLS is self-signed, off, or <cert.pem>,<key.pem>")?;
                Tls::Files {
                    cert: cert.trim().into(),
                    key: key.trim().into(),
                }
            }
        };
        let listen = get("LISTEN").unwrap_or_else(|| "0.0.0.0:8443".into());
        Ok(Self {
            listen: listen.parse().with_context(|| format!("LISTEN {listen}"))?,
            tls,
            tls_names: list(get("TLS_NAMES")),
            hosts: parse_hosts(&get("PUNKTFUNK_HOSTS").unwrap_or_default())?,
            discover: get("DISCOVER").as_deref() != Some("0"),
            dist: get("DIST_DIR").unwrap_or_else(|| "dist".into()).into(),
            data: get("DATA_DIR").unwrap_or_else(|| "data".into()).into(),
        })
    }
}

fn list(v: Option<String>) -> Vec<String> {
    v.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `desk=192.168.1.21, couch=couch.lan:47991#<sha256 hex>, lab=[fd00::5]`.
pub fn parse_hosts(spec: &str) -> Result<Vec<Listed>> {
    list(Some(spec.into()))
        .iter()
        .map(|e| parse_host(e))
        .collect()
}

fn parse_host(entry: &str) -> Result<Listed> {
    let (name, rest) = entry
        .split_once('=')
        .with_context(|| format!("PUNKTFUNK_HOSTS entry {entry:?} is not name=address"))?;
    let (target, pin) = match rest.split_once('#') {
        Some((t, fp)) => (
            t,
            Some(parse_fp(fp.trim()).with_context(|| format!("fingerprint of {name}"))?),
        ),
        None => (rest, None),
    };
    let target = target.trim();
    let (addr, port) = if let Some(v6) = target.strip_prefix('[') {
        let (ip, tail) = v6
            .split_once(']')
            .with_context(|| format!("{target:?} has no closing ]"))?;
        (format!("[{ip}]"), tail.strip_prefix(':'))
    } else {
        match target.rsplit_once(':') {
            Some((a, p)) => (a.to_owned(), Some(p)),
            None => (target.to_owned(), None),
        }
    };
    let port = match port {
        Some(p) => p.parse().with_context(|| format!("port of {name}"))?,
        None => MGMT_PORT,
    };
    if name.trim().is_empty() || addr.is_empty() {
        bail!("PUNKTFUNK_HOSTS entry {entry:?} needs both a name and an address");
    }
    Ok(Listed {
        name: name.trim().into(),
        addr,
        port,
        pin,
    })
}

/// A certificate fingerprint as the console shows it: 64 hex digits, colons allowed.
pub fn parse_fp(s: &str) -> Result<[u8; 32]> {
    let hex: String = s.chars().filter(|c| *c != ':').collect();
    if hex.len() != 64 {
        bail!("a fingerprint is 64 hex digits");
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).context("a fingerprint is hex")?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_parse_with_ports_ipv6_and_pins() {
        let fp = "ab".repeat(32);
        let got = parse_hosts(&format!(
            "desk=192.168.1.21, couch=couch.lan:47991#{fp}, lab=[fd00::5]"
        ))
        .unwrap();
        assert_eq!(
            got[0],
            Listed {
                name: "desk".into(),
                addr: "192.168.1.21".into(),
                port: 47990,
                pin: None
            }
        );
        assert_eq!(got[1].addr, "couch.lan");
        assert_eq!(got[1].port, 47991);
        assert_eq!(got[1].pin, Some([0xab; 32]));
        assert_eq!(got[2].addr, "[fd00::5]");
        assert_eq!(got[2].port, 47990);
        assert!(parse_hosts("nameless").is_err());
        assert!(parse_hosts("desk=1.2.3.4#abc").is_err());
    }

    #[test]
    fn defaults_serve_self_signed_on_8443() {
        let c = Config::from_lookup(|_| None).unwrap();
        assert_eq!(c.listen.port(), 8443);
        assert!(matches!(c.tls, Tls::SelfSigned));
        assert!(c.discover && c.hosts.is_empty());
        let off = Config::from_lookup(|k| (k == "TLS").then(|| "off".into())).unwrap();
        assert!(matches!(off.tls, Tls::Off));
    }
}
