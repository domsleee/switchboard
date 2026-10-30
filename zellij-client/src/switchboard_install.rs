//! `zellij switchboard install`: this computer's login and host list on first
//! install, then its background services. Re-running is safe and keeps
//! existing files.
use super::*;
#[cfg(any(target_os = "macos", target_os = "linux", all(unix, test)))]
use serde_json::Value;

/// Helpers the services and the updater run, shipped inside this executable so
/// installing needs no repository checkout.
#[cfg(target_os = "macos")]
const HELPERS: &[(&str, &str)] = &[
    (
        "menu_bar.swift",
        include_str!("../../tools/switchboard/menu_bar.swift"),
    ),
    (
        "update_local.sh",
        include_str!("../../tools/switchboard/update_local.sh"),
    ),
    (
        "install_service.py",
        include_str!("../../tools/switchboard/install_service.py"),
    ),
];
#[cfg(target_os = "linux")]
const HELPERS: &[(&str, &str)] = &[(
    "update_local.sh",
    include_str!("../../tools/switchboard/update_local.sh"),
)];
#[cfg(windows)]
const HELPERS: &[(&str, &str)] = &[
    (
        "install_windows_web.ps1",
        include_str!("../../tools/switchboard/install_windows_web.ps1"),
    ),
    (
        "windows_releases.psm1",
        include_str!("../../tools/switchboard/windows_releases.psm1"),
    ),
    (
        "update_windows.ps1",
        include_str!("../../tools/switchboard/update_windows.ps1"),
    ),
    (
        "windows_cli.ps1",
        include_str!("../../tools/switchboard/windows_cli.ps1"),
    ),
    (
        "update_services_windows.ps1",
        include_str!("../../tools/switchboard/update_services_windows.ps1"),
    ),
];

pub(super) fn install(binary: &Path) -> Result<()> {
    ensure!(
        cfg!(any(target_os = "macos", target_os = "linux", windows)),
        "Switchboard installs on macOS, Linux and Windows"
    );
    #[allow(deprecated)]
    let home = std::env::home_dir().context("No home directory")?;
    let config = home.join(if cfg!(windows) {
        ".config/switchboard/hosts.json"
    } else {
        ".config/zellij/switchboard-hosts.json"
    });
    if ensure_host_config(&config, &computer_name(), cfg!(windows), || {
        zellij_utils::web_authentication_tokens::create_token(None, false)
            .map(|(token, _)| token)
            .map_err(|error| anyhow!("Cannot create a login token: {error:?}"))
    })? {
        println!("Created {}", config.display());
    }
    platform_install(&home, binary)?;
    println!("Connect your computers in Settings → Computers.");
    Ok(())
}

/// First install: a login token for this computer and a host list holding only
/// this computer. Paired computers are added in Settings, never here. Returns
/// whether it created the host list.
fn ensure_host_config(
    config: &Path,
    name: &str,
    windows: bool,
    create_token: impl FnOnce() -> Result<String>,
) -> Result<bool> {
    if config.exists() {
        return Ok(false);
    }
    let directory = config.parent().context("Host list has no directory")?;
    fs::create_dir_all(directory)?;
    let token_file = directory.join("switchboard-token");
    if !token_file.exists() {
        let token = create_token()?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        std::io::Write::write_all(
            &mut options.open(&token_file)?,
            format!("{token}\n").as_bytes(),
        )?;
    }
    let mut host = serde_json::json!({
        "id": if windows { "windows" } else { "mac" },
        "name": name,
        "url": "http://127.0.0.1:8082",
        "token_file": token_file,
    });
    if windows {
        host["escape_transport"] = "local".into();
    }
    let text = serde_json::to_string_pretty(&serde_json::json!({ "hosts": [host] }))?;
    std::io::Write::write_all(
        &mut fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(config)?,
        format!("{text}\n").as_bytes(),
    )?;
    Ok(true)
}

fn computer_name() -> String {
    let name = if cfg!(windows) {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    } else {
        let mut hostname = Command::new("hostname");
        hostname.arg("-s");
        run_command(hostname, Duration::from_secs(5)).unwrap_or_default()
    };
    if name.is_empty() {
        "This computer".into()
    } else {
        name
    }
}

