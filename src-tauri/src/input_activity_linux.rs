use super::Shared;
use std::{
    ptr::null,
    sync::{mpsc::Sender, Arc},
    time::Duration,
};
use x11_dl::{xinput2 as xi, xlib};
pub fn permission(_: bool) -> u8 {
    if std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("x11")
        && std::env::var_os("WAYLAND_DISPLAY").is_none()
    {
        1
    } else {
        3
    }
}
pub fn run(shared: &Arc<Shared>, sender: Sender<bool>) {
    let Ok(x) = xlib::Xlib::open() else {
        let _ = sender.send(false);
        return;
    };
    let Ok(input) = xi::XInput2::open() else {
        let _ = sender.send(false);
        return;
    };
    unsafe {
        let display = (x.XOpenDisplay)(null());
        if display.is_null() {
            let _ = sender.send(false);
            return;
        }
        let (mut opcode, mut event, mut error) = (0, 0, 0);
        let (mut major, mut minor) = (2, 1);
        if (x.XQueryExtension)(
            display,
            c"XInputExtension".as_ptr(),
            &mut opcode,
            &mut event,
            &mut error,
        ) == 0
            || (input.XIQueryVersion)(display, &mut major, &mut minor) != 0
        {
            (x.XCloseDisplay)(display);
            let _ = sender.send(false);
            return;
        }
        let mut mask = [0u8; 4];
        for kind in [xi::XI_RawKeyPress, xi::XI_RawButtonPress, xi::XI_RawMotion] {
            xi::XISetMask(&mut mask, kind);
        }
        let mut selection = xi::XIEventMask {
            deviceid: xi::XIAllMasterDevices,
            mask_len: mask.len() as i32,
            mask: mask.as_mut_ptr(),
        };
        if (input.XISelectEvents)(display, (x.XDefaultRootWindow)(display), &mut selection, 1) != 0
        {
            (x.XCloseDisplay)(display);
            let _ = sender.send(false);
            return;
        }
        (x.XFlush)(display);
        let _ = sender.send(true);
        while shared.running() {
            while (x.XPending)(display) > 0 {
                let mut event: xlib::XEvent = std::mem::zeroed();
                (x.XNextEvent)(display, &mut event);
                if event.get_type() != xlib::GenericEvent {
                    continue;
                }
                let cookie = &mut event.generic_event_cookie;
                if cookie.extension != opcode || (x.XGetEventData)(display, cookie) == 0 {
                    continue;
                }
                if !cookie.data.is_null() {
                    let raw = &*cookie.data.cast::<xi::XIRawEvent>();
                    match raw.evtype {
                        xi::XI_RawKeyPress => shared.count(0),
                        xi::XI_RawButtonPress => {
                            shared.count(if (4..=7).contains(&raw.detail) { 2 } else { 1 })
                        }
                        xi::XI_RawMotion => shared.count(3),
                        _ => {}
                    }
                }
                (x.XFreeEventData)(display, cookie);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        (x.XCloseDisplay)(display);
    }
}
