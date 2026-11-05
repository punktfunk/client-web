//! The hosts this server proxies: the ones named in `PUNKTFUNK_HOSTS`, and the ones mDNS finds.
//!
//! Every host is pinned before the proxy trusts it: to the fingerprint it was listed with, the one
//! it advertises over mDNS, or the one it presented first (kept in `pins.json`). The API hop
//! carries the browser's device token, so an unpinned hop would hand that token to anyone on the
//! LAN able to answer in the host's place.

use crate::config::Listed;
use crate::lanes::Lanes;
use crate::proof::{Proofs, KEPT};
use crate::visitor::Machine;
use anyhow::{Context, Result};
use std::collections::BTreeMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

#[derive(Clone, Debug, PartialEq)]
pub struct Host {
    /// The route segment, `/h/<id>/…`.
    pub id: String,
    pub name: String,
    /// As it goes in a URL: an IPv6 address in brackets. The browser dials the plane here too.
    pub addr: String,
    pub port: u16,
    pub pin: Option<[u8; 32]>,
    /// The mDNS service that announced it; `None` for a listed host.
    pub fullname: Option<String>,
}

impl Host {
    /// First-contact pins are kept by where the host answers, not by its id: renaming the entry
    /// must not make the server trust whatever answers next.
    fn pin_key(&self) -> String {
        format!("{}:{}", self.addr, self.port)
    }
}

pub struct Hosts {
    /// Whether `/a/<address>/…` proxies a host the page names. See [`crate::config::Config`].
    pub add_hosts: bool,
    /// What this machine knows of its networks: who is at home, and which addresses are its own.
    pub machine: Machine,
    /// Which unlisted addresses are Punktfunk hosts.
    pub proofs: Proofs,
    /// Passes, and the limits strangers share.
    pub lanes: Lanes,
    list: RwLock<Vec<Host>>,
    /// Hex fingerprints by `addr:port`, least recently used first.
    pins: Mutex<Vec<(String, String)>>,
    pins_path: PathBuf,
    /// Wake-capable MACs a host announced, by where it answers. Kept in `wake.json`: a host is
    /// woken exactly when it is too asleep to announce them.
    macs: Mutex<BTreeMap<String, Vec<String>>>,
    macs_path: PathBuf,
}

