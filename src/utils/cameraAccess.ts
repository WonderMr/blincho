export type CameraAccessResult = 'granted' | 'denied' | 'unavailable' | 'cancelled';

interface CameraAccessDependencies {
  mediaDevices: () => Pick<MediaDevices, 'getUserMedia'> | undefined;
}

// Permission only: acquiring and immediately releasing video never samples frames.
export function createCameraAccessRequester({ mediaDevices }: CameraAccessDependencies) {
  return (signal: AbortSignal, beforeRequest?: () => Promise<void>): Promise<CameraAccessResult> => {
    if (signal.aborted) return Promise.resolve('cancelled');
    return new Promise(resolve => {
      let settled = false;
      const finish = (result: CameraAccessResult) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        resolve(result);
      };
      const cancel = () => finish('cancelled');
      signal.addEventListener('abort', cancel, { once: true });
      void (async () => {
        try {
          await beforeRequest?.();
          if (signal.aborted) { finish('cancelled'); return; }
          const devices = mediaDevices();
          if (!devices?.getUserMedia) { finish('unavailable'); return; }
          const stream = await devices.getUserMedia({ video: true, audio: false });
          // getUserMedia cannot be aborted. Release even a stream arriving after cancel.
          for (const track of stream.getTracks()) track.stop();
          finish(signal.aborted ? 'cancelled' : 'granted');
        } catch (error) {
          const name = (error as { name?: string } | null)?.name;
          finish(signal.aborted ? 'cancelled' : name === 'NotAllowedError' || name === 'PermissionDeniedError' ? 'denied' : 'unavailable');
        }
      })();
    });
  };
}

export const requestCameraAccess = createCameraAccessRequester({
  mediaDevices: () => typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
});
