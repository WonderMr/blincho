// Intelligent Idle and Meeting / Presentation Detection Service
import { normalizeMeetingApplications } from './meetings';

export interface MeetingStatus {
  inMeeting: boolean;
  details?: string;
  supported?: boolean;
  applications?: string[];
}

let lastPageActivity = Date.now();

export function markPageActivity(): void { lastPageActivity = Date.now(); }

export function hasSystemIdleDetection(): boolean { return !!window.desktopAPI?.getSystemIdleTime; }

export function hasMeetingDetection(): boolean { return !!window.desktopAPI?.meetingDetectionSupported; }

export async function getSystemIdleSeconds(): Promise<number | null> {
  if (window.desktopAPI?.getSystemIdleTime) {
    try {
      const seconds = await window.desktopAPI.getSystemIdleTime();
      if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) return seconds;
    } catch (error) {
      console.warn('Blincho: System idle detection failed; presence is unconfirmed:', error);
    }
    return null;
  }
  if (window.desktopAPI?.isDesktop) return null;
  return Math.max(0, (Date.now() - lastPageActivity) / 1000);
}

export async function detectActiveMeeting(options?: { fresh?: boolean }): Promise<MeetingStatus> {
  if (window.desktopAPI?.checkMeetingActive) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const status: MeetingStatus = await Promise.race([
        Promise.resolve().then(() => window.desktopAPI!.checkMeetingActive!(options)),
        new Promise<MeetingStatus>(resolve => {
          timeout = setTimeout(() => {
            console.warn('Blincho: Meeting detection timed out.');
            resolve({ inMeeting: false, supported: false });
          }, 3000);
        }),
      ]);
      if (!status || typeof status.inMeeting !== 'boolean') {
        console.warn('Blincho: Invalid meeting detection response.');
        return { inMeeting: false, supported: false };
      }
      return { ...status, ...(status.applications !== undefined ? {
        applications: status.inMeeting ? normalizeMeetingApplications(status.applications) : [],
      } : {}) };
    } catch (error) {
      console.warn('Blincho: Meeting detection failed:', error);
      return { inMeeting: false, supported: false };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
  return { inMeeting: false, supported: false };
}
