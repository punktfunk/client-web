//! The hosts this server proxies: the ones named in `PUNKTFUNK_HOSTS`, and the ones mDNS finds.
//!
//! Every host is pinned before the proxy trusts it: to the fingerprint it was listed with, the one
//! it advertises over mDNS, or the one it presented first (kept in `pins.json`). The API hop
//! carries the browser's device token, so an unpinned hop would hand that token to anyone on the
//! LAN able to answer in the host's place.

use crate::config::Listed;
use anyhow::{Context, Result};
use std::collections::BTreeMap;
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
    list: RwLock<Vec<Host>>,
    pins: Mutex<BTreeMap<String, String>>,
    pins_path: PathBuf,
}

impl Hosts {
    pub fn new(listed: Vec<Listed>, data: &Path) -> Result<Arc<Self>> {
        std::fs::create_dir_all(data).with_context(|| format!("create {}", data.display()))?;
        let pins_path = data.join("pins.json");
        let pins: BTreeMap<String, String> = match std::fs::read(&pins_path) {
            Ok(b) => serde_json::from_slice(&b)
                .with_context(|| format!("read {}", pins_path.display()))?,
            Err(_) => BTreeMap::new(),
        };
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
            list: RwLock::new(list),
            pins: Mutex::new(pins),
            pins_path,
        }))
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
        tracing::info!(host = id, fingerprint = %hex(&fp), "pinned on first contact");
        let mut pins = self.pins.lock().unwrap();
        pins.insert(key, hex(&fp));
        if let Err(e) = std::fs::write(
            &self.pins_path,
            serde_json::to_vec_pretty(&*pins).unwrap_or_default(),
        ) {
            tracing::warn!(error = %e, "pins.json was not written; the pin lasts until restart");
        }
    }

    /// An mDNS advert. A host already listed, by fingerprint or address, stays as listed.
    fn found(&self, a: Advert) {
        let mut list = self.list.write().unwrap();
        if list.iter().any(|h| {
            h.fullname.is_none()
                && ((a.pin.is_some() && h.pin == a.pin) || (h.addr == a.addr && h.port == a.port))
        }) {
            return;
        }
        if let Some(h) = list
            .iter_mut()
            .find(|h| h.fullname.as_deref() == Some(&a.fullname))
        {
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

    fn lost(&self, fullname: &str) {
        self.list
            .write()
            .unwrap()
            .retain(|h| h.fullname.as_deref() != Some(fullname));
    }
}

/// What a host announces, reduced to what the proxy needs.
struct Advert {
    fullname: String,
    name: String,
    addr: String,
    port: u16,
    pin: Option<[u8; 32]>,
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
        let hosts = Hosts::new(vec![desk], &dir).unwrap();
        let advert = |name: &str, addr: &str, pin| Advert {
            fullname: format!("{name}._punktfunk._udp.local."),
            name: name.into(),
            addr: addr.into(),
            port: crate::config::MGMT_PORT,
            pin,
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
    fn a_first_contact_pin_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("pf-pins-{}", std::process::id()));
        let hosts = Hosts::new(vec![listed("desk", "10.0.0.2")], &dir).unwrap();
        hosts.learned("desk", [7; 32]);
        hosts.learned("desk", [9; 32]); // a second certificate does not replace the first
        let again = Hosts::new(vec![listed("desk", "10.0.0.2")], &dir).unwrap();
        assert_eq!(again.get("desk").unwrap().pin, Some([7; 32]));
        let _ = std::fs::remove_dir_all(dir);
    }
}
