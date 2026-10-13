//! LevelDB 1.22 uses Win32 A APIs, whose paths use the active ANSI code page.
//! Rust copies the original Unicode source into a private snapshot first. Only
//! that snapshot needs a lossless ANSI path or an available Windows short name.

use std::{
    ffi::CString,
    fs::Metadata,
    os::windows::{ffi::OsStrExt, fs::MetadataExt},
    path::Path,
};
use windows_sys::Win32::{
    Globalization::{
        GetACP, WideCharToMultiByte, CP_UTF8, WC_ERR_INVALID_CHARS, WC_NO_BEST_FIT_CHARS,
    },
    Storage::FileSystem::{GetShortPathNameW, FILE_ATTRIBUTE_REPARSE_POINT},
};

pub(super) fn is_reparse_point(metadata: &Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn encode_ansi(wide: &[u16]) -> Option<CString> {
    if wide.is_empty() || wide.contains(&0) {
        return None;
    }
    let count = i32::try_from(wide.len()).ok()?;
    let codepage = unsafe { GetACP() };
    let mut substituted = 0;
    let (flags, used) = if codepage == CP_UTF8 {
        (WC_ERR_INVALID_CHARS, std::ptr::null_mut())
    } else {
        (WC_NO_BEST_FIT_CHARS, &mut substituted as *mut i32)
    };
    let needed = unsafe {
        WideCharToMultiByte(
            codepage,
            flags,
            wide.as_ptr(),
            count,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            used,
        )
    };
    if needed <= 0 || substituted != 0 {
        return None;
    }
    let mut bytes = vec![0; needed as usize];
    let written = unsafe {
        WideCharToMultiByte(
            codepage,
            flags,
            wide.as_ptr(),
            count,
            bytes.as_mut_ptr(),
            needed,
            std::ptr::null(),
            used,
        )
    };
    if written != needed || substituted != 0 {
        return None;
    }
    CString::new(bytes).ok()
}

pub(super) fn native_path(path: &Path) -> Result<CString, String> {
    let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if let Some(name) = encode_ansi(&wide) {
        return Ok(name);
    }
    if wide.contains(&0) {
        return Err("Invalid legacy history path".into());
    }
    let mut terminated = wide;
    terminated.push(0);
    let needed = unsafe { GetShortPathNameW(terminated.as_ptr(), std::ptr::null_mut(), 0) };
    if needed > 0 {
        let mut short = vec![0; needed as usize];
        let length = unsafe { GetShortPathNameW(terminated.as_ptr(), short.as_mut_ptr(), needed) };
        if length > 0 && length < needed {
            short.truncate(length as usize);
            if let Some(name) = encode_ansi(&short) {
                return Ok(name);
            }
        }
    }
    Err("Windows LevelDB cannot read this temporary directory path; use an ASCII temporary directory and retry. The original Electron profile is preserved".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn active_codepage_conversion_rejects_nuls_and_never_substitutes_unicode() {
        assert!(encode_ansi(&[0]).is_none());
        assert_eq!(
            encode_ansi(
                &"C:\\Temp\\blincho-history"
                    .encode_utf16()
                    .collect::<Vec<_>>()
            )
            .unwrap()
            .to_bytes(),
            b"C:\\Temp\\blincho-history"
        );
        let emoji: Vec<_> = "C:\\Temp\\👁".encode_utf16().collect();
        if unsafe { GetACP() } == CP_UTF8 {
            assert_eq!(
                encode_ansi(&emoji).unwrap().to_bytes(),
                "C:\\Temp\\👁".as_bytes()
            );
        } else {
            assert!(encode_ansi(&emoji).is_none());
        }
    }
    #[test]
    fn unicode_snapshot_name_uses_ansi_or_short_path_without_source_changes() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("Юлия 👁");
        std::fs::create_dir(&directory).unwrap();
        match native_path(&directory) {
            Ok(name) => assert!(!name.to_bytes().contains(&b'?')),
            Err(error) => assert!(error.contains("ASCII temporary directory")),
        }
        assert!(directory.is_dir());
    }
}
