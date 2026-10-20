use crate::os_input_output::{
    resize_windows_terminal, resolve_command, windows_pane_environment, AsyncReader,
};
use crate::panes::PaneId;

use std::{
    collections::BTreeMap,
    ffi::OsStr,
    io,
    os::windows::ffi::OsStrExt,
    os::windows::io::{FromRawHandle, IntoRawHandle, OwnedHandle},
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use tokio::io::AsyncReadExt;
use tokio::net::windows::named_pipe::NamedPipeServer;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, S_OK};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FlushFileBuffers, WriteFile, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, GenerateConsoleCtrlEvent, ResizePseudoConsole, COORD,
    CTRL_C_EVENT, HPCON,
};
use windows_sys::Win32::System::Pipes::CreateNamedPipeW;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, OpenProcess, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
    PROCESS_INFORMATION, PROCESS_TERMINATE, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
};

use zellij_utils::{errors::prelude::*, input::command::RunCommand};

pub use async_trait::async_trait;

// Not exported by windows-sys; value from the Windows SDK.
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x00020016;
const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x00080000;
const PIPE_ACCESS_INBOUND: u32 = 0x00000001;
const PIPE_ACCESS_OUTBOUND: u32 = 0x00000002;
const PIPE_TYPE_BYTE: u32 = 0;
const PIPE_WAIT: u32 = 0;
const PIPE_NOWAIT: u32 = 0x00000001;
const GENERIC_READ: u32 = 0x80000000;
const GENERIC_WRITE: u32 = 0x40000000;

/// Monotonic counter so each ConPTY pipe gets a unique name, even when
/// re-spawning on the same `terminal_id` (the old async reader may still hold
/// the previous pipe handle).
static PIPE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Per-terminal ConPTY state.
struct ConPtyTerminal {
    hpcon: HPCON,
    input_write_handle: HANDLE,
    size: (u16, u16),
}

// HANDLE/HPCON are raw pointers in windows-sys >= 0.59; OS handles are
// safe to send across threads.
unsafe impl Send for ConPtyTerminal {}
unsafe impl Sync for ConPtyTerminal {}

impl Drop for ConPtyTerminal {
    fn drop(&mut self) {
        unsafe {
            // Close the pseudo console first — it may write a final VT frame
            // to the output pipe. The async reader task (if still alive) will
            // drain it. Then close the remaining handle.
            ClosePseudoConsole(self.hpcon);
            CloseHandle(self.input_write_handle);
        }
    }
}

/// An `AsyncReader` backed by a named pipe connected to ConPTY output.
///
/// Construction stores the raw `OwnedHandle`. The first `read()` call promotes
/// it to a `NamedPipeServer` (IOCP registration requires a live Tokio reactor,
/// which is not available at `spawn_terminal` time).
struct ConPtyAsyncReader {
    pending: Option<OwnedHandle>,
    pipe: Option<NamedPipeServer>,
}

// OwnedHandle is Send+Sync; NamedPipeServer is Send.
// The reader is only ever used from a single async task (via &mut self),
// so Sync is safe.
unsafe impl Sync for ConPtyAsyncReader {}

impl ConPtyAsyncReader {
    fn new(handle: OwnedHandle) -> Self {
        Self {
            pending: Some(handle),
            pipe: None,
        }
    }
}

