#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdatomic.h>

static _Atomic int strictShieldCount;
// A passive tap counts categories only. It never reads text, key codes,
// coordinates, target processes or other event fields.
bool blincho_input_permission(bool prompt) {
    return CGPreflightListenEventAccess() || (prompt && CGRequestListenEventAccess());
}
typedef bool (*BlinchoInputCallback)(void *, int);
typedef struct { void *context; BlinchoInputCallback callback; bool failed; CFMachPortRef tap; } BlinchoInputContext;
static CGEventRef blincho_input_event(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *data) {
    (void)proxy;
    BlinchoInputContext *context = data;
    int kind = -1;
    switch (type) {
        case kCGEventKeyDown: kind = 0; break;
        case kCGEventLeftMouseDown: case kCGEventRightMouseDown: case kCGEventOtherMouseDown: kind = 1; break;
        case kCGEventScrollWheel: kind = 2; break;
        case kCGEventMouseMoved: case kCGEventLeftMouseDragged: case kCGEventRightMouseDragged: case kCGEventOtherMouseDragged: kind = 3; break;
        case kCGEventTapDisabledByTimeout: case kCGEventTapDisabledByUserInput:
            if (context->tap && CGPreflightListenEventAccess() && context->callback(context->context, -1)) {
                CGEventTapEnable(context->tap, true);
            } else {
                context->failed = true; context->callback(context->context, 5);
            }
            break;
        default: break;
    }
    if (kind >= 0) context->callback(context->context, kind);
    return event;
}
void blincho_input_run(void *data, BlinchoInputCallback callback) {
    @autoreleasepool {
        BlinchoInputContext context = {data, callback, false, NULL};
        CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventLeftMouseDown) |
            CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventOtherMouseDown) |
            CGEventMaskBit(kCGEventScrollWheel) | CGEventMaskBit(kCGEventMouseMoved) |
            CGEventMaskBit(kCGEventLeftMouseDragged) | CGEventMaskBit(kCGEventRightMouseDragged) | CGEventMaskBit(kCGEventOtherMouseDragged);
        CFMachPortRef tap = CGEventTapCreate(kCGSessionEventTap, kCGTailAppendEventTap, kCGEventTapOptionListenOnly, mask, blincho_input_event, &context);
        if (!tap) return;
        context.tap = tap;
        CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
        if (!source) { CFRelease(tap); return; }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        callback(data, 4);
        while (callback(data, -1) && !context.failed && CGPreflightListenEventAccess()) {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.25, false);
        }
        CGEventTapEnable(tap, false);
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        CFRelease(source); CFRelease(tap);
    }
}
int blincho_strict_shield_count(void) { return atomic_load(&strictShieldCount); }

@interface BlinchoFocusTarget : NSObject
@property(nonatomic, strong) NSRunningApplication *application;
@property(nonatomic) pid_t processIdentifier;
@property(nonatomic, copy) NSDate *launchDate;
@end
@implementation BlinchoFocusTarget
@end

