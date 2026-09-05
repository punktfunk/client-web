//! Client → host input, on the datagram plane the video shares.
//!
//! The page owns the browser events and the key table — what a `KeyboardEvent.code` means, when
//! the pointer is locked, which gamepad is which. Rust owns the wire: every event goes through
//! core's [`InputEvent`] codec, tagged `0xC8`, exactly as a native client sends it. Nothing here
//! is sent before the session is live, because the host reads input on the session it admitted.
//!
//! Gamepads go as [`GamepadSnapshot`]s when the host advertised `HOST_CAP_GAMEPAD_STATE` — one
//! datagram per change, sequence-numbered so a reorder cannot un-press a button — and as the
//! per-transition events an older host understands otherwise. The page calls with the whole pad
//! either way and never sees the difference.

use crate::session;
use crate::transport::send_datagram;
use punktfunk_core::input::{
    encode_gamepad_arrival, encode_gamepad_remove, gamepad, GamepadSnapshot, InputEvent,
    InputKind, MAX_PADS,
};
use punktfunk_core::quic::HOST_CAP_GAMEPAD_STATE;
use std::cell::RefCell;

struct Pads {
    /// What was last sent per pad, for the change check and the transition diff.
    last: [Option<GamepadSnapshot>; MAX_PADS],
    seq: [u8; MAX_PADS],
}

thread_local! {
    static PADS: RefCell<Pads> = const { RefCell::new(Pads { last: [None; MAX_PADS], seq: [0; MAX_PADS] }) };
}

fn send(ev: InputEvent) {
    if session::is_live() {
        send_datagram(&ev.encode());
    }
}

/// One event, fields as [`InputKind`] documents them. `kind` outside the table is dropped.
#[unsafe(no_mangle)]
pub extern "C" fn pf_input(kind: u32, code: u32, x: i32, y: i32, flags: u32) {
    let Some(kind) = u8::try_from(kind).ok().and_then(InputKind::from_u8) else {
        return;
    };
    send(InputEvent {
        kind,
        _pad: [0; 3],
        code,
        x,
        y,
        flags,
    });
}

/// A pad appeared. `pad` is its slot; the host picks the backend from its own default.
#[unsafe(no_mangle)]
pub extern "C" fn pf_gamepad_arrival(pad: u32) {
    let Ok(pad) = u8::try_from(pad) else { return };
    if usize::from(pad) >= MAX_PADS {
        return;
    }
    PADS.with(|p| p.borrow_mut().last[usize::from(pad)] = None);
    send(InputEvent {
        kind: InputKind::GamepadArrival,
        _pad: [0; 3],
        code: 0,
        x: 0,
        y: 0,
        flags: encode_gamepad_arrival(pad, 0),
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn pf_gamepad_remove(pad: u32) {
    let Ok(pad) = u8::try_from(pad) else { return };
    if usize::from(pad) >= MAX_PADS {
        return;
    }
    let seq = PADS.with(|p| {
        let mut p = p.borrow_mut();
        p.last[usize::from(pad)] = None;
        let s = &mut p.seq[usize::from(pad)];
        *s = s.wrapping_add(1);
        *s
    });
    send(InputEvent {
        kind: InputKind::GamepadRemove,
        _pad: [0; 3],
        code: 0,
        x: 0,
        y: 0,
        flags: encode_gamepad_remove(pad, seq),
    });
}

/// The whole pad, as the page read it. Sticks −32768..32767 with **+y = up**, triggers 0..255,
/// `buttons` in core's `BTN_*` layout. Sends only what changed.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn pf_gamepad(
    pad: u32,
    buttons: u32,
    ls_x: i32,
    ls_y: i32,
    rs_x: i32,
    rs_y: i32,
    lt: u32,
    rt: u32,
) {
    let Ok(pad) = u8::try_from(pad) else { return };
    let slot = usize::from(pad);
    if slot >= MAX_PADS || !session::is_live() {
        return;
    }
    let clamp = |v: i32| v.clamp(i16::MIN.into(), i16::MAX.into()) as i16;
    let now = GamepadSnapshot {
        pad,
        seq: 0,
        buttons,
        left_trigger: lt.min(255) as u8,
        right_trigger: rt.min(255) as u8,
        ls_x: clamp(ls_x),
        ls_y: clamp(ls_y),
        rs_x: clamp(rs_x),
        rs_y: clamp(rs_y),
    };
    let last = PADS.with(|p| p.borrow().last[slot]);
    if last.is_some_and(|l| same_pad(&l, &now)) {
        return;
    }
    if session::host_caps() & HOST_CAP_GAMEPAD_STATE != 0 {
        let seq = PADS.with(|p| {
            let s = &mut p.borrow_mut().seq[slot];
            *s = s.wrapping_add(1);
            *s
        });
        send(GamepadSnapshot { seq, ..now }.to_event());
    } else {
        transitions(last.unwrap_or_default(), &now);
    }
    PADS.with(|p| p.borrow_mut().last[slot] = Some(now));
}

fn same_pad(a: &GamepadSnapshot, b: &GamepadSnapshot) -> bool {
    GamepadSnapshot { seq: 0, ..*a } == GamepadSnapshot { seq: 0, ..*b }
}

/// The older vocabulary: one event per button that flipped, one per axis that moved.
fn transitions(last: GamepadSnapshot, now: &GamepadSnapshot) {
    let pad = u32::from(now.pad);
    let changed = last.buttons ^ now.buttons;
    for bit in (0..32).map(|i| 1u32 << i).filter(|b| changed & b != 0) {
        send(InputEvent {
            kind: InputKind::GamepadButton,
            _pad: [0; 3],
            code: bit,
            x: i32::from(now.buttons & bit != 0),
            y: 0,
            flags: pad,
        });
    }
    let axes = [
        (gamepad::AXIS_LS_X, i32::from(last.ls_x), i32::from(now.ls_x)),
        (gamepad::AXIS_LS_Y, i32::from(last.ls_y), i32::from(now.ls_y)),
        (gamepad::AXIS_RS_X, i32::from(last.rs_x), i32::from(now.rs_x)),
        (gamepad::AXIS_RS_Y, i32::from(last.rs_y), i32::from(now.rs_y)),
        (gamepad::AXIS_LT, i32::from(last.left_trigger), i32::from(now.left_trigger)),
        (gamepad::AXIS_RT, i32::from(last.right_trigger), i32::from(now.right_trigger)),
    ];
    for (code, _, is) in axes.into_iter().filter(|(_, was, is)| was != is) {
        send(InputEvent {
            kind: InputKind::GamepadAxis,
            _pad: [0; 3],
            code,
            x: is,
            y: 0,
            flags: pad,
        });
    }
}