#[async_trait]
impl AsyncReader for ConPtyAsyncReader {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, io::Error> {
        if let Some(handle) = self.pending.take() {
            let pipe = unsafe { NamedPipeServer::from_raw_handle(handle.into_raw_handle()) }?;
            self.pipe = Some(pipe);
        }
        let pipe = self
            .pipe
            .as_mut()
            .expect("ConPtyAsyncReader used after init");
        pipe.read(buf).await
    }
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/// Encode a Rust string as null-terminated UTF-16.
fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Quote a single argument per the `CommandLineToArgvW` convention.
///
/// Rules:
///   * n backslashes not followed by a quote are n literal backslashes.
///   * 2n backslashes followed by a quote produce n backslashes and a
///     delimiting quote.
///   * 2n+1 backslashes followed by a quote produce n backslashes and
///     a literal quote.
fn append_quoted_arg(cmdline: &mut String, arg: &str) {
    if !(arg.is_empty() || arg.contains(' ') || arg.contains('\t') || arg.contains('"')) {
        cmdline.push_str(arg);
        return;
    }
    cmdline.push('"');
    let mut backslashes: usize = 0;
    for ch in arg.chars() {
        if ch == '\\' {
            backslashes += 1;
        } else if ch == '"' {
            for _ in 0..(backslashes * 2 + 1) {
                cmdline.push('\\');
            }
            backslashes = 0;
            cmdline.push('"');
        } else {
            for _ in 0..backslashes {
                cmdline.push('\\');
            }
            backslashes = 0;
            cmdline.push(ch);
        }
    }
    // Double any trailing backslashes so the closing quote still terminates
    // the argument rather than being escaped.
    for _ in 0..(backslashes * 2) {
        cmdline.push('\\');
    }
    cmdline.push('"');
}

/// Build a Windows command-line string from a `RunCommand`, following the
/// `CommandLineToArgvW` quoting convention.
fn build_command_line_string(cmd: &RunCommand) -> String {
    let mut cmdline = String::new();

    // Executable — always quote to handle spaces in paths.
    let exe = cmd.command.to_string_lossy();
    cmdline.push('"');
    cmdline.push_str(&exe);
    cmdline.push('"');

    for arg in &cmd.args {
        cmdline.push(' ');
        append_quoted_arg(&mut cmdline, arg);
    }

    cmdline
}

fn build_command_line(cmd: &RunCommand) -> Vec<u16> {
    to_wide(&build_command_line_string(cmd))
}

/// Build a UTF-16 environment block (each entry `KEY=VALUE\0`, terminated by
/// an extra `\0`) with terminal capability defaults and the pane identity.
fn build_environment_block(terminal_id: u32) -> Vec<u16> {
    let mut block: Vec<u16> = Vec::new();
    for (key, value) in windows_pane_environment(std::env::vars(), terminal_id) {
        let entry = format!("{}={}", key, value);
        block.extend(OsStr::new(&entry).encode_wide());
        block.push(0);
    }
    block.push(0); // double-null terminator
    block
}

/// Create an overlapped named-pipe pair for ConPTY output.
///
/// Returns `(server_read_handle, client_write_handle)` where the server
/// (read) end has `FILE_FLAG_OVERLAPPED` for IOCP and the client (write) end
/// is synchronous (required by ConPTY).
fn create_overlapped_output_pipe(terminal_id: u32) -> io::Result<(HANDLE, HANDLE)> {
    let seq = PIPE_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = format!(
        r"\\.\pipe\zellij-pty-{}-{}-{}",
        std::process::id(),
        terminal_id,
        seq
    );
    let wide_name = to_wide(&name);

    let server = unsafe {
        CreateNamedPipeW(
            wide_name.as_ptr(),
            PIPE_ACCESS_INBOUND | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_WAIT,
            1,     // max instances
            0,     // out buffer (we only read)
            65536, // in buffer
            0,     // default timeout
            std::ptr::null(),
        )
    };
    if server == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }

    let client = unsafe {
        CreateFileW(
            wide_name.as_ptr(),
            GENERIC_WRITE,
            0,                    // no sharing
            std::ptr::null(),     // default security
            OPEN_EXISTING,        // pipe already exists
            0,                    // synchronous
            std::ptr::null_mut(), // no template
        )
    };
    if client == INVALID_HANDLE_VALUE {
        unsafe { CloseHandle(server) };
        return Err(io::Error::last_os_error());
    }

    Ok((server, client))
}

/// ConPTY reads synchronously; the shared writer must return partial writes or
/// zero when full, so one busy terminal cannot stall input to every other pane.
fn create_input_pipe(terminal_id: u32) -> io::Result<(HANDLE, HANDLE)> {
    let seq = PIPE_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = to_wide(&format!(
        r"\\.\pipe\zellij-pty-input-{}-{}-{}",
        std::process::id(),
        terminal_id,
        seq
    ));
    let write = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_NOWAIT,
            1,
            65536,
            0,
            0,
            std::ptr::null(),
        )
    };
    if write == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let read = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if read == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        unsafe { CloseHandle(write) };
        return Err(error);
    }
    Ok((read, write))
}