impl Hosts {
    pub fn new(
        listed: Vec<Listed>,
        data: &Path,
        add_hosts: bool,
        machine: Machine,
    ) -> Result<Arc<Self>> {
        std::fs::create_dir_all(data).with_context(|| format!("create {}", data.display()))?;
        let pins_path = data.join("pins.json");
        // Only a missing file means no pins: one that cannot be read must not re-trust every host.
        let pins: BTreeMap<String, String> = match std::fs::read(&pins_path) {
            Ok(b) => serde_json::from_slice(&b)
                .with_context(|| format!("read {}", pins_path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => return Err(e).with_context(|| format!("read {}", pins_path.display())),
        };
        let macs_path = data.join("wake.json");
        let macs: BTreeMap<String, Vec<String>> = std::fs::read(&macs_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let mut list: Vec<Host> = Vec::new();
        for l in listed {
            let mut h = Host {
                id: String::new(),
                name: l.name,
                addr: l.addr,
                port: l.port,
                pin: l.pin,
                fullname: None,
            };
            if h.pin.is_none() {
                h.pin = pins
                    .get(&h.pin_key())
                    .and_then(|hex| crate::config::parse_fp(hex).ok());
            }
            h.id = unique_id(&h.name, &list);
            list.push(h);
        }
        Ok(Arc::new(Self {
            add_hosts,
            machine,
            proofs: Proofs::default(),
            lanes: Lanes::new(data),
            list: RwLock::new(list),
            pins: Mutex::new(pins.into_iter().collect()),
            pins_path,
            macs: Mutex::new(macs),
            macs_path,
        }))
    }

    /// The MACs a magic packet for this host goes to; empty when it never announced one.
    pub fn macs(&self, id: &str) -> Vec<String> {
        let Some(host) = self.get(id) else {
            return Vec::new();
        };
        self.macs
            .lock()
            .unwrap()
            .get(&host.pin_key())
            .cloned()
            .unwrap_or_default()
    }

    /// Keep what a host announced it wakes on. Only a change is written.
    fn remember_macs(&self, key: &str, macs: Vec<String>) {
        if macs.is_empty() {
            return;
        }
        let mut all = self.macs.lock().unwrap();
        if all.get(key) == Some(&macs) {
            return;
        }
        all.insert(key.to_owned(), macs);
        if let Err(e) = write_whole(
            &self.macs_path,
            &serde_json::to_vec_pretty(&*all).unwrap_or_default(),
        ) {
            tracing::warn!(error = %e, "wake.json was not written; the MACs last until restart");
        }
    }

    pub fn all(&self) -> Vec<Host> {
        self.list.read().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<Host> {
        self.list
            .read()
            .unwrap()
            .iter()
            .find(|h| h.id == id)
            .cloned()
    }

    /// The certificate a pinless host presented on first contact becomes its pin.
    pub fn learned(&self, id: &str, fp: [u8; 32]) {
        let key = {
            let mut list = self.list.write().unwrap();
            let Some(h) = list.iter_mut().find(|h| h.id == id && h.pin.is_none()) else {
                return;
            };
            h.pin = Some(fp);
            h.pin_key()
        };
        self.keep(&key, fp);
    }

    /// The pin kept for a host at `addr:port`, whoever named it.
    pub fn pin_at(&self, key: &str) -> Option<[u8; 32]> {
        let pins = self.pins.lock().unwrap();
        let (_, hex) = pins.iter().find(|(k, _)| k == key)?;
        crate::config::parse_fp(hex).ok()
    }

    /// Keep a listed host's first-contact pin, or a proven host's. An address already pinned keeps
    /// its first certificate. Unlisted addresses keep at most [`KEPT`], least recently used out.
    pub fn keep(&self, key: &str, fp: [u8; 32]) {
        let listed: Vec<String> = self
            .list
            .read()
            .unwrap()
            .iter()
            .filter(|h| h.fullname.is_none())
            .map(Host::pin_key)
            .collect();
        let mut pins = self.pins.lock().unwrap();
        if let Some(i) = pins.iter().position(|(k, _)| k == key) {
            let used = pins.remove(i);
            return pins.push(used);
        }
        tracing::info!(host = key, fingerprint = %hex(&fp), "pinned");
        pins.push((key.to_owned(), hex(&fp)));
        let unlisted = |(k, _): &&(String, String)| !listed.contains(k);
        while pins.iter().filter(unlisted).count() > KEPT {
            let Some(i) = pins.iter().position(|p| unlisted(&p)) else {
                break;
            };
            pins.remove(i);
        }
        let file: BTreeMap<_, _> = pins.iter().cloned().collect();
        if let Err(e) = write_whole(
            &self.pins_path,
            &serde_json::to_vec_pretty(&file).unwrap_or_default(),
        ) {
            tracing::warn!(error = %e, "pins.json was not written; the pin lasts until restart");
        }
    }

    /// An address this server may reach without the operator's word: on a home network, and not
    /// loopback.
    pub fn may_dial(&self, ip: IpAddr) -> bool {
        crate::proxy::home_range(ip) && !(self.machine.loopback)(ip)
    }

    /// An mDNS advert. A host already listed, by fingerprint or address, stays as listed, but
    /// what it wakes on is kept for it. Any other joins only at an address this server may dial,
    /// and only while fewer than [`FOUND`] are held. Past that a new name is refused and keeps no
    /// MACs. The hosts already held stay, and still move.
    fn found(&self, a: Advert) {
        let mut list = self.list.write().unwrap();
        if let Some(h) = list.iter().find(|h| {
            h.fullname.is_none()
                && ((a.pin.is_some() && h.pin == a.pin) || (h.addr == a.addr && h.port == a.port))
        }) {
            let key = h.pin_key();
            drop(list);
            return self.remember_macs(&key, a.macs);
        }
        if !a.addr.parse().is_ok_and(|ip| self.may_dial(ip)) {
            return tracing::debug!(addr = %a.addr, "advert at an address this server does not dial");
        }
        let held = list
            .iter()
            .position(|h| h.fullname.as_deref() == Some(&a.fullname));
        if held.is_none() && list.iter().filter(|h| h.fullname.is_some()).count() >= FOUND {
            return tracing::debug!(addr = %a.addr, "advert past the hosts kept from mDNS");
        }
        self.remember_macs(&format!("{}:{}", a.addr, a.port), a.macs.clone());
        if let Some(h) = held.map(|i| &mut list[i]) {
            (h.addr, h.port, h.pin) = (a.addr, a.port, a.pin);
            return;
        }
        let id = unique_id(&a.name, &list);
        tracing::info!(host = %id, addr = %a.addr, "found on the network");
        list.push(Host {
            id,
            name: a.name,
            addr: a.addr,
            port: a.port,
            pin: a.pin,
            fullname: Some(a.fullname),
        });
    }

    /// A host stopped announcing. One that can be woken stays listed: asleep is exactly when the
    /// page needs its card, to wake it.
    fn lost(&self, fullname: &str) {
        let macs = self.macs.lock().unwrap().clone();
        self.list
            .write()
            .unwrap()
            .retain(|h| h.fullname.as_deref() != Some(fullname) || macs.contains_key(&h.pin_key()));
    }
}

/// Hosts kept from mDNS adverts. A LAN device can announce any number of names.
const FOUND: usize = 64;

/// What a host announces, reduced to what the proxy needs.
struct Advert {
    fullname: String,
    name: String,
    addr: String,
    port: u16,
    pin: Option<[u8; 32]>,
    /// TXT `mac`: the NICs it wakes on, routed one first.
    macs: Vec<String>,
}

/// Browse `_punktfunk._udp` for as long as the server runs, the way the native clients do
/// (pf-client-core `discovery`): TXT `fp` is the pin, `mgmt` the API port, and the address is
/// core's pick among the IPv4s announced. Inside a container this sees only the host's network.
pub fn discover(hosts: Arc<Hosts>) {
    use mdns_sd::{ServiceDaemon, ServiceEvent};
    let spawned = std::thread::Builder::new().name("mdns".into()).spawn(move || {
        let daemon = match ServiceDaemon::new() {
            Ok(d) => d,
            Err(e) => return tracing::warn!(error = %e, "mDNS did not start; list hosts in PUNKTFUNK_HOSTS"),
        };
        let events = match daemon.browse("_punktfunk._udp.local.") {
            Ok(r) => r,
            Err(e) => return tracing::warn!(error = %e, "mDNS browse did not start"),
        };
        while let Ok(event) = events.recv() {
            match event {
                ServiceEvent::ServiceResolved(info) => {
                    let props = info.get_properties();
                    let val = |k: &str| props.get_property_val_str(k).unwrap_or("").to_owned();
                    let candidates: Vec<std::net::Ipv4Addr> = info.get_addresses_v4().into_iter().collect();
                    let Some(addr) = punktfunk_core::discovery::pick_host_addr(&candidates, val("addr").parse().ok())
                    else {
                        continue;
                    };
                    let fullname = info.get_fullname().to_owned();
                    hosts.found(Advert {
                        name: fullname.split('.').next().unwrap_or("host").to_owned(),
                        fullname,
                        addr: addr.to_string(),
                        port: val("mgmt").parse().unwrap_or(crate::config::MGMT_PORT),
                        pin: crate::config::parse_fp(&val("fp")).ok(),
                        macs: val("mac")
                            .split(',')
                            .map(|m| m.trim().to_owned())
                            .filter(|m| punktfunk_core::wol::parse_mac(m).is_some())
                            .collect(),
                    });
                }
                ServiceEvent::ServiceRemoved(_, fullname) => hosts.lost(&fullname),
                _ => {}
            }
        }
    });
    if let Err(e) = spawned {
        tracing::warn!(error = %e, "mDNS thread did not start");
    }
}

/// Write `path` whole or not at all: a crash mid-write leaves the old file, never half of one.
pub(crate) fn write_whole(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// A route segment from a display name: lowercase letters, digits and dashes, unique in `taken`.
fn unique_id(name: &str, taken: &[Host]) -> String {
    let mut base: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    base = base
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if base.is_empty() {
        base = "host".into();
    }
    let mut id = base.clone();
    let mut n = 2;
    while taken.iter().any(|h| h.id == id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::visitor::TEST;

    fn listed(name: &str, addr: &str) -> Listed {
        Listed {
            name: name.into(),
            addr: addr.into(),
            port: crate::config::MGMT_PORT,
            pin: None,
        }
    }

    #[test]
    fn ids_are_url_safe_and_unique() {
        let dir = std::env::temp_dir().join(format!("pf-hosts-{}", std::process::id()));
        let hosts = Hosts::new(
            vec![
                listed("Living Room PC", "10.0.0.2"),
                listed("living room pc", "10.0.0.3"),
            ],
            &dir,
            true,
            TEST,
        )
        .unwrap();
        let ids: Vec<_> = hosts.all().into_iter().map(|h| h.id).collect();
        assert_eq!(ids, ["living-room-pc", "living-room-pc-2"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn adverts_join_the_list_unless_the_host_is_already_listed() {
        let dir = std::env::temp_dir().join(format!("pf-adverts-{}", std::process::id()));
        let mut desk = listed("desk", "10.0.0.2");
        desk.pin = Some([1; 32]);
        let hosts = Hosts::new(vec![desk], &dir, true, TEST).unwrap();
        let advert = |name: &str, addr: &str, pin| Advert {
            fullname: format!("{name}._punktfunk._udp.local."),
            name: name.into(),
            addr: addr.into(),
            port: crate::config::MGMT_PORT,
            pin,
            macs: Vec::new(),
        };
        hosts.found(advert("desk-too", "10.0.0.9", Some([1; 32]))); // same fingerprint as desk
        hosts.found(advert("couch", "10.0.0.3", Some([2; 32])));
        hosts.found(advert("couch", "10.0.0.4", Some([2; 32]))); // moved
        let all = hosts.all();
        assert_eq!(all.len(), 2);
        assert_eq!(
            (all[1].id.as_str(), all[1].addr.as_str()),
            ("couch", "10.0.0.4")
        );
        hosts.lost("couch._punktfunk._udp.local.");
        assert_eq!(hosts.all().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_advert_at_loopback_or_off_the_home_network_is_ignored() {
        let dir = std::env::temp_dir().join(format!("pf-self-adverts-{}", std::process::id()));
        let hosts = Hosts::new(Vec::new(), &dir, true, Machine::REAL).unwrap();
        for (name, addr) in [
            ("loop", "127.0.0.1"),
            ("far", "203.0.113.5"),
            ("couch", "10.0.0.3"),
        ] {
            hosts.found(Advert {
                fullname: format!("{name}._punktfunk._udp.local."),
                name: name.into(),
                addr: addr.into(),
                port: crate::config::MGMT_PORT,
                pin: None,
                macs: Vec::new(),
            });
        }
        let ids: Vec<_> = hosts.all().into_iter().map(|h| h.id).collect();
        assert_eq!(ids, ["couch"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn adverts_past_the_cap_are_refused_and_the_held_ones_stay() {
        let dir = std::env::temp_dir().join(format!("pf-advert-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let hosts = Hosts::new(Vec::new(), &dir, true, TEST).unwrap();
        let advert = |i: usize, addr: String| Advert {
            fullname: format!("h{i}._punktfunk._udp.local."),
            name: format!("h{i}"),
            addr,
            port: crate::config::MGMT_PORT,
            pin: None,
            macs: vec![format!("aa:bb:cc:dd:ee:{:02x}", i % 256)],
        };
        for i in 0..=FOUND {
            hosts.found(advert(i, format!("10.2.0.{i}")));
        }
        let all = hosts.all();
        assert_eq!(all.len(), FOUND);
        assert!(all.iter().all(|h| h.id != format!("h{FOUND}")));
        let macs = hosts.macs.lock().unwrap().len();
        assert_eq!(macs, FOUND, "a refused advert keeps no MACs");
        // One already held still moves.
        hosts.found(advert(0, "10.2.1.0".into()));
        assert_eq!(hosts.get("h0").unwrap().addr, "10.2.1.0");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unlisted_pins_keep_the_most_recent_64() {
        let dir = std::env::temp_dir().join(format!("pf-pin-cap-{}", std::process::id()));
        let hosts = Hosts::new(vec![listed("desk", "10.0.0.2")], &dir, true, TEST).unwrap();
        hosts.learned("desk", [1; 32]);
        for i in 0..=KEPT {
            hosts.keep(&format!("10.1.0.{i}:47990"), [2; 32]);
            if i == 1 {
                // Used again: the first is now the least recently used.
                hosts.keep("10.1.0.0:47990", [2; 32]);
            }
        }
        assert_eq!(hosts.pin_at("10.1.0.1:47990"), None);
        assert!(hosts.pin_at("10.1.0.0:47990").is_some());
        assert!(hosts.pin_at(&format!("10.1.0.{KEPT}:47990")).is_some());
        let again = Hosts::new(vec![listed("desk", "10.0.0.2")], &dir, true, TEST).unwrap();
        assert_eq!(again.get("desk").unwrap().pin, Some([1; 32]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_first_contact_pin_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("pf-pins-{}", std::process::id()));
        let hosts = Hosts::new(vec![listed("desk", "10.0.0.2")], &dir, true, TEST).unwrap();
        hosts.learned("desk", [7; 32]);
        hosts.learned("desk", [9; 32]); // a second certificate does not replace the first
        let again = Hosts::new(vec![listed("desk", "10.0.0.2")], &dir, true, TEST).unwrap();
        assert_eq!(again.get("desk").unwrap().pin, Some([7; 32]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_host_that_can_be_woken_outlives_its_advert() {
        let dir = std::env::temp_dir().join(format!("pf-wake-{}", std::process::id()));
        let hosts = Hosts::new(vec![listed("desk", "10.0.0.2")], &dir, true, TEST).unwrap();
        let advert = |name: &str, addr: &str, macs: &[&str]| Advert {
            fullname: format!("{name}._punktfunk._udp.local."),
            name: name.into(),
            addr: addr.into(),
            port: crate::config::MGMT_PORT,
            pin: None,
            macs: macs.iter().map(|m| (*m).to_owned()).collect(),
        };
        // A listed host keeps its entry but learns what it wakes on.
        hosts.found(advert("desk", "10.0.0.2", &["aa:bb:cc:dd:ee:01"]));
        hosts.found(advert("couch", "10.0.0.3", &["aa:bb:cc:dd:ee:02"]));
        hosts.found(advert("attic", "10.0.0.4", &[]));
        assert_eq!(hosts.macs("desk"), ["aa:bb:cc:dd:ee:01"]);

        // Asleep: the advert goes, the wakeable one stays listed.
        hosts.lost("couch._punktfunk._udp.local.");
        hosts.lost("attic._punktfunk._udp.local.");
        let ids: Vec<_> = hosts.all().into_iter().map(|h| h.id).collect();
        assert_eq!(ids, ["desk", "couch"]);

        // And its MACs survive a restart of this server.
        let again = Hosts::new(vec![listed("desk", "10.0.0.2")], &dir, true, TEST).unwrap();
        assert_eq!(again.macs("desk"), ["aa:bb:cc:dd:ee:01"]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
