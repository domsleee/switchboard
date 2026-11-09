//! Finds where a new parser must start reading so that it picks up exactly
//! where the old one stopped. A pause can land inside an escape sequence or
//! UTF-8 character, which the old screen has not applied. This mirrors the
//! state machine of `vte::Parser`; the tests hold it to that parser.
#![allow(dead_code)] // Used once engines can hand a session over.

#[derive(Clone, Copy, PartialEq)]
enum State {
    Ground,
    Escape,
    EscapeIntermediate,
    CsiEntry,
    CsiParam,
    CsiIntermediate,
    CsiIgnore,
    DcsEntry,
    DcsParam,
    DcsIntermediate,
    DcsIgnore,
    DcsPassthrough,
    Osc,
    IgnoredString,
}

/// Follows a terminal's output and reports the position to resume from.
pub struct SequenceTracker {
    state: State,
    position: u64,
    sequence_start: u64,
    /// A control character inside the sequence has already taken effect, so
    /// reading the sequence again would apply it twice.
    executed_inside: bool,
    partial_character: Vec<u8>,
}

fn is_executed(byte: u8) -> bool {
    matches!(byte, 0x00..=0x17 | 0x19 | 0x1c..=0x1f)
}

impl SequenceTracker {
    pub fn new(position: u64) -> Self {
        Self {
            state: State::Ground,
            position,
            sequence_start: position,
            executed_inside: false,
            partial_character: Vec::with_capacity(4),
        }
    }

