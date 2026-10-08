//! Correlated Windows session pipes. The legacy protocol paired two shared
//! listeners by accept order, which crossed replies after concurrent connects or
//! a client dying between its two connects. Each new connection instead supplies
//! a random, private reply endpoint on a separate, versioned command endpoint.
//!
//! Also compiled on Unix in tests so cancellation/concurrency regressions run on
//! developer machines as well as Windows CI. No session marker files are created.
use interprocess::local_socket::{prelude::*, Listener, ListenerOptions, Stream};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use uuid::Uuid;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(5);

fn command_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push("-paired-v1");
    name.into()
}

fn reply_path(id: Uuid) -> PathBuf {
    // Keep Unix test socket names below sockaddr_un's length limit. On Windows
    // this is a namespaced pipe name, not a file or a session discovery marker.
    #[cfg(windows)]
    let base = PathBuf::new();
    #[cfg(unix)]
    let base = PathBuf::from("/tmp");
    base.join(format!("zellij-reply-{id}"))
}

fn bind_endpoint(path: &Path) -> io::Result<Listener> {
    #[cfg(windows)]
    let name = path
        .as_os_str()
        .to_ns_name::<interprocess::local_socket::GenericNamespaced>()?;
    #[cfg(unix)]
    let name = path.to_fs_name::<interprocess::local_socket::GenericFilePath>()?;
    ListenerOptions::new().name(name).create_sync()
}

fn connect_endpoint(path: &Path) -> io::Result<Stream> {
    #[cfg(windows)]
    let name = path
        .as_os_str()
        .to_ns_name::<interprocess::local_socket::GenericNamespaced>()?;
    #[cfg(unix)]
    let name = path.to_fs_name::<interprocess::local_socket::GenericFilePath>()?;
    Stream::connect(name)
}

/// Bind before publishing the legacy session marker so new clients never race
/// startup and accidentally select the legacy transport for a new engine.
pub fn bind(path: &Path) -> io::Result<Listener> {
    bind_endpoint(&command_path(path))
}

fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "session IPC pairing timed out")
}

// PIPE_NOWAIT reads are not portable: Windows reports an empty live pipe as
// ERROR_NO_DATA, which interprocess maps to EOF. Peek before a blocking read so
// a slow handshake is not mistaken for a disconnected client.
#[cfg(windows)]
fn bytes_ready(stream: &Stream) -> io::Result<bool> {
    use std::os::windows::io::{AsHandle, AsRawHandle};
    use windows_sys::Win32::Foundation::{ERROR_BROKEN_PIPE, ERROR_PIPE_NOT_CONNECTED};
    use windows_sys::Win32::System::Pipes::PeekNamedPipe;
    let Stream::NamedPipe(pipe) = stream;
    let mut available = 0;
    // SAFETY: pipe owns the handle throughout this call; all optional outputs
    // are null and available is a valid output pointer. No bytes are consumed.
    let ok = unsafe {
        PeekNamedPipe(
            pipe.as_handle().as_raw_handle(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut available,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        let error = io::Error::last_os_error();
        return match error.raw_os_error().map(|code| code as u32) {
            Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED) => {
                Err(io::ErrorKind::UnexpectedEof.into())
            },
            _ => Err(error),
        };
    }
    Ok(available > 0)
}

fn read_before(stream: &mut Stream, buffer: &mut [u8], deadline: Instant) -> io::Result<()> {
    #[cfg(unix)]
    stream.set_nonblocking(true)?;
    let mut received = 0;
    while received < buffer.len() {
        if Instant::now() >= deadline {
            return Err(timed_out());
        }
        #[cfg(windows)]
        if !bytes_ready(stream)? {
            std::thread::sleep(POLL_INTERVAL);
            continue;
        }
        match stream.read(&mut buffer[received..]) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(count) => received += count,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(POLL_INTERVAL);
            },
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
            Err(error) => return Err(error),
        }
    }
    #[cfg(unix)]
    stream.set_nonblocking(false)?;
    Ok(())
}

/// Complete one accepted command connection. The caller runs each handshake on
/// its own thread; a stalled client must not hold up other session connections.
pub fn accept(mut command: Stream) -> io::Result<(Stream, Stream)> {
    let mut id = [0u8; 16];
    read_before(&mut command, &mut id, Instant::now() + HANDSHAKE_TIMEOUT)?;
    let reply = connect_endpoint(&reply_path(Uuid::from_bytes(id)))?;
    Ok((command, reply))
}

/// None means this engine predates the paired protocol. Only a missing command
/// endpoint permits legacy fallback: a failed handshake must never open an
/// unrelated legacy command connection as a side effect.
pub fn try_connect(path: &Path) -> io::Result<Option<(Stream, Stream)>> {
    let id = Uuid::new_v4();
    let listener = bind_endpoint(&reply_path(id))?;
    listener.set_nonblocking(interprocess::local_socket::ListenerNonblockingMode::Accept)?;
    let mut command = match connect_endpoint(&command_path(path)) {
        Ok(command) => command,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    command.write_all(id.as_bytes())?;
    // Do not flush: Windows FlushFileBuffers waits for the server to read, which
    // defeats the bounded handshake when the peer is stalled.
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    loop {
        match listener.accept() {
            Ok(reply) => return Ok(Some((command, reply))),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(timed_out());
                }
                std::thread::sleep(POLL_INTERVAL);
            },
            Err(error) => return Err(error),
        }
    }
}

