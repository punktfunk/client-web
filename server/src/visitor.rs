//! Who sent a request: an address, or none, and the class the host's own rules use for it.
//!
//! A proxy appends what it saw on the right; anything to its left could be a caller's invention.
//! So the class is the strictest of every address on offer, and an invented entry can only make
//! the visitor stricter. The address named is the right-most one that classes as the internet.

use crate::hosts::Hosts;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap};
use axum::middleware::Next;
use axum::response::Response;
use punktfunk_core::provenance::{classify_with, is_mesh_iface, KnockSource, CLIENT_ADDR_UNKNOWN};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::sync::Arc;

/// What this machine knows of its own networks. Injected, so a test can fake it.
#[derive(Clone, Copy)]
pub struct Machine {
    /// Replies to this 100.64/10 address leave through a mesh VPN's interface.
    pub over_mesh: fn(Ipv4Addr) -> bool,
    /// This address is on one of this machine's own IPv6 /64s.
    pub on_own_prefix: fn(Ipv6Addr) -> bool,
    /// Loopback: this machine talking to itself, never a host to dial for a visitor.
    pub loopback: fn(IpAddr) -> bool,
}

impl Machine {
    pub const REAL: Machine = Machine {
        over_mesh: routes_over_mesh,
        on_own_prefix,
        loopback: |ip| ip.to_canonical().is_loopback(),
    };

    /// The host's classification, plus one rule of this server's: a home network that hands out
    /// global IPv6 addresses is still at home.
    pub fn class(&self, ip: IpAddr) -> KnockSource {
        match ip.to_canonical() {
            IpAddr::V6(v6) if (self.on_own_prefix)(v6) => KnockSource::Lan,
            ip => classify_with(Some(ip), self.over_mesh),
        }
    }
}

/// A machine with no mesh VPN, no global IPv6 prefix and no loopback, so a test's loopback
/// upstream stands in for a host on the network.
#[cfg(test)]
pub const TEST: Machine = Machine {
    over_mesh: |_| false,
    on_own_prefix: |_| false,
    loopback: |_| false,
};

/// Who a request came from, found once per request and kept in its extensions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Visitor {
    /// `None`: unknown.
    pub addr: Option<IpAddr>,
    pub class: KnockSource,
}

impl Visitor {
    const UNKNOWN: Visitor = Visitor {
        addr: None,
        class: KnockSource::Wan,
    };

    /// The value of `pf-client-addr`.
    pub fn header(&self) -> String {
        self.addr
            .map_or_else(|| CLIENT_ADDR_UNKNOWN.into(), |a| a.to_string())
    }

    /// `proxied`: a proxy is in front by definition (`TLS=off`), so a request it forwarded
    /// without saying for whom names nobody.
    pub fn of(peer: Option<IpAddr>, headers: &HeaderMap, proxied: bool, m: &Machine) -> Visitor {
        let Some(forwarded) = forwarded(headers) else {
            return Visitor::UNKNOWN;
        };
        if forwarded.is_empty() && proxied {
            return Visitor::UNKNOWN;
        }
        let all: Vec<IpAddr> = forwarded.iter().copied().chain(peer).collect();
        let Some(class) = all.iter().map(|ip| m.class(*ip)).max() else {
            return Visitor::UNKNOWN;
        };
        let addr = all
            .iter()
            .rev()
            .find(|ip| m.class(**ip) == KnockSource::Wan)
            .or(forwarded.last())
            .or(peer.as_ref())
            .map(|ip| ip.to_canonical());
        Visitor { addr, class }
    }
}

/// The header a page sends its pass in. Never forwarded: the relay passes an allowlist.
pub const PASS_HEADER: &str = "pf-pass";

/// Every route: the visitor, as [`Visitor::of`] finds them, and the hosts their pass opens.
pub async fn find(
    State((hosts, proxied)): State<(Arc<Hosts>, bool)>,
    mut req: Request,
    next: Next,
) -> Response {
    let peer = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip());
    let visitor = Visitor::of(peer, req.headers(), proxied, &hosts.machine);
    let pass = req.headers().get(PASS_HEADER).and_then(|v| v.to_str().ok());
    let pass = pass
        .map(|p| hosts.lanes.passes.hosts(p))
        .unwrap_or_default();
    req.extensions_mut().insert(visitor);
    req.extensions_mut().insert(pass);
    next.run(req).await
}

/// Every address in `X-Forwarded-For` and in `Forwarded`'s `for=`, left to right. `None` when an
/// entry is not an address: an `unknown` or obfuscated hop hides who the visitor is.
fn forwarded(headers: &HeaderMap) -> Option<Vec<IpAddr>> {
    let mut out = Vec::new();
    for value in headers.get_all("x-forwarded-for") {
        for entry in value.to_str().ok()?.split(',') {
            out.push(address(entry)?);
        }
    }
    for value in headers.get_all(header::FORWARDED) {
        for pair in value.to_str().ok()?.split([',', ';']) {
            match pair.split_once('=') {
                Some((key, v)) if key.trim().eq_ignore_ascii_case("for") => out.push(address(v)?),
                _ => {}
            }
        }
    }
    Some(out)
}