    pub fn advance(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.advance_byte(byte);
            self.position += 1;
        }
    }

    /// How much output has been followed.
    pub fn position(&self) -> u64 {
        self.position
    }

    /// The position a new parser should read from, or `None` when no position
    /// reproduces the old parser's state and the handoff must not proceed.
    pub fn resume_position(&self) -> Option<u64> {
        match self.state {
            State::Ground => Some(self.position - self.partial_character.len() as u64),
            _ if self.executed_inside => None,
            _ => Some(self.sequence_start),
        }
    }

    fn begin_sequence(&mut self) {
        self.state = State::Escape;
        self.sequence_start = self.position;
        self.executed_inside = false;
        self.partial_character.clear();
    }

    /// Bytes that mean the same thing in every state but ground.
    fn anywhere(&mut self, byte: u8) {
        match byte {
            0x18 | 0x1a => self.state = State::Ground,
            0x1b => self.begin_sequence(),
            _ => {},
        }
    }

    fn execute_inside(&mut self) {
        self.executed_inside = true;
    }

    fn advance_ground(&mut self, byte: u8) {
        if byte == 0x1b {
            self.begin_sequence();
            return;
        }
        self.partial_character.push(byte);
        loop {
            match std::str::from_utf8(&self.partial_character) {
                Ok(_) => {
                    self.partial_character.clear();
                    return;
                },
                Err(error) => match error.error_len() {
                    None => {
                        self.partial_character.drain(..error.valid_up_to());
                        return;
                    },
                    Some(length) => {
                        self.partial_character.drain(..error.valid_up_to() + length);
                        if self.partial_character.is_empty() {
                            return;
                        }
                    },
                },
            }
        }
    }

    fn advance_byte(&mut self, byte: u8) {
        match self.state {
            State::Ground => self.advance_ground(byte),
            State::Escape => match byte {
                _ if is_executed(byte) => self.execute_inside(),
                0x20..=0x2f => self.state = State::EscapeIntermediate,
                0x50 => self.state = State::DcsEntry,
                0x58 | 0x5e | 0x5f => self.state = State::IgnoredString,
                0x5b => self.state = State::CsiEntry,
                0x5d => self.state = State::Osc,
                0x30..=0x7e => self.state = State::Ground,
                0x18 | 0x1a => self.state = State::Ground,
                0x1b => self.begin_sequence(),
                _ => {},
            },
            State::EscapeIntermediate => match byte {
                _ if is_executed(byte) => self.execute_inside(),
                0x20..=0x2f | 0x7f => {},
                0x30..=0x7e => self.state = State::Ground,
                _ => self.anywhere(byte),
            },
            State::CsiEntry | State::CsiParam => match byte {
                _ if is_executed(byte) => self.execute_inside(),
                0x20..=0x2f => self.state = State::CsiIntermediate,
                0x30..=0x3b => self.state = State::CsiParam,
                0x3c..=0x3f if self.state == State::CsiEntry => self.state = State::CsiParam,
                0x3c..=0x3f => self.state = State::CsiIgnore,
                0x40..=0x7e => self.state = State::Ground,
                0x7f => {},
                _ => self.anywhere(byte),
            },
            State::CsiIntermediate => match byte {
                _ if is_executed(byte) => self.execute_inside(),
                0x20..=0x2f | 0x7f => {},
                0x30..=0x3f => self.state = State::CsiIgnore,
                0x40..=0x7e => self.state = State::Ground,
                _ => self.anywhere(byte),
            },
            State::CsiIgnore => match byte {
                _ if is_executed(byte) => self.execute_inside(),
                0x20..=0x3f | 0x7f => {},
                0x40..=0x7e => self.state = State::Ground,
                _ => self.anywhere(byte),
            },
            State::DcsEntry | State::DcsParam => match byte {
                _ if is_executed(byte) => {},
                0x20..=0x2f => self.state = State::DcsIntermediate,
                0x30..=0x3b => self.state = State::DcsParam,
                0x3c..=0x3f if self.state == State::DcsEntry => self.state = State::DcsParam,
                0x3c..=0x3f => self.state = State::DcsIgnore,
                0x40..=0x7e => self.state = State::DcsPassthrough,
                0x7f => {},
                _ => self.anywhere(byte),
            },
            State::DcsIntermediate => match byte {
                _ if is_executed(byte) => {},
                0x20..=0x2f | 0x7f => {},
                0x30..=0x3f => self.state = State::DcsIgnore,
                0x40..=0x7e => self.state = State::DcsPassthrough,
                _ => self.anywhere(byte),
            },
            State::DcsPassthrough => match byte {
                0x18 | 0x1a | 0x9c => self.state = State::Ground,
                0x1b => self.begin_sequence(),
                _ => {},
            },
            State::Osc => match byte {
                0x07 | 0x18 | 0x1a => self.state = State::Ground,
                0x1b => self.begin_sequence(),
                _ => {},
            },
            State::DcsIgnore | State::IgnoredString => self.anywhere(byte),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vte::{Params, Parser, Perform};

    #[derive(Default)]
    struct Recorder(Vec<String>);

    impl Perform for Recorder {
        fn print(&mut self, c: char) {
            self.0.push(format!("print {c:?}"));
        }
        fn execute(&mut self, byte: u8) {
            self.0.push(format!("execute {byte}"));
        }
        fn hook(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
            self.0.push(format!(
                "hook {params:?} {intermediates:?} {ignore} {action}"
            ));
        }
        fn put(&mut self, byte: u8) {
            self.0.push(format!("put {byte}"));
        }
        fn unhook(&mut self) {
            self.0.push("unhook".into());
        }
        fn osc_dispatch(&mut self, params: &[&[u8]], bell: bool) {
            self.0.push(format!("osc {params:?} {bell}"));
        }
        fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, c: char) {
            self.0
                .push(format!("csi {params:?} {intermediates:?} {ignore} {c}"));
        }
        fn esc_dispatch(&mut self, intermediates: &[u8], ignore: bool, byte: u8) {
            self.0
                .push(format!("esc {intermediates:?} {ignore} {byte}"));
        }
    }

    fn events(bytes: &[u8]) -> Vec<String> {
        let mut recorder = Recorder::default();
        Parser::new().advance(&mut recorder, bytes);
        recorder.0
    }

    struct Random(u64);

    impl Random {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, limit: usize) -> usize {
            (self.next() % limit as u64) as usize
        }
    }

    fn terminal_like_bytes(random: &mut Random) -> Vec<u8> {
        const FRAGMENTS: &[&[u8]] = &[
            b"\x1b",
            b"\x1b[",
            b"\x1b]",
            b"\x1bP",
            b"\x1bX",
            b"\x1b^",
            b"\x1b_",
            b"\x1b(",
            b"\x1b\\",
            b"\x1b[31m",
            b"\x1b[?1049h",
            b"\x1b]0;title\x07",
            b"\x1b]8;;http://a\x1b\\",
            b"\x1bP1;2qdata\x1b\\",
            b"[",
            b"]",
            b";",
            b":",
            b"?",
            b"<",
            b" ",
            b"!",
            b"0",
            b"12",
            b"m",
            b"H",
            b"A",
            b"\x07",
            b"\x08",
            b"\n",
            b"\r",
            b"\x18",
            b"\x1a",
            b"\x7f",
            b"\x9c",
            b"\x80",
            b"\xff",
            b"\xc0",
            b"\xe6",
            b"\xe6\x97",
            b"\xe6\x97\xa5",
            b"\xf0\x9f",
            b"\xf0\x9f\x98\x80",
        ];
        let mut bytes = Vec::new();
        for _ in 0..random.below(40) {
            bytes.extend_from_slice(FRAGMENTS[random.below(FRAGMENTS.len())]);
        }
        bytes
    }

    #[test]
    fn resuming_gives_the_same_events_as_never_stopping() {
        let mut random = Random(0x9e3779b97f4a7c15);
        let mut refused = 0;
        for _ in 0..200_000 {
            let bytes = terminal_like_bytes(&mut random);
            let mut tracker = SequenceTracker::new(0);
            tracker.advance(&bytes);
            let Some(position) = tracker.resume_position() else {
                refused += 1;
                continue;
            };
            let position = position as usize;
            let continuation = terminal_like_bytes(&mut random);
            // What the old screen applied. A DCS string still open has no
            // effect on a snapshot, so the new parser starts it again.
            let mut applied = events(&bytes);
            let last_hook = applied.iter().rposition(|event| event.starts_with("hook"));
            let last_unhook = applied.iter().rposition(|event| event == "unhook");
            if let Some(hook) = last_hook.filter(|hook| last_unhook < Some(*hook)) {
                applied.truncate(hook);
            }
            applied.extend(events(&[&bytes[position..], &continuation].concat()));
            let uninterrupted = events(&[bytes.as_slice(), &continuation].concat());
            assert_eq!(
                applied, uninterrupted,
                "input {bytes:?} then {continuation:?} at {position}"
            );
        }
        assert!(refused < 100_000, "refused {refused} inputs");
    }

    #[test]
    fn splitting_the_input_does_not_change_the_answer() {
        let mut random = Random(0x2545f4914f6cdd1d);
        for _ in 0..50_000 {
            let bytes = terminal_like_bytes(&mut random);
            let mut whole = SequenceTracker::new(7);
            whole.advance(&bytes);
            let mut split = SequenceTracker::new(7);
            let mut rest = bytes.as_slice();
            while !rest.is_empty() {
                let (chunk, tail) = rest.split_at(1 + random.below(rest.len()));
                split.advance(chunk);
                rest = tail;
            }
            assert_eq!(split.resume_position(), whole.resume_position());
        }
    }

    #[test]
    fn resumes_before_unfinished_sequences_and_characters() {
        let resume = |bytes: &[u8]| {
            let mut tracker = SequenceTracker::new(100);
            tracker.advance(bytes);
            tracker.resume_position()
        };
        assert_eq!(resume(b"ab"), Some(102));
        assert_eq!(resume(b"ab\x1b[3"), Some(102));
        assert_eq!(resume(b"ab\x1b[31m"), Some(107));
        assert_eq!(resume("a\u{65e5}".as_bytes()), Some(104));
        assert_eq!(resume(&"a\u{65e5}".as_bytes()[..3]), Some(101));
        assert_eq!(resume(b"\x1b]2;t"), Some(100));
    }

    #[test]
    fn refuses_a_sequence_whose_control_character_already_ran() {
        let mut tracker = SequenceTracker::new(0);
        tracker.advance(b"\x1b[3\n");
        assert_eq!(tracker.resume_position(), None);
        tracker.advance(b"1m");
        assert_eq!(tracker.resume_position(), Some(6));
    }
}
