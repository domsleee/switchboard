//! State lives in the retained attachment, never in a replaceable transport.
use anyhow::{bail, ensure, Result};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const INPUT_LIMIT: usize = 64 * 1024;
const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const RECORD_LIMIT: usize = 4096;
/// Starts a repaint on a terminal that missed output. The engine's redraw follows.
const RESYNC: &str = "\x1b[0m";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Input {
    pub seq: u64,
    pub channel: String,
    pub data: String,
}
#[derive(Clone, Debug, Serialize)]
pub(super) struct Output {
    pub seq: u64,
    pub channel: &'static str,
    pub data: String,
    /// Terminal output before this record was dropped. The browser accepts
    /// the sequence gap and the engine repaints the screen.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub resync: bool,
}
#[derive(Default)]
pub(super) struct Journal {
    pub generation: u64,
    nonce: String,
    pub input: Option<Input>,
    pub output: VecDeque<Output>,
    pub emitted: u64,
    pub applied: u64,
    bytes: usize,
    pub failure: Option<String>,
    /// Set when terminal output was dropped; the attachment asks the engine to repaint.
    pub redraw: bool,
}
impl Journal {
    pub fn release_payloads(&mut self) {
        self.output = VecDeque::new();
        self.bytes = 0;
        if let Some(input) = &mut self.input {
            input.data = String::new();
        }
    }

