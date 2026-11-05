//! Who uses this server, and who only knocks at it.
//!
//! A pass is a secret this server gives a browser that proved itself to a host with a device
//! token. It opens nothing on a host. Here it lifts the limits a stranger meets for that host:
//! the meter, the pairing pool, the short `config.json`, no wake.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// A pass holds for 30 days after it was last proven to a host.
const PASS_LIFE: u64 = 30 * 24 * 60 * 60;
/// Passes kept; the least recently proven goes first.
const PASSES: usize = 256;
/// Bridge sessions for browsers with a pass for the host.
pub const PAIRED: usize = 12;
/// Bridge sessions for strangers. The host keeps 4 pending knocks per address, so a relay can
/// never push a real knock out of its queue.
const PAIRING: usize = 4;
/// A pairing session's longest life: the host parks a knock for 180 s.
pub const PAIRING_LIFE: Duration = Duration::from_secs(180);

/// The hosts a request's pass was proven to, by identity fingerprint. Empty: a stranger.
#[derive(Clone, Default)]
pub struct Pass(pub Arc<[[u8; 32]]>);

impl Pass {
    pub fn stranger(&self) -> bool {
        self.0.is_empty()
    }

    /// A pass for the host whose identity is `fp`.
    pub fn covers(&self, fp: Option<[u8; 32]>) -> bool {
        fp.is_some_and(|fp| self.0.contains(&fp))
    }
}

/// What `passes.json` keeps of a pass: never the pass, only its SHA-256.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Record {
    hash: String,
    hosts: Vec<String>,
    /// Unix seconds.
    proven: u64,
}

pub struct Passes {
    path: PathBuf,
    all: Mutex<Vec<Record>>,
}

impl Passes {
    pub fn load(data: &Path) -> Passes {
        let path = data.join("passes.json");
        let all = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Passes {
            path,
            all: Mutex::new(all),
        }
    }

    /// The hosts `pass` was proven to, while it holds. Empty for one this server never gave.
    pub fn hosts(&self, pass: &str) -> Pass {
        let all = self.all.lock().unwrap();
        let held = digest(pass).and_then(|h| all.iter().find(|r| r.hash == h));
        let hosts = held
            .filter(|r| now() < r.proven + PASS_LIFE)
            .map(|r| r.hosts.iter().filter_map(|h| parse(h)).collect())
            .unwrap_or_default();
        Pass(hosts)
    }

    /// `pass` proven to the host `fp` again, or a new pass when it is not one of this server's.
    pub fn prove(&self, pass: Option<&str>, fp: [u8; 32]) -> String {
        let mut all = self.all.lock().unwrap();
        let (now, host) = (now(), crate::hosts::hex(&fp));
        all.retain(|r| now < r.proven + PASS_LIFE);
        let held = pass.and_then(|p| Some((p, digest(p)?)));
        let held = held.and_then(|(p, h)| Some((p, all.iter().position(|r| r.hash == h)?)));
        let (pass, mut record) = match held {
            Some((p, i)) => (p.to_owned(), all.remove(i)),
            None => {
                let mut fresh = [0u8; 32];
                getrandom::fill(&mut fresh).expect("the system has randomness");
                let pass = crate::hosts::hex(&fresh);
                let hash = digest(&pass).expect("a pass this server made");
                let record = Record {
                    hash,
                    hosts: Vec::new(),
                    proven: now,
                };
                (pass, record)
            }
        };
        if !record.hosts.contains(&host) {
            record.hosts.push(host);
        }
        record.proven = now;
        all.push(record);
        if all.len() > PASSES {
            all.remove(0);
        }
        let json = serde_json::to_vec_pretty(&*all).unwrap_or_default();
        if let Err(e) = crate::hosts::write_whole(&self.path, &json) {
            tracing::warn!(error = %e, "passes.json was not written; the pass lasts until restart");
        }
        pass
    }
}

/// A pass is 64 hex digits; what is kept is the hex of its SHA-256.
fn digest(pass: &str) -> Option<String> {
    use sha2::Digest as _;
    let bytes = parse(pass)?;
    Some(crate::hosts::hex(&sha2::Sha256::digest(bytes)))
}

