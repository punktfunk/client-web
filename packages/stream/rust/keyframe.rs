//! Is this access unit a key frame? The wire carries no such bit, and WebCodecs refuses a
//! delta as the first chunk after a configure, so the page reads it out of the bitstream.
//! Pure, so it is tested off wasm.

/// Does this access unit start a decodable picture?
///
/// `EncodedVideoChunk` needs `key` or `delta` and the first chunk must be a key, but the wire
/// carries no such bit — the native decoders read it from the bitstream, so this does too. The
/// host sends parameter sets with every IDR, so their presence is the signal: SPS for H.264,
/// VPS/SPS for HEVC. Anything else is a delta, which is the safe direction — a mislabelled key
/// corrupts the decoder's state, a mislabelled delta is only dropped.
pub fn is_keyframe(au: &[u8], codec: u8) -> bool {
    if codec == punktfunk_core::quic::CODEC_AV1 {
        return av1_is_keyframe(au);
    }
    let mut i = 0;
    while i + 3 < au.len() {
        // Annex B start code, three or four bytes.
        let payload = if au[i] == 0 && au[i + 1] == 0 && au[i + 2] == 1 {
            i + 3
        } else if i + 4 < au.len()
            && au[i] == 0
            && au[i + 1] == 0
            && au[i + 2] == 0
            && au[i + 3] == 1
        {
            i + 4
        } else {
            i += 1;
            continue;
        };
        let b = au[payload];
        let hit = if codec == punktfunk_core::quic::CODEC_HEVC {
            let t = (b >> 1) & 0x3f;
            // IDR_W_RADL, IDR_N_LP, CRA, or the VPS/SPS that precede them.
            matches!(t, 19 | 20 | 21 | 32 | 33)
        } else {
            let t = b & 0x1f;
            matches!(t, 5 | 7) // IDR slice, or the SPS that precedes it
        };
        if hit {
            return true;
        }
        i = payload;
    }
    false
}

/// Does this temporal unit carry a key frame? Its first frame header says so: `show_existing_frame`
/// clear, then `frame_type` 0. Low-overhead OBUs without a reduced still-picture header, which is
/// what a streaming encoder writes.
fn av1_is_keyframe(tu: &[u8]) -> bool {
    let mut i = 0;
    while let Some(&header) = tu.get(i) {
        let obu_type = (header >> 3) & 0x0f;
        i += 1 + usize::from(header & 0x04 != 0);
        let size = if header & 0x02 != 0 {
            let Some((size, used)) = leb128(tu.get(i..).unwrap_or_default()) else {
                return false;
            };
            i += used;
            size
        } else {
            tu.len().saturating_sub(i)
        };
        // OBU_FRAME_HEADER and OBU_FRAME both open with the uncompressed header.
        if matches!(obu_type, 3 | 6) {
            return tu
                .get(i)
                .is_some_and(|b| b & 0x80 == 0 && (b >> 5) & 0x03 == 0);
        }
        i = i.saturating_add(size);
    }
    false
}

/// An OBU size: the value and how many bytes it took. `None` past eight bytes, as the spec caps it.
fn leb128(b: &[u8]) -> Option<(usize, usize)> {
    let mut value = 0usize;
    for (n, byte) in b.iter().take(8).enumerate() {
        value |= usize::from(byte & 0x7f) << (7 * n);
        if byte & 0x80 == 0 {
            return Some((value, n + 1));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyframes_are_read_from_the_bitstream() {
        let h264 = punktfunk_core::quic::CODEC_H264;
        // SPS (type 7) then an IDR slice (type 5), the shape the host sends.
        assert!(is_keyframe(
            &[0, 0, 0, 1, 0x67, 0x42, 0, 0, 1, 0x65, 0x88],
            h264
        ));
        // A plain P slice (type 1) is not.
        assert!(!is_keyframe(&[0, 0, 0, 1, 0x41, 0x9a, 0x00], h264));
        // Three-byte start codes count too.
        assert!(is_keyframe(&[0, 0, 1, 0x65, 0x88], h264));
        assert!(!is_keyframe(&[], h264));

        let hevc = punktfunk_core::quic::CODEC_HEVC;
        // HEVC types live in bits 6..1: VPS = 32 -> 0x40, IDR_W_RADL = 19 -> 0x26.
        assert!(is_keyframe(&[0, 0, 0, 1, 0x40, 0x01], hevc));
        assert!(is_keyframe(&[0, 0, 0, 1, 0x26, 0x01], hevc));
        // TRAIL_R = 1 -> 0x02 is a delta.
        assert!(!is_keyframe(&[0, 0, 0, 1, 0x02, 0x01], hevc));

        let av1 = punktfunk_core::quic::CODEC_AV1;
        // Temporal delimiter, sequence header, then OBU_FRAME (0x32: type 6, sized) whose
        // uncompressed header opens `0 00`: shown, KEY_FRAME.
        let key = [0x12, 0x00, 0x0a, 0x02, 0xaa, 0xbb, 0x32, 0x02, 0x10, 0x00];
        assert!(is_keyframe(&key, av1));
        // frame_type 1 (INTER) is a delta; so is showing an existing frame.
        assert!(!is_keyframe(&[0x12, 0x00, 0x32, 0x02, 0x30, 0x00], av1));
        assert!(!is_keyframe(&[0x12, 0x00, 0x32, 0x02, 0x80, 0x00], av1));
        // A truncated size is no frame at all.
        assert!(!is_keyframe(&[0x12, 0x80], av1));
    }
}