/// `ip`, `ip:port`, `[v6]` or `[v6]:port`, quoted or not.
fn address(s: &str) -> Option<IpAddr> {
    let s = s.trim().trim_matches('"');
    s.parse::<IpAddr>()
        .or_else(|_| s.parse::<SocketAddr>().map(|sa| sa.ip()))
        .ok()
        .or_else(|| s.strip_prefix('[')?.strip_suffix(']')?.parse().ok())
}

/// Replies to `peer` leave through a mesh VPN's interface, which a CGNAT neighbour borrowing a
/// mesh address cannot arrange. A UDP `connect` finds the route without sending anything.
fn routes_over_mesh(peer: Ipv4Addr) -> bool {
    let Ok(src) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).and_then(|s| {
        s.connect((peer, 9))?;
        s.local_addr()
    }) else {
        return false;
    };
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .iter()
        .any(|i| i.ip() == src.ip() && is_mesh_iface(&i.name, i.ip()))
}

fn on_own_prefix(v6: Ipv6Addr) -> bool {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .iter()
        .any(|i| match i.ip() {
            IpAddr::V6(own) => !own.is_loopback() && own.segments()[..4] == v6.segments()[..4],
            IpAddr::V4(_) => false,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use KnockSource::{Lan, Wan};

    fn on_prefix(v6: Ipv6Addr) -> bool {
        v6.segments()[..4] == [0x2001, 0xdb8, 1, 2]
    }

    const MESH: Machine = Machine {
        over_mesh: |_| true,
        on_own_prefix: on_prefix,
        loopback: |_| false,
    };
    const NO_MESH: Machine = Machine {
        over_mesh: |_| false,
        on_own_prefix: on_prefix,
        loopback: |_| false,
    };
    const UNKNOWN: (Option<String>, KnockSource) = (None, Wan);

    fn visit(peer: &str, h: HeaderMap, proxied: bool, m: Machine) -> (Option<String>, KnockSource) {
        let v = Visitor::of(peer.parse().ok(), &h, proxied, &m);
        (v.addr.map(|a| a.to_string()), v.class)
    }
    /// Behind a proxy on loopback, with `TLS=off`.
    fn behind(h: HeaderMap) -> (Option<String>, KnockSource) {
        visit("127.0.0.1", h, true, NO_MESH)
    }
    fn direct(peer: &str, m: Machine) -> (Option<String>, KnockSource) {
        visit(peer, HeaderMap::new(), false, m)
    }
    fn named(addr: &str, class: KnockSource) -> (Option<String>, KnockSource) {
        (Some(addr.into()), class)
    }
    fn header(name: &'static str, value: &'static str) -> HeaderMap {
        HeaderMap::from_iter([(name.parse().unwrap(), HeaderValue::from_static(value))])
    }
    fn xff(value: &'static str) -> HeaderMap {
        header("x-forwarded-for", value)
    }

    #[test]
    fn the_visitor_is_the_strictest_address_and_the_right_most_public_one() {
        // A proxy that appends what it saw.
        assert_eq!(behind(xff("203.0.113.9")), named("203.0.113.9", Wan));
        assert_eq!(behind(xff("192.168.1.20")), named("192.168.1.20", Lan));
        let fwd = header("forwarded", "for=\"[2001:db8:9::17]:4711\";proto=https");
        assert_eq!(behind(fwd), named("2001:db8:9::17", Wan));
        // Default nginx sends nothing: behind `TLS=off` that names nobody.
        assert_eq!(behind(HeaderMap::new()), UNKNOWN);
        // No proxy: the peer.
        assert_eq!(direct("192.168.1.20", NO_MESH), named("192.168.1.20", Lan));
        assert_eq!(direct("203.0.113.9", NO_MESH), named("203.0.113.9", Wan));
        assert_eq!(
            direct("::ffff:203.0.113.9", NO_MESH),
            named("203.0.113.9", Wan)
        );
        // A caller's entry on the left only tightens, and is never named over the proxy's.
        let forged = behind(xff("192.168.1.5, 203.0.113.9"));
        assert_eq!(forged, named("203.0.113.9", Wan));
        assert_eq!(behind(xff("8.8.8.8, 192.168.1.20")), named("8.8.8.8", Wan));
        let forged = visit("203.0.113.9", xff("192.168.1.5"), false, NO_MESH);
        assert_eq!(forged, named("203.0.113.9", Wan));
        // An entry that is not an address hides the visitor.
        assert_eq!(behind(xff("unknown, 192.168.1.20")), UNKNOWN);
        assert_eq!(behind(header("forwarded", "for=_hidden")), UNKNOWN);
        // A global IPv6 address on this machine's own /64 is at home; one elsewhere is not.
        let home = "2001:db8:1:2::50";
        assert_eq!(direct(home, NO_MESH), named(home, Lan));
        let away = "2001:db8:1:3::50";
        assert_eq!(direct(away, NO_MESH), named(away, Wan));
        // 100.64/10 is at home only over a mesh VPN.
        assert_eq!(direct("100.96.0.7", MESH), named("100.96.0.7", Lan));
        assert_eq!(direct("100.96.0.7", NO_MESH), named("100.96.0.7", Wan));
        assert_eq!(Visitor::UNKNOWN.header(), "unknown");
    }
}
