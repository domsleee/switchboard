use super::protocol::MAX_OUTPUT_CHUNK;
use std::collections::VecDeque;

const MAX_UNACKNOWLEDGED: u64 = 4 * 1024 * 1024;
const MAX_IN_FLIGHT: u64 = 256 * 1024;
const RETAINED_ACKNOWLEDGED: u64 = 1024 * 1024;

/// One terminal's output. Unacknowledged bytes are never discarded: a full
/// buffer stops the host reading the terminal, which blocks its child.
#[derive(Default)]
pub struct OutputBuffer {
    start: u64,
    bytes: VecDeque<u8>,
    sent: u64,
    acknowledged: u64,
}

impl OutputBuffer {
    fn end(&self) -> u64 {
        self.start + self.bytes.len() as u64
    }

    pub fn has_room(&self) -> bool {
        self.end() - self.acknowledged < MAX_UNACKNOWLEDGED
    }

    pub fn append(&mut self, bytes: &[u8]) {
        self.bytes.extend(bytes);
    }

    pub fn is_fully_sent(&self) -> bool {
        self.sent == self.end()
    }

    /// The next chunk to send, within the terminal's flow-control window.
    pub fn take_unsent(&mut self) -> Option<(u64, Vec<u8>)> {
        let window = MAX_IN_FLIGHT.saturating_sub(self.sent - self.acknowledged);
        let length = (self.end() - self.sent)
            .min(window)
            .min(MAX_OUTPUT_CHUNK as u64) as usize;
        if length == 0 {
            return None;
        }
        let sequence = self.sent;
        let offset = (sequence - self.start) as usize;
        let chunk = self
            .bytes
            .iter()
            .skip(offset)
            .take(length)
            .copied()
            .collect();
        self.sent += length as u64;
        Some((sequence, chunk))
    }

    /// Acknowledge output up to `sequence`, which cannot pass what was sent.
    pub fn acknowledge(&mut self, sequence: u64) {
        self.acknowledged = self.acknowledged.max(sequence.min(self.sent));
        let keep_from = self.acknowledged.saturating_sub(RETAINED_ACKNOWLEDGED);
        if keep_from > self.start {
            self.bytes.drain(..(keep_from - self.start) as usize);
            self.start = keep_from;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sends_in_order_with_sequence_numbers() {
        let mut buffer = OutputBuffer::default();
        buffer.append(b"hello");
        assert_eq!(buffer.take_unsent(), Some((0, b"hello".to_vec())));
        assert_eq!(buffer.take_unsent(), None);
        buffer.append(b"!");
        assert_eq!(buffer.take_unsent(), Some((5, b"!".to_vec())));
        assert!(buffer.is_fully_sent());
    }

    #[test]
    fn in_flight_output_waits_for_acknowledgement() {
        let mut buffer = OutputBuffer::default();
        buffer.append(&vec![1; MAX_IN_FLIGHT as usize + 10]);
        let mut sent = 0;
        while let Some((_, chunk)) = buffer.take_unsent() {
            assert!(chunk.len() <= MAX_OUTPUT_CHUNK);
            sent += chunk.len() as u64;
        }
        assert_eq!(sent, MAX_IN_FLIGHT);
        buffer.acknowledge(10);
        assert_eq!(buffer.take_unsent().unwrap().1.len(), 10);
    }

    #[test]
    fn full_buffer_stops_reading_until_acknowledged() {
        let mut buffer = OutputBuffer::default();
        buffer.append(&vec![1; MAX_UNACKNOWLEDGED as usize]);
        assert!(!buffer.has_room());
        while buffer.take_unsent().is_some() {}
        buffer.acknowledge(MAX_IN_FLIGHT);
        assert!(buffer.has_room());
    }

    #[test]
    fn acknowledgement_keeps_a_bounded_tail_and_cannot_pass_sent() {
        let mut buffer = OutputBuffer::default();
        buffer.append(&vec![1; 2 * MAX_IN_FLIGHT as usize]);
        buffer.acknowledge(u64::MAX);
        assert_eq!(buffer.acknowledged, 0);
        let total = RETAINED_ACKNOWLEDGED + 3 * MAX_IN_FLIGHT;
        buffer.append(&vec![2; total as usize]);
        loop {
            while buffer.take_unsent().is_some() {}
            if buffer.is_fully_sent() {
                break;
            }
            buffer.acknowledge(buffer.sent);
        }
        buffer.acknowledge(buffer.sent);
        assert_eq!(buffer.bytes.len() as u64, RETAINED_ACKNOWLEDGED);
        assert_eq!(buffer.start, buffer.sent - RETAINED_ACKNOWLEDGED);
    }
}