    pub fn resume(&mut self, expected: u64, nonce: &str, applied: u64) -> Result<u64> {
        ensure!(
            !nonce.is_empty() && nonce.len() <= 64,
            "Invalid resume identity"
        );
        if let Some(error) = &self.failure {
            bail!("{error}");
        }
        ensure!(
            applied >= self.applied && applied <= self.emitted,
            "Invalid output acknowledgment"
        );
        // A reply can be lost after the generation changed. The same request
        // must return that generation, never fence its own successful retry.
        if self.nonce != nonce {
            ensure!(expected == self.generation, "Stale transport generation");
            self.generation = self
                .generation
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("Generation exhausted"))?;
            self.nonce = nonce.to_owned();
        } else {
            ensure!(
                expected == self.generation || expected.checked_add(1) == Some(self.generation),
                "Invalid resume generation"
            );
        }
        self.acknowledge(applied)?;
        Ok(self.generation)
    }
    pub fn acknowledge(&mut self, applied: u64) -> Result<()> {
        ensure!(
            applied >= self.applied && applied <= self.emitted,
            "Invalid output acknowledgment"
        );
        self.applied = applied;
        while self.output.front().is_some_and(|o| o.seq <= applied) {
            self.bytes -= self.output.pop_front().unwrap().data.len();
        }
        Ok(())
    }
    pub fn accepts(&self, generation: u64, input: &Input) -> Result<bool> {
        ensure!(generation == self.generation, "Stale transport generation");
        ensure!(input.data.len() <= INPUT_LIMIT, "Input exceeds limit");
        ensure!(
            matches!(input.channel.as_str(), "terminal" | "control"),
            "Unknown input channel"
        );
        if let Some(error) = &self.failure {
            bail!("{error}");
        }
        if let Some(last) = &self.input {
            if input.seq == last.seq {
                ensure!(input == last, "Changed input retry");
                return Ok(false);
            }
        }
        ensure!(
            input.seq
                == self
                    .input_ack()
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("Input sequence exhausted"))?,
            "Input sequence gap"
        );
        Ok(true)
    }
    pub fn delivery_failed(&mut self, dispatched: bool, error: String) {
        // Fenced work can still be sitting in the actor queue after resume.
        // Reject it to that transport without poisoning the retained owner.
        if dispatched {
            self.failure = Some(error);
        }
    }
    pub fn input_ack(&self) -> u64 {
        self.input.as_ref().map_or(0, |i| i.seq)
    }
    pub fn emit(&mut self, channel: &'static str, data: String) {
        if self.failure.is_some() {
            return;
        }
        if self.over_limit(data.len()) {
            // A viewer that falls far behind (a hidden browser tab, a long
            // disconnect) gets a repaint instead of every frame it missed.
            // Control records carry state the browser waits on, so they stay.
            self.output.retain(|o| o.channel != "terminal");
            for record in &mut self.output {
                record.resync = true;
            }
            self.bytes = self.output.iter().map(|o| o.data.len()).sum();
            self.redraw = true;
            self.push("terminal", RESYNC.into(), true);
            if self.over_limit(data.len()) {
                self.failure = Some(
                    "Terminal replay buffer exhausted; reconnect cannot safely continue".into(),
                );
                return;
            }
        }
        self.push(channel, data, false);
    }
    fn over_limit(&self, incoming: usize) -> bool {
        self.bytes.saturating_add(incoming) > OUTPUT_LIMIT || self.output.len() >= RECORD_LIMIT
    }
    fn push(&mut self, channel: &'static str, data: String, resync: bool) {
        self.emitted += 1;
        self.bytes += data.len();
        self.output.push_back(Output {
            seq: self.emitted,
            channel,
            data,
            resync,
        });
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn switchboard_attachment_retired_payloads_preserve_final_delivery_identity() {
        let mut journal = Journal::default();
        journal.resume(0, "first", 0).unwrap();
        journal.input = Some(Input {
            seq: 1,
            channel: "terminal".into(),
            data: "private input".into(),
        });
        journal.emit("terminal", "private output".into());
        journal.failure = Some("Permission revoked".into());
        journal.release_payloads();
        assert_eq!(
            journal.generation, 1,
            "The existing transport must receive its error, not be fenced"
        );
        assert_eq!(journal.input_ack(), 1);
        assert_eq!(journal.failure.as_deref(), Some("Permission revoked"));
        assert!(journal.output.is_empty());
        assert_eq!(journal.bytes, 0);
        assert!(journal.input.unwrap().data.is_empty());
    }
    #[test]
    fn switchboard_attachment_resume_lost_replies_do_not_duplicate_input() {
        let mut j = Journal::default();
        assert_eq!(j.resume(0, "first", 0).unwrap(), 1);
        let input = Input {
            seq: 1,
            channel: "terminal".into(),
            data: "\x1b[200~hello\x1b[201~".into(),
        };
        assert!(j.accepts(1, &input).unwrap());
        j.input = Some(input.clone());
        // Worker accepted input, but the replaceable web service lost the ack.
        assert_eq!(j.resume(1, "replacement", 0).unwrap(), 2);
        assert_eq!(j.resume(1, "replacement", 0).unwrap(), 2);
        assert!(!j.accepts(2, &input).unwrap());
        assert!(j.accepts(1, &input).is_err());
        let mut changed = input.clone();
        changed.data.push('!');
        assert!(j.accepts(2, &changed).is_err());
        changed.seq = 3;
        assert!(j.accepts(2, &changed).is_err());
        j.emit("terminal", "output".into());
        assert!(j.acknowledge(2).is_err());
        j.acknowledge(1).unwrap();
        assert!(j.output.is_empty());
        assert!(j.resume(2, "rollback", 0).is_err());
        assert_eq!(j.generation, 2);
        assert_eq!(j.resume(2, "valid", 1).unwrap(), 3);
    }
    #[test]
    fn switchboard_attachment_overflow_resyncs_terminal_and_keeps_control() {
        let mut j = Journal::default();
        j.resume(0, "first", 0).unwrap();
        j.emit("terminal", "a".into());
        j.acknowledge(1).unwrap();
        j.emit("control", "focus".into());
        for _ in 0..RECORD_LIMIT {
            j.emit("terminal", "frame".into());
        }
        assert!(
            j.failure.is_none(),
            "A slow viewer must not lose its terminal"
        );
        assert!(std::mem::take(&mut j.redraw));
        let kept: Vec<_> = j
            .output
            .iter()
            .map(|o| (o.channel, o.data.as_str(), o.resync))
            .collect();
        assert_eq!(kept[0], ("control", "focus", true));
        assert_eq!(kept[1], ("terminal", RESYNC, true));
        assert!(kept[2..].iter().all(|o| o == &("terminal", "frame", false)));
        let seqs: Vec<_> = j.output.iter().map(|o| o.seq).collect();
        assert!(seqs.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(*seqs.last().unwrap(), j.emitted);
        // The browser can still acknowledge a dropped record it already had.
        j.acknowledge(5).unwrap();
        assert_eq!(j.output.front().unwrap().seq, seqs[1]);
        assert_eq!(j.resume(1, "second", 5).unwrap(), 2);

        let mut big = Journal::default();
        big.emit("terminal", "x".repeat(OUTPUT_LIMIT));
        big.emit("terminal", "y".into());
        assert!(big.failure.is_none());
        assert_eq!(big.bytes, RESYNC.len() + 1);
    }
    #[test]
    fn switchboard_attachment_overflow_fails_when_control_alone_exceeds_limit() {
        let mut j = Journal::default();
        j.emit("control", "x".repeat(OUTPUT_LIMIT));
        j.emit("control", "y".into());
        assert!(j.failure.is_some());
        assert!(j.resume(0, "first", 0).is_err());
    }
    #[test]
    fn switchboard_attachment_queued_stale_delivery_does_not_poison_resume() {
        let mut j = Journal::default();
        j.resume(0, "old", 0).unwrap();
        let queued = Input {
            seq: 1,
            channel: "terminal".into(),
            data: "once".into(),
        };
        j.resume(1, "new", 0).unwrap();
        let error = j.accepts(1, &queued).unwrap_err();
        j.delivery_failed(false, error.to_string());
        assert!(j.failure.is_none());
        assert!(j.accepts(2, &queued).unwrap());
        j.delivery_failed(true, "IPC failed after dispatch".into());
        assert!(j.accepts(2, &queued).is_err());
    }
}
