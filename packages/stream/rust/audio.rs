//! Host → browser audio: the Opus plane, demuxed, rebuilt and reordered before the page
//! decodes it.
//!
//! Audio arrives on the same datagram flow as video, tagged `0xC9` (one 5 ms Opus frame) or
//! `0xD2` (the same, carrying a copy of the previous frame). [`on_datagram`] takes both off the
//! ring before the session pump can mistake them for video, rebuilds a lost predecessor from the
//! copy with core's [`AudioRedRecovery`] — exactly as the native client's demux does — and
//! releases frames to the page in sequence order from a short reorder window.
//!
//! The page decodes (WebCodecs `AudioDecoder`) and plays (an `AudioWorklet`), because the browser
//! has an Opus decoder and this module does not. What crosses is the encoded frame, borrowed for
//! one call. The microphone is the same plane the other way: the page encodes, [`pf_mic_send`]
//! wraps each frame as `0xCB`.

use punktfunk_core::audio::{AudioRedRecovery, FRAME_MS};
use punktfunk_core::quic::{
    decode_audio_datagram, decode_audio_red_datagram, encode_mic_datagram, AUDIO_MAGIC,
    AUDIO_RED_MAGIC,
};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

unsafe extern "C" {
    /// One Opus frame for the page's decoder. Borrowed for the call; the page copies it.
    fn pf_audio_frame(ptr: *const u8, len: u32, seq: u32, pts_ns: f64);
}

/// Frames held back so a datagram that arrives late still plays in order. Three frames is
/// 15 ms: inside the playback ring's own prime, so it costs no audible latency of its own.
const REORDER_DEPTH: usize = 3;

/// A gap wider than this is not a reorder in flight, it is loss: release what follows rather
/// than wait for what will not come.
const GAP_LIMIT: u32 = 16;

#[derive(Default)]
struct Plane {
    red: AudioRedRecovery,
    /// Frames waiting for their predecessors, by sequence.
    pending: BTreeMap<u32, (u64, Vec<u8>)>,
    /// The last sequence released. Anything at or before it is stale.
    released: Option<u32>,
    frames: u64,
    /// Sequences skipped over: lost and not rebuilt.
    lost: u64,
}

thread_local! {
    static PLANE: RefCell<Plane> = RefCell::new(Plane::default());
    /// The channels the next `Hello` asks for: what the page's output and decoder can play. The
    /// page's to say, so a session reset leaves it.
    static WANT_CHANNELS: Cell<u8> = const { Cell::new(2) };
    /// `Welcome`'s answer: the channels and layout the host encodes.
    static NEGOTIATED: Cell<(u8, u8)> = const { Cell::new((2, 0)) };
}

/// Ask for 2, 6 or 8 channels in the next `Hello`; anything else is stereo.
#[unsafe(no_mangle)]
pub extern "C" fn pf_session_audio(channels: u32) {
    let channels = match channels {
        6 => 6,
        8 => 8,
        _ => 2,
    };
    WANT_CHANNELS.with(|c| c.set(channels));
}

/// What `Hello` asks for.
pub fn requested_channels() -> u8 {
    WANT_CHANNELS.with(Cell::get)
}

/// `Welcome`'s channels and layout, which the page's decoder is built from.
pub fn negotiated(channels: u8, layout: u8) {
    NEGOTIATED.with(|n| n.set((channels, layout)));
}

/// The multistream the host encodes: stream count, coupled count, then one mapping byte per
/// channel, which is what a family-255 `OpusHead` carries. Returns the byte count, `0` for
/// stereo or a layout this build does not know.
///
/// # Safety
/// `out` must point to 10 writable bytes: two counts and up to eight mapping bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pf_session_audio_layout(out: *mut u8) -> u32 {
    let (channels, layout) = NEGOTIATED.with(Cell::get);
    let Some(bytes) = crate::surround::multistream(channels, layout) else {
        return 0;
    };
    // SAFETY: the caller guarantees 10 writable bytes at `out`; at most 2 + 8 are written.
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len()) };
    bytes.len() as u32
}

/// One Opus frame from the page's microphone, sent as the `0xCB` uplink. Dropped unless a
/// session is live: the host reads it only on the connection it admitted.
///
/// # Safety
/// `ptr` must point to `len` readable bytes for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pf_mic_send(ptr: *const u8, len: u32, seq: u32, pts_ns: f64) {
    if ptr.is_null() || !crate::session::is_live() {
        return;
    }
    // SAFETY: the caller guarantees `len` readable bytes at `ptr` for this call.
    let opus = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    crate::transport::send_datagram(&encode_mic_datagram(seq, pts_ns as u64, opus));
}

/// One audio datagram, either shape.
pub fn on_datagram(d: &[u8]) {
    PLANE.with(|p| {
        let mut p = p.borrow_mut();
        match d.first() {
            Some(&AUDIO_MAGIC) => {
                if let Some((seq, pts_ns, opus)) = decode_audio_datagram(d) {
                    p.red.recover_before(seq, false);
                    p.take(seq, pts_ns, opus);
                }
            }
            Some(&AUDIO_RED_MAGIC) => {
                if let Some((seq, pts_ns, opus, prev)) = decode_audio_red_datagram(d) {
                    if p.red.recover_before(seq, prev.is_some()) {
                        // The copy is the previous protocol frame: seq − 1, one frame earlier.
                        let earlier = pts_ns.saturating_sub(u64::from(FRAME_MS) * 1_000_000);
                        p.take(seq.wrapping_sub(1), earlier, prev.unwrap_or_default());
                    }
                    p.take(seq, pts_ns, opus);
                }
            }
            _ => {}
        }
    });
}

impl Plane {
    fn take(&mut self, seq: u32, pts_ns: u64, opus: &[u8]) {
        if self
            .released
            .is_some_and(|r| seq.wrapping_sub(r).wrapping_sub(1) > u32::MAX / 2)
        {
            return; // at or behind what already played
        }
        self.pending.insert(seq, (pts_ns, opus.to_vec()));
        self.release();
    }

    /// Hand over everything that is next in line, and — once the window is full — whatever is
    /// oldest, counting what it skipped.
    fn release(&mut self) {
        loop {
            let Some((&seq, _)) = self.pending.iter().next() else {
                return;
            };
            let next = self.released.map(|r| r.wrapping_add(1));
            let in_order = next.is_none_or(|n| n == seq);
            let gap = next.map_or(0, |n| seq.wrapping_sub(n));
            if !in_order && self.pending.len() < REORDER_DEPTH && gap < GAP_LIMIT {
                return;
            }
            let (pts_ns, opus) = self.pending.remove(&seq).expect("first key exists");
            if !in_order {
                self.lost += u64::from(gap);
            }
            self.released = Some(seq);
            self.frames += 1;
            // SAFETY: the frame outlives the call, which copies it and returns.
            unsafe { pf_audio_frame(opus.as_ptr(), opus.len() as u32, seq, pts_ns as f64) };
        }
    }
}

/// Frames handed to the page since the session opened.
#[unsafe(no_mangle)]
pub extern "C" fn pf_audio_frames() -> u32 {
    PLANE.with(|p| u32::try_from(p.borrow().frames).unwrap_or(u32::MAX))
}

/// Frames the wire lost and the redundant copy could not rebuild.
#[unsafe(no_mangle)]
pub extern "C" fn pf_audio_lost() -> u32 {
    PLANE.with(|p| u32::try_from(p.borrow().lost).unwrap_or(u32::MAX))
}

/// Forget the plane's position: a new session numbers from its own start.
pub fn reset() {
    PLANE.with(|p| *p.borrow_mut() = Plane::default());
}