fn try_write_input(handle: HANDLE, buf: &[u8]) -> io::Result<usize> {
    // Windows can reject an oversized nonblocking write even when the pipe has space.
    let buf = &buf[..buf.len().min(4096)];
    let mut written = 0;
    let ok = unsafe {
        WriteFile(
            handle,
            buf.as_ptr(),
            buf.len() as u32,
            &mut written,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(written as usize)
    }
}

/// Create a ConPTY pseudo console of the given size attached to the provided
/// pipes.
fn create_conpty(
    cols: u16,
    rows: u16,
    input_read: HANDLE,
    output_write: HANDLE,
) -> io::Result<HPCON> {
    let size = COORD {
        X: cols as i16,
        Y: rows as i16,
    };
    let mut hpcon: HPCON = 0;
    let hr = unsafe { CreatePseudoConsole(size, input_read, output_write, 0, &mut hpcon) };
    if hr != S_OK {
        Err(io::Error::from_raw_os_error(hr))
    } else {
        Ok(hpcon)
    }
}

/// Spawn a child process attached to the given ConPTY.
///
/// Returns `(process_handle, thread_handle, child_pid)`.
fn spawn_child_process(
    hpcon: HPCON,
    cmd: &RunCommand,
    terminal_id: u32,
) -> io::Result<(HANDLE, HANDLE, u32)> {
    // --- proc thread attribute list ---
    let mut attr_size: usize = 0;
    unsafe {
        InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attr_size);
    }
    let mut attr_buf = vec![0u8; attr_size];
    let attr_list = attr_buf.as_mut_ptr().cast();

    if unsafe { InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size) } == 0 {
        return Err(io::Error::last_os_error());
    }

    // N.B. For PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, lpValue is the HPCON
    // value itself (not a pointer to it). In C, HPCON is `void*` so passing
    // it directly as PVOID is natural. In Rust, HPCON is `isize`, so we cast
    // the value to a pointer. This matches the Microsoft ConPTY sample.
    // See: https://github.com/microsoft/terminal/issues/6705
    if unsafe {
        UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            hpcon as *const core::ffi::c_void,
            std::mem::size_of::<HPCON>(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        unsafe { DeleteProcThreadAttributeList(attr_list) };
        return Err(io::Error::last_os_error());
    }

    // --- startup info ---
    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    // Prevent the service's redirected standard streams from being duplicated
    // into the shell. Null handles let ConPTY provide the console streams.
    // https://github.com/microsoft/terminal/discussions/15814
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.lpAttributeList = attr_list;

    // --- command line & environment ---
    let mut cmd_line = build_command_line(cmd);
    let env_block = build_environment_block(terminal_id);

    let cwd: Option<Vec<u16>> = cmd.cwd.as_ref().and_then(|p| {
        if p.exists() && p.is_dir() {
            Some(to_wide(&p.to_string_lossy()))
        } else {
            log::error!(
                "CWD for new pane '{}' does not exist or is not a directory",
                p.display()
            );
            None
        }
    });
    let cwd_ptr = cwd.as_ref().map_or(std::ptr::null(), |v| v.as_ptr());

    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    let ok = unsafe {
        CreateProcessW(
            std::ptr::null(),      // lpApplicationName
            cmd_line.as_mut_ptr(), // lpCommandLine (mutable)
            std::ptr::null(),      // lpProcessAttributes
            std::ptr::null(),      // lpThreadAttributes
            0,                     // bInheritHandles = FALSE
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            env_block.as_ptr().cast(),              // lpEnvironment
            cwd_ptr,                                // lpCurrentDirectory
            &si.StartupInfo as *const STARTUPINFOW, // lpStartupInfo
            &mut pi,                                // lpProcessInformation
        )
    };

    unsafe { DeleteProcThreadAttributeList(attr_list) };

    if ok == 0 {
        return Err(io::Error::last_os_error());
    }

    Ok((pi.hProcess, pi.hThread, pi.dwProcessId))
}

