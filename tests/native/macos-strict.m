#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern void blincho_window_level(void *pointer, int strict);

@interface ScrollSink : NSResponder
@property(nonatomic) NSInteger delivered;
@end
@implementation ScrollSink
- (void)scrollWheel:(NSEvent *)event { (void)event; self.delivered++; }
- (void)mouseDown:(NSEvent *)event { (void)event; self.delivered++; }
@end

static NSArray<NSPanel *> *shields(void) {
    NSMutableArray *result = [NSMutableArray new];
    for (NSWindow *window in NSApp.windows) {
        if ([NSStringFromClass(window.class) isEqualToString:@"BlinchoStrictShieldPanel"] && window.visible) {
            [result addObject:window];
        }
    }
    return result;
}

static void flush(void) {
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
}

// Exit through AppKit after removing the Dock registration. Aborting or merely
// returning from main can leave launching icons for unbundled test executables.
static void finish(int status) {
    for (NSWindow *window in NSApp.windows.copy) [window close];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    flush();
    if (status == 0) [NSApp terminate:nil];
    exit(status);
}

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "Check failed: %s (line %d)\n", #condition, __LINE__); \
        finish(EXIT_FAILURE); \
    } \
} while (0)

static int fullscreenFixture(NSString *directory) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSScreen.mainScreen.frame
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
    [NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidEnterFullScreenNotification
        object:window queue:nil usingBlock:^(NSNotification *notification) {
            (void)notification;
            NSData *ready = [NSJSONSerialization dataWithJSONObject:@{@"windowNumber": @(window.windowNumber)} options:0 error:nil];
            [ready writeToFile:[directory stringByAppendingPathComponent:@"ready.json"] atomically:YES];
        }];
    [NSApp finishLaunching];
    [window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [window toggleFullScreen:nil];
    [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *timer) {
        (void)timer;
        if (getppid() == 1 || [deadline timeIntervalSinceNow] <= 0 ||
            [NSFileManager.defaultManager fileExistsAtPath:[directory stringByAppendingPathComponent:@"stop"]]) {
            finish(EXIT_SUCCESS);
        }
    }];
    [NSApp run];
    return 0;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        CHECK([NSApp setActivationPolicy:NSApplicationActivationPolicyRegular]);
        if (argc == 3 && strcmp(argv[1], "--fullscreen-fixture") == 0) {
            return fullscreenFixture([NSString stringWithUTF8String:argv[2]]);
        }
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 320, 240)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        window.level = NSFloatingWindowLevel;
        window.collectionBehavior = NSWindowCollectionBehaviorManaged | NSWindowCollectionBehaviorFullScreenPrimary;
        NSInteger originalLevel = window.level;
        NSWindowCollectionBehavior originalBehavior = window.collectionBehavior;
        NSApplicationActivationPolicy originalPolicy = NSApp.activationPolicy;
        const char *fixtureNumber = getenv("BLINCHO_FULLSCREEN_WINDOW_NUMBER");
        NSPoint fixturePoint = NSMakePoint(NSMaxX(NSScreen.mainScreen.frame) - 20, NSMaxY(NSScreen.mainScreen.frame) - 40);
        if (fixtureNumber) CHECK([NSWindow windowNumberAtPoint:fixturePoint belowWindowWithWindowNumber:0] == atoi(fixtureNumber));

        // Restoring a regular application's policy can return to its own Space.
        // Check fullscreen coverage before that restoration, then its exact state.
        for (int cycle = 0; cycle < (fixtureNumber ? 1 : 2); cycle++) {
            blincho_window_level((__bridge void *)window, 1);
            flush();
            NSArray<NSPanel *> *panels = shields();
            CHECK(panels.count == NSScreen.screens.count && panels.count > 0);
            CHECK(NSApp.activationPolicy == NSApplicationActivationPolicyAccessory);
            CHECK(window.level > NSScreenSaverWindowLevel);
            for (NSPanel *panel in panels) {
                CHECK(panel.level == NSScreenSaverWindowLevel);
                CHECK(panel.opaque && !panel.ignoresMouseEvents && !panel.hidesOnDeactivate);
                CHECK(!panel.canBecomeKeyWindow && !panel.canBecomeMainWindow);
                CHECK(panel.styleMask & NSWindowStyleMaskNonactivatingPanel);
                NSWindowCollectionBehavior required = NSWindowCollectionBehaviorCanJoinAllSpaces |
                    NSWindowCollectionBehaviorCanJoinAllApplications |
                    NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorStationary;
                CHECK(panel.collectionBehavior == required);
                CHECK(NSEqualRects(panel.frame, panel.screen.frame));
                NSPoint point = NSMakePoint(NSMaxX(panel.frame) - 20, NSMaxY(panel.frame) - 40);
                CHECK([NSWindow windowNumberAtPoint:point belowWindowWithWindowNumber:0] == panel.windowNumber);
                CHECK([panel.contentView acceptsFirstMouse:nil]);
                // The shield owns this event, even though it never becomes the key window.
                ScrollSink *sink = [ScrollSink new];
                panel.contentView.nextResponder = sink;
                CGEventRef wheel = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 1, 80);
                [panel.contentView scrollWheel:[NSEvent eventWithCGEvent:wheel]];
                NSEvent *click = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:NSZeroPoint
                    modifierFlags:0 timestamp:0 windowNumber:panel.windowNumber context:nil
                    eventNumber:0 clickCount:1 pressure:0];
                [panel.contentView mouseDown:click];
                CHECK(sink.delivered == 0);
                CFRelease(wheel);
            }
            blincho_window_level((__bridge void *)window, 1);
            CHECK(shields().count == panels.count);
            [NSNotificationCenter.defaultCenter postNotificationName:NSApplicationDidChangeScreenParametersNotification object:NSApp];
            flush();
            CHECK(shields().count == NSScreen.screens.count);
            blincho_window_level((__bridge void *)window, 0);
            flush();
            CHECK(shields().count == 0);
            CHECK(window.level == originalLevel);
            CHECK(window.collectionBehavior == originalBehavior);
            CHECK(NSApp.activationPolicy == originalPolicy);
            blincho_window_level((__bridge void *)window, 0);
            CHECK(NSApp.activationPolicy == originalPolicy);
        }
        blincho_window_level((__bridge void *)window, 1);
        CHECK(shields().count > 0);
        [window close];
        CHECK(shields().count == 0);
        CHECK(NSApp.activationPolicy == originalPolicy);
        blincho_window_level((__bridge void *)window, 0);
        puts("PASS: native strict shields cover displays, consume scroll, refresh and restore");
        finish(EXIT_SUCCESS);
    }
    return 0;
}
