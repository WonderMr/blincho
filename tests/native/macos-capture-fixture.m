#import <CoreAudio/CoreAudio.h>
#import <CoreMediaIO/CMIOHardware.h>
#include <assert.h>
#include <string.h>

static bool legacy, audioFailure, cameraFailure, partialAudio, partialCamera;
static UInt32 audioRunning, cameraRunning;
static UInt32 deviceCount = 2;
/** Select the process-input probe or legacy device fallback without using real devices. */
static Boolean has_property(AudioObjectID object, const AudioObjectPropertyAddress *address) {
    (void)object; (void)address;
    return !legacy;
}
/** Supply fixture list or input-stream sizes, optionally failing the audio scan. */
static OSStatus audio_size(AudioObjectID object, const AudioObjectPropertyAddress *address, UInt32 qualifierSize, const void *qualifier, UInt32 *size) {
    (void)object; (void)qualifierSize; (void)qualifier;
    if (audioFailure) return -1;
    *size = address->mSelector == kAudioDevicePropertyStreams ? sizeof(AudioStreamID) : deviceCount * sizeof(AudioObjectID);
    return noErr;
}
/** Supply fixture audio IDs or running bits, including a failed first-device observation. */
static OSStatus audio_data(AudioObjectID object, const AudioObjectPropertyAddress *address, UInt32 qualifierSize, const void *qualifier, UInt32 *size, void *data) {
    (void)qualifierSize; (void)qualifier;
    if (address->mSelector == kAudioHardwarePropertyDevices || address->mSelector == kAudioHardwarePropertyProcessObjectList) {
        const AudioObjectID ids[] = {10, 11};
        memcpy(data, ids, *size);
        return noErr;
    }
    if (partialAudio && object == 10) return -1;
    assert(address->mSelector == (legacy ? kAudioDevicePropertyDeviceIsRunningSomewhere : kAudioProcessPropertyIsRunningInput));
    *(UInt32 *)data = (audioRunning >> (object - 10)) & 1;
    *size = sizeof(UInt32);
    return noErr;
}
/** Supply the fixture camera-list size or simulate a failed enumeration. */
static OSStatus camera_size(CMIOObjectID object, const CMIOObjectPropertyAddress *address, UInt32 qualifierSize, const void *qualifier, UInt32 *size) {
    (void)object; (void)address; (void)qualifierSize; (void)qualifier;
    if (cameraFailure) return -1;
    *size = deviceCount * sizeof(CMIODeviceID);
    return noErr;
}
/** Supply fixture camera IDs or running bits while reporting the exact bytes written. */
static OSStatus camera_data(CMIOObjectID object, const CMIOObjectPropertyAddress *address, UInt32 qualifierSize, const void *qualifier, UInt32 size, UInt32 *used, void *data) {
    (void)qualifierSize; (void)qualifier;
    if (address->mSelector == kCMIOHardwarePropertyDevices) {
        const CMIODeviceID ids[] = {20, 21};
        memcpy(data, ids, size);
        *used = size;
        return noErr;
    }
    assert(address->mSelector == kCMIODevicePropertyDeviceIsRunningSomewhere);
    if (partialCamera && object == 20) return -1;
    *(UInt32 *)data = (cameraRunning >> (object - 20)) & 1;
    *used = sizeof(UInt32);
    return noErr;
}
#define AudioObjectHasProperty has_property
#define AudioObjectGetPropertyDataSize audio_size
#define AudioObjectGetPropertyData audio_data
#define CMIOObjectGetPropertyDataSize camera_size
#define CMIOObjectGetPropertyData camera_data
#include "../../src-tauri/native/capture.m"

/** Verify tri-state aggregation for both probe paths, partial failures and empty device lists. */
int main(void) {
    for (int old = 0; old <= 1; ++old) {
        legacy = old;
        assert(blincho_capture_active() == 0);
        audioRunning = 2;
        assert(blincho_capture_active() == 1);
        audioRunning = 0; cameraRunning = 2;
        assert(blincho_capture_active() == 1);
        cameraRunning = 0; audioFailure = true;
        assert(blincho_capture_active() == -1);
        cameraRunning = 1;
        assert(blincho_capture_active() == 1);
        audioFailure = false; cameraRunning = 0; cameraFailure = true;
        assert(blincho_capture_active() == -1);
        audioRunning = 1;
        assert(blincho_capture_active() == 1);
        audioRunning = 0; cameraFailure = false;
        partialAudio = true;
        assert(blincho_capture_active() == -1);
        audioRunning = 2;
        assert(blincho_capture_active() == 1);
        audioRunning = 0; partialAudio = false; partialCamera = true;
        assert(blincho_capture_active() == -1);
        cameraRunning = 2;
        assert(blincho_capture_active() == 1);
        cameraRunning = 0; partialCamera = false;
        deviceCount = 0;
        assert(blincho_capture_active() == 0);
        deviceCount = 2;
    }
    return 0;
}
