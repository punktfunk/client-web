//! Automatic bitrate on the page: core's driver, fed through `punktfunk_core::abr::feed` the
//! way the native pump feeds it. The session calls in at four points: the Welcome builds an
//! [`Abr`], each access unit and each control frame it reads goes in, and each pump ticks it.
//!
//! No clock handshake runs in a browser and the page asks for no probe burst, so loss, the
//! session's counters and the host's acks drive it.

use punktfunk_core::abr::feed::{Facts, Feed, Inputs};
use punktfunk_core::abr::Action;
use punktfunk_core::audio::{plan_audio_budget, AudioLayout, AudioTier};
use punktfunk_core::config::Mode;
use punktfunk_core::hud::RateCut;
use punktfunk_core::packet::USER_FLAG_REPEAT;
use punktfunk_core::quic::v2::msg::V2Message;
use punktfunk_core::quic::{
    AckReason, BitrateChanged, HostLink, HostTiming, LinkFacts, Welcome, HOST_CAP2_RAMP,
    HOST_CAP2_REPEAT_MARK, HOST_CAP_AUDIO_RED,
};
use punktfunk_core::session::Session;
use std::time::Instant;

/// Host timings held between two ticks, the native plane's bound.
const HOST_TIMINGS: usize = 512;

/// What the session read since the last tick.
#[derive(Default)]
struct Since {
    acks: Vec<(u32, Option<AckReason>)>,
    mode: Option<Mode>,
    /// `(sum µs, samples)`: the page's arrival → decoded, and the host's encode share.
    decode_lat: (u64, u32),
    encode_lat: (u64, u32),
    host_timings: Vec<HostTiming>,
    keyframe_asks: u32,
}

impl Since {
    /// One `BitrateChanged` body. One that does not parse is skipped.
    fn on_ack(&mut self, body: &[u8]) {
        if let Ok(ack) = BitrateChanged::from_body(body) {
            self.acks.push((ack.bitrate_kbps, ack.reason));
        }
    }
}

/// One session's driver, and what it has heard since its last tick.
pub struct Abr {
    feed: Feed,
    since: Since,
    /// The ring's drops before this session: the driver counts the session's own.
    drops_at_start: u64,
    /// What the overlay shows as of the last closed window: the rate, and why it was last cut
    /// (a `RateCut` code, `0` none).
    pub target_kbps: u32,
    pub rate_cut: u8,
}

impl Abr {
    /// `bitrate_kbps` is what `Hello` asked for, `0` Automatic; `ring_drops` the ring's count now.
    pub fn new(welcome: &Welcome, bitrate_kbps: u32, ring_drops: u64) -> Abr {
        let m = welcome.mode;
        let facts = Facts {
            bitrate_kbps,
            resolved_bitrate_kbps: welcome.bitrate_kbps,
            codec: welcome.codec,
            bit_depth: welcome.bit_depth,
            chroma_format: welcome.chroma_format,
            refresh_hz: m.refresh_hz,
            stream_cap_kbps: punktfunk_core::abr::stream_ceiling_kbps(
                m.width,
                m.height,
                m.refresh_hz,
                welcome.codec,
                welcome.bit_depth,
                welcome.chroma_format,
            ),
            // The page decodes no PyroWave.
            pyrowave_floor_kbps: None,
            // The page takes Opus only, so the reservation is Opus's default tier.
            audio_reserved_kbps: plan_audio_budget(
                welcome.bitrate_kbps,
                welcome.audio_channels,
                AudioLayout::from_wire(welcome.audio_layout).unwrap_or_default(),
                AudioTier::default(),
                welcome.host_caps & HOST_CAP_AUDIO_RED != 0,
            )
            .kbps,
            marks_repeats: welcome.host_caps2 & HOST_CAP2_REPEAT_MARK != 0,
            serves_ramp: welcome.host_caps2 & HOST_CAP2_RAMP != 0,
            probe_only: false,
        };
        let feed = Feed::new(
            facts,
            HostLink::default(),
            LinkFacts::default(),
            Instant::now(),
        );
        Abr {
            feed,
            since: Since::default(),
            drops_at_start: ring_drops,
            target_kbps: 0,
            rate_cut: 0,
        }
    }

    pub fn on_ack(&mut self, body: &[u8]) {
        self.since.on_ack(body);
    }

    /// The host accepted a new mode.
    pub fn on_mode(&mut self, mode: Mode) {
        self.since.mode = Some(mode);
    }

    /// One access unit for the decoder. A repeat is the host's idle keepalive, not content.
    pub fn on_au(&mut self, flags: u32) {
        self.feed.driver.on_au(flags & USER_FLAG_REPEAT != 0);
    }

    /// One frame's arrival → decoded time.
    pub fn on_decode_us(&mut self, us: u64) {
        let d = &mut self.since.decode_lat;
        (d.0, d.1) = (d.0 + us, d.1 + 1);
    }

