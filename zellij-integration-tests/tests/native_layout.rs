#![cfg(unix)]

use zellij_integration_tests::{col, keys, TestRunner, TERMINAL_SIZE};
use zellij_utils::{cli::CliAction, data::LayoutInfo};

const LEGACY_LAYOUT: &str = r#"
layout {
    pane size=1 borderless=true { plugin location="zellij:tab-bar"; }
    pane
    pane size=2 borderless=true { plugin location="zellij:status-bar"; }
}
"#;

#[test]
fn legacy_layout_and_background_plugins_leave_one_full_size_terminal() {
    let mut zellij = TestRunner::new(TERMINAL_SIZE)
        .with_config("load_plugins { \"zellij:link\"; }")
        .with_layout(LayoutInfo::Stringified(LEGACY_LAYOUT.into()))
        .start();
    let terminal = zellij.expect_pty_spawn();
    terminal.output(b"$ ");
    zellij.wait_until("native prompt renders without plugin bars", |grid| {
        grid.cursor_is_at(col(2).row(0))
    });
    terminal.wait_for_size("terminal fills the display", |cols, rows| {
        cols as usize == TERMINAL_SIZE.cols && rows as usize == TERMINAL_SIZE.rows
    });
    assert!(!zellij.snapshot().tab_bar_appears());
    assert!(!zellij.snapshot().status_bar_appears());
    zellij.quit();
}

#[test]
fn explicit_plugin_launch_and_new_tab_requests_fail_without_losing_input() {
    let mut zellij = TestRunner::new(TERMINAL_SIZE).start();
    let terminal = zellij.expect_pty_spawn();
    terminal.output(b"$ ");
    zellij.wait_until("initial native prompt", |grid| {
        grid.cursor_is_at(col(2).row(0))
    });
    for _ in 0..5 {
        assert_eq!(
            zellij.run_cli_action(CliAction::StartOrReloadPlugin {
                url: "zellij:tab-bar".into(),
                configuration: None,
            }),
            2
        );
        assert_eq!(
            zellij.run_cli_action(CliAction::NewTab {
                name: None,
                layout: None,
                layout_string: None,
                layout_dir: None,
                cwd: None,
                initial_command: vec![],
                initial_plugin: Some("zellij:tab-bar".into()),
                close_on_exit: false,
                start_suspended: false,
                block_until_exit_success: false,
                block_until_exit_failure: false,
                block_until_exit: false,
                no_focus: false,
            }),
            2
        );
    }
    zellij.send_stdin(b"still-running");
    terminal.wait_for_stdin("plugin rejection keeps original terminal usable", |bytes| {
        bytes.windows(13).any(|window| window == b"still-running")
    });
    zellij.quit();
}

#[test]
fn new_tab_and_close_work_without_the_plugin_coordinator() {
    let mut zellij = TestRunner::new(TERMINAL_SIZE).start();
    let first = zellij.expect_pty_spawn();
    first.output(b"first prompt");
    zellij.wait_until("first terminal ready", |grid| grid.contains("first prompt"));
    zellij.send_stdin(&keys::ctrl('t'));
    zellij.send_stdin(&keys::key('n'));
    let second = zellij.expect_pty_spawn();
    second.output(b"second prompt");
    zellij.wait_until("new tab focused", |grid| {
        grid.contains("second prompt") && !grid.contains("first prompt")
    });
    zellij.send_stdin(&keys::ctrl('t'));
    zellij.send_stdin(&keys::key('x'));
    zellij.wait_until("closing returns to the original terminal", |grid| {
        grid.contains("first prompt") && !grid.contains("second prompt")
    });
    zellij.quit();
}
