//! One WebSocket message: a tag byte, then its payload (`web-client-tcp-bridge.md` §3.3).
//!
//! Integers are big-endian. A ping's `f64` is echoed byte for byte, never read.

const DATAGRAM: u8 = 0;
const CONTROL: u8 = 1;
const UNI: u8 = 2;
const CLOSE: u8 = 3;
const PING: u8 = 4;

#[derive(Debug, PartialEq)]
pub enum Frame<'a> {
    /// One datagram, as on the wire.
    Datagram(&'a [u8]),
    /// Control-stream bytes, any chunking.
    Control(&'a [u8]),
    /// One whole unidirectional stream, host to page.
    Uni(&'a [u8]),
    /// The session's close, sent before the WebSocket closes.
    Close { code: u32, reason: &'a [u8] },
    /// The sender's clock in ms, an `f64`.
    Ping([u8; 8]),
    /// The ping's clock, then the bridge's smoothed WebTransport RTT.
    Pong { sent: [u8; 8], rtt_us: u32 },
}

/// `None` for an unknown tag or a truncated close or ping.
pub fn decode(msg: &[u8]) -> Option<Frame<'_>> {
    let (&tag, body) = msg.split_first()?;
    Some(match tag {
        DATAGRAM => Frame::Datagram(body),
        CONTROL => Frame::Control(body),
        UNI => Frame::Uni(body),
        CLOSE => {
            let (code, reason) = body.split_first_chunk()?;
            Frame::Close {
                code: u32::from_be_bytes(*code),
                reason,
            }
        }
        PING => match body.len() {
            8 => Frame::Ping(body.try_into().ok()?),
            12 => {
                let (sent, rtt) = body.split_first_chunk()?;
                Frame::Pong {
                    sent: *sent,
                    rtt_us: u32::from_be_bytes(rtt.try_into().ok()?),
                }
            }
            _ => return None,
        },
        _ => return None,
    })
}

pub fn encode(frame: &Frame) -> Vec<u8> {
    let (tag, parts): (u8, [&[u8]; 2]) = match frame {
        Frame::Datagram(b) => (DATAGRAM, [b, &[]]),
        Frame::Control(b) => (CONTROL, [b, &[]]),
        Frame::Uni(b) => (UNI, [b, &[]]),
        Frame::Close { code, reason } => (CLOSE, [&code.to_be_bytes(), reason]),
        Frame::Ping(sent) => (PING, [sent, &[]]),
        Frame::Pong { sent, rtt_us } => (PING, [sent, &rtt_us.to_be_bytes()]),
    };
    [&[tag][..], parts[0], parts[1]].concat()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_frame_round_trips() {
        let t = 1234.5f64.to_be_bytes();
        for f in [
            Frame::Datagram(b"\x05media"),
            Frame::Control(b""),
            Frame::Uni(b"refused"),
            Frame::Close {
                code: 0x51,
                reason: "quit".as_bytes(),
            },
            Frame::Ping(t),
            Frame::Pong {
                sent: t,
                rtt_us: 900,
            },
        ] {
            assert_eq!(decode(&encode(&f)), Some(f));
        }
    }

    #[test]
    fn the_bytes_are_the_contract() {
        let close = Frame::Close {
            code: 0x51,
            reason: b"bye",
        };
        assert_eq!(encode(&close), b"\x03\x00\x00\x00\x51bye");
        let pong = Frame::Pong {
            sent: [1; 8],
            rtt_us: 0x0102_0304,
        };
        assert_eq!(
            encode(&pong),
            b"\x04\x01\x01\x01\x01\x01\x01\x01\x01\x01\x02\x03\x04"
        );
        assert_eq!(encode(&Frame::Datagram(b"x")), b"\x00x");
    }

    #[test]
    fn unknown_and_truncated_are_refused() {
        assert_eq!(decode(b""), None);
        assert_eq!(decode(b"\x05abc"), None);
        assert_eq!(decode(b"\x03\x00\x00\x51"), None);
        assert_eq!(decode(b"\x04\x00\x00\x00"), None);
        assert_eq!(decode(b"\x04123456789"), None);
    }
}
