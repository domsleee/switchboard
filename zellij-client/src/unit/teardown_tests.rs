use crate::{terminal_teardown_message, DISABLE_FOCUS_REPORTING, ENABLE_FOCUS_REPORTING};

#[test]
fn terminal_output_propagates_write_and_flush_failures_without_panicking() {
    use crate::{stdin_ansi_parser::SyncOutput, write_terminal_output};
    use std::io::{self, Write};

    struct FailingTerminal(usize);
    impl Write for FailingTerminal {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.0 == 0 {
                return Err(io::Error::from_raw_os_error(5));
            }
            self.0 -= 1;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::from_raw_os_error(5))
        }
    }
    for sync in [None, Some(SyncOutput::CSI), Some(SyncOutput::DCS)] {
        for successful_writes in 0..=3 {
            let error =
                write_terminal_output(&mut FailingTerminal(successful_writes), b"screen", sync)
                    .unwrap_err();
            assert_eq!(error.raw_os_error(), Some(5));
        }
        let mut output = Vec::new();
        write_terminal_output(&mut output, b"screen", sync).unwrap();
        let expected = match sync {
            Some(sync) => [sync.start_seq(), b"screen", sync.end_seq()].concat(),
            None => b"screen".to_vec(),
        };
        assert_eq!(output, expected);
    }
}

#[test]
fn the_teardown_message_cancels_focus_reporting() {
    let message = terminal_teardown_message("bye", 20, false);
    assert!(
        message.contains(DISABLE_FOCUS_REPORTING),
        "the host must stop emitting focus reports on teardown, got: {:?}",
        message
    );
}

#[test]
fn the_teardown_message_cancels_focus_reporting_before_leaving_the_alternate_screen() {
    let message = terminal_teardown_message("bye", 20, true);
    let disable_focus = message.find(DISABLE_FOCUS_REPORTING).unwrap();
    let exit_alternate_screen = message.find("\u{1b}[?1049l").unwrap();
    assert!(
        disable_focus < exit_alternate_screen,
        "focus reporting is cancelled while we still own the screen, got: {:?}",
        message
    );
}

#[test]
fn the_focus_reporting_sequences_are_the_decset_1004_pair() {
    assert_eq!(ENABLE_FOCUS_REPORTING, "\u{1b}[?1004h");
    assert_eq!(DISABLE_FOCUS_REPORTING, "\u{1b}[?1004l");
}
