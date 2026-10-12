#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

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
void blincho_window_level(void *pointer, int strict) {
    NSWindow *window = (__bridge NSWindow *)pointer;
    static NSMapTable *previous;
    if (!previous) previous = [NSMapTable weakToStrongObjectsMapTable];
    if (strict) {
        if (![previous objectForKey:window]) [previous setObject:@[@(window.level), @(window.collectionBehavior)] forKey:window];
        window.level = NSScreenSaverWindowLevel;
        window.collectionBehavior |= NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorCanJoinAllSpaces;
    } else {
        NSArray *saved = [previous objectForKey:window];
        if (saved) { window.level = [saved[0] integerValue]; window.collectionBehavior = [saved[1] unsignedIntegerValue]; [previous removeObjectForKey:window]; }
    }
}