fn parse(hex: &str) -> Option<[u8; 32]> {
    crate::config::parse_fp(hex).ok()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// `n` requests a `per`, refilled evenly.
#[derive(Clone, Copy)]
struct Rate {
    n: f64,
    per: Duration,
}

#[derive(Clone, Copy)]
struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn full(rate: Rate, now: Instant) -> Bucket {
        Bucket {
            tokens: rate.n,
            at: now,
        }
    }

    fn refill(&mut self, rate: Rate, now: Instant) {
        let gained = now.duration_since(self.at).as_secs_f64() * rate.n / rate.per.as_secs_f64();
        self.tokens = (self.tokens + gained).min(rate.n);
        self.at = now;
    }

    /// How long until one token is back.
    fn wait(&self, rate: Rate) -> Duration {
        rate.per.mul_f64(((1.0 - self.tokens) / rate.n).max(0.0))
    }
}

/// Addresses a meter tracks. Past this, a new one shares the unknown visitors' bucket.
const KEYS: usize = 4096;
/// How often a full meter forgets the addresses whose buckets have refilled.
const SWEEP: Duration = Duration::from_secs(1);

/// The key a per-address limit counts under. One IPv6 subscriber holds a whole /64.
pub fn subscriber(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V6(v6) => IpAddr::V6((u128::from(v6) & !u128::from(u64::MAX)).into()),
        v4 => v4,
    }
}

/// A token bucket per visitor address, and one for all of them. Unknown visitors share a key.
pub struct Meter {
    each: Rate,
    all: Rate,
    buckets: Mutex<Buckets>,
}

#[derive(Default)]
struct Buckets {
    each: HashMap<Option<IpAddr>, Bucket>,
    all: Option<Bucket>,
    swept: Option<Instant>,
}
/// The addresses with a pairing session open.
type Pairing = Arc<Mutex<HashSet<Option<IpAddr>>>>;

impl Meter {
    fn new(each: u32, all: u32, per: Duration) -> Meter {
        let rate = |n| Rate {
            n: f64::from(n),
            per,
        };
        Meter {
            each: rate(each),
            all: rate(all),
            buckets: Mutex::default(),
        }
    }

    /// One request from `who`, or how long until there is room for it.
    pub fn take(&self, who: Option<IpAddr>) -> Result<(), Duration> {
        self.take_at(who, Instant::now())
    }

    fn take_at(&self, who: Option<IpAddr>, now: Instant) -> Result<(), Duration> {
        let mut guard = self.buckets.lock().unwrap();
        let b = &mut *guard;
        let (e, a) = (self.each, self.all);
        let due = b.swept.is_none_or(|t| now.duration_since(t) >= SWEEP);
        if b.each.len() >= KEYS && due {
            b.swept = Some(now);
            b.each.retain(|_, b| {
                b.refill(e, now);
                b.tokens < e.n
            });
        }
        let who = who.map(subscriber);
        let who = match b.each.len() >= KEYS && !b.each.contains_key(&who) {
            true => None,
            false => who,
        };
        let mine = b.each.entry(who).or_insert(Bucket::full(e, now));
        let all = b.all.get_or_insert(Bucket::full(a, now));
        mine.refill(e, now);
        all.refill(a, now);
        if mine.tokens < 1.0 || all.tokens < 1.0 {
            return Err(mine.wait(e).max(all.wait(a)));
        }
        mine.tokens -= 1.0;
        all.tokens -= 1.0;
        Ok(())
    }
}

/// The bridge's two pools.
pub struct Pools {
    paired: Arc<Semaphore>,
    pairing: Arc<Semaphore>,
    pairing_at: Pairing,
    /// 20 pairing sessions an hour, for everyone together.
    starts: Meter,
}

/// A bridge session's place in its pool, given back when the session ends.
pub struct Slot {
    _permit: OwnedSemaphorePermit,
    pairing: Option<(Pairing, Option<IpAddr>)>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        if let Some((at, who)) = &self.pairing {
            at.lock().unwrap().remove(who);
        }
    }
}

