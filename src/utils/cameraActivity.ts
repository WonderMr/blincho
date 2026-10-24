import { subscribeLanguage, t } from '../i18n/runtime';

/** Tracks acquired video streams, independently of settings and pending prompts. */
export function createCameraActivityReporter(report: (active: boolean) => Promise<void> | void) {
  const owners = new Set<{ stream: MediaStream; release: () => void }>();
  let active = false;
  let queue = Promise.resolve();
  const publish = (force = false) => {
    const next = owners.size > 0;
    if (!force && next === active) return;
    active = next;
    // Preserve transition order even when native IPC is slow or rejects a call.
    queue = queue.then(() => report(next)).catch(error => console.warn('Blincho: Camera indicator unavailable:', error));
  };
  const trackStream = (stream: MediaStream): (() => void) => {
    const tracks = stream.getVideoTracks?.() ?? stream.getTracks().filter(track => track.kind === 'video');
    if (!tracks.some(track => track.readyState === 'live')) return () => {};
    let released = false;
    const ended = () => { if (!tracks.some(track => track.readyState === 'live')) release(); };
    const release = () => {
      if (released) return;
      released = true;
      for (const track of tracks) track.removeEventListener?.('ended', ended);
      owners.delete(owner);
      publish();
    };
    const owner = { stream, release };
    owners.add(owner);
    for (const track of tracks) track.addEventListener?.('ended', ended);
    publish();
    return release;
  };
  return {
    trackStream,
    refresh: () => { if (active) publish(true); },
    stopAll: () => {
      for (const owner of [...owners]) {
        for (const track of owner.stream.getTracks()) {
          try { track.stop(); } catch (error) { console.warn('Blincho: Camera release failed:', error); }
        }
        owner.release();
      }
    },
    settled: () => queue,
  };
}

const activity = createCameraActivityReporter(active =>
  typeof window === 'undefined' ? undefined : window.desktopAPI?.setCameraActivity?.(active, t('Камера Blincho активна')));
export const trackCameraStream = activity.trackStream;
subscribeLanguage(activity.refresh);
if (typeof window !== 'undefined') window.addEventListener('pagehide', activity.stopAll);
