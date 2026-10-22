#import <CoreAudio/CoreAudio.h>
#import <CoreMediaIO/CMIOHardware.h>
#include <stdlib.h>

// Read device-use flags without opening a stream, recording media or requesting
// camera/microphone permission. A failed or incomplete scan remains unknown.
static int legacy_microphone_active(void) {
    AudioObjectPropertyAddress devicesAddress = {kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    UInt32 bytes = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &devicesAddress, 0, NULL, &bytes) != noErr || bytes > 65536 || bytes % sizeof(AudioDeviceID)) return -1;
    if (!bytes) return 0;
    AudioDeviceID *devices = malloc(bytes);
    if (!devices) return -1;
    UInt32 capacity = bytes;
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &devicesAddress, 0, NULL, &bytes, devices) != noErr || bytes > capacity || bytes % sizeof(AudioDeviceID)) { free(devices); return -1; }
    int result = 0;
    for (UInt32 i = 0; i < bytes / sizeof(AudioDeviceID); ++i) {
        AudioObjectPropertyAddress streamsAddress = {kAudioDevicePropertyStreams, kAudioDevicePropertyScopeInput, kAudioObjectPropertyElementMain};
        UInt32 streamBytes = 0;
        if (AudioObjectGetPropertyDataSize(devices[i], &streamsAddress, 0, NULL, &streamBytes) != noErr) { result = -1; continue; }
        if (!streamBytes) continue;
        // The global flag can include output on a duplex device. Conservatively
        // keep postponing in that case rather than infer that its input is off.
        AudioObjectPropertyAddress runningAddress = {kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
        UInt32 running = 0, size = sizeof(running);
        if (AudioObjectGetPropertyData(devices[i], &runningAddress, 0, NULL, &size, &running) != noErr || size != sizeof(running)) { result = -1; continue; }
        if (running) { result = 1; break; }
    }
    free(devices);
    return result;
}

static int microphone_active(void) {
    // Process input activity distinguishes microphone capture from playback on
    // the same duplex device. Older systems use the conservative device scan.
    AudioObjectPropertyAddress processesAddress = {kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    if (!AudioObjectHasProperty(kAudioObjectSystemObject, &processesAddress)) return legacy_microphone_active();
    UInt32 bytes = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &processesAddress, 0, NULL, &bytes) != noErr || bytes > 65536 || bytes % sizeof(AudioObjectID)) return -1;
    if (!bytes) return 0;
    AudioObjectID *processes = malloc(bytes);
    if (!processes) return -1;
    UInt32 capacity = bytes;
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &processesAddress, 0, NULL, &bytes, processes) != noErr || bytes > capacity || bytes % sizeof(AudioObjectID)) { free(processes); return -1; }
    int result = 0;
    for (UInt32 i = 0; i < bytes / sizeof(AudioObjectID); ++i) {
        AudioObjectPropertyAddress runningAddress = {kAudioProcessPropertyIsRunningInput, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
        UInt32 running = 0, size = sizeof(running);
        if (AudioObjectGetPropertyData(processes[i], &runningAddress, 0, NULL, &size, &running) != noErr || size != sizeof(running)) { result = -1; continue; }
        if (running) { result = 1; break; }
    }
    free(processes);
    return result;
}

static int camera_active(void) {
    CMIOObjectPropertyAddress devicesAddress = {kCMIOHardwarePropertyDevices, kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMain};
    UInt32 bytes = 0;
    if (CMIOObjectGetPropertyDataSize(kCMIOObjectSystemObject, &devicesAddress, 0, NULL, &bytes) != noErr || bytes > 65536 || bytes % sizeof(CMIODeviceID)) return -1;
    if (!bytes) return 0;
    CMIODeviceID *devices = malloc(bytes);
    if (!devices) return -1;
    UInt32 used = 0;
    if (CMIOObjectGetPropertyData(kCMIOObjectSystemObject, &devicesAddress, 0, NULL, bytes, &used, devices) != noErr || used > bytes || used % sizeof(CMIODeviceID)) { free(devices); return -1; }
    int result = 0;
    for (UInt32 i = 0; i < used / sizeof(CMIODeviceID); ++i) {
        CMIOObjectPropertyAddress runningAddress = {kCMIODevicePropertyDeviceIsRunningSomewhere, kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMain};
        UInt32 running = 0, size = 0;
        if (CMIOObjectGetPropertyData(devices[i], &runningAddress, 0, NULL, sizeof(running), &size, &running) != noErr || size != sizeof(running)) { result = -1; continue; }
        if (running) { result = 1; break; }
    }
    free(devices);
    return result;
}

int blincho_capture_active(void) {
    int microphone = microphone_active();
    int camera = camera_active();
    if (microphone == 1 || camera == 1) return 1;
    return microphone == 0 && camera == 0 ? 0 : -1;
}