const PAIRED_FULL: &str =
    "this page is carrying as many streams as it can. Try again in a few minutes";
pub const PAIRING_FULL: &str =
    "too many browsers are pairing through this page right now. Try again in a few minutes";
const PAIRING_HERE: &str =
    "a browser at this address is already pairing through this page. Try again when it's done";
pub const PAIRING_HOURLY: &str =
    "this page has taken all the pairing requests it allows for this hour. Try again later";

impl Pools {
    /// A slot in the paired pool, or the page's sentence.
    pub fn paired(&self) -> Result<Slot, &'static str> {
        let permit = self.paired.clone().try_acquire_owned();
        let permit = permit.map_err(|_| PAIRED_FULL)?;
        Ok(Slot {
            _permit: permit,
            pairing: None,
        })
    }

    /// A slot in the pairing pool for a stranger at `who`, or the page's sentence.
    pub fn pairing(&self, who: Option<IpAddr>) -> Result<Slot, &'static str> {
        let who = who.map(subscriber);
        let mut at = self.pairing_at.lock().unwrap();
        if at.contains(&who) {
            return Err(PAIRING_HERE);
        }
        let permit = self.pairing.clone().try_acquire_owned();
        let permit = permit.map_err(|_| PAIRING_FULL)?;
        self.starts.take(None).map_err(|_| PAIRING_HOURLY)?;
        at.insert(who);
        Ok(Slot {
            _permit: permit,
            pairing: Some((self.pairing_at.clone(), who)),
        })
    }
}

/// The limits strangers share, and the passes that lift them.
pub struct Lanes {
    pub passes: Passes,
    /// Every non-static request, and every refusal, from a stranger.
    pub strangers: Meter,
    /// Proving an address a stranger typed.
    pub proofs: Meter,
    pub pools: Pools,
}

