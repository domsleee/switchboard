//! Replace the DACL with one protected current-user grant, including existing explicit ACEs.
use std::{os::windows::ffi::OsStrExt, path::Path, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
        },
        GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

fn current_sid() -> anyhow::Result<String> {
    unsafe {
        let mut token = ptr::null_mut();
        anyhow::ensure!(
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0,
            "Cannot identify the mesh storage owner"
        );
        let result = (|| {
            let mut length = 0;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut length);
            anyhow::ensure!(length > 0, "Cannot read the mesh storage owner");
            // TOKEN_USER needs pointer alignment; the Windows API reports a byte count.
            let mut bytes = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
            anyhow::ensure!(
                GetTokenInformation(
                    token,
                    TokenUser,
                    bytes.as_mut_ptr().cast(),
                    length,
                    &mut length
                ) != 0,
                "Cannot read the mesh storage owner"
            );
            let user = &*bytes.as_ptr().cast::<TOKEN_USER>();
            let mut sid = ptr::null_mut();
            anyhow::ensure!(
                ConvertSidToStringSidW(user.User.Sid, &mut sid) != 0,
                "Cannot encode the mesh storage owner"
            );
            let mut count = 0;
            while *sid.add(count) != 0 {
                count += 1;
            }
            let encoded = String::from_utf16(std::slice::from_raw_parts(sid, count));
            LocalFree(sid.cast());
            Ok(encoded?)
        })();
        CloseHandle(token);
        result
    }
}
pub(super) fn private(path: &Path, directory: bool) -> anyhow::Result<()> {
    let sid = current_sid()?;
    let sddl: Vec<u16> = format!("D:P(A;{};FA;;;{sid})", if directory { "OICI" } else { "" })
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let mut descriptor = ptr::null_mut();
        anyhow::ensure!(
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut()
            ) != 0,
            "Cannot restrict mesh storage permissions"
        );
        let result = (|| {
            let mut present = 0;
            let mut defaulted = 0;
            let mut dacl = ptr::null_mut();
            anyhow::ensure!(
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) != 0
                    && present != 0
                    && !dacl.is_null(),
                "Cannot restrict mesh storage permissions"
            );
            anyhow::ensure!(
                SetNamedSecurityInfoW(
                    path.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    dacl,
                    ptr::null_mut()
                ) == 0,
                "Cannot restrict mesh storage permissions"
            );
            Ok(())
        })();
        LocalFree(descriptor);
        result
    }
}
