//! What the host said about this session's launch (`MSG_LAUNCH_OUTCOME`), reduced to the one
//! line a player is shown. Decoded here because the pinned core predates `quic::LaunchOutcome`;
//! switch to its `notice()` at the next bump.

use punktfunk_core::quic::MAGIC;

/// `magic[0..4] type[4] kind[5] len[6] message[7..]`.
const MSG_LAUNCH_OUTCOME: u8 = 0x5A;

/// The host's sentence when the player did not get the game they asked for — adopted-unknown,
/// refused or failed (kinds 2–4) — else `None`. Spawned and adopted need no words; an unknown
/// kind reads as spawned, since the wire only ever appends kinds.
pub fn notice(body: &[u8]) -> Option<&str> {
    if body.len() < 7 || !body.starts_with(MAGIC) || body[4] != MSG_LAUNCH_OUTCOME {
        return None;
    }
    let len = body[6] as usize;
    if len == 0 || body.len() != 7 + len || !matches!(body[5], 2..=4) {
        return None;
    }
    std::str::from_utf8(&body[7..]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(kind: u8, text: &str) -> Vec<u8> {
        let mut b = MAGIC.to_vec();
        b.extend_from_slice(&[MSG_LAUNCH_OUTCOME, kind, text.len() as u8]);
        b.extend_from_slice(text.as_bytes());
        b
    }

    #[test]
    fn only_a_launch_the_player_did_not_get_is_told() {
        assert_eq!(
            notice(&msg(3, "Couldn't start Quail.")),
            Some("Couldn't start Quail.")
        );
        assert_eq!(notice(&msg(4, "Quail closed.")), Some("Quail closed."));
        assert_eq!(notice(&msg(2, "Start it again.")), Some("Start it again."));
        assert_eq!(notice(&msg(0, "Started.")), None, "spawned needs no words");
        assert_eq!(
            notice(&msg(1, "Picked it up.")),
            None,
            "adopted needs no words"
        );
        assert_eq!(
            notice(&msg(9, "From a newer host.")),
            None,
            "unknown reads as spawned"
        );
        assert_eq!(notice(&msg(3, "")), None);
        let mut short = msg(3, "Cut off");
        short.pop();
        assert_eq!(notice(&short), None, "a length that lies is refused");
        let mut other = msg(3, "Wrong type");
        other[4] = 0x59;
        assert_eq!(notice(&other), None, "another message type is not this one");
    }
}