/// Write each helper only when its content changed.
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
fn write_helpers(directory: &Path) -> Result<()> {
    fs::create_dir_all(directory)?;
    for (name, text) in HELPERS {
        let path = directory.join(name);
        if fs::read(&path).ok().as_deref() != Some(text.as_bytes()) {
            fs::write(&path, text)?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn platform_install(home: &Path, binary: &Path) -> Result<()> {
    // The installer copies itself into the tray script and registers it to
    // start at logon; it reads the host list created above.
    let helpers = home.join(".config/switchboard");
    write_helpers(&helpers)?;
    let output = powershell(
        &helpers.join("install_windows_web.ps1"),
        vec!["-Binary".into(), binary.as_os_str().into()],
        &[],
    )?;
    println!("{output}");
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn platform_install(_: &Path, _: &Path) -> Result<()> {
    unreachable!("checked in install")
}

#[cfg(target_os = "macos")]
fn platform_install(home: &Path, binary: &Path) -> Result<()> {
    let agents = home.join("Library/LaunchAgents");
    fs::create_dir_all(&agents)?;
    fs::create_dir_all(home.join("Library/Logs"))?;
    let helpers = home.join(".local/share/switchboard/updater");
    write_helpers(&helpers)?;
    let contents = home.join("Applications/Switchboard.app/Contents");
    let menu = contents.join("MacOS/Switchboard");
    fs::create_dir_all(menu.parent().unwrap())?;
    let mut compile = Command::new("swiftc");
    compile
        .arg(helpers.join("menu_bar.swift"))
        .arg("-o")
        .arg(&menu);
    run_command(compile, Duration::from_secs(180))?;
    write_plist(
        &contents.join("Info.plist"),
        &serde_json::json!({
            "CFBundleIdentifier": "dev.switchboard.menu", "CFBundleName": "Switchboard",
            "CFBundleExecutable": "Switchboard", "CFBundlePackageType": "APPL",
            "CFBundleVersion": "1", "LSUIElement": true, "SwitchboardZellij": binary,
        }),
    )?;
    let shell = nix::unistd::User::from_uid(nix::unistd::getuid())
        .ok()
        .flatten()
        .map(|user| user.shell.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/bin/zsh".into());
    let start = web_start_command(home, &binary.to_string_lossy());
    for (label, job) in mac_jobs(home, binary, &menu, &helpers, &shell, &start) {
        install_job(&agents, label, job)?;
    }
    println!("Switchboard installed: http://127.0.0.1:8090");
    Ok(())
}

/// launchd job definitions, before `Label` and `RunAtLoad` are added.
#[cfg(any(target_os = "macos", all(unix, test)))]
fn mac_jobs(
    home: &Path,
    binary: &Path,
    menu: &Path,
    helpers: &Path,
    shell: &str,
    web_start: &str,
) -> Vec<(&'static str, Value)> {
    let zellij = binary.to_string_lossy();
    let logs = home.join("Library/Logs");
    let log = |name: &str| logs.join(name).to_string_lossy().into_owned();
    // Panes start $SHELL. Pin the login shell so an installing agent's shell never leaks in.
    let h = home.display();
    let env = serde_json::json!({
        "PATH": format!("{h}/.local/bin:{h}/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"),
        "SHELL": shell,
    });
    vec![
        (
            "dev.zellij.switchboard",
            serde_json::json!({
                "ProgramArguments": ["/bin/sh", "-c", relay_command(home, binary, web_start)],
                "WorkingDirectory": helpers, "KeepAlive": true,
                // Unset means launchd throttles CPU and I/O, so keystroke echo stalls under load.
                "ProcessType": "Interactive",
                "StandardOutPath": log("zellij-switchboard.log"),
                "StandardErrorPath": log("zellij-switchboard.log"),
                "EnvironmentVariables": env,
            }),
        ),
        (
            "dev.switchboard.update",
            serde_json::json!({
                // Through sh like the relay job: launchd pins a directly launched program's
                // code hash, and this job replaces that program on every update.
                "ProgramArguments": ["/bin/sh", "-c", format!(
                    "exec {} switchboard update --binary {}", shell_quote(&zellij), shell_quote(&zellij)
                )],
                "StartInterval": 900,
                "StandardOutPath": log("switchboard-update.log"),
                "StandardErrorPath": log("switchboard-update.log"),
                "EnvironmentVariables": env,
            }),
        ),
        (
            "dev.switchboard.menu",
            serde_json::json!({
                "ProgramArguments": [menu], "KeepAlive": false,
                "StandardOutPath": log("switchboard-menu.log"),
                "StandardErrorPath": log("switchboard-menu.log"),
                "EnvironmentVariables": {"SHELL": shell},
            }),
        ),
    ]
}

/// Starts the web server unless it is running, then runs the relay.
#[cfg(any(target_os = "macos", target_os = "linux", all(unix, test)))]
fn relay_command(home: &Path, binary: &Path, web_start: &str) -> String {
    let zellij = binary.to_string_lossy();
    let hosts = home.join(".config/zellij/switchboard-hosts.json");
    format!(
        "{} >/dev/null 2>&1 || {{ {web_start}; }}; exec {}",
        shell_words(&[&zellij, "web", "--status", "--timeout", "2"]),
        shell_words(&[
            &zellij,
            "serve",
            "--host-config",
            &hosts.to_string_lossy(),
            "--port",
            "8090"
        ])
    )
}

#[cfg(target_os = "linux")]
fn platform_install(home: &Path, binary: &Path) -> Result<()> {
    let helpers = home.join(".local/share/switchboard/updater");
    write_helpers(&helpers)?;
    let units = home.join(".config/systemd/user");
    fs::create_dir_all(&units)?;
    let shell = nix::unistd::User::from_uid(nix::unistd::getuid())
        .ok()
        .flatten()
        .map(|user| user.shell.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/bin/bash".into());
    let start = web_start_command(home, &binary.to_string_lossy());
    let mut relay_changed = false;
    for (name, text) in linux_units(home, binary, &helpers, &shell, &start) {
        let path = units.join(name);
        if fs::read(&path).ok().as_deref() != Some(text.as_bytes()) {
            fs::write(&path, text)?;
            relay_changed |= name == "switchboard.service";
        }
    }
    let systemctl = |args: &[&str]| {
        let mut command = Command::new("systemctl");
        command.arg("--user").args(args);
        run_command(command, Duration::from_secs(60)).map(drop)
    };
    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", "switchboard.service", "switchboard-update.timer"])?;
    // An unchanged, running relay stays online.
    systemctl(&[
        if relay_changed { "restart" } else { "start" },
        "switchboard.service",
    ])?;
    systemctl(&["start", "switchboard-update.timer"])?;
    // Without lingering, systemd stops user services when the last login ends.
    let mut linger = Command::new("loginctl");
    linger.arg("enable-linger");
    if let Err(error) = run_command(linger, Duration::from_secs(30)) {
        eprintln!(
            "Switchboard stops when you log out; keep it running with: sudo loginctl enable-linger $USER ({error:#})"
        );
    }
    println!("Switchboard installed: http://127.0.0.1:8090");
    Ok(())
}

/// systemd user units: the relay, and an updater every 15 minutes.
#[cfg(any(target_os = "linux", all(unix, test)))]
fn linux_units(
    home: &Path,
    binary: &Path,
    helpers: &Path,
    shell: &str,
    web_start: &str,
) -> Vec<(&'static str, String)> {
    let zellij = binary.to_string_lossy();
    let h = home.display();
    // Panes start $SHELL. Pin the login shell so an installing agent's shell never leaks in.
    let env = format!(
        "Environment={}\nEnvironment={}\n",
        systemd_quote(&format!(
            "PATH={h}/.local/bin:{h}/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
        )),
        systemd_quote(&format!("SHELL={shell}"))
    );
    let exec = |command: &str| systemd_quote(&command.replace('$', "$$"));
    let relay = format!(
        // Without StartLimitIntervalSec=0, five quick failures (a port still held by
        // the previous relay) would stop systemd restarting the relay at all.
        "[Unit]\nDescription=Switchboard relay and web server\nStartLimitIntervalSec=0\n\n[Service]\n{env}\
         WorkingDirectory={}\nExecStart=/bin/sh -c {}\nRestart=always\nRestartSec=2\n\
         # Restarts stop only the relay: the web server and terminal sessions it started keep running.\n\
         KillMode=process\n\n[Install]\nWantedBy=default.target\n",
        helpers.display(),
        exec(&relay_command(home, binary, web_start))
    );
    let update = format!(
        // A oneshot has no start timeout by default; a hung run would block every later check.
        "[Unit]\nDescription=Switchboard automatic update\n\n[Service]\nType=oneshot\n{env}\
         ExecStart=/bin/sh -c {}\nTimeoutStartSec=30min\n\
         # The web server and relay it restarts must outlive this run.\nKillMode=process\n",
        exec(&format!(
            "exec {} switchboard update --binary {}",
            shell_quote(&zellij),
            shell_quote(&zellij)
        ))
    );
    let timer = "[Unit]\nDescription=Check for Switchboard updates every 15 minutes\n\n\
                 [Timer]\nOnBootSec=2min\nOnUnitActiveSec=15min\n\n[Install]\nWantedBy=timers.target\n";
    vec![
        ("switchboard.service", relay),
        ("switchboard-update.service", update),
        ("switchboard-update.timer", timer.into()),
    ]
}

/// One systemd unit-file word: quoted, with escapes and `%` specifiers kept literal.
#[cfg(any(target_os = "linux", all(unix, test)))]
fn systemd_quote(word: &str) -> String {
    format!(
        "\"{}\"",
        word.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    )
}

/// Starts web daemon mode, first recovering an unshared session only while its
/// original socket still exists (see native-web-recovery.json).
#[cfg(any(target_os = "macos", target_os = "linux", all(unix, test)))]
fn web_start_command(home: &Path, zellij: &str) -> String {
    use std::os::unix::fs::MetadataExt;
    let normal = format!("{} web --daemonize", shell_quote(zellij));
    let recovered = || -> Option<String> {
        let file = home.join(".local/share/switchboard/native-web-recovery.json");
        let policy: Value = serde_json::from_slice(&fs::read(file).ok()?).ok()?;
        let socket = fs::symlink_metadata(policy["socket_path"].as_str()?).ok()?;
        let identity = format!(
            "{}:{}:{}:{}",
            socket.dev(),
            socket.ino(),
            socket.ctime(),
            socket.ctime_nsec()
        );
        (policy["socket_identity"].as_str()? == identity).then(|| {
            let session = policy["session"].as_str().unwrap_or_default();
            format!(
                "env {} {} {} web --daemonize || {normal}",
                shell_quote(&format!("SWITCHBOARD_RECOVER_UNSHARED_SESSION={session}")),
                shell_quote(&format!(
                    "SWITCHBOARD_RECOVER_UNSHARED_SOCKET_IDENTITY={identity}"
                )),
                shell_quote(zellij)
            )
        })
    };
    recovered().unwrap_or(normal)
}

/// Shell words joined into one POSIX command line.
#[cfg(any(target_os = "macos", target_os = "linux", all(unix, test)))]
fn shell_words(words: &[&str]) -> String {
    words
        .iter()
        .map(|w| shell_quote(w))
        .collect::<Vec<_>>()
        .join(" ")
}

/// POSIX shell quoting, as Python's shlex.quote.
#[cfg(any(target_os = "macos", target_os = "linux", all(unix, test)))]
fn shell_quote(word: &str) -> String {
    let safe = !word.is_empty()
        && word
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_@%+=:,./-".contains(&b));
    if safe {
        word.into()
    } else {
        format!("'{}'", word.replace('\'', r#"'"'"'"#))
    }
}

/// launchd reads XML plists; plutil converts the JSON in place.
#[cfg(target_os = "macos")]
fn write_plist(path: &Path, value: &Value) -> Result<()> {
    fs::write(path, serde_json::to_vec(value)?)?;
    let mut convert = Command::new("plutil");
    convert.args(["-convert", "xml1"]).arg(path);
    run_command(convert, Duration::from_secs(30)).map(drop)
}

/// An unchanged, running job is only kicked, never stopped, so reinstalling
/// keeps the live relay online.
#[cfg(target_os = "macos")]
fn install_job(agents: &Path, label: &str, mut job: Value) -> Result<()> {
    job["Label"] = label.into();
    job["RunAtLoad"] = true.into();
    let domain = format!("gui/{}", user_id());
    let service = format!("{domain}/{label}");
    let target = agents.join(format!("{label}.plist"));
    let previous = fs::read(&target).ok();
    write_plist(&target, &job)?;
    let launchctl = |args: &[&str]| {
        Command::new("launchctl")
            .args(args)
            .stdin(Stdio::null())
            .output()
    };
    let loaded = launchctl(&["print", &service])?.status.success();
    if loaded && previous == fs::read(&target).ok() {
        ensure!(
            launchctl(&["kickstart", &service])?.status.success(),
            "Cannot start {label}"
        );
        return Ok(());
    }
    if loaded {
        launchctl(&["bootout", &service])?;
    }
    // launchd can report EIO (5) while the old job finishes removing its resources.
    let target = target.to_string_lossy();
    for _ in 0..60 {
        let result = launchctl(&["bootstrap", &domain, &target])?;
        if result.status.success() {
            return Ok(());
        }
        if result.status.code() != Some(5) {
            bail!(
                "Cannot load {label}: {}",
                String::from_utf8_lossy(&result.stderr).trim()
            );
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    bail!("Cannot load {label}: launchd stayed busy")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_token_creation_leaves_first_install_retryable() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join("hosts.json");
        let token = home.path().join("switchboard-token");
        assert!(
            ensure_host_config(&config, "Desk", true, || bail!("token store unavailable")).is_err()
        );
        assert!(!config.exists());
        assert!(!token.exists());
        assert!(ensure_host_config(&config, "Desk", true, || Ok("t1".into())).unwrap());
        assert_eq!(fs::read_to_string(&token).unwrap(), "t1\n");
    }

    #[test]
    fn first_install_creates_a_private_token_and_never_overwrites() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join(".config/switchboard/hosts.json");
        let token = home.path().join(".config/switchboard/switchboard-token");
        assert!(ensure_host_config(&config, "Desk", true, || Ok("t1".into())).unwrap());
        assert_eq!(fs::read_to_string(&token).unwrap(), "t1\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&token).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let hosts: serde_json::Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        let host = &hosts["hosts"][0];
        assert_eq!(hosts["hosts"].as_array().unwrap().len(), 1);
        assert_eq!(
            (host["id"].as_str(), host["name"].as_str()),
            (Some("windows"), Some("Desk"))
        );
        assert_eq!(host["url"], "http://127.0.0.1:8082");
        assert_eq!(Path::new(host["token_file"].as_str().unwrap()), token);
        assert_eq!(host["escape_transport"], "local");
        // Re-running keeps both files and creates no new token.
        fs::write(&config, "{}").unwrap();
        assert!(!ensure_host_config(&config, "Desk", true, || bail!("no new token")).unwrap());
        assert_eq!(fs::read_to_string(&config).unwrap(), "{}");
        assert_eq!(fs::read_to_string(&token).unwrap(), "t1\n");
        // A missing host list reuses an existing token.
        fs::remove_file(&config).unwrap();
        assert!(ensure_host_config(&config, "Desk", false, || bail!("no new token")).unwrap());
        let hosts: serde_json::Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        assert_eq!(hosts["hosts"][0]["id"], "mac");
        assert!(hosts["hosts"][0].get("escape_transport").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn launch_agents_run_the_installed_executable_with_the_login_shell() {
        let home = Path::new("/Users/me");
        let jobs = mac_jobs(
            home,
            Path::new("/bin/zellij"),
            Path::new("/Users/me/Applications/Switchboard.app/Contents/MacOS/Switchboard"),
            Path::new("/Users/me/.local/share/switchboard/updater"),
            "/opt/login/nu",
            "/bin/zellij web --daemonize",
        );
        let labels: Vec<_> = jobs.iter().map(|(label, _)| *label).collect();
        assert_eq!(
            labels,
            [
                "dev.zellij.switchboard",
                "dev.switchboard.update",
                "dev.switchboard.menu"
            ]
        );
        for (label, job) in &jobs {
            assert_eq!(
                job["EnvironmentVariables"]["SHELL"], "/opt/login/nu",
                "{label}"
            );
        }
        let job = |label| &jobs.iter().find(|(l, _)| *l == label).unwrap().1;
        assert_eq!(
            job("dev.switchboard.update")["ProgramArguments"],
            serde_json::json!([
                "/bin/sh",
                "-c",
                "exec /bin/zellij switchboard update --binary /bin/zellij"
            ])
        );
        assert_eq!(job("dev.switchboard.update")["StartInterval"], 900);
        assert_eq!(
            job("dev.zellij.switchboard")["ProgramArguments"][2],
            "/bin/zellij web --status --timeout 2 >/dev/null 2>&1 || { /bin/zellij web --daemonize; }; \
             exec /bin/zellij serve --host-config /Users/me/.config/zellij/switchboard-hosts.json --port 8090"
        );
        assert_eq!(job("dev.zellij.switchboard")["KeepAlive"], true);
        assert_eq!(job("dev.zellij.switchboard")["ProcessType"], "Interactive");
        assert_eq!(job("dev.switchboard.menu")["KeepAlive"], false);
        assert_eq!(
            job("dev.switchboard.menu")["StandardOutPath"],
            "/Users/me/Library/Logs/switchboard-menu.log"
        );
        assert_eq!(shell_quote("it's here"), r#"'it'"'"'s here'"#);
    }

    #[cfg(unix)]
    #[test]
    fn systemd_units_restart_only_the_relay_and_update_every_15_minutes() {
        let units = linux_units(
            Path::new("/home/me"),
            Path::new("/home/me/.cargo/bin/zellij"),
            Path::new("/home/me/.local/share/switchboard/updater"),
            "/usr/bin/nu",
            "/home/me/.cargo/bin/zellij web --daemonize",
        );
        let unit = |name| &units.iter().find(|(n, _)| *n == name).unwrap().1;
        let relay = unit("switchboard.service");
        assert!(relay.contains(
            "ExecStart=/bin/sh -c \"/home/me/.cargo/bin/zellij web --status --timeout 2 >/dev/null 2>&1 || \
             { /home/me/.cargo/bin/zellij web --daemonize; }; exec /home/me/.cargo/bin/zellij serve \
             --host-config /home/me/.config/zellij/switchboard-hosts.json --port 8090\"\n"
        ));
        for name in ["switchboard.service", "switchboard-update.service"] {
            assert!(unit(name).contains("\nKillMode=process\n"), "{name}");
            assert!(
                unit(name).contains("Environment=\"SHELL=/usr/bin/nu\"\n"),
                "{name}"
            );
        }
        assert!(relay.contains("\nRestart=always\n"));
        assert!(relay.contains("\nStartLimitIntervalSec=0\n"));
        assert!(unit("switchboard-update.service").contains("\nTimeoutStartSec=30min\n"));
        assert!(unit("switchboard-update.service").contains(
            "ExecStart=/bin/sh -c \"exec /home/me/.cargo/bin/zellij switchboard update --binary /home/me/.cargo/bin/zellij\"\n"
        ));
        assert!(unit("switchboard-update.timer").contains("\nOnUnitActiveSec=15min\n"));
        // systemd would otherwise expand these itself.
        assert_eq!(systemd_quote(r#"a "b" \ 100%"#), r#""a \"b\" \\ 100%%""#);
    }

    #[cfg(unix)]
    #[test]
    fn web_recovery_applies_only_to_the_original_socket() {
        use std::os::unix::fs::MetadataExt;
        let home = tempfile::tempdir().unwrap();
        let socket = home.path().join("main");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let metadata = fs::symlink_metadata(&socket).unwrap();
        let identity = format!(
            "{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec()
        );
        let policy = home
            .path()
            .join(".local/share/switchboard/native-web-recovery.json");
        fs::create_dir_all(policy.parent().unwrap()).unwrap();
        let write = |identity: &str| {
            fs::write(
                &policy,
                serde_json::json!({"session":"main","socket_path":socket,"socket_identity":identity}).to_string(),
            )
            .unwrap()
        };
        write(&identity);
        let command = web_start_command(home.path(), "/bin/zellij");
        assert!(command.contains("SWITCHBOARD_RECOVER_UNSHARED_SESSION=main"));
        assert!(command.ends_with(" || /bin/zellij web --daemonize"));
        write("stale");
        assert_eq!(
            web_start_command(home.path(), "/bin/zellij"),
            "/bin/zellij web --daemonize"
        );
    }
}