    pub fn on_host_timing(&mut self, t: &HostTiming) {
        let s = &mut self.since;
        if let Some(st) = &t.stages {
            s.encode_lat = (s.encode_lat.0 + u64::from(st.encode_us), s.encode_lat.1 + 1);
        }
        if s.host_timings.len() < HOST_TIMINGS {
            s.host_timings.push(*t);
        }
    }

    /// A recovery keyframe ask went out.
    pub fn on_keyframe_ask(&mut self) {
        self.since.keyframe_asks += 1;
    }

    /// Tick the driver with what was read since the last pump, and send what it asks for.
    /// `send` writes a `SetBitrate` and says whether the control stream took it.
    pub fn tick(&mut self, session: &mut Session, ring_drops: u64, send: impl FnMut(u32) -> bool) {
        let s = std::mem::take(&mut self.since);
        let tick = self.feed.tick(Inputs {
            // No clock offset: the driver reads no one-way delay. The shard delays are drained
            // anyway, to stay bounded.
            clock_offset_ns: 0,
            stats: session.stats(),
            loss_positions: session.take_loss_positions(),
            sock_drops: Some(ring_drops.saturating_sub(self.drops_at_start)),
            shard_delays: session.take_shard_delays().collect(),
            probe_active: false,
            mode: s.mode,
            acks: s.acks,
            decode_lat: s.decode_lat,
            encode_lat: s.encode_lat,
            host_timings: s.host_timings,
            keyframe_asks: s.keyframe_asks,
            ..Inputs::default()
        });
        let unsent = apply(tick.actions, send);
        let d = &mut self.feed.driver;
        for kbps in unsent.requests {
            d.on_request_dropped(kbps);
        }
        for _ in 0..unsent.probes {
            d.on_probe_dropped();
        }
        if tick.window.is_some() {
            self.target_kbps = d.target_kbps();
            self.rate_cut = d
                .last_cut()
                .and_then(RateCut::of_reason)
                .map_or(0, |c| c as u8);
        }
    }
}

/// What a tick asked for that never went out, for the driver to hear back.
#[derive(Debug, Default, PartialEq)]
struct Unsent {
    requests: Vec<u32>,
    probes: u32,
}

/// Send what a tick asked for, in order.
fn apply(actions: Vec<Action>, mut send: impl FnMut(u32) -> bool) -> Unsent {
    let mut unsent = Unsent::default();
    for action in actions {
        match action {
            Action::SetBitrate(kbps) => {
                if !send(kbps) {
                    unsent.requests.push(kbps);
                }
            }
            // The page asks for no burst: each goes back unsent.
            Action::Probe { .. } => unsent.probes += 1,
            // The window report, frame shape and link rate ride `Feedback`'s levels, which the
            // page does not send. Only a burst raises `Keyframe` and `AbandonProbe`.
            Action::Report { .. }
            | Action::Shape(_)
            | Action::LinkRate(_)
            | Action::Keyframe
            | Action::AbandonProbe => {}
        }
    }
    unsent
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every ack reaches the next tick in arrival order, its reason with it.
    #[test]
    fn acks_queue_for_the_next_tick() {
        let mut since = Since::default();
        let short = Some(AckReason::EncoderLimit);
        for ack in [
            BitrateChanged {
                bitrate_kbps: 8_000,
                reason: short,
            },
            BitrateChanged {
                bitrate_kbps: 20_000,
                reason: None,
            },
        ] {
            let frame = ack.encode_v2();
            let (ty, body, _) = punktfunk_core::quic::v2::field::split_frame(
                &frame,
                punktfunk_core::quic::v2::registry::max_body,
            )
            .unwrap()
            .unwrap();
            assert_eq!(ty, BitrateChanged::TYPE);
            since.on_ack(body);
        }
        since.on_ack(&[0xff]);
        assert_eq!(since.acks, vec![(8_000, short), (20_000, None)]);
    }

    /// A rate the control stream took is sent; one it did not goes back, as every probe does.
    #[test]
    fn an_unsent_rate_goes_back_to_the_driver() {
        let probe = Action::Probe {
            target_kbps: 50_000,
            duration_ms: 300,
            ramp: true,
        };
        let actions = vec![Action::LinkRate(100_000), Action::SetBitrate(12_000), probe];
        let mut sent = Vec::new();
        let open = apply(actions.clone(), |kbps| {
            sent.push(kbps);
            true
        });
        assert_eq!(sent, vec![12_000]);
        assert_eq!(
            open,
            Unsent {
                requests: vec![],
                probes: 1
            }
        );
        let closed = apply(actions, |_| false);
        assert_eq!(
            closed,
            Unsent {
                requests: vec![12_000],
                probes: 1
            }
        );
    }
}
