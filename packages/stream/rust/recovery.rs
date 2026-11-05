//! Which access units the page decodes after a loss, and what it asks the host for. The hold
//! itself is `punktfunk_core::reanchor`; this is the frame-index bookkeeping around it, and who
//! raised the hold.

use punktfunk_core::packet::{
    FLAG_SOF, RFI_MAX_RANGE, USER_FLAG_RECOVERY_ANCHOR, USER_FLAG_RECOVERY_POINT,
};
use punktfunk_core::quic::v2::dgram::Feedback;
use punktfunk_core::reanchor::ReanchorGate;
use std::time::{Duration, Instant};

/// The post-loss hold, and whether the page raised it on an unbroken stream rather than a loss.
///
/// The page's own holds come from its decoder: an error streak, or a rebuilt decoder's ask.
/// Their keyframe asks, the hold's re-asks included, go to the bitrate driver as a starved
/// decoder's, which a lower rate cannot feed. Core's `RecoveryDriver` keeps the same flag.
pub struct Freeze {
    gate: ReanchorGate,
    own: bool,
}

impl Default for Freeze {
    /// Open, for a session whose reassembler has dropped nothing yet.
    fn default() -> Freeze {
        Freeze {
            gate: ReanchorGate::new(0),
            own: false,
        }
    }
}

impl Freeze {
    /// One gate event; `page` when the page's decoder raised it, not the wire. An event that
    /// arms decides who holds: the page keeps a hold it raised on an open gate or already held.
    pub fn step<T>(&mut self, page: bool, event: impl FnOnce(&mut ReanchorGate) -> T) -> T {
        let (arms, held) = (self.gate.arms(), self.gate.is_holding());
        let out = event(&mut self.gate);
        if self.gate.arms() != arms {
            self.own = page && (self.own || !held);
        }
        out
    }

    /// A keyframe ask this hold makes now is a starved decoder's, not a loss's.
    pub fn starved(&self) -> bool {
        self.own
    }
}

/// An open ask repeats this often: a feedback datagram can be lost.
const REPEAT: Duration = Duration::from_millis(16);
/// An ask nothing answered closes here; the hold's own re-ask takes over.
const GIVE_UP: Duration = Duration::from_millis(500);

/// Frames skipped when `got` is ahead of `expected`, else `None`. Indices wrap: a small
/// forward difference is a gap, the top half of the space is a straggler already passed.
fn index_gap(expected: u32, got: u32) -> Option<u32> {
    let ahead = got.wrapping_sub(expected);
    (ahead != 0 && ahead < u32::MAX / 2).then_some(ahead)
}

/// What one access unit's frame index says about loss.
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    /// In order, or the first: decode it.
    Deliver,
    /// This many frames went missing before it: hold, and remember the range to ask for.
    Gap(u32),
    /// Behind one already decoded: decoding it would rewind the decoder. Skip it.
    Straggler,
}

/// Advance the expected index past `index`, widening `pending` over a gap. The oldest range not
/// yet asked for keeps its start: the host invalidates everything since it anyway.
pub fn on_index(next: &mut Option<u32>, pending: &mut Option<(u32, u32)>, index: u32) -> Step {
    let Some(exp) = *next else {
        *next = Some(index.wrapping_add(1));
        return Step::Deliver;
    };
    if index == exp {
        *next = Some(exp.wrapping_add(1));
        return Step::Deliver;
    }
    match index_gap(exp, index) {
        Some(gap) => {
            let first = pending.map_or(exp, |(first, _)| first);
            *pending = Some((first, index.wrapping_sub(1)));
            *next = Some(index.wrapping_add(1));
            Step::Gap(gap)
        }
        None => Step::Straggler,
    }
}

/// What to send once the throttle opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ask {
    Keyframe,
    Rfi(u32, u32),
}

/// An IDR the hold wants outranks the lost range, and a range wider than any encoder's history
/// is asked as an IDR too.
pub fn take_ask(want_keyframe: bool, pending: &mut Option<(u32, u32)>) -> Option<Ask> {
    if want_keyframe {
        *pending = None;
        return Some(Ask::Keyframe);
    }
    let (first, last) = pending.take()?;
    Some(
        if last.wrapping_sub(first).wrapping_add(1) > RFI_MAX_RANGE {
            Ask::Keyframe
        } else {
            Ask::Rfi(first, last)
        },
    )
}

/// The open ask, numbered as the host reads it: each number once, however often it arrives.
#[derive(Default)]
pub struct Asks {
    seq: u16,
    newest: Option<u32>,
    open: Option<Open>,
}

struct Open {
    ask: Ask,
    /// The newest frame when the ask went out: only a later one answers it.
    after: Option<u32>,
    next: Instant,
    until: Instant,
}

impl Asks {
    /// `ask` under a new number, replacing the open one.
    pub fn ask(&mut self, ask: Ask, now: Instant) -> Feedback {
        self.seq = self.seq.wrapping_add(1).max(1);
        self.open = Some(Open {
            ask,
            after: self.newest,
            next: now + REPEAT,
            until: now + GIVE_UP,
        });
        self.feedback()
    }

    /// A frame arrived. A keyframe after the ask answers it, and so does an anchor after an RFI.
    pub fn on_frame(&mut self, index: u32, flags: u32) {
        if self.newest.is_none_or(|n| index_gap(n, index).is_some()) {
            self.newest = Some(index);
        }
        let Some(o) = &self.open else { return };
        let after = o.after.is_none_or(|a| index_gap(a, index).is_some());
        let key = flags & u32::from(FLAG_SOF) != 0;
        let anchor = flags & (USER_FLAG_RECOVERY_ANCHOR | USER_FLAG_RECOVERY_POINT) != 0;
        if after && (key || (anchor && o.ask != Ask::Keyframe)) {
            self.open = None;
        }
    }

