//! A per-session process that owns terminals so an engine can be replaced
//! without losing them. See docs/SWITCHBOARD_TERMINAL_HOST.md.
mod boundary;
mod buffer;
mod client;
#[cfg(test)]
mod handoff_tests;
pub mod host;
mod protocol;

#[allow(unused_imports)] // Used once engines can hand a session over.
pub(crate) use boundary::SequenceTracker;
pub(crate) use client::HostedPtyBackend;

use interprocess::local_socket::{prelude::*, Listener, ListenerOptions, Stream};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use uuid::Uuid;

pub(crate) const ENABLE: &str = "SWITCHBOARD_TERMINAL_HOST";

pub(crate) fn enabled() -> bool {
    std::env::var(ENABLE).map_or(true, |value| value != "0")
}

fn new_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn root() -> io::Result<PathBuf> {
    zellij_utils::handoff::hosts_root()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home directory"))
}

/// Private directory holding a host's token.
struct HostDirectory {
    path: PathBuf,
}

impl HostDirectory {
    fn create() -> io::Result<Self> {
        let root = root()?;
        fs::create_dir_all(&root)?;
        // Short enough for Unix socket paths under a long home directory.
        let id = Uuid::new_v4().simple().to_string()[..12].to_string();
        let path = root.join(id);
        create_private_directory(&path)?;
        write_private_file(&path.join("token"), new_token().as_bytes())?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn endpoint(&self) -> PathBuf {
        endpoint_for(&self.path)
    }

    fn read_token(&self) -> io::Result<String> {
        fs::read_to_string(self.path.join("token"))
    }
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(path)
}

#[cfg(windows)]
fn create_private_directory(path: &Path) -> io::Result<()> {
    // Under the user's profile, which only the user and administrators can read.
    fs::create_dir(path)
}

#[cfg(unix)]
fn write_private_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?
        .write_all(contents)
}

#[cfg(windows)]
fn write_private_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    fs::write(path, contents)
}

#[cfg(unix)]
fn endpoint_for(directory: &Path) -> PathBuf {
    directory.join("s")
}

#[cfg(windows)]
fn endpoint_for(directory: &Path) -> PathBuf {
    let id = directory.file_name().unwrap_or_default().to_string_lossy();
    PathBuf::from(format!("switchboard-terminal-host-{id}"))
}

#[cfg(unix)]
fn bind_endpoint(endpoint: &Path) -> io::Result<Listener> {
    let name = endpoint.to_fs_name::<interprocess::local_socket::GenericFilePath>()?;
    ListenerOptions::new().name(name).create_sync()
}

#[cfg(windows)]
fn bind_endpoint(endpoint: &Path) -> io::Result<Listener> {
    use interprocess::os::windows::{
        local_socket::ListenerOptionsExt, security_descriptor::SecurityDescriptor,
    };
    use widestring::U16CString;
    let name = endpoint
        .as_os_str()
        .to_ns_name::<interprocess::local_socket::GenericNamespaced>()?;
    // Owner only: the default named pipe DACL lets every user read.
    let owner_only = U16CString::from_str("D:P(A;;GA;;;OW)")
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    ListenerOptions::new()
        .name(name)
        .security_descriptor(SecurityDescriptor::deserialize(&owner_only)?)
        .create_sync()
}

#[cfg(unix)]
fn connect_endpoint(endpoint: &Path) -> io::Result<Stream> {
    Stream::connect(endpoint.to_fs_name::<interprocess::local_socket::GenericFilePath>()?)
}

#[cfg(windows)]
fn connect_endpoint(endpoint: &Path) -> io::Result<Stream> {
    Stream::connect(
        endpoint
            .as_os_str()
            .to_ns_name::<interprocess::local_socket::GenericNamespaced>()?,
    )
}

