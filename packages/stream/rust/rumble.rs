//! Host → pad rumble: core's policy, played through the browser's gamepad actuator.
//!
//! The host's `0xCA` datagrams pass the same per-pad sequence gate the native demux runs, then
//! core's [`RumbleEngine`] (lease, legacy staleness, backstop). Each command it emits goes to the
//! page, which plays it with `vibrationActuator.playEffect`. That API takes a duration, so a
//! command's `backstop_ms` is the duration: every renewal re-arms it, and a page that stops
//! polling goes quiet on its own.

use punktfunk_core::input::{GamepadSnapshot, MAX_PADS};
use punktfunk_core::quic::decode_rumble_envelope;
use punktfunk_core::rumble::{RumbleCommand, RumbleEngine};
use std::time::Instant;

/// One session's rumble: the sequence gate and the policy behind it.
#[derive(Default)]
pub struct Rumble {
    engine: RumbleEngine,
    last_seq: [Option<u8>; MAX_PADS],
}

impl Rumble {
    /// Fold one datagram. A reordered or repeated envelope and an out-of-range pad stop here.
    pub fn on_datagram(&mut self, now: Instant, d: &[u8]) {
        let Some(u) = decode_rumble_envelope(d) else {
            return;
        };
        let slot = usize::from(u.pad);
        if slot >= MAX_PADS {
            return;
        }
        if let Some(env) = u.envelope {
            if !GamepadSnapshot::seq_newer(env.seq, self.last_seq[slot]) {
                return;
            }
            self.last_seq[slot] = Some(env.seq);
        }
        let ttl = u.envelope.map(|e| e.ttl_ms);
        self.engine.wire_update(
            now,
            u.pad,
            u.low,
            u.high,
            u.left_trigger,
            u.right_trigger,
            ttl,
        );
    }

    /// Every command due at `now`.
    pub fn due(&mut self, now: Instant, mut play: impl FnMut(RumbleCommand)) {
        while let (Some(cmd), _) = self.engine.poll(now) {
            play(cmd);
        }
    }

    /// A stop for every pad still moving, then a clean slate: a new session numbers from its own
    /// start.
    pub fn reset(&mut self, mut play: impl FnMut(RumbleCommand)) {
        while let Some(cmd) = self.engine.close_drain() {
            play(cmd);
        }
        *self = Rumble::default();
    }
}

#[cfg(target_family = "wasm")]
unsafe extern "C" {
    /// Play one command on the pad whose `Gamepad.index` is `pad`: four motor levels on the wire's
    /// 0–65535 scale, for `ms`. `ms == 0` is a stop.
    fn pf_rumble(pad: u32, low: u32, high: u32, lt: u32, rt: u32, ms: u32);
}

#[cfg(target_family = "wasm")]
thread_local! {
    static RUMBLE: std::cell::RefCell<Rumble> = std::cell::RefCell::new(Rumble::default());
}

#[cfg(target_family = "wasm")]
fn play(c: RumbleCommand) {
    // SAFETY: plain integers; the glue reads nothing from wasm memory.
    unsafe {
        pf_rumble(
            c.pad.into(),
            c.low.into(),
            c.high.into(),
            c.left_trigger.into(),
            c.right_trigger.into(),
            c.backstop_ms,
        );
    }
}

/// One rumble datagram off the ring.
#[cfg(target_family = "wasm")]
pub fn on_datagram(d: &[u8]) {
    RUMBLE.with(|r| r.borrow_mut().on_datagram(Instant::now(), d));
}

/// Play what is due. Called once a frame by the session pump.
#[cfg(target_family = "wasm")]
pub fn pump() {
    RUMBLE.with(|r| r.borrow_mut().due(Instant::now(), play));
}

/// Stop every pad and forget the session's sequence numbers.
#[cfg(target_family = "wasm")]
pub fn reset() {
    RUMBLE.with(|r| r.borrow_mut().reset(play));
}

