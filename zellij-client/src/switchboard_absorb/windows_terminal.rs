//! Windows Terminal. It has no tab API, so a tab is a shell whose parent is WindowsTerminal.exe,
//! reached through that shell's console: the tab's id is the shell's pid.

use super::{ForeignTab, Terminal};
use anyhow::{bail, Context, Result};
use std::ptr::null;
use windows_sys::Win32::Foundation::{
    CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::*;
use windows_sys::Win32::System::Threading::{
    OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, VkKeyScanW, MAPVK_VK_TO_VSC,
};

pub struct WindowsTerminal;

/// The shells Windows Terminal runs, from (pid, parent, executable name) rows. Each tab's
/// OpenConsole.exe is a sibling of its shell, not its parent.
pub(super) fn tab_shells<'a>(
    rows: impl Iterator<Item = (u32, Option<u32>, &'a str)> + Clone,
) -> Vec<u32> {
    let terminals: Vec<u32> = rows
        .clone()
        .filter(|(_, _, name)| name.eq_ignore_ascii_case("WindowsTerminal.exe"))
        .map(|(pid, ..)| pid)
        .collect();
    let mut shells: Vec<u32> = rows
        .filter(|(_, parent, name)| {
            parent.is_some_and(|p| terminals.contains(&p))
                && !name.eq_ignore_ascii_case("OpenConsole.exe")
        })
        .map(|(pid, ..)| pid)
        .collect();
    shells.sort();
    shells
}

fn pid(id: &str) -> Result<u32> {
    id.parse()
        .with_context(|| format!("Bad Windows Terminal tab id {id}"))
}

fn last_error(what: &str) -> anyhow::Error {
    anyhow::anyhow!("{what}: {}", std::io::Error::last_os_error())
}

/// The other processes on the console this process is attached to.
fn console_peers() -> Vec<u32> {
    let mut pids = [0u32; 256];
    let count = unsafe { GetConsoleProcessList(pids.as_mut_ptr(), pids.len() as u32) } as usize;
    let me = std::process::id();
    pids[..count.min(pids.len())]
        .iter()
        .copied()
        .filter(|p| *p != me)
        .collect()
}

fn terminate(pid: u32) {
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !process.is_null() {
            TerminateProcess(process, 0);
            CloseHandle(process);
        }
    }
}

/// Run `f` attached to `shell`'s console, then return to this process's own console.
// shortcut: with no other process on our console (absorb run as a tab's own command) we can't
// reattach and further output is lost; run it from a shell.
fn with_console<T>(shell: u32, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let own = console_peers().first().copied();
    unsafe {
        // While attached, a Ctrl-C in that console must not end this process.
        SetConsoleCtrlHandler(None, 1);
        FreeConsole();
        let result = if AttachConsole(shell) != 0 {
            let result = f();
            FreeConsole();
            result
        } else {
            Err(last_error("Can't attach to the tab's console"))
        };
        if let Some(own) = own {
            AttachConsole(own);
        }
        SetConsoleCtrlHandler(None, 0);
        result
    }
}

fn open(name: &str) -> Result<HANDLE> {
    let name: Vec<u16> = name.encode_utf16().chain([0]).collect();
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(last_error("Can't open the tab's console"));
    }
    Ok(handle)
}

fn title() -> String {
    let mut title = [0u16; 1024];
    let len = unsafe { GetConsoleTitleW(title.as_mut_ptr(), title.len() as u32) } as usize;
    String::from_utf16_lossy(&title[..len.min(title.len())])
}

/// Key-down and key-up records for `text`, with the key and modifiers that type each character.
/// Written into the input buffer, even Ctrl-C arrives as a key and raises no CTRL_C_EVENT.
pub(super) fn key_records(text: &str) -> Vec<INPUT_RECORD> {
    let mut records = Vec::new();
    for unit in text.encode_utf16() {
        // Low byte: the key. High byte: 1 Shift, 2 Ctrl, 4 Alt. -1 when no key types it.
        let key = unsafe { VkKeyScanW(unit) };
        let (vk, mods) = if key == -1 {
            (0, 0)
        } else {
            ((key & 0xFF) as u16, (key >> 8) as u32)
        };
        let state = [
            (1, SHIFT_PRESSED),
            (2, LEFT_CTRL_PRESSED),
            (4, LEFT_ALT_PRESSED),
        ]
        .into_iter()
        .filter(|(bit, _)| mods & bit != 0)
        .fold(0, |state, (_, flag)| state | flag);
        let scan = unsafe { MapVirtualKeyW(vk.into(), MAPVK_VK_TO_VSC) } as u16;
        for down in [1, 0] {
            records.push(INPUT_RECORD {
                EventType: KEY_EVENT as u16,
                Event: INPUT_RECORD_0 {
                    KeyEvent: KEY_EVENT_RECORD {
                        bKeyDown: down,
                        wRepeatCount: 1,
                        wVirtualKeyCode: vk,
                        wVirtualScanCode: scan,
                        uChar: KEY_EVENT_RECORD_0 { UnicodeChar: unit },
                        dwControlKeyState: state,
                    },
                },
            });
        }
    }
    records
}

