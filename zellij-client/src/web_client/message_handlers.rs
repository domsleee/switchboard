use crate::input_handler::from_termwiz;
use crate::keyboard_parser::{KittyKeyboardParser, KittyParseOutcome};
use crate::os_input_output::ClientOsApi;
use crate::web_client::types::BRACKETED_PASTE_END;
use crate::web_client::types::BRACKETED_PASTE_START;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use zellij_utils::{
    data::KeyWithModifier,
    input::{actions::Action, cast_termwiz_key, mouse::MouseEvent},
    ipc::ClientToServerMsg,
    vendored::termwiz::input::{InputEvent, InputParser},
};

/// Per-WebSocket-connection parsing state. Owns the Kitty and termwiz
/// parsers so a CSI / Kitty sequence split across two WebSocket frames
/// resolves on the second frame instead of being dropped or
/// degraded-and-emitted as separate keys.
pub struct StdinSession {
    kitty_parser: KittyKeyboardParser,
    input_parser: InputParser,
    explicitly_disable_kitty_keyboard_protocol: bool,
    /// Set when the last frame left the termwiz parser holding an
    /// ambiguous-but-complete event (e.g. a bare ESC). Cleared by
    /// `finalize` when an idle timeout drains those events.
    pending_finalize: bool,
    /// Input bytes not yet sent with an event, so a held ESC still
    /// reaches the pane as byte 27 when a later frame or `finalize` emits it.
    held: Vec<u8>,
}

impl StdinSession {
    pub fn new(explicitly_disable_kitty_keyboard_protocol: bool) -> Self {
        StdinSession {
            kitty_parser: KittyKeyboardParser::new(),
            input_parser: InputParser::new(),
            explicitly_disable_kitty_keyboard_protocol,
            pending_finalize: false,
            held: Vec::new(),
        }
    }

    pub fn pending_finalize(&self) -> bool {
        self.pending_finalize
    }

    /// Clear the pending-finalize flag without draining events. Used
    /// when the WebSocket loop hits an idle timeout but the client
    /// connection has already been removed — there's nowhere to send
    /// the drained events, and leaving the flag set would busy-loop the
    /// idle timer.
    pub fn clear_pending_finalize(&mut self) {
        self.pending_finalize = false;
    }

    /// Drain any ambiguous-but-complete events that termwiz held back
    /// on the previous `parse_stdin` call. Called from the WebSocket
    /// loop after an idle interval with no further frames, mirroring
    /// `stdin_handler::finalize_events`.
    pub fn finalize(&mut self, os_input: &dyn ClientOsApi, mouse_old_event: &mut MouseEvent) {
        self.dispatch(&[], false, os_input, mouse_old_event);
        self.pending_finalize = false;
    }

    /// Like the native client, each event carries the bytes that produced it,
    /// including bytes held from earlier frames. termwiz can absorb an ESC as an
    /// Alt prefix without counting it, so an event takes every held byte except
    /// those the parser still buffers.
    fn dispatch(
        &mut self,
        buf: &[u8],
        maybe_more: bool,
        os_input: &dyn ClientOsApi,
        mouse_old_event: &mut MouseEvent,
    ) {
        let mut remaining = self.input_parser.buffered_len() + buf.len();
        self.held.extend_from_slice(buf);
        let mut events = vec![];
        self.input_parser.parse_with_consumed(
            buf,
            |input_event: InputEvent, consumed: usize| {
                events.push((input_event, consumed));
            },
            maybe_more,
        );
        for (input_event, consumed) in events {
            remaining = remaining.saturating_sub(consumed);
            let take = self.held.len().saturating_sub(remaining);
            let raw_bytes: Vec<u8> = self.held.drain(..take).collect();
            dispatch_termwiz_event(os_input, mouse_old_event, input_event, &raw_bytes);
        }
        // Bytes termwiz dropped without an event are not input.
        if self.input_parser.buffered_len() == 0 {
            self.held.clear();
        }
    }
}

