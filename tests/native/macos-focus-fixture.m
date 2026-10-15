#import <AppKit/AppKit.h>
#include <limits.h>
#include <stdlib.h>
#include <unistd.h>

// A normal work-app window for focus regression tests. Only local control files
// activate it; no Accessibility access or synthesized input is involved.
static void writeJSON(NSString *path, NSDictionary *value) {
    NSError *error = nil;
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
    if (!bytes || ![bytes writeToFile:path options:NSDataWritingAtomic error:&error]) {
        fprintf(stderr, "Focus fixture JSON: %s\n", error.localizedDescription.UTF8String);
        exit(EXIT_FAILURE);
    }
}

static void finish(int status) {
    for (NSWindow *window in NSApp.windows.copy) [window close];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    if (status == EXIT_SUCCESS) [NSApp terminate:nil];
    exit(status);
}

static NSDictionary *readRequest(NSString *path) {
    NSData *bytes = [NSData dataWithContentsOfFile:path];
    if (!bytes) return nil;
    NSError *error = nil;
    id request = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:&error];
    if (bytes.length > 1024 || ![request isKindOfClass:NSDictionary.class] ||
        ![request[@"id"] isKindOfClass:NSNumber.class]) {
        fprintf(stderr, "Focus fixture invalid request: %s\n", path.UTF8String);
        finish(EXIT_FAILURE);
    }
    if (![NSFileManager.defaultManager removeItemAtPath:path error:&error]) {
        fprintf(stderr, "Focus fixture control: %s\n", error.localizedDescription.UTF8String);
        finish(EXIT_FAILURE);
    }
    return request;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 3) {
            fprintf(stderr, "Usage: focus-fixture CONTROL_DIRECTORY WINDOW_TITLE\n");
            return EXIT_FAILURE;
        }
        NSString *directory = [NSString stringWithUTF8String:argv[1]];
        NSString *title = [NSString stringWithUTF8String:argv[2]];
        BOOL isDirectory = NO;
        if (![NSFileManager.defaultManager fileExistsAtPath:directory isDirectory:&isDirectory] || !isDirectory) {
            fprintf(stderr, "Focus fixture requires an existing isolated control directory\n");
            return EXIT_FAILURE;
        }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        if (NSApp.activationPolicy != NSApplicationActivationPolicyRegular) {
            fprintf(stderr, "Focus fixture could not register a regular application (policy %ld)\n", (long)NSApp.activationPolicy);
            return EXIT_FAILURE;
        }
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 360, 220)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
            backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        window.title = title;
        NSTextField *label = [NSTextField labelWithString:title];
        label.frame = NSMakeRect(24, 90, 312, 30);
        [window.contentView addSubview:label];
        [NSApp finishLaunching];
        [window orderFront:nil];
        pid_t parent = getppid();
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:240];
        __block unsigned long long sequence = 0;
        __block pid_t observedPID = 0;
        __block pid_t lastFrontmostPID = -1;
        NSMutableArray *focusChanges = [NSMutableArray new];
        void (^report)(void) = ^{
            NSRunningApplication *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
            pid_t frontmostPID = frontmost ? frontmost.processIdentifier : 0;
            long long reportedAtMs = (long long)(NSDate.date.timeIntervalSince1970 * 1000);
            if (frontmostPID != lastFrontmostPID) {
                if (focusChanges.count == 32) [focusChanges removeObjectAtIndex:0];
                [focusChanges addObject:@{@"pid": @(frontmostPID), @"atMs": @(reportedAtMs)}];
                lastFrontmostPID = frontmostPID;
            }
            NSRunningApplication *observed = observedPID > 0
                ? [NSRunningApplication runningApplicationWithProcessIdentifier:observedPID] : nil;
            writeJSON([directory stringByAppendingPathComponent:@"state.json"], @{
                @"pid": @(getpid()), @"windowNumber": @(window.windowNumber),
                @"frontmostPID": @(frontmostPID), @"focusChanges": focusChanges.copy,
                @"visible": @(window.visible), @"key": @(window.keyWindow),
                @"active": @(NSApp.active), @"sample": @(++sequence),
                @"observedPID": @(observedPID),
                @"observedLookupFound": @(observed != nil),
                @"observedTerminated": observed ? @(observed.terminated) : NSNull.null,
                @"observedActivationPolicy": observed ? @(observed.activationPolicy) : NSNull.null,
                @"reportedAtMs": @(reportedAtMs)
            });
        };
        report();
        [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *timer) {
            (void)timer;
            if (getppid() != parent || [deadline timeIntervalSinceNow] <= 0) finish(EXIT_SUCCESS);
            NSDictionary *stop = readRequest([directory stringByAppendingPathComponent:@"stop"]);
            if (stop) {
                writeJSON([directory stringByAppendingPathComponent:@"response.json"], @{@"id": stop[@"id"], @"ok": @YES});
                finish(EXIT_SUCCESS);
            }
            NSDictionary *observe = readRequest([directory stringByAppendingPathComponent:@"observe-app"]);
            if (observe) {
                NSNumber *pid = observe[@"pid"];
                if (![pid isKindOfClass:NSNumber.class] || pid.longLongValue <= 0 || pid.longLongValue > INT_MAX) {
                    fprintf(stderr, "Focus fixture invalid observed PID\n");
                    finish(EXIT_FAILURE);
                }
                observedPID = pid.intValue;
                writeJSON([directory stringByAppendingPathComponent:@"response.json"], @{@"id": observe[@"id"], @"ok": @YES});
            }
            NSDictionary *activate = readRequest([directory stringByAppendingPathComponent:@"activate"]);
            if (activate) {
                [window makeKeyAndOrderFront:nil];
                [NSApp activateIgnoringOtherApps:YES];
                writeJSON([directory stringByAppendingPathComponent:@"response.json"], @{@"id": activate[@"id"], @"ok": @YES});
            }
            report();
        }];
        [NSApp run];
    }
    return EXIT_SUCCESS;
}
