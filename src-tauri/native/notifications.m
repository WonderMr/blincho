#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

typedef void (*BlinchoResult)(void *, int);
static void (*notificationClicked)(void);
@interface BlinchoNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation BlinchoNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification
    withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    (void)center; (void)notification;
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response
    withCompletionHandler:(void (^)(void))completionHandler {
    (void)center; (void)response;
    if (notificationClicked) notificationClicked();
    completionHandler();
}
@end
static BlinchoNotificationDelegate *notificationDelegate;
void blincho_notifications_initialize(void (*clicked)(void)) {
    notificationClicked = clicked;
    notificationDelegate = [BlinchoNotificationDelegate new];
    UNUserNotificationCenter.currentNotificationCenter.delegate = notificationDelegate;
}
void blincho_notification_permission(void *context, BlinchoResult callback) {
    UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        if (settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
            [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound
                completionHandler:^(BOOL granted, NSError *error) { callback(context, error ? -1 : granted); }];
        } else {
            callback(context, settings.authorizationStatus == UNAuthorizationStatusAuthorized || settings.authorizationStatus == UNAuthorizationStatusProvisional);
        }
    }];
}
void blincho_notification_send(const char *title, const char *body, void *context, BlinchoResult callback) {
    NSString *notificationTitle = [NSString stringWithUTF8String:title];
    NSString *notificationBody = [NSString stringWithUTF8String:body];
    if (!notificationTitle || !notificationBody) { callback(context, -1); return; }
    UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        void (^deliver)(void) = ^{
            UNMutableNotificationContent *content = [UNMutableNotificationContent new];
            content.title = notificationTitle; content.body = notificationBody;
            UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:NSUUID.UUID.UUIDString content:content trigger:nil];
            [center addNotificationRequest:request withCompletionHandler:^(NSError *error) { callback(context, error ? -1 : 1); }];
        };
        if (settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
            [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound
                completionHandler:^(BOOL granted, NSError *error) { if (granted && !error) deliver(); else callback(context, error ? -1 : 0); }];
        } else if (settings.authorizationStatus == UNAuthorizationStatusAuthorized || settings.authorizationStatus == UNAuthorizationStatusProvisional) {
            deliver();
        } else { callback(context, 0); }
    }];
}
