//! Numeric observations of upstream terminal bursts and browser backpressure.
//! Never retain terminal contents or change/delay the forwarded ANSI stream.
use std::time::Duration;

#[derive(Default)]
pub(super) struct OutputWindow {
    first: Option<Duration>,
    last: Duration,
    frames: u64,
    bytes: u64,
    largest_frame: usize,
    max_gap: Duration,
    max_forwarding: Duration,
    full_clear_frames: u64,
    synchronized_frames: u64,
}

impl OutputWindow {
    pub(super) fn frame(
        &mut self,
        received: Duration,
        bytes: usize,
        full_clear: bool,
        synchronized: bool,
        forwarding: Duration,
    ) {
        if self.first.is_some() {
            self.max_gap = self.max_gap.max(received.saturating_sub(self.last));
        } else {
            self.first = Some(received);
        }
        self.last = received;
        self.frames = self.frames.saturating_add(1);
        self.bytes = self.bytes.saturating_add(bytes as u64);
        self.largest_frame = self.largest_frame.max(bytes);
        self.max_forwarding = self.max_forwarding.max(forwarding);
        self.full_clear_frames += u64::from(full_clear);
        self.synchronized_frames += u64::from(synchronized);
    }

    pub(super) fn report(&mut self, now: Duration) -> Option<String> {
        let window = std::mem::take(self);
        let first = window.first?;
        if window.frames < 64
            && window.bytes < 512 * 1024
            && window.max_forwarding < Duration::from_millis(100)
        {
            return None;
        }
        Some(format!(
            "Terminal transport frames={} bytes={} span_ms={} active_ms={} gap_ms={} forward_ms={} largest={} clear_frames={} sync_start_frames={}",
            window.frames,
            window.bytes,
            now.saturating_sub(first).as_millis(),
            window.last.saturating_sub(first).as_millis(),
            window.max_gap.as_millis(),
            window.max_forwarding.as_millis(),
            window.largest_frame,
            window.full_clear_frames,
            window.synchronized_frames,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_transport_reports_upstream_bursts_separately_from_forwarding_delay() {
        let mut window = OutputWindow::default();
        for frame in 0..70 {
            window.frame(
                Duration::from_millis(100 + frame * 60),
                19000,
                frame == 0,
                true,
                Duration::from_millis(2),
            );
        }
        let report = window.report(Duration::from_secs(5)).unwrap();
        assert!(report.contains("frames=70 bytes=1330000"));
        assert!(report.contains("span_ms=4900 active_ms=4140 gap_ms=60 forward_ms=2"));
        assert!(report.contains("largest=19000 clear_frames=1 sync_start_frames=70"));
        assert!(report.len() <= 240);
        assert!(window.report(Duration::from_secs(10)).is_none());
    }

    #[test]
    fn terminal_transport_reports_a_slow_send_without_inventing_a_large_burst() {
        let mut window = OutputWindow::default();
        window.frame(Duration::ZERO, 40, false, false, Duration::from_millis(120));
        let report = window.report(Duration::from_secs(5)).unwrap();
        assert!(report.contains("frames=1 bytes=40"));
        assert!(report.contains("active_ms=0 gap_ms=0 forward_ms=120"));
    }

    #[test]
    fn terminal_transport_discards_small_normal_windows_and_idle_time_before_output() {
        let mut window = OutputWindow::default();
        window.frame(Duration::from_secs(3600), 20000, true, true, Duration::ZERO);
        assert!(window.report(Duration::from_secs(3605)).is_none());
        window.frame(
            Duration::from_secs(7200),
            600000,
            true,
            true,
            Duration::ZERO,
        );
        let report = window.report(Duration::from_secs(7205)).unwrap();
        assert!(report.contains("frames=1 bytes=600000 span_ms=5000 active_ms=0"));
    }
}