/// Start a host that outlives this engine process.
fn spawn_host_process(directory: &Path) -> io::Result<()> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("terminal-host")
        .arg("--dir")
        .arg(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            nix::unistd::setsid().map_err(io::Error::from)?;
            Ok(())
        });
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{
            CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS,
        };
        command.creation_flags(
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
        );
    }
    command.spawn().map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::os_input_output::AsyncReader;
    use crate::panes::PaneId;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use zellij_utils::errors::ZellijError;
    use zellij_utils::input::command::RunCommand;

    struct TestHost {
        directory: tempfile::TempDir,
        endpoint: PathBuf,
        token: String,
        server: Option<std::thread::JoinHandle<io::Result<()>>>,
    }

    fn start_host() -> TestHost {
        let directory = tempfile::tempdir().unwrap();
        let token = new_token();
        fs::write(directory.path().join("token"), &token).unwrap();
        let endpoint = endpoint_for(directory.path());
        let path = directory.path().to_path_buf();
        let server = std::thread::spawn(move || host::serve(&path));
        TestHost {
            directory,
            endpoint,
            token,
            server: Some(server),
        }
    }

    fn shell() -> RunCommand {
        RunCommand {
            command: PathBuf::from(if cfg!(windows) { "cmd.exe" } else { "sh" }),
            ..Default::default()
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap()
    }

    fn read_until(
        runtime: &tokio::runtime::Runtime,
        reader: &mut Box<dyn AsyncReader>,
        marker: &str,
    ) -> bool {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut output = Vec::new();
        let mut buf = vec![0; 65536];
        while Instant::now() < deadline {
            let read = runtime.block_on(async {
                tokio::time::timeout(Duration::from_millis(500), reader.read(&mut buf)).await
            });
            match read {
                Ok(Ok(0)) | Ok(Err(_)) => break,
                Ok(Ok(count)) => {
                    output.extend_from_slice(&buf[..count]);
                    if String::from_utf8_lossy(&output).contains(marker) {
                        return true;
                    }
                },
                Err(_) => {},
            }
        }
        panic!(
            "missing {marker:?} in output: {}",
            String::from_utf8_lossy(&output)
        );
    }

    #[test]
    fn a_hosted_shell_runs_typed_commands_and_reports_its_exit() {
        let host = start_host();
        let backend = HostedPtyBackend::connect(&host.endpoint, &host.token).unwrap();
        let runtime = runtime();
        let (exited, exit) = mpsc::channel();
        let (mut reader, pid) = backend
            .spawn_terminal(
                shell(),
                None,
                Box::new(move |pane, status, _| {
                    let _ = exited.send((pane, status));
                }),
                1,
            )
            .unwrap();
        assert_ne!(pid, 0);
        let mut pending: &[u8] = if cfg!(windows) {
            b"set /a 40+2\rexit\r"
        } else {
            b"echo $((40+2))\nexit\n"
        };
        while !pending.is_empty() {
            let accepted = backend.write_to_tty_stdin(1, pending).unwrap();
            pending = &pending[accepted..];
        }
        assert!(read_until(&runtime, &mut reader, "42"));
        let (pane, status) = exit.recv_timeout(Duration::from_secs(20)).unwrap();
        assert_eq!(pane, PaneId::Terminal(1));
        assert_eq!(status, Some(0));
        backend.clear_terminal_id(1);
        drop(host.directory);
    }

    #[test]
    fn a_missing_command_is_reported_as_not_found() {
        let host = start_host();
        let backend = HostedPtyBackend::connect(&host.endpoint, &host.token).unwrap();
        let error = backend
            .spawn_terminal(
                RunCommand {
                    command: PathBuf::from("switchboard-no-such-command"),
                    ..Default::default()
                },
                None,
                Box::new(|_, _, _| {}),
                1,
            )
            .err()
            .expect("spawn should fail");
        assert!(matches!(
            error.downcast_ref::<ZellijError>(),
            Some(ZellijError::CommandNotFound { terminal_id: 1, .. })
        ));
    }

    #[test]
    fn a_blocked_exit_callback_does_not_stop_replies() {
        let host = start_host();
        let backend = HostedPtyBackend::connect(&host.endpoint, &host.token).unwrap();
        let (entered, callback_entered) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let (_exiting, _) = backend
            .spawn_terminal(
                shell(),
                None,
                Box::new(move |_, _, _| {
                    let _ = entered.send(());
                    let _ = released.recv();
                }),
                1,
            )
            .unwrap();
        let (_running, _) = backend
            .spawn_terminal(shell(), None, Box::new(|_, _, _| {}), 2)
            .unwrap();
        let exit: &[u8] = if cfg!(windows) { b"exit\r" } else { b"exit\n" };
        backend.write_to_tty_stdin(1, exit).unwrap();
        callback_entered
            .recv_timeout(Duration::from_secs(20))
            .unwrap();
        let (written, write_finished) = mpsc::channel();
        let writer = backend.clone();
        std::thread::spawn(move || {
            let _ = written.send(writer.write_to_tty_stdin(2, b"x").is_ok());
        });
        assert_eq!(
            write_finished.recv_timeout(Duration::from_secs(10)),
            Ok(true)
        );
        drop(release);
    }

    #[test]
    fn an_oversized_write_is_accepted_in_part() {
        let host = start_host();
        let backend = HostedPtyBackend::connect(&host.endpoint, &host.token).unwrap();
        let (_reader, _) = backend
            .spawn_terminal(shell(), None, Box::new(|_, _, _| {}), 1)
            .unwrap();
        let accepted = backend
            .write_to_tty_stdin(1, &vec![b'a'; 2 * 1024 * 1024])
            .unwrap();
        assert!(accepted <= 64 * 1024);
    }

    #[test]
    fn requests_fail_after_the_host_is_lost() {
        let host = start_host();
        let backend = HostedPtyBackend::connect(&host.endpoint, &host.token).unwrap();
        backend.fail_connection();
        let (finished, result) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = finished.send(backend.tcdrain(1).is_err());
        });
        assert_eq!(result.recv_timeout(Duration::from_secs(10)), Ok(true));
    }

    #[test]
    fn a_wrong_token_is_refused() {
        let host = start_host();
        assert!(HostedPtyBackend::connect(&host.endpoint, "wrong").is_err());
    }

    #[test]
    fn losing_the_engine_stops_its_terminals_and_the_host() {
        let mut host = start_host();
        let backend = HostedPtyBackend::connect(&host.endpoint, &host.token).unwrap();
        let (_reader, pid) = backend
            .spawn_terminal(shell(), None, Box::new(|_, _, _| {}), 1)
            .unwrap();
        backend.disconnect();
        host.server.take().unwrap().join().unwrap().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let pid = sysinfo::Pid::from_u32(pid);
        loop {
            let mut system = sysinfo::System::new();
            system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
            if system.process(pid).is_none() {
                break;
            }
            assert!(Instant::now() < deadline, "hosted shell is still running");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