void *blincho_capture_focus(void) {
    @autoreleasepool {
        if (!NSThread.isMainThread) return NULL;
        NSRunningApplication *application = NSWorkspace.sharedWorkspace.frontmostApplication;
        if (!application || application.terminated || application.processIdentifier <= 0 ||
            [application isEqual:NSRunningApplication.currentApplication]) return NULL;
        BlinchoFocusTarget *target = [BlinchoFocusTarget new];
        target.application = application;
        target.processIdentifier = application.processIdentifier;
        target.launchDate = application.launchDate;
        return (__bridge_retained void *)target;
    }
}
int blincho_restore_focus(void *pointer) {
    @autoreleasepool {
        if (!NSThread.isMainThread) return -2;
        BlinchoFocusTarget *target = (__bridge BlinchoFocusTarget *)pointer;
        NSRunningApplication *application = target.application;
        NSRunningApplication *own = NSRunningApplication.currentApplication;
        if (!application || application.terminated || [application isEqual:own] ||
            application.processIdentifier != target.processIdentifier) return 0;
        // NSRunningApplication represents an application instance, unlike a PID.
        // Retaining it and comparing isEqual: avoids activating a reused process.
        NSRunningApplication *current = [NSRunningApplication
            runningApplicationWithProcessIdentifier:target.processIdentifier];
        if (!current || ![current isEqual:application] ||
            (target.launchDate && ![target.launchDate isEqual:current.launchDate])) return 0;
        if (![NSWorkspace.sharedWorkspace.frontmostApplication isEqual:own]) return 0;
        if (@available(macOS 14.0, *)) {
            [NSApp yieldActivationToApplication:application];
            return [application activateFromApplication:own options:0] ? 1 : -1;
        }
        return [application activateWithOptions:0] ? 1 : -1;
    }
}
void blincho_release_focus(void *pointer) {
    if (pointer) CFRelease(pointer);
}

// Retain observer tokens for the process lifetime. All AppKit calls run on its main thread.
static NSMutableArray *observers;
void blincho_observe_power(void (*callback)(int)) {
    observers = [NSMutableArray new];
    NSNotificationCenter *center = NSWorkspace.sharedWorkspace.notificationCenter;
    NSArray *names = @[NSWorkspaceWillSleepNotification, NSWorkspaceDidWakeNotification,
                       NSWorkspaceSessionDidResignActiveNotification, NSWorkspaceSessionDidBecomeActiveNotification];
    for (NSUInteger index = 0; index < names.count; index++) {
        int code = (int)index + 1;
        [observers addObject:[center addObserverForName:names[index] object:nil queue:nil
            usingBlock:^(NSNotification *notification) { (void)notification; callback(code); }]];
    }
    // The same distributed lock notifications used by Electron's macOS power monitor.
    NSDistributedNotificationCenter *distributed = NSDistributedNotificationCenter.defaultCenter;
    [observers addObject:[distributed addObserverForName:@"com.apple.screenIsLocked" object:nil queue:nil
        usingBlock:^(NSNotification *notification) { (void)notification; callback(3); }]];
    [observers addObject:[distributed addObserverForName:@"com.apple.screenIsUnlocked" object:nil queue:nil
        usingBlock:^(NSNotification *notification) { (void)notification; callback(4); }]];
}
double blincho_idle_seconds(void) {
    return CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType);
}
int blincho_session_locked(void) {
    NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    if (!session) return -1;
    return [session[@"CGSSessionScreenIsLocked"] boolValue] || ![session[(__bridge NSString *)kCGSessionOnConsoleKey] boolValue];
}
int blincho_lock_confirmed(void) {
    NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    if (!session) return -1;
    return [session[@"CGSSessionScreenIsLocked"] boolValue] ? 1 : 0;
}
int blincho_request_lock(void) {
    @autoreleasepool {
        // macOS has no public session-lock API. Resolve this private entry point
        // at runtime, as Hammerspoon does, and let Rust confirm the lock state.
        // https://github.com/Hammerspoon/hammerspoon/blob/master/extensions/caffeinate/libcaffeinate.m
        NSURL *url = [NSURL fileURLWithPath:@"/System/Library/PrivateFrameworks/login.framework"];
        CFBundleRef bundle = CFBundleCreate(kCFAllocatorDefault, (__bridge CFURLRef)url);
        if (!bundle) return -1;
        void (*lockScreen)(void) = (void (*)(void))CFBundleGetFunctionPointerForName(bundle, CFSTR("SACLockScreenImmediate"));
        if (!lockScreen) { CFRelease(bundle); return -1; }
        lockScreen();
        CFRelease(bundle);
        return 1;
    }
}