impl Lanes {
    pub fn new(data: &Path) -> Lanes {
        const MINUTE: Duration = Duration::from_secs(60);
        const HOUR: Duration = Duration::from_secs(3600);
        // 6 a minute each, 30 an hour together: the hourly bucket refills at 0.5 a minute.
        let mut proofs = Meter::new(6, 30, MINUTE);
        proofs.all = Rate { n: 30.0, per: HOUR };
        Lanes {
            passes: Passes::load(data),
            strangers: Meter::new(30, 300, MINUTE),
            proofs,
            pools: Pools {
                paired: Arc::new(Semaphore::new(PAIRED)),
                pairing: Arc::new(Semaphore::new(PAIRING)),
                pairing_at: Arc::default(),
                starts: Meter::new(20, 20, HOUR),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pass_holds_for_its_hosts_until_it_lapses_and_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("pf-passes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let passes = Passes::load(&dir);
        let pass = passes.prove(None, [1; 32]);
        assert!(passes.hosts(&pass).covers(Some([1; 32])));
        assert!(!passes.hosts(&pass).covers(Some([2; 32])));
        // Extended, not replaced.
        assert_eq!(passes.prove(Some(&pass), [2; 32]), pass);
        // A forged pass, or one this server made for someone else, is a stranger's.
        assert!(passes.hosts(&"ab".repeat(32)).stranger());
        assert!(passes.hosts("not hex").stranger());
        assert_ne!(
            passes.prove(Some(&"ab".repeat(32)), [1; 32]),
            "ab".repeat(32)
        );

        let again = Passes::load(&dir);
        assert!(again.hosts(&pass).covers(Some([2; 32])));
        let kept = std::fs::read_to_string(dir.join("passes.json")).unwrap();
        assert!(!kept.contains(&pass), "the pass itself is never written");

        again.all.lock().unwrap()[0].proven = now() - PASS_LIFE;
        assert!(again.hosts(&pass).stranger(), "lapsed");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_meter_refuses_then_refills() {
        let meter = Meter::new(30, 300, Duration::from_secs(60));
        let (t0, me, you) = (Instant::now(), Some([10, 0, 0, 1].into()), None);
        for _ in 0..30 {
            meter.take_at(me, t0).unwrap();
        }
        let wait = meter.take_at(me, t0).unwrap_err();
        assert_eq!(wait, Duration::from_secs(2));
        meter.take_at(you, t0).unwrap();
        meter.take_at(me, t0 + Duration::from_secs(2)).unwrap();
        // All strangers together.
        let all = Meter::new(30, 300, Duration::from_secs(60));
        for i in 0..300u32 {
            all.take_at(Some(IpAddr::from(i.to_be_bytes())), t0)
                .unwrap();
        }
        assert!(all.take_at(Some([10, 9, 9, 9].into()), t0).is_err());

        // One /64 is one subscriber.
        let v6 = Meter::new(30, 300, Duration::from_secs(60));
        for i in 0..30u16 {
            let ip = std::net::Ipv6Addr::new(0x2001, 0xdb8, 0, 1, i, i, i, i);
            v6.take_at(Some(ip.into()), t0).unwrap();
        }
        let next = std::net::Ipv6Addr::new(0x2001, 0xdb8, 0, 1, 9, 9, 9, 99);
        assert!(v6.take_at(Some(next.into()), t0).is_err());
        let other = std::net::Ipv6Addr::new(0x2001, 0xdb8, 0, 2, 0, 0, 0, 1);
        v6.take_at(Some(other.into()), t0).unwrap();
    }

    #[test]
    fn a_full_meter_shares_one_bucket_among_new_addresses() {
        let meter = Meter::new(2, 1 << 20, Duration::from_secs(60));
        let t0 = Instant::now();
        let at = |i: u32| Some(IpAddr::from(i.to_be_bytes()));
        for i in 1..=KEYS as u32 {
            meter.take_at(at(i), t0).unwrap();
        }
        // Full, and nothing has refilled: two newcomers share the unknown visitors' two.
        let new = KEYS as u32 + 1;
        meter.take_at(at(new), t0).unwrap();
        meter.take_at(at(new + 1), t0).unwrap();
        assert!(meter.take_at(at(new + 2), t0).is_err());
        assert!(meter.buckets.lock().unwrap().each.len() <= KEYS + 1);
        // A minute on, the sweep forgets the refilled ones and a newcomer has its own again.
        let later = t0 + Duration::from_secs(60);
        meter.take_at(at(new + 3), later).unwrap();
        meter.take_at(at(new + 3), later).unwrap();
        assert!(meter.buckets.lock().unwrap().each.len() < 8);
    }

    #[test]
    fn the_pairing_pool_holds_four_one_per_address_twenty_an_hour() {
        let lanes = Lanes::new(&std::env::temp_dir());
        let at = |i: u8| Some(IpAddr::from([10, 0, 0, i]));
        let held: Vec<_> = (0..4)
            .map(|i| lanes.pools.pairing(at(i)).unwrap())
            .collect();
        assert_eq!(lanes.pools.pairing(at(9)).err(), Some(PAIRING_FULL));
        drop(held);
        let one = lanes.pools.pairing(at(1)).unwrap();
        assert_eq!(lanes.pools.pairing(at(1)).err(), Some(PAIRING_HERE));
        drop(one);
        let v6 = |i: u16| Some(IpAddr::from([0x2001, 0xdb8, 0, 1, 0, 0, 0, i]));
        let one = lanes.pools.pairing(v6(1)).unwrap();
        assert_eq!(
            lanes.pools.pairing(v6(2)).err(),
            Some(PAIRING_HERE),
            "one /64"
        );
        drop(one);
        for i in 7..21 {
            drop(lanes.pools.pairing(at(i)).unwrap());
        }
        assert_eq!(lanes.pools.pairing(at(30)).err(), Some(PAIRING_HOURLY));
        let paired: Vec<_> = (0..PAIRED).map(|_| lanes.pools.paired().unwrap()).collect();
        assert_eq!(lanes.pools.paired().err(), Some(PAIRED_FULL));
        drop(paired);
    }
}