#[cfg(test)]
mod tests {
    use super::*;
    use punktfunk_core::quic::{
        encode_rumble_datagram, encode_rumble_datagram_v2, encode_rumble_datagram_v3,
    };
    use std::time::Duration;

    fn played(r: &mut Rumble, now: Instant) -> Vec<(u16, u16, u16, u32)> {
        let mut out = Vec::new();
        r.due(now, |c| out.push((c.pad, c.low, c.high, c.backstop_ms)));
        out
    }

    #[test]
    fn an_envelope_plays_for_twice_its_lease() {
        let mut r = Rumble::default();
        let t = Instant::now();
        r.on_datagram(t, &encode_rumble_datagram_v2(1, 0x4000, 0x8000, 7, 400));
        assert_eq!(played(&mut r, t), vec![(1, 0x4000, 0x8000, 800)]);
        assert!(played(&mut r, t).is_empty(), "played once, not every frame");
    }

    #[test]
    fn a_reordered_envelope_is_dropped() {
        let mut r = Rumble::default();
        let t = Instant::now();
        r.on_datagram(t, &encode_rumble_datagram_v2(0, 0x4000, 0, 9, 400));
        let _ = played(&mut r, t);
        // Older than 9: a start that arrived after the stop would buzz for ever.
        r.on_datagram(t, &encode_rumble_datagram_v2(0, 0xffff, 0xffff, 8, 400));
        assert!(played(&mut r, t).is_empty());
    }

    #[test]
    fn an_unrenewed_lease_goes_quiet() {
        let mut r = Rumble::default();
        let t = Instant::now();
        r.on_datagram(t, &encode_rumble_datagram_v2(0, 0x4000, 0, 1, 200));
        let _ = played(&mut r, t);
        let later = t + Duration::from_millis(201);
        assert_eq!(played(&mut r, later), vec![(0, 0, 0, 0)]);
    }

    #[test]
    fn a_legacy_host_plays_with_the_legacy_backstop() {
        let mut r = Rumble::default();
        let t = Instant::now();
        r.on_datagram(t, &encode_rumble_datagram(2, 0x1000, 0x2000));
        assert_eq!(played(&mut r, t), vec![(2, 0x1000, 0x2000, 2000)]);
    }

    #[test]
    fn trigger_levels_reach_the_page() {
        let mut r = Rumble::default();
        let t = Instant::now();
        r.on_datagram(
            t,
            &encode_rumble_datagram_v3(0, 0, 0, 1, 400, 0x3000, 0x5000),
        );
        let mut out = Vec::new();
        r.due(t, |c| out.push((c.left_trigger, c.right_trigger)));
        assert_eq!(out, vec![(0x3000, 0x5000)]);
    }

    #[test]
    fn a_pad_past_the_table_is_ignored() {
        let mut r = Rumble::default();
        let t = Instant::now();
        r.on_datagram(
            t,
            &encode_rumble_datagram_v2(MAX_PADS as u16, 0xffff, 0, 1, 400),
        );
        assert!(played(&mut r, t).is_empty());
    }

    #[test]
    fn reset_stops_a_moving_pad_and_forgets_its_sequence() {
        let mut r = Rumble::default();
        let t = Instant::now();
        r.on_datagram(t, &encode_rumble_datagram_v2(3, 0x4000, 0, 200, 400));
        let _ = played(&mut r, t);
        let mut stops = Vec::new();
        r.reset(|c| stops.push((c.pad, c.low, c.high, c.backstop_ms)));
        assert_eq!(stops, vec![(3, 0, 0, 0)]);
        // A new session starts its sequence low; the old high-water mark must not gate it.
        r.on_datagram(t, &encode_rumble_datagram_v2(3, 0x4000, 0, 1, 400));
        assert_eq!(played(&mut r, t), vec![(3, 0x4000, 0, 800)]);
    }
}