// A normal foreground NSWindow cannot cover another application's fullscreen
// Space. Nonactivating accessory panels cover those Spaces and own pointer input.
@interface BlinchoStrictShieldPanel : NSPanel
@end
@implementation BlinchoStrictShieldPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

@interface BlinchoStrictShieldView : NSView
@end
@implementation BlinchoStrictShieldView
- (void)drawRect:(NSRect)rect { [self.window.backgroundColor setFill]; NSRectFill(rect); }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { (void)event; return YES; }
- (void)scrollWheel:(NSEvent *)event { (void)event; }
- (void)mouseDown:(NSEvent *)event { (void)event; }
- (void)mouseUp:(NSEvent *)event { (void)event; }
- (void)rightMouseDown:(NSEvent *)event { (void)event; }
- (void)rightMouseUp:(NSEvent *)event { (void)event; }
- (void)otherMouseDown:(NSEvent *)event { (void)event; }
- (void)otherMouseUp:(NSEvent *)event { (void)event; }
@end

@interface BlinchoStrictPresentation : NSObject
@property(nonatomic, weak) NSWindow *window;
@property(nonatomic) NSInteger previousLevel;
@property(nonatomic) NSWindowCollectionBehavior previousBehavior;
@property(nonatomic) NSApplicationActivationPolicy previousPolicy;
@property(nonatomic) BOOL active;
@property(nonatomic, strong) NSArray<NSPanel *> *shields;
@property(nonatomic, strong) id screenObserver;
@property(nonatomic, strong) id closeObserver;
- (instancetype)initWithWindow:(NSWindow *)window;
- (void)refreshScreens;
- (void)stop;
@end

@implementation BlinchoStrictPresentation
- (instancetype)initWithWindow:(NSWindow *)window {
    self = [super init];
    if (!self) return nil;
    self.window = window;
    self.previousLevel = window.level;
    self.previousBehavior = window.collectionBehavior;
    self.previousPolicy = NSApp.activationPolicy;
    self.active = YES;
    if (![NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory]) {
        NSLog(@"Blincho: strict overlay activation policy unavailable");
    }
    window.level = NSScreenSaverWindowLevel + 1;
    // AppKit collection groups are mutually exclusive; preserve unrelated flags.
    NSWindowCollectionBehavior conflicting = NSWindowCollectionBehaviorManaged |
        NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorMoveToActiveSpace |
        NSWindowCollectionBehaviorFullScreenPrimary | NSWindowCollectionBehaviorFullScreenNone |
        NSWindowCollectionBehaviorPrimary | NSWindowCollectionBehaviorAuxiliary;
    // A window already in native fullscreen must keep its primary Space role.
    if (!(window.styleMask & NSWindowStyleMaskFullScreen)) {
        window.collectionBehavior = (self.previousBehavior & ~conflicting) |
            NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorCanJoinAllApplications |
            NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorStationary;
    }
    [self refreshScreens];
    __weak BlinchoStrictPresentation *weakSelf = self;
    self.screenObserver = [NSNotificationCenter.defaultCenter
        addObserverForName:NSApplicationDidChangeScreenParametersNotification object:nil queue:nil
        usingBlock:^(NSNotification *notification) { (void)notification; [weakSelf refreshScreens]; }];
    self.closeObserver = [NSNotificationCenter.defaultCenter
        addObserverForName:NSWindowWillCloseNotification object:window queue:nil
        usingBlock:^(NSNotification *notification) { (void)notification; [weakSelf stop]; }];
    return self;
}
- (void)refreshScreens {
    if (!self.active) return;
    NSMutableArray *panels = [NSMutableArray new];
    for (NSScreen *screen in NSScreen.screens) {
        NSPanel *panel = [[BlinchoStrictShieldPanel alloc] initWithContentRect:screen.frame
            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
            backing:NSBackingStoreBuffered defer:NO];
        panel.releasedWhenClosed = NO;
        panel.floatingPanel = YES;
        panel.hidesOnDeactivate = NO;
        panel.ignoresMouseEvents = NO;
        panel.opaque = YES;
        panel.hasShadow = NO;
        panel.backgroundColor = NSColor.windowBackgroundColor;
        panel.appearance = self.window.effectiveAppearance;
        panel.level = NSScreenSaverWindowLevel;
        panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
            NSWindowCollectionBehaviorCanJoinAllApplications |
            NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorStationary;
        panel.contentView = [[BlinchoStrictShieldView alloc] initWithFrame:NSMakeRect(0, 0, screen.frame.size.width, screen.frame.size.height)];
        [panel orderFrontRegardless];
        [panels addObject:panel];
    }
    for (NSPanel *panel in self.shields) [panel close];
    self.shields = panels;
    atomic_store(&strictShieldCount, (int)panels.count);
    [self.window orderFrontRegardless];
}
- (void)stop {
    if (!self.active) return;
    self.active = NO;
    if (self.screenObserver) [NSNotificationCenter.defaultCenter removeObserver:self.screenObserver];
    if (self.closeObserver) [NSNotificationCenter.defaultCenter removeObserver:self.closeObserver];
    self.screenObserver = nil;
    self.closeObserver = nil;
    for (NSPanel *panel in self.shields) [panel close];
    self.shields = nil;
    atomic_store(&strictShieldCount, 0);
    self.window.level = self.previousLevel;
    self.window.collectionBehavior = self.previousBehavior;
    if (![NSApp setActivationPolicy:self.previousPolicy]) {
        NSLog(@"Blincho: application activation policy restoration failed");
    }
}
- (void)dealloc { [self stop]; }
@end

