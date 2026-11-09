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
    pinned: Option<u64>,
}

impl OutputBuffer {
    fn end(&self) -> u64 {
        self.start + self.bytes.len() as u64
    }

    fn oldest_needed(&self) -> u64 {
        self.pinned
            .map_or(self.acknowledged, |pinned| pinned.min(self.acknowledged))
    }

    pub fn has_room(&self) -> bool {
        self.end() - self.oldest_needed() < MAX_UNACKNOWLEDGED
    }

    pub fn can_pin(&self, sequence: u64) -> bool {
        (self.start..=self.sent).contains(&sequence)
    }

    /// Keeps output from `sequence` for the engine that takes over.
    pub fn pin(&mut self, sequence: u64) {
        self.pinned = Some(sequence);
    }

    pub fn unpin(&mut self) {
        self.pinned = None;
    }

    /// A new engine continues from its snapshot, or else from what the last
    /// engine confirmed.
    pub fn rewind(&mut self) {
        let resume = self.pinned.unwrap_or(self.acknowledged);
        self.sent = resume;
        self.acknowledged = resume;
    }

    pub fn sent(&self) -> u64 {
        self.sent
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
        let mut keep_from = self.acknowledged.saturating_sub(RETAINED_ACKNOWLEDGED);
        if let Some(pinned) = self.pinned {
            keep_from = keep_from.min(pinned);
        }
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
    fn a_pin_keeps_output_past_the_retention_limit_and_counts_against_room() {
        let mut buffer = OutputBuffer::default();
        buffer.append(b"snapshot starts here");
        while buffer.take_unsent().is_some() {}
        buffer.pin(9);
        buffer.acknowledge(buffer.sent);
        let mut remaining = MAX_UNACKNOWLEDGED;
        while remaining > 0 {
            let chunk = remaining.min(MAX_IN_FLIGHT);
            buffer.append(&vec![1; chunk as usize]);
            while buffer.take_unsent().is_some() {}
            buffer.acknowledge(buffer.sent);
            remaining -= chunk;
        }
        assert_eq!(buffer.start, 9);
        assert!(!buffer.has_room());
        buffer.rewind();
        assert_eq!(buffer.take_unsent().unwrap().0, 9);
        buffer.unpin();
        buffer.rewind();
        assert!(buffer.can_pin(buffer.sent));
    }

    #[test]
    fn a_rewind_starts_at_the_pin_even_when_acknowledgements_lag_behind_it() {
        let mut buffer = OutputBuffer::default();
        buffer.append(b"0123456789");
        while buffer.take_unsent().is_some() {}
        buffer.acknowledge(2);
        buffer.pin(6);
        buffer.rewind();
        assert_eq!(buffer.take_unsent(), Some((6, b"6789".to_vec())));
    }

    #[test]
    fn a_rewind_without_a_pin_resumes_from_what_was_confirmed() {
        let mut buffer = OutputBuffer::default();
        buffer.append(b"hello");
        while buffer.take_unsent().is_some() {}
        buffer.acknowledge(2);
        buffer.rewind();
        assert_eq!(buffer.take_unsent(), Some((2, b"llo".to_vec())));
    }

    #[test]
    fn output_already_discarded_cannot_be_pinned() {
        let mut buffer = OutputBuffer::default();
        buffer.append(&vec![1; 2 * MAX_IN_FLIGHT as usize]);
        loop {
            while buffer.take_unsent().is_some() {}
            buffer.acknowledge(buffer.sent);
            if buffer.is_fully_sent() {
                break;
            }
        }
        let later = RETAINED_ACKNOWLEDGED + 3 * MAX_IN_FLIGHT;
        buffer.append(&vec![2; later as usize]);
        loop {
            while buffer.take_unsent().is_some() {}
            buffer.acknowledge(buffer.sent);
            if buffer.is_fully_sent() {
                break;
            }
        }
        assert!(!buffer.can_pin(0));
        assert!(!buffer.can_pin(buffer.sent + 1));
    }

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