impl Terminal for WindowsTerminal {
    fn tabs(&self) -> Result<Vec<ForeignTab>> {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        let names: Vec<(u32, Option<u32>, String)> = system
            .processes()
            .iter()
            .map(|(pid, p)| {
                (
                    pid.as_u32(),
                    p.parent().map(|p| p.as_u32()),
                    p.name().to_string_lossy().into_owned(),
                )
            })
            .collect();
        let shells = tab_shells(
            names
                .iter()
                .map(|(pid, parent, name)| (*pid, *parent, name.as_str())),
        );
        // An elevated tab refuses the attach, so it drops out here.
        Ok(shells
            .into_iter()
            .filter_map(|shell| {
                let title = with_console(shell, || Ok(title())).ok()?;
                Some(ForeignTab {
                    id: shell.to_string(),
                    title,
                    shell_pid: shell,
                })
            })
            .collect())
    }

    fn screen(&self, id: &str) -> Result<String> {
        with_console(pid(id)?, || {
            let out = open("CONOUT$")?;
            let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
            let ok = unsafe { GetConsoleScreenBufferInfo(out, &mut info) };
            let window = info.srWindow;
            let width = (window.Right - window.Left + 1).max(0) as usize;
            let mut lines = Vec::new();
            for y in window.Top..=window.Bottom {
                if ok == 0 {
                    break;
                }
                let mut line = vec![0u16; width];
                let mut read = 0;
                let at = COORD {
                    X: window.Left,
                    Y: y,
                };
                unsafe {
                    ReadConsoleOutputCharacterW(out, line.as_mut_ptr(), width as u32, at, &mut read)
                };
                lines.push(
                    String::from_utf16_lossy(&line[..read as usize])
                        .trim_end()
                        .to_owned(),
                );
            }
            unsafe { CloseHandle(out) };
            if ok == 0 {
                return Err(last_error("Can't read the tab's screen"));
            }
            Ok(lines.join("\n"))
        })
    }

    fn type_text(&self, id: &str, text: &str) -> Result<()> {
        let records = key_records(text);
        with_console(pid(id)?, || {
            let input = open("CONIN$")?;
            let mut result = Ok(());
            // One key at a time: Codex reads keys arriving together as a paste, and pasted
            // "/exit" is sent as a message instead of running the command.
            for (i, key) in records.chunks(2).enumerate() {
                if i > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                let mut written = 0;
                let ok = unsafe { WriteConsoleInputW(input, key.as_ptr(), 2, &mut written) };
                if ok == 0 || written != 2 {
                    result = Err(last_error("Can't type into the tab"));
                    break;
                }
            }
            unsafe { CloseHandle(input) };
            result
        })
    }

    fn close(&self, id: &str) -> Result<()> {
        let shell = pid(id)?;
        let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, shell) };
        if process.is_null() {
            return Err(last_error("Can't open the tab's shell"));
        }
        let exited = || unsafe { WaitForSingleObject(process, 5000) } == WAIT_OBJECT_0;
        // Windows Terminal closes a tab whose shell exits with 0, and the window once it's empty.
        let mut closed = self.type_text(id, "exit\r").is_ok() && exited();
        if !closed {
            // As closing the tab by hand would: the tab stays open while anything is on its console.
            for pid in with_console(shell, || Ok(console_peers()))? {
                terminate(pid);
            }
            closed = exited();
        }
        unsafe { CloseHandle(process) };
        if !closed {
            bail!("The tab's shell did not exit");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{key_records, tab_shells};
    use windows_sys::Win32::System::Console::SHIFT_PRESSED;

    #[test]
    fn switchboard_absorb_windows_terminal_tabs_are_its_shells() {
        // From a live machine: two windows (one elevated), an OpenConsole per tab, a Zellij pane.
        let rows = [
            (3560, Some(11712), "WindowsTerminal.exe"),
            (5724, Some(3560), "OpenConsole.exe"),
            (11148, Some(3560), "nu.exe"),
            (11972, Some(3560), "OpenConsole.exe"),
            (22168, Some(3560), "nu.exe"),
            (6496, Some(22168), "claude.exe"),
            (42580, Some(11712), "WindowsTerminal.exe"),
            (1420, Some(42580), "nu.exe"),
            (33684, Some(32912), "claude.exe"),
            (32912, Some(1492), "nu.exe"),
            (1492, Some(11148), "zellij.exe"),
        ];
        assert_eq!(tab_shells(rows.into_iter()), vec![1420, 11148, 22168]);
        assert!(tab_shells([(1, None, "nu.exe")].into_iter()).is_empty());
    }

    #[test]
    fn switchboard_absorb_windows_terminal_types_keys_with_their_modifiers() {
        let records = key_records("A\r");
        assert_eq!(records.len(), 4);
        let key = |i: usize| unsafe { records[i].Event.KeyEvent };
        assert_eq!((key(0).bKeyDown, key(1).bKeyDown), (1, 0));
        assert_eq!(key(0).wVirtualKeyCode, u16::from(b'A'));
        assert_eq!(key(0).dwControlKeyState, SHIFT_PRESSED);
        assert_eq!(unsafe { key(0).uChar.UnicodeChar }, u16::from(b'A'));
        assert_eq!(key(2).wVirtualKeyCode, 0x0D, "Enter");
        assert_eq!(key(2).dwControlKeyState, 0);
    }
}