int blincho_activation_policy(void) {
    if (!NSThread.isMainThread || !NSApp) return -1;
    return (int)NSApp.activationPolicy;
}

void blincho_window_level(void *pointer, int strict) {
    NSWindow *window = (__bridge NSWindow *)pointer;
    static BlinchoStrictPresentation *presentation;
    if (strict) {
        if (presentation.active && presentation.window == window) return;
        [presentation stop];
        presentation = [[BlinchoStrictPresentation alloc] initWithWindow:window];
    } else if (presentation.window == window || !presentation.active) {
        [presentation stop];
        presentation = nil;
    }
}

// Called on the AppKit main thread with a fixed, embedded application asset.
bool blincho_set_application_icon(const unsigned char *bytes, size_t length) {
    if (![NSThread isMainThread] || bytes == NULL || length == 0) return false;
    NSData *data = [NSData dataWithBytes:bytes length:length];
    NSImage *image = [[NSImage alloc] initWithData:data];
    if (image == nil || ![image isValid]) return false;
    [NSApp setApplicationIconImage:image];
    return true;
}


// Only external .blincho documents may receive custom Finder metadata.
// NSWorkspace permits background calls when serialized by the Rust controller.
bool blincho_set_shortcut_icon(const char *path, const unsigned char *bytes, size_t length) {
    @autoreleasepool {
        if (path == NULL || bytes == NULL || length == 0) return false;
        NSString *file = [NSString stringWithUTF8String:path];
        if (file == nil || [file.pathExtension caseInsensitiveCompare:@"blincho"] != NSOrderedSame) return false;
        NSImage *image = [[NSImage alloc] initWithData:[NSData dataWithBytes:bytes length:length]];
        if (image == nil || !image.isValid) return false;
        [NSWorkspace.sharedWorkspace setIcon:nil forFile:file options:0];
        return [NSWorkspace.sharedWorkspace setIcon:image forFile:file options:0];
    }
}
void blincho_reveal_shortcut(const char *path) {
    if (!NSThread.isMainThread || path == NULL) return;
    NSString *file = [NSString stringWithUTF8String:path];
    if (file != nil) [NSWorkspace.sharedWorkspace activateFileViewerSelectingURLs:@[[NSURL fileURLWithPath:file]]];
}
