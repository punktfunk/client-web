//! The Opus multistream a surround session carries, as the page's decoder needs it described.
//!
//! The host encodes one of core's layout rows ([`layout_for`]); the page's `OpusHead` (mapping
//! family 255) must name the same stream count, coupled count and mapping, or every channel lands
//! in the wrong speaker. Pure, so it is tested off wasm.

use punktfunk_core::audio::{layout_for, AudioLayout};

/// Stream count, coupled count, then one mapping byte per channel, for `Welcome`'s channels and
/// layout. `None` for stereo, which needs no description, and for a layout this build does not know.
pub fn multistream(channels: u8, layout: u8) -> Option<Vec<u8>> {
    let layout = AudioLayout::from_wire(layout).filter(|_| matches!(channels, 6 | 8))?;
    let l = layout_for(channels, layout);
    let mut bytes = vec![l.streams, l.coupled];
    bytes.extend_from_slice(l.mapping);
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The page's decoder is built from these bytes, so they must be the host's own table row.
    #[test]
    fn the_layout_the_host_encodes_reaches_the_page() {
        let standard = AudioLayout::Standard.wire();
        assert_eq!(multistream(6, standard).unwrap(), [4, 2, 0, 1, 4, 5, 2, 3]);
        assert_eq!(
            multistream(8, standard).unwrap(),
            [5, 3, 0, 1, 6, 7, 2, 3, 4, 5]
        );
        assert_eq!(
            multistream(6, AudioLayout::Legacy.wire()).unwrap(),
            [4, 2, 0, 1, 2, 3, 4, 5]
        );
        assert_eq!(multistream(2, standard), None, "stereo needs none");
        assert_eq!(
            multistream(6, 0xff),
            None,
            "an unknown layout is never guessed"
        );
    }
}
