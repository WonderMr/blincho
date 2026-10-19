use super::Shared;
use std::sync::{mpsc::Sender, Arc};
extern "C" {
    fn blincho_input_permission(prompt: bool) -> bool;
    fn blincho_input_run(
        context: *mut std::ffi::c_void,
        callback: extern "C" fn(*mut std::ffi::c_void, i32) -> bool,
    );
}
pub fn permission(prompt: bool) -> u8 {
    if unsafe { blincho_input_permission(prompt) } {
        1
    } else {
        2
    }
}
struct Context<'a> {
    shared: &'a Shared,
    ready: Option<Sender<bool>>,
}
extern "C" fn event(context: *mut std::ffi::c_void, kind: i32) -> bool {
    let context = unsafe { &mut *context.cast::<Context<'_>>() };
    match kind {
        0..=3 => context.shared.count(kind as usize),
        4 => {
            if let Some(sender) = context.ready.take() {
                let _ = sender.send(true);
            }
        }
        5 => {
            context
                .shared
                .status
                .store(4, std::sync::atomic::Ordering::Release);
        }
        _ => {}
    }
    context.shared.running()
}
pub fn run(shared: &Arc<Shared>, sender: Sender<bool>) {
    let mut context = Context {
        shared,
        ready: Some(sender),
    };
    unsafe {
        blincho_input_run((&mut context as *mut Context<'_>).cast(), event);
    }
}