/// Old running engines remain accessible during rolling upgrades. They still
/// need their original transport; updating the relay cannot repair their code.
#[cfg(windows)]
pub fn connect(path: &Path) -> io::Result<(Stream, Stream)> {
    if let Some(pair) = try_connect(path)? {
        return Ok(pair);
    }
    let command = crate::consts::ipc_connect(path)?;
    let reply = crate::consts::ipc_connect_reply(path)?;
    Ok((command, reply))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;

    fn test_path() -> PathBuf {
        #[cfg(windows)]
        let base = std::env::temp_dir();
        #[cfg(unix)]
        let base = PathBuf::from("/tmp");
        base.join(format!("zipc-{}", Uuid::new_v4()))
    }

    fn exchange(pair: (Stream, Stream), expected: u8) {
        let (mut command, mut reply) = pair;
        command.write_all(&[expected]).unwrap();
        let mut response = [0];
        read_before(
            &mut reply,
            &mut response,
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(response[0], expected);
    }

    fn echo(command: Stream) {
        let (mut command, mut reply) = accept(command).unwrap();
        let mut request = [0];
        command.read_exact(&mut request).unwrap();
        reply.write_all(&request).unwrap();
    }

    #[test]
    fn windows_ipc_concurrent_replies_follow_their_command() {
        let path = test_path();
        let listener = bind(&path).unwrap();
        let server = thread::spawn(move || {
            let mut workers = vec![];
            for _ in 0..24 {
                let command = listener.accept().unwrap();
                workers.push(thread::spawn(move || echo(command)));
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        let clients: Vec<_> = (0..24)
            .map(|value| {
                let path = path.clone();
                thread::spawn(move || exchange(try_connect(&path).unwrap().unwrap(), value))
            })
            .collect();
        for client in clients {
            client.join().unwrap();
        }
        server.join().unwrap();
    }

    #[test]
    fn windows_ipc_cancelled_and_stalled_clients_do_not_steal_next_reply() {
        let path = test_path();
        let listener = bind(&path).unwrap();
        // One client disappears halfway through its ID; another never sends it.
        let mut cancelled = connect_endpoint(&command_path(&path)).unwrap();
        cancelled.write_all(&[0; 8]).unwrap();
        let cancelled_server = listener.accept().unwrap();
        drop(cancelled);
        let stalled = connect_endpoint(&command_path(&path)).unwrap();
        let stalled_server = listener.accept().unwrap();
        let cancelled_worker = thread::spawn(move || accept(cancelled_server));
        let stalled_worker = thread::spawn(move || accept(stalled_server));
        let server = thread::spawn(move || echo(listener.accept().unwrap()));
        exchange(try_connect(&path).unwrap().unwrap(), 73);
        assert_eq!(
            cancelled_worker.join().unwrap().unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        assert_eq!(
            stalled_worker.join().unwrap().unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        drop(stalled);
        server.join().unwrap();
    }

    #[test]
    fn windows_ipc_reversed_handshakes_and_pipelined_commands_stay_paired() {
        let path = test_path();
        let listener = bind(&path).unwrap();
        assert!(
            !path.exists(),
            "paired listener must not publish a session marker"
        );
        let first_id = Uuid::new_v4();
        let second_id = Uuid::new_v4();
        let first_replies = bind_endpoint(&reply_path(first_id)).unwrap();
        let second_replies = bind_endpoint(&reply_path(second_id)).unwrap();
        let mut first = connect_endpoint(&command_path(&path)).unwrap();
        let first_server = listener.accept().unwrap();
        let mut second = connect_endpoint(&command_path(&path)).unwrap();
        let second_server = listener.accept().unwrap();
        // Complete B before A, with each application byte immediately after its
        // handshake. Neither order nor buffered payloads may change the pairing.
        second.write_all(second_id.as_bytes()).unwrap();
        second.write_all(&[22]).unwrap();
        first.write_all(first_id.as_bytes()).unwrap();
        first.write_all(&[11]).unwrap();
        echo(second_server);
        echo(first_server);
        let mut value = [0];
        first_replies
            .accept()
            .unwrap()
            .read_exact(&mut value)
            .unwrap();
        assert_eq!(value, [11]);
        second_replies
            .accept()
            .unwrap()
            .read_exact(&mut value)
            .unwrap();
        assert_eq!(value, [22]);
    }

    #[test]
    fn windows_ipc_cancelled_reply_listener_does_not_poison_following_connection() {
        let path = test_path();
        let listener = bind(&path).unwrap();
        let id = Uuid::new_v4();
        let replies = bind_endpoint(&reply_path(id)).unwrap();
        let mut command = connect_endpoint(&command_path(&path)).unwrap();
        let accepted = listener.accept().unwrap();
        command.write_all(id.as_bytes()).unwrap();
        drop(replies);
        assert!(accept(accepted).is_err());
        let server = thread::spawn(move || echo(listener.accept().unwrap()));
        exchange(try_connect(&path).unwrap().unwrap(), 91);
        server.join().unwrap();
    }

    #[test]
    fn windows_ipc_missing_endpoint_allows_legacy_but_failed_handshake_does_not() {
        let path = test_path();
        assert!(try_connect(&path).unwrap().is_none());
        let listener = bind(&path).unwrap();
        let (done, wait) = mpsc::channel();
        let server = thread::spawn(move || {
            let _command = listener.accept().unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        assert_eq!(
            try_connect(&path).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        done.send(()).unwrap();
        server.join().unwrap();
    }
}
