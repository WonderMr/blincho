use super::Shared;
use std::{
    cell::RefCell,
    ptr::{null, null_mut},
    sync::{mpsc::Sender, Arc},
};
use windows_sys::Win32::{
    Foundation::{LPARAM, LRESULT, WPARAM},
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::*,
};
thread_local! { static COUNTERS: RefCell<Option<Arc<Shared>>> = const { RefCell::new(None) }; }
pub fn permission(_: bool) -> u8 {
    1
}
unsafe extern "system" fn keyboard(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 && matches!(message as u32, WM_KEYDOWN | WM_SYSKEYDOWN) {
        COUNTERS.with(|value| {
            if let Some(shared) = value.borrow().as_ref() {
                shared.count(0);
            }
        });
    }
    CallNextHookEx(null_mut(), code, message, data)
}
unsafe extern "system" fn mouse(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 {
        let kind = match message as u32 {
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN => Some(1),
            WM_MOUSEWHEEL | WM_MOUSEHWHEEL => Some(2),
            WM_MOUSEMOVE => Some(3),
            _ => None,
        };
        if let Some(kind) = kind {
            COUNTERS.with(|value| {
                if let Some(shared) = value.borrow().as_ref() {
                    shared.count(kind);
                }
            });
        }
    }
    CallNextHookEx(null_mut(), code, message, data)
}
pub fn run(shared: &Arc<Shared>, sender: Sender<bool>) {
    unsafe {
        let module = GetModuleHandleW(null());
        let keys = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), module, 0);
        let pointer = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), module, 0);
        if keys.is_null() || pointer.is_null() {
            if !keys.is_null() {
                UnhookWindowsHookEx(keys);
            }
            if !pointer.is_null() {
                UnhookWindowsHookEx(pointer);
            }
            let _ = sender.send(false);
            return;
        }
        COUNTERS.with(|value| *value.borrow_mut() = Some(Arc::clone(shared)));
        let _ = sender.send(true);
        let mut message = MSG::default();
        while shared.running() {
            while PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            // Low-level hooks run on this thread. Wake immediately for input
            // instead of adding a fixed delay to every system-wide event.
            if MsgWaitForMultipleObjects(0, null(), 0, 250, QS_ALLINPUT) == u32::MAX {
                break;
            }
        }
        UnhookWindowsHookEx(keys);
        UnhookWindowsHookEx(pointer);
        COUNTERS.with(|value| *value.borrow_mut() = None);
    }
}