/// Switchboard owns tabs and panes in the browser, so a typed key is written to
/// the focused program as a terminal window would, never matched against Zellij's
/// mode shortcuts (Ctrl+O, Ctrl+G, Ctrl+Q, ...).
fn send_key(
    os_input: &dyn ClientOsApi,
    key: KeyWithModifier,
    raw_bytes: Vec<u8>,
    is_kitty_keyboard_protocol: bool,
) {
    os_input.send_to_server(ClientToServerMsg::Action {
        action: Action::Write {
            key_with_modifier: Some(key),
            bytes: raw_bytes,
            is_kitty_keyboard_protocol,
        },
        terminal_id: None,
        client_id: None,
        is_cli_client: false,
    });
}

/// Dispatch a single termwiz `InputEvent` produced by either the live
/// path or the idle finalize path. `raw_bytes` is the byte slice that
/// produced the event, including the held bytes a finalize drains.
fn dispatch_termwiz_event(
    os_input: &dyn ClientOsApi,
    mouse_old_event: &mut MouseEvent,
    input_event: InputEvent,
    raw_bytes: &[u8],
) {
    match input_event {
        InputEvent::Key(key_event) => {
            let raw_bytes_vec = raw_bytes.to_vec();
            let key = cast_termwiz_key(key_event.clone(), &raw_bytes_vec, None);
            send_key(os_input, key, raw_bytes_vec, false);
        },
        InputEvent::FocusGained => {
            os_input.send_to_server(ClientToServerMsg::HostTerminalFocusChanged { focused: true });
        },
        InputEvent::FocusLost => {
            os_input.send_to_server(ClientToServerMsg::HostTerminalFocusChanged { focused: false });
        },
        InputEvent::Mouse(mouse_event) => {
            let mouse_event = from_termwiz(mouse_old_event, mouse_event);
            let action = Action::MouseEvent { event: mouse_event };
            os_input.send_to_server(ClientToServerMsg::Action {
                action,
                terminal_id: None,
                client_id: None,
                is_cli_client: false,
            });
        },
        InputEvent::Paste(pasted_text) => {
            os_input.send_to_server(ClientToServerMsg::Action {
                action: Action::Write {
                    key_with_modifier: None,
                    bytes: BRACKETED_PASTE_START.to_vec(),
                    is_kitty_keyboard_protocol: false,
                },
                terminal_id: None,
                client_id: None,
                is_cli_client: false,
            });
            os_input.send_to_server(ClientToServerMsg::Action {
                action: Action::Write {
                    key_with_modifier: None,
                    bytes: pasted_text.as_bytes().to_vec(),
                    is_kitty_keyboard_protocol: false,
                },
                terminal_id: None,
                client_id: None,
                is_cli_client: false,
            });
            os_input.send_to_server(ClientToServerMsg::Action {
                action: Action::Write {
                    key_with_modifier: None,
                    bytes: BRACKETED_PASTE_END.to_vec(),
                    is_kitty_keyboard_protocol: false,
                },
                terminal_id: None,
                client_id: None,
                is_cli_client: false,
            });
        },
        _ => {
            log::error!("Unsupported event: {:#?}", input_event);
        },
    }
}

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{stream::SplitSink, SinkExt};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_util::sync::CancellationToken;