fn terminate_process(pid: u32) -> std::result::Result<(), std::io::Error> {
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let ok = TerminateProcess(handle, 1);
        CloseHandle(handle);
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// WindowsPtyBackend
// ---------------------------------------------------------------------------

/// Windows PTY backend using native ConPTY with IOCP-based async I/O.
#[derive(Clone)]
pub(crate) struct WindowsPtyBackend {
    terminals: Arc<Mutex<BTreeMap<u32, Option<ConPtyTerminal>>>>,
    next_terminal_id_counter: Arc<AtomicU32>,
}

impl WindowsPtyBackend {
    pub fn new() -> Result<Self, io::Error> {
        Ok(Self {
            terminals: Arc::new(Mutex::new(BTreeMap::new())),
            next_terminal_id_counter: Arc::new(AtomicU32::new(0)),
        })
    }

    /// Core spawn logic — creates ConPTY, spawns child, sets up exit monitor.
    fn do_spawn(
        &self,
        cmd: RunCommand,
        quit_cb: Box<dyn Fn(PaneId, Option<i32>, RunCommand) + Send>,
        terminal_id: u32,
    ) -> Result<(Box<dyn AsyncReader>, u32)> {
        let err_context = |c: &RunCommand| {
            format!(
                "failed to spawn terminal for '{}'",
                c.command.to_string_lossy()
            )
        };

        // 1. Output pipe pair (named, overlapped read end for IOCP)
        let (output_read, output_write) =
            create_overlapped_output_pipe(terminal_id).with_context(|| err_context(&cmd))?;

        // 2. Input pipe pair
        let (input_read, input_write) = match create_input_pipe(terminal_id) {
            Ok(pipe) => pipe,
            Err(error) => {
                unsafe {
                    CloseHandle(output_read);
                    CloseHandle(output_write);
                }
                return Err(error).with_context(|| err_context(&cmd));
            },
        };

        // 3. Create pseudo console
        let hpcon = match create_conpty(80, 24, input_read, output_write) {
            Ok(h) => h,
            Err(e) => {
                unsafe {
                    CloseHandle(output_read);
                    CloseHandle(output_write);
                    CloseHandle(input_read);
                    CloseHandle(input_write);
                }
                return Err(e).with_context(|| err_context(&cmd));
            },
        };

        // 4. ConPTY duplicated the pipe ends it needs; close our copies.
        unsafe {
            CloseHandle(input_read);
            CloseHandle(output_write);
        }

        // 5. Spawn child process
        let (process_handle, thread_handle, child_pid) =
            match spawn_child_process(hpcon, &cmd, terminal_id) {
                Ok(r) => r,
                Err(e) => {
                    unsafe {
                        ClosePseudoConsole(hpcon);
                        CloseHandle(input_write);
                        CloseHandle(output_read);
                    }
                    return Err(e).with_context(|| err_context(&cmd));
                },
            };

        // Thread handle is not needed after spawn.
        unsafe { CloseHandle(thread_handle) };

        // 6. Store per-terminal state
        self.terminals.lock().unwrap().insert(
            terminal_id,
            Some(ConPtyTerminal {
                hpcon,
                input_write_handle: input_write,
                size: (80, 24),
            }),
        );

        // 7. Exit-monitoring thread (zero CPU — spends all time in kernel wait)
        // Pass the HANDLE through as `usize` because raw pointers are not
        // Send. Windows OS handles are safe to use cross-thread.
        let cmd_for_monitor = cmd.clone();
        let process_handle_addr = process_handle as usize;
        std::thread::spawn(move || {
            let process_handle = process_handle_addr as HANDLE;
            let exit_code = unsafe {
                WaitForSingleObject(process_handle, INFINITE);
                let mut code: u32 = 0;
                GetExitCodeProcess(process_handle, &mut code);
                CloseHandle(process_handle);
                code
            };
            quit_cb(
                PaneId::Terminal(terminal_id),
                Some(exit_code as i32),
                cmd_for_monitor,
            );
        });

        // 8. Wrap the output read handle in an async reader
        let owned = unsafe { OwnedHandle::from_raw_handle(output_read as *mut core::ffi::c_void) };
        let reader = Box::new(ConPtyAsyncReader::new(owned)) as Box<dyn AsyncReader>;

        Ok((reader, child_pid))
    }

    pub fn spawn_terminal(
        &self,
        mut cmd: RunCommand,
        failover_cmd: Option<RunCommand>,
        quit_cb: Box<dyn Fn(PaneId, Option<i32>, RunCommand) + Send>,
        terminal_id: u32,
    ) -> Result<(Box<dyn AsyncReader>, u32)> {
        if let Some(resolved) = resolve_command(&cmd) {
            cmd.command = resolved;
            return self.do_spawn(cmd, quit_cb, terminal_id);
        }
        if let Some(mut failover) = failover_cmd {
            if let Some(resolved) = resolve_command(&failover) {
                failover.command = resolved;
                return self.do_spawn(failover, quit_cb, terminal_id);
            }
        }
        Err(ZellijError::CommandNotFound {
            terminal_id,
            command: cmd.command.to_string_lossy().to_string(),
        })
        .context("failed to spawn terminal")
    }

    pub fn set_terminal_size(
        &self,
        terminal_id: u32,
        cols: u16,
        rows: u16,
        _width_in_pixels: Option<u16>,
        _height_in_pixels: Option<u16>,
    ) -> Result<()> {
        let err_context = || {
            format!(
                "failed to set terminal {} to size ({}, {})",
                terminal_id, cols, rows
            )
        };

        let started = std::time::Instant::now();
        match self
            .terminals
            .lock()
            .to_anyhow()
            .with_context(err_context)?
            .get_mut(&terminal_id)
        {
            Some(Some(term)) => {
                let previous = term.size;
                let hpcon = term.hpcon;
                let resized = resize_windows_terminal(&mut term.size, cols, rows, |cols, rows| {
                    let size = COORD {
                        X: cols as i16,
                        Y: rows as i16,
                    };
                    let hr = unsafe { ResizePseudoConsole(hpcon, size) };
                    if hr == S_OK {
                        Ok(())
                    } else {
                        Err::<(), _>(anyhow!("ResizePseudoConsole failed: HRESULT 0x{:08x}", hr))
                    }
                });
                let elapsed = started.elapsed();
                if elapsed.as_millis() >= 100 {
                    log::warn!(
                        "Slow ConPTY resize: terminal={} old={}x{} new={}x{} elapsed_ms={} applied={}",
                        terminal_id, previous.0, previous.1, cols, rows, elapsed.as_millis(),
                        matches!(&resized, Ok(true)),
                    );
                }
                resized.with_context(err_context).non_fatal();
            },
            _ => {
                Err::<(), _>(anyhow!("no ConPTY terminal found for id {}", terminal_id))
                    .with_context(err_context)
                    .non_fatal();
            },
        }
        Ok(())
    }

    pub fn write_to_tty_stdin(&self, terminal_id: u32, buf: &[u8]) -> Result<usize> {
        let err_context = || format!("failed to write to stdin of terminal {}", terminal_id);

        match self
            .terminals
            .lock()
            .to_anyhow()
            .with_context(err_context)?
            .get(&terminal_id)
        {
            Some(Some(term)) => {
                try_write_input(term.input_write_handle, buf).with_context(err_context)
            },
            _ => Err(anyhow!("no ConPTY terminal found for id {}", terminal_id))
                .with_context(err_context),
        }
    }

    pub fn tcdrain(&self, terminal_id: u32) -> Result<()> {
        let err_context = || format!("failed to drain terminal {}", terminal_id);

        match self
            .terminals
            .lock()
            .to_anyhow()
            .with_context(err_context)?
            .get(&terminal_id)
        {
            Some(Some(term)) => {
                let ok = unsafe { FlushFileBuffers(term.input_write_handle) };
                if ok == 0 {
                    // FlushFileBuffers can legitimately fail on pipe handles
                    // (ERROR_INVALID_FUNCTION) — treat as non-fatal.
                    let e = io::Error::last_os_error();
                    log::debug!("FlushFileBuffers on terminal {}: {}", terminal_id, e);
                }
                Ok(())
            },
            _ => Err(anyhow!("no ConPTY terminal found for id {}", terminal_id))
                .with_context(err_context),
        }
    }

    pub fn kill(&self, pid: u32) -> Result<()> {
        terminate_process(pid).with_context(|| format!("failed to kill pid {}", pid))?;
        Ok(())
    }

    pub fn force_kill(&self, pid: u32) -> Result<()> {
        terminate_process(pid).with_context(|| format!("failed to force-kill pid {}", pid))?;
        Ok(())
    }

    pub fn send_sigint(&self, pid: u32) -> Result<()> {
        let ok = unsafe { GenerateConsoleCtrlEvent(CTRL_C_EVENT, pid) };
        if ok != 0 {
            Ok(())
        } else {
            terminate_process(pid)
                .with_context(|| format!("failed to send SIGINT to pid {}", pid))?;
            Ok(())
        }
    }

    pub fn reserve_terminal_id(&self, terminal_id: u32) {
        self.terminals.lock().unwrap().insert(terminal_id, None);
    }

    pub fn clear_terminal_id(&self, terminal_id: u32) {
        self.terminals.lock().unwrap().remove(&terminal_id);
    }

    pub fn next_terminal_id(&self) -> Option<u32> {
        Some(
            self.next_terminal_id_counter
                .fetch_add(1, Ordering::Relaxed),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::windows::io::AsRawHandle;
    use std::path::PathBuf;
    use std::time::Duration;

    fn input_pipe() -> (std::fs::File, std::fs::File) {
        let (read, write) = create_input_pipe(0).unwrap();
        unsafe {
            (
                std::fs::File::from_raw_handle(read),
                std::fs::File::from_raw_handle(write),
            )
        }
    }

    #[test]
    fn stalled_input_does_not_block_other_terminals() {
        let (stalled_reader, stalled_writer) = input_pipe();
        let (mut healthy_reader, healthy_writer) = input_pipe();
        let (sent, received) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = (|| -> io::Result<usize> {
                let input = vec![b'x'; 1024 * 1024];
                let mut accepted = 0;
                loop {
                    let written =
                        try_write_input(stalled_writer.as_raw_handle(), &input[accepted..])?;
                    if written == 0 {
                        break;
                    }
                    accepted += written;
                    assert!(accepted < input.len(), "the fixture must fill the pipe");
                }
                assert_eq!(
                    try_write_input(healthy_writer.as_raw_handle(), b"typed")?,
                    5
                );
                Ok(accepted)
            })();
            sent.send(result).unwrap();
        });
        let progress = received.recv_timeout(Duration::from_secs(2));
        // Release a synchronous writer before asserting so the regression cannot hang the suite.
        drop(stalled_reader);
        worker.join().unwrap();
        let accepted = progress
            .expect("a full input pipe blocked typing in another terminal")
            .unwrap();
        assert!(accepted > 0);
        let mut typed = [0; 5];
        healthy_reader.read_exact(&mut typed).unwrap();
        assert_eq!(&typed, b"typed");
    }

    #[test]
    fn input_resumes_without_losing_or_reordering_bytes() {
        let (mut reader, writer) = input_pipe();
        let input: Vec<u8> = (0..256 * 1024).map(|i| (i % 251) as u8).collect();
        let mut output = Vec::new();
        let mut offset = 0;
        while offset < input.len() {
            let start = offset;
            while offset < input.len() {
                let written = try_write_input(writer.as_raw_handle(), &input[offset..]).unwrap();
                if written == 0 {
                    break;
                }
                offset += written;
            }
            assert!(offset > start);
            let mut chunk = vec![0; offset - start];
            reader.read_exact(&mut chunk).unwrap();
            output.extend(chunk);
        }
        assert_eq!(output, input);
    }

    #[test]
    fn closed_input_reports_an_error_instead_of_backpressure() {
        let (reader, writer) = input_pipe();
        drop(reader);
        assert!(try_write_input(writer.as_raw_handle(), b"typed").is_err());
    }

    #[test]
    fn typed_input_reaches_a_real_conpty_child() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let backend = WindowsPtyBackend::new().unwrap();
        let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("cmd.exe");
        let command = RunCommand {
            command: shell,
            args: [
                "/d",
                "/q",
                "/v:on",
                "/c",
                "set /p value= & echo received:!value! & set /p finish=",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            ..Default::default()
        };
        let (exited, exit) = std::sync::mpsc::channel();
        let (mut reader, pid) = backend
            .do_spawn(
                command,
                Box::new(move |_, _, _| {
                    let _ = exited.send(());
                }),
                0,
            )
            .unwrap();
        let received = runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(10), async {
                let input = b"fixture\r";
                anyhow::ensure!(backend.write_to_tty_stdin(0, input)? == input.len());
                let mut output = Vec::new();
                let mut buffer = [0; 4096];
                loop {
                    let count = reader.read(&mut buffer).await?;
                    anyhow::ensure!(count > 0, "ConPTY exited before echoing the input");
                    output.extend_from_slice(&buffer[..count]);
                    if output
                        .windows(b"received:fixture".len())
                        .any(|part| part == b"received:fixture")
                    {
                        break;
                    }
                }
                Ok::<(), anyhow::Error>(())
            })
            .await
        });
        let stopped = if exit.try_recv().is_err() {
            backend.kill(pid)
        } else {
            Ok(())
        };
        backend.clear_terminal_id(0);
        stopped.unwrap();
        received
            .expect("typed input did not reach the isolated ConPTY child")
            .unwrap();
    }

    fn cmd(exe: &str, args: &[&str]) -> RunCommand {
        RunCommand {
            command: PathBuf::from(exe),
            args: args.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn plain_arg_is_left_unquoted() {
        let s = build_command_line_string(&cmd("nvim", &["hello"]));
        assert_eq!(s, "\"nvim\" hello");
    }

    #[test]
    fn arg_with_space_is_quoted() {
        let s = build_command_line_string(&cmd("nvim", &["hello world"]));
        assert_eq!(s, "\"nvim\" \"hello world\"");
    }

    // Regression: zellij edit with a Windows backslash path plus a space in
    // the path used to eat every backslash inside the quoted arg. See
    // https://github.com/zellij-org/zellij/issues/5293.
    #[test]
    fn backslash_path_with_space_preserves_backslashes() {
        let path = r"C:\Users\me\Folder With Space\README.md";
        let s = build_command_line_string(&cmd("nvim", &[path]));
        assert_eq!(
            s,
            "\"nvim\" \"C:\\Users\\me\\Folder With Space\\README.md\""
        );
    }

    #[test]
    fn embedded_quote_is_escaped_with_odd_backslashes() {
        // Input arg: a"b (contains a literal quote). It should be emitted
        // as a\"b inside a quoted arg.
        let s = build_command_line_string(&cmd("prog", &["a\"b"]));
        assert_eq!(s, "\"prog\" \"a\\\"b\"");
    }

    #[test]
    fn backslash_before_embedded_quote_gets_doubled() {
        // Input arg: a\"b — one literal backslash, then a literal quote.
        // Must emit 3 backslashes then a quote so CommandLineToArgvW parses
        // back to a\"b.
        let s = build_command_line_string(&cmd("prog", &["a\\\"b c"]));
        assert_eq!(s, "\"prog\" \"a\\\\\\\"b c\"");
    }

    #[test]
    fn trailing_backslash_before_closing_quote_gets_doubled() {
        // "path with space\" would let the trailing backslash escape the
        // closing quote. The trailing backslash must be doubled.
        let s = build_command_line_string(&cmd("prog", &["C:\\my path\\"]));
        assert_eq!(s, "\"prog\" \"C:\\my path\\\\\"");
    }
}
