//! Which access units the page decodes after a loss, and what it asks the host for. The hold
//! itself is `punktfunk_core::reanchor`; this is the frame-index bookkeeping around it.

use punktfunk_core::packet::RFI_MAX_RANGE;
use punktfunk_core::reanchor::index_gap;

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
#[derive(Debug, PartialEq, Eq)]
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

    #[test]
    fn the_index_wraps() {
        let (mut next, mut pending) = (Some(u32::MAX), None);
        assert_eq!(on_index(&mut next, &mut pending, 1), Step::Gap(2));
        assert_eq!(pending, Some((u32::MAX, 0)));
    }
}
