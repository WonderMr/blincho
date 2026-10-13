#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdatomic.h>

static _Atomic int strictShieldCount;
int blincho_strict_shield_count(void) { return atomic_load(&strictShieldCount); }

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