pub fn render_to_client(
    mut stdout_channel_rx: UnboundedReceiver<String>,
    mut client_channel_tx: SplitSink<WebSocket, Message>,
    cancellation_token: CancellationToken,
    should_not_reconnect: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = cancellation_token.cancelled() => {
                    let code = if should_not_reconnect.load(Ordering::Relaxed) {
                        4001u16
                    } else {
                        axum::extract::ws::close_code::NORMAL
                    };
                    let close_frame = CloseFrame {
                        code,
                        reason: "Connection closed".into(),
                    };
                    let close_message = Message::Close(Some(close_frame));
                    if client_channel_tx
                        .send(close_message)
                        .await
                        .is_err()
                    {
                        break;
                    }
                    break;
                }
                result = stdout_channel_rx.recv() => {
                    match result {
                        // Empty renders carry nothing; forwarding them floods every viewer.
                        Some(rendered_bytes) if rendered_bytes.is_empty() => {},
                        Some(rendered_bytes) => {
                            if client_channel_tx
                                .send(Message::Text(rendered_bytes.into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
        }
    });
}

pub fn send_control_messages_to_client(
    mut control_channel_rx: UnboundedReceiver<Message>,
    mut socket_channel_tx: SplitSink<WebSocket, Message>,
) {
    tokio::spawn(async move {
        while let Some(message) = control_channel_rx.recv().await {
            if socket_channel_tx.send(message).await.is_err() {
                break;
            }
        }
    });
}

pub fn parse_stdin(
    buf: &[u8],
    os_input: Box<dyn ClientOsApi>,
    mouse_old_event: &mut MouseEvent,
    session: &mut StdinSession,
) {
    if !session.explicitly_disable_kitty_keyboard_protocol {
        match session.kitty_parser.feed(buf) {
            KittyParseOutcome::Complete(key_with_modifier) => {
                send_key(&*os_input, key_with_modifier, buf.to_vec(), true);
                return;
            },
            KittyParseOutcome::Incomplete | KittyParseOutcome::NoMatch => {},
        }
    }

    // maybe_more = true so termwiz buffers ambiguous prefixes across
    // WebSocket frames; the WebSocket loop calls `session.finalize`
    // after an idle interval to drain any remaining ambiguous events.
    session.dispatch(buf, true, &*os_input, mouse_old_event);
    session.pending_finalize = true;
}

#[cfg(test)]
mod tests {
    use super::{parse_stdin, Action, KeyWithModifier};
    use crate::os_input_output::ClientOsApi;
    use std::io::{BufRead, Cursor, Write};
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use zellij_utils::{
        data::Palette,
        errors::ErrorContext,
        input::mouse::MouseEvent,
        ipc::{ClientToServerMsg, ServerToClientMsg},
        pane_size::Size,
    };

    #[derive(Clone, Debug, Default)]
    struct RecordingOsInput {
        sent_messages: Arc<Mutex<Vec<ClientToServerMsg>>>,
    }

    impl RecordingOsInput {
        fn take_sent_messages(&self) -> Vec<ClientToServerMsg> {
            self.sent_messages.lock().unwrap().clone()
        }
    }

    impl ClientOsApi for RecordingOsInput {
        fn get_terminal_size(&self) -> Size {
            Size::default()
        }
        fn set_raw_mode(&mut self) {}
        fn unset_raw_mode(&self) -> Result<(), std::io::Error> {
            Ok(())
        }
        fn get_stdout_writer(&self) -> Box<dyn Write> {
            Box::new(std::io::sink())
        }
        fn get_stdin_reader(&self) -> Box<dyn BufRead> {
            Box::new(Cursor::new(Vec::<u8>::new()))
        }
        fn update_session_name(&mut self, _new_session_name: String) {}
        fn read_from_stdin(&mut self) -> Result<Vec<u8>, &'static str> {
            Ok(vec![])
        }
        fn box_clone(&self) -> Box<dyn ClientOsApi> {
            Box::new(self.clone())
        }
        fn send_to_server(&self, msg: ClientToServerMsg) {
            self.sent_messages.lock().unwrap().push(msg);
        }
        fn recv_from_server(&self) -> Option<(ServerToClientMsg, ErrorContext)> {
            None
        }
        fn handle_signals(
            &self,
            _sigwinch_cb: Box<dyn Fn()>,
            _quit_cb: Box<dyn Fn()>,
            _resize_receiver: Option<std::sync::mpsc::Receiver<()>>,
        ) {
        }
        fn connect_to_server(&self, _path: &Path) {}
        fn load_palette(&self) -> Palette {
            Palette::default()
        }
        fn enable_mouse(&self) -> anyhow::Result<()> {
            Ok(())
        }
        fn disable_mouse(&self) -> anyhow::Result<()> {
            Ok(())
        }
    }

    /// A typed key as the web client sends it: a write to the focused program.
    fn typed(message: &ClientToServerMsg) -> (KeyWithModifier, Vec<u8>, bool) {
        match message {
            ClientToServerMsg::Action {
                action:
                    Action::Write {
                        key_with_modifier: Some(key),
                        bytes,
                        is_kitty_keyboard_protocol,
                    },
                terminal_id: None,
                is_cli_client: false,
                ..
            } => (key.clone(), bytes.clone(), *is_kitty_keyboard_protocol),
            other => panic!("expected a typed key, got {other:?}"),
        }
    }

    #[test]
    fn ime_multi_char_input_uses_per_char_raw_bytes() {
        let os_input = RecordingOsInput::default();
        let mut mouse_old_event = MouseEvent::new();
        let mut session = super::StdinSession::new(false);

        parse_stdin(
            "你好".as_bytes(),
            Box::new(os_input.clone()),
            &mut mouse_old_event,
            &mut session,
        );

        let sent_messages = os_input.take_sent_messages();
        assert_eq!(sent_messages.len(), 2);

        let raw_bytes: Vec<Vec<u8>> = sent_messages
            .into_iter()
            .map(|message| typed(&message).1)
            .collect();

        assert_eq!(
            raw_bytes,
            vec!["你".as_bytes().to_vec(), "好".as_bytes().to_vec()]
        );
    }

    /// A bare ESC is held until the idle finalize. It must still reach the pane
    /// as byte 27: a pane without the Kitty protocol is written the raw bytes.
    #[test]
    fn bare_escape_keeps_its_byte_when_finalized() {
        use zellij_utils::data::BareKey;
        let os_input = RecordingOsInput::default();
        let mut mouse_old_event = MouseEvent::new();
        let mut session = super::StdinSession::new(false);

        parse_stdin(
            b"\x1b",
            Box::new(os_input.clone()),
            &mut mouse_old_event,
            &mut session,
        );
        assert!(os_input.take_sent_messages().is_empty());
        session.finalize(&os_input, &mut mouse_old_event);

        let sent = os_input.take_sent_messages();
        assert_eq!(sent.len(), 1, "{sent:?}");
        let (key, raw_bytes, _) = typed(&sent[0]);
        assert_eq!(key.bare_key, BareKey::Esc);
        assert_eq!(raw_bytes, vec![0x1b]);
    }

    /// Claude Code's double Escape: the second press lands before the first is
    /// finalized. The pane must still receive both bytes, in order with typing.
    #[test]
    fn quick_escapes_and_typing_reach_the_pane_byte_for_byte() {
        let os_input = RecordingOsInput::default();
        let mut mouse_old_event = MouseEvent::new();
        let mut session = super::StdinSession::new(false);
        for frame in [&b"a"[..], b"\x1b", b"\x1b", b"b", b"\x1b"] {
            parse_stdin(
                frame,
                Box::new(os_input.clone()),
                &mut mouse_old_event,
                &mut session,
            );
        }
        session.finalize(&os_input, &mut mouse_old_event);
        let bytes: Vec<u8> = os_input
            .take_sent_messages()
            .into_iter()
            .flat_map(|message| typed(&message).1)
            .collect();
        assert_eq!(bytes, b"a\x1b\x1bb\x1b");
    }

    #[test]
    fn single_char_input_keeps_original_raw_bytes() {
        let os_input = RecordingOsInput::default();
        let mut mouse_old_event = MouseEvent::new();
        let mut session = super::StdinSession::new(false);

        parse_stdin(
            "a".as_bytes(),
            Box::new(os_input.clone()),
            &mut mouse_old_event,
            &mut session,
        );

        let sent_messages = os_input.take_sent_messages();
        assert_eq!(sent_messages.len(), 1);

        assert_eq!(typed(&sent_messages[0]).1, b"a".to_vec());
    }

    /// Cross-frame fragmentation regression. Under WebSocket transport,
    /// a single ANSI sequence routinely arrives split across two frames.
    /// The per-connection `StdinSession` must keep parser state across
    /// `parse_stdin` calls so a Kitty CSI sequence that crosses a frame
    /// boundary still resolves on the second frame.
    #[test]
    fn fragmented_kitty_sequence_resolves_across_frames() {
        use zellij_utils::data::BareKey;
        let os_input = RecordingOsInput::default();
        let mut mouse_old_event = MouseEvent::new();
        let mut session = super::StdinSession::new(false);

        // Frame 1: prefix only — incomplete.
        parse_stdin(
            b"\x1b[97;",
            Box::new(os_input.clone()),
            &mut mouse_old_event,
            &mut session,
        );
        assert!(
            os_input.take_sent_messages().is_empty(),
            "incomplete Kitty prefix must not emit a key on frame 1"
        );

        // Frame 2: completes the sequence — Kitty parser emits.
        parse_stdin(
            b"5u",
            Box::new(os_input.clone()),
            &mut mouse_old_event,
            &mut session,
        );
        let sent = os_input.take_sent_messages();
        assert_eq!(
            sent.len(),
            1,
            "exactly one Kitty key event after both frames; got {:?}",
            sent
        );
        let (key, _, is_kitty_keyboard_protocol) = typed(&sent[0]);
        assert!(is_kitty_keyboard_protocol);
        assert_eq!(
            key,
            KeyWithModifier::new(BareKey::Char('a')).with_ctrl_modifier()
        );
    }

    #[test]
    fn focus_reports_are_not_typed_into_the_session() {
        let os_input = RecordingOsInput::default();
        let mut mouse_old_event = MouseEvent::new();
        let mut session = super::StdinSession::new(false);

        parse_stdin(
            b"\x1b[O",
            Box::new(os_input.clone()),
            &mut mouse_old_event,
            &mut session,
        );
        parse_stdin(
            b"\x1b[I",
            Box::new(os_input.clone()),
            &mut mouse_old_event,
            &mut session,
        );

        let sent = os_input.take_sent_messages();
        assert_eq!(
            sent,
            vec![
                ClientToServerMsg::HostTerminalFocusChanged { focused: false },
                ClientToServerMsg::HostTerminalFocusChanged { focused: true },
            ],
            "focus reports must become focus messages, never key events"
        );
    }

    #[test]
    fn fragmented_focus_report_resolves_across_frames() {
        let os_input = RecordingOsInput::default();
        let mut mouse_old_event = MouseEvent::new();
        let mut session = super::StdinSession::new(false);

        parse_stdin(
            b"\x1b[",
            Box::new(os_input.clone()),
            &mut mouse_old_event,
            &mut session,
        );
        assert!(
            os_input.take_sent_messages().is_empty(),
            "an incomplete focus report must not emit anything on frame 1"
        );

        parse_stdin(
            b"I",
            Box::new(os_input.clone()),
            &mut mouse_old_event,
            &mut session,
        );
        assert_eq!(
            os_input.take_sent_messages(),
            vec![ClientToServerMsg::HostTerminalFocusChanged { focused: true }],
        );
    }

    /// Plain printable bytes that aren't a Kitty sequence must NOT be
    /// trapped in the long-lived Kitty parser. After `feed()` returns
    /// `NoMatch` and resets, the bytes flow through the termwiz path
    /// and reach the server as ordinary key events.
    #[test]
    fn non_kitty_bytes_pass_through_to_termwiz_path() {
        let os_input = RecordingOsInput::default();
        let mut mouse_old_event = MouseEvent::new();
        let mut session = super::StdinSession::new(false);

        parse_stdin(
            b"ab",
            Box::new(os_input.clone()),
            &mut mouse_old_event,
            &mut session,
        );

        let sent = os_input.take_sent_messages();
        // Two Char events ('a', 'b'), both via the termwiz path.
        assert_eq!(sent.len(), 2);
        for msg in &sent {
            assert!(!typed(msg).2);
        }
    }
}
