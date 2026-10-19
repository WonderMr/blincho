export type CameraPresence = 'present' | 'absent' | 'unavailable';
interface PersonDetector {
  detect(image: HTMLCanvasElement): { detections: Array<{ categories: Array<{ categoryName: string; score: number }> }> } | Promise<{ detections: Array<{ categories: Array<{ categoryName: string; score: number }> }> }>;
  close(): void;
}
interface CameraEnvironment {
  mediaDevices(): Pick<MediaDevices, 'getUserMedia'> | undefined;
  createVideo(): HTMLVideoElement;
  createCanvas(): HTMLCanvasElement;
  loadDetector(): Promise<PersonDetector>;
  now(): number;
}
const CHECK_TIMEOUT_MS = 15_000;
const FRAME_GAP_MS = 400;
const REQUIRED_EMPTY_FRAMES = 3;
const defaultEnvironment: CameraEnvironment = {
  mediaDevices: () => typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
  createVideo: () => document.createElement('video'),
  createCanvas: () => document.createElement('canvas'),
  loadDetector: async () => (await import('./cameraModel')).loadPersonDetector(),
  now: () => performance.now(),
};

// Covered/black camera frames cannot establish that a person is absent.
export function isUsableCameraFrame(pixels: Uint8ClampedArray): boolean {
  if (pixels.length < 4) return false;
  let total = 0, minimum = 255, maximum = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const brightness = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
    total += brightness; minimum = Math.min(minimum, brightness); maximum = Math.max(maximum, brightness);
  }
  return total / (pixels.length / 4) >= 8 && maximum - minimum >= 10;
}

export function createCameraPresenceChecker(environment: CameraEnvironment = defaultEnvironment) {
  let inFlight: Promise<CameraPresence> | undefined;
  let inFlightSignal: AbortSignal | undefined;
  return function checkPresence(signal?: AbortSignal): Promise<CameraPresence> {
    if (inFlight) {
      // A new purpose must not inherit an aborted observation, for example
      // when break completion replaces an enhanced-presence check.
      if (inFlightSignal?.aborted && !signal?.aborted) return inFlight.then(() => checkPresence(signal));
      return inFlight;
    }
    const media = environment.mediaDevices();
    if (!media?.getUserMedia || signal?.aborted) return Promise.resolve('unavailable');
    const check = async (): Promise<CameraPresence> => {
      let cancelled = false;
      let stream: MediaStream | undefined;
      let detector: PersonDetector | undefined;
      let video: HTMLVideoElement | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const stop = () => { for (const track of stream?.getTracks() ?? []) track.stop(); };
      let cancel!: () => void;
      const aborted = new Promise<CameraPresence>(resolve => {
        cancel = () => { cancelled = true; stop(); resolve('unavailable'); };
        timeout = setTimeout(cancel, CHECK_TIMEOUT_MS);
        signal?.addEventListener('abort', cancel, { once: true });
      });
      const capture = async (): Promise<CameraPresence> => {
        try {
          stream = await media.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } });
          if (cancelled) { stop(); return 'unavailable'; }
          const track = stream.getVideoTracks()[0];
          if (!track || track.readyState !== 'live' || track.muted) return 'unavailable';
          video = environment.createVideo();
          video.muted = true; video.playsInline = true; video.srcObject = stream;
          await video.play();
          if (cancelled) return 'unavailable';
          detector = await environment.loadDetector();
          if (cancelled) { detector.close(); detector = undefined; return 'unavailable'; }
          const canvas = environment.createCanvas();
          canvas.width = 320; canvas.height = 240;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) return 'unavailable';
          let emptyFrames = 0, previousFrameTime = -1;
          let previousPixels: Uint8ClampedArray | undefined;
          const deadline = environment.now() + 4000;
          while (!cancelled && environment.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, FRAME_GAP_MS));
            if (cancelled || track.readyState !== 'live' || track.muted) return 'unavailable';
            if (video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.currentTime <= previousFrameTime) continue;
            previousFrameTime = video.currentTime;
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            if (!isUsableCameraFrame(pixels)) return 'unavailable';
            // Some stalled camera drivers still advance video timestamps.
            if (previousPixels && pixels.every((value, index) => value === previousPixels![index])) return 'unavailable';
            previousPixels = new Uint8ClampedArray(pixels);
            const result = await detector.detect(canvas);
            if (cancelled || track.readyState !== 'live' || track.muted) return 'unavailable';
            if (!Array.isArray(result?.detections)) return 'unavailable';
            if (result.detections.some(detection => detection.categories.some(category => category.categoryName === 'person' && category.score >= 0.35))) return 'present';
            if (++emptyFrames >= REQUIRED_EMPTY_FRAMES) return 'absent';
          }
          return 'unavailable';
        } catch (error) {
          console.warn('Blincho: Camera presence check unavailable:', error);
          return 'unavailable';
        }
      };
      try { return await Promise.race([capture(), aborted]); }
      finally {
        cancelled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
        stop();
        if (video) { video.pause(); video.srcObject = null; }
        detector?.close(); detector = undefined;
      }
    };
    const pending = check().finally(() => { if (inFlight === pending) { inFlight = undefined; inFlightSignal = undefined; } });
    inFlight = pending;
    inFlightSignal = signal;
    return pending;
  };
}

export const checkCameraPresence = createCameraPresenceChecker();