    /// The open ask again, once per [`REPEAT`] until a frame answers it or [`GIVE_UP`] passes.
    pub fn resend(&mut self, now: Instant) -> Option<Feedback> {
        let o = self.open.as_mut()?;
        if now >= o.until {
            self.open = None;
            return None;
        }
        if now < o.next {
            return None;
        }
        o.next = now + REPEAT;
        Some(self.feedback())
    }

    fn feedback(&self) -> Feedback {
        let Some(o) = &self.open else {
            return Feedback::default();
        };
        Feedback {
            ask: self.seq,
            keyframe: o.ask == Ask::Keyframe,
            invalidate: match o.ask {
                Ask::Rfi(first, last) => Some((first, last)),
                Ask::Keyframe => None,
            },
            ..Feedback::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gap_names_the_lost_range_until_it_is_asked() {
        let (mut next, mut pending) = (None, None);
        assert_eq!(on_index(&mut next, &mut pending, 10), Step::Deliver);
        assert_eq!(on_index(&mut next, &mut pending, 11), Step::Deliver);
        assert_eq!(on_index(&mut next, &mut pending, 14), Step::Gap(2));
        assert_eq!(pending, Some((12, 13)));
        // A second gap before the ask widens the range; its start stays the oldest loss.
        assert_eq!(on_index(&mut next, &mut pending, 17), Step::Gap(2));
        assert_eq!(pending, Some((12, 16)));
        assert_eq!(on_index(&mut next, &mut pending, 13), Step::Straggler);
        assert_eq!(take_ask(false, &mut pending), Some(Ask::Rfi(12, 16)));
        assert_eq!(take_ask(false, &mut pending), None, "asked once");
    }

    #[test]
    fn an_idr_outranks_the_range_and_a_wide_range_asks_for_one() {
        let mut pending = Some((5, 9));
        assert_eq!(take_ask(true, &mut pending), Some(Ask::Keyframe));
        assert_eq!(pending, None, "the IDR repairs the range too");
        let mut wide = Some((0, RFI_MAX_RANGE));
        assert_eq!(take_ask(false, &mut wide), Some(Ask::Keyframe));
    }

    /// One number per ask, repeated until a later keyframe answers it.
    #[test]
    fn an_ask_repeats_until_a_later_keyframe() {
        let t0 = Instant::now();
        let mut asks = Asks::default();
        asks.on_frame(7, 0);
        let fb = asks.ask(Ask::Keyframe, t0);
        assert_eq!((fb.ask, fb.keyframe, fb.invalidate), (1, true, None));
        assert!(asks.resend(t0).is_none(), "not due yet");
        assert_eq!(asks.resend(t0 + REPEAT).map(|f| f.ask), Some(1));
        asks.on_frame(7, u32::from(FLAG_SOF));
        assert!(
            asks.resend(t0 + REPEAT * 2).is_some(),
            "a frame before the ask answers nothing"
        );
        asks.on_frame(8, u32::from(FLAG_SOF));
        assert!(asks.resend(t0 + REPEAT * 3).is_none(), "answered");
        let rfi = asks.ask(Ask::Rfi(3, 5), t0);
        assert_eq!((rfi.ask, rfi.invalidate), (2, Some((3, 5))));
        assert!(asks.resend(t0 + GIVE_UP).is_none(), "given up");
    }

    /// A hold the page raised on an open gate asks as starved, its backstop re-ask too, until a
    /// loss re-arms it.
    #[test]
    fn a_page_hold_asks_starved_until_a_loss_re_arms_it() {
        use punktfunk_core::reanchor::REANCHOR_FREEZE_MAX;
        let t0 = Instant::now();
        let mut f = Freeze::default();
        f.step(true, |g| g.arm(t0));
        assert!(f.starved(), "a rebuilt decoder's ask");
        assert!(f.step(false, |g| g.poll(0, t0 + REANCHOR_FREEZE_MAX)));
        assert!(f.starved(), "the backstop re-ask of the page's hold");
        f.step(false, |g| g.arm_expecting_drops(t0, 2));
        assert!(!f.starved(), "a gap makes the hold the loss's");
        assert!(f.step(false, |g| g.poll(9, t0 + REANCHOR_FREEZE_MAX)));
        assert!(!f.starved(), "a drop climb is a loss");
    }

    /// The page's streak inside a loss's hold leaves it the loss's; on an open gate it is the
    /// page's.
    #[test]
    fn a_no_output_streak_is_the_page_s_only_on_an_open_gate() {
        let t0 = Instant::now();
        let mut f = Freeze::default();
        f.step(false, |g| g.arm_expecting_drops(t0, 1));
        let trips = (0..3)
            .filter(|_| f.step(true, |g| g.on_no_output(t0)))
            .count();
        assert_eq!(trips, 1);
        assert!(!f.starved(), "held by a loss");
        f.step(false, |g| g.on_decoded(u32::from(FLAG_SOF), true, t0));
        let trips = (0..3)
            .filter(|_| f.step(true, |g| g.on_no_output(t0)))
            .count();
        assert_eq!(trips, 1);
        assert!(f.starved(), "raised on an open gate");
    }

    #[test]
    fn the_index_wraps() {
        let (mut next, mut pending) = (Some(u32::MAX), None);
        assert_eq!(on_index(&mut next, &mut pending, 1), Step::Gap(2));
        assert_eq!(pending, Some((u32::MAX, 0)));
    }
}
