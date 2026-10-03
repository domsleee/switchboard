use std::net::{IpAddr, Ipv4Addr};

use clap::{CommandFactory, Parser};
use zellij_utils::cli::{CliArgs, Command};

#[test]
fn verify_cli() {
    CliArgs::command().debug_assert();
}

#[test]
fn existing_only_attach_requires_a_named_existing_target_without_creation_options() {
    assert!(CliArgs::try_parse_from(["zellij", "attach", "--existing-only", "main"]).is_ok());
    for args in [
        vec!["zellij", "attach", "--existing-only"],
        vec!["zellij", "attach", "--existing-only", "--create", "main"],
        vec!["zellij", "attach", "--existing-only", "--create-background", "main"],
        vec!["zellij", "attach", "--existing-only", "--force-run-commands", "main"],
    ] {
        assert!(CliArgs::try_parse_from(args).is_err());
    }
}

#[test]
fn existing_session_web_sharing_can_be_enabled_or_disabled_without_plugins() {
    for (value, enabled) in [("on", true), ("off", false)] {
        let args =
            CliArgs::try_parse_from(["zellij", "-s", "main", "action", "set-web-sharing", value])
                .unwrap();
        assert!(matches!(
            args.command,
            Some(Command::Action(action))
                if matches!(*action, zellij_utils::cli::CliAction::SetWebSharing { enabled: actual } if actual == enabled)
        ));
    }
    assert!(CliArgs::try_parse_from(["zellij", "action", "set-web-sharing", "disabled"]).is_err());
}

#[test]
fn web_cli_status_alone_works() {
    let args = CliArgs::try_parse_from(["zellij", "web", "--status"]);
    assert!(args.is_ok());
    if let Ok(CliArgs {
        command: Some(Command::Web(web)),
        ..
    }) = args
    {
        assert!(web.status);
        assert!(web.timeout.is_none());
    } else {
        panic!("Expected Web command");
    }
}

#[test]
fn web_cli_status_with_timeout_works() {
    let args = CliArgs::try_parse_from(["zellij", "web", "--status", "--timeout", "5"]);
    assert!(args.is_ok());
    if let Ok(CliArgs {
        command: Some(Command::Web(web)),
        ..
    }) = args
    {
        assert!(web.status);
        assert_eq!(web.timeout, Some(5));
    } else {
        panic!("Expected Web command");
    }
}

#[test]
fn web_cli_timeout_with_status_works() {
    // Test with --timeout before --status (order shouldn't matter)
    let args = CliArgs::try_parse_from(["zellij", "web", "--timeout", "10", "--status"]);
    assert!(args.is_ok());
    if let Ok(CliArgs {
        command: Some(Command::Web(web)),
        ..
    }) = args
    {
        assert!(web.status);
        assert_eq!(web.timeout, Some(10));
    } else {
        panic!("Expected Web command");
    }
}

#[test]
fn web_cli_timeout_without_status_fails() {
    let args = CliArgs::try_parse_from(["zellij", "web", "--timeout", "5"]);
    assert!(args.is_err());
}

#[test]
fn web_cli_status_with_start_fails() {
    let args = CliArgs::try_parse_from(["zellij", "web", "--status", "--start"]);
    assert!(args.is_err());
}

#[test]
fn web_cli_status_with_stop_fails() {
    let args = CliArgs::try_parse_from(["zellij", "web", "--status", "--stop"]);
    assert!(args.is_err());
}

#[test]
fn web_cli_status_with_ip_works() {
    let args = CliArgs::try_parse_from(["zellij", "web", "--status", "--ip", "127.0.0.1"]);
    assert!(args.is_ok());
    if let Ok(CliArgs {
        command: Some(Command::Web(web)),
        ..
    }) = args
    {
        assert!(web.status);
        assert_eq!(web.ip, Some(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
    } else {
        panic!("Expected Web command");
    }
}

#[test]
fn web_cli_status_with_port_works() {
    let args = CliArgs::try_parse_from(["zellij", "web", "--status", "--port", "9000"]);
    assert!(args.is_ok());
    if let Ok(CliArgs {
        command: Some(Command::Web(web)),
        ..
    }) = args
    {
        assert!(web.status);
        assert_eq!(web.port, Some(9000));
    } else {
        panic!("Expected Web command");
    }
}

#[test]
fn web_cli_status_with_ip_and_port_works() {
    let args = CliArgs::try_parse_from([
        "zellij", "web", "--status", "--ip", "0.0.0.0", "--port", "9000",
    ]);
    assert!(args.is_ok());
    if let Ok(CliArgs {
        command: Some(Command::Web(web)),
        ..
    }) = args
    {
        assert!(web.status);
        assert_eq!(web.ip, Some(IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0))));
        assert_eq!(web.port, Some(9000));
    } else {
        panic!("Expected Web command");
    }
}
