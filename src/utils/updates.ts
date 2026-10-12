import { useCallback, useEffect, useRef, useState } from 'react';

export type UpdatePolicy = 'ask' | 'auto' | 'off';
export interface UpdateState {
  policy: UpdatePolicy;
  status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error' | 'manual';
  supported: boolean;
  supportReason: null | 'development' | 'unsigned-mac' | 'unsupported-package' | 'missing-config';
  currentVersion: string;
  availableVersion: string | null;
  skippedVersion: string | null;
  progress: number | null;
  lastCheckedAt: string | null;
  errorCode: null | 'check-failed' | 'download-failed' | 'preferences-failed' | 'invalid-request';
  installOnQuit: boolean;
  manualCheck: boolean;
  manualDownloadUrl: string;
}

export interface UpdateBridge {
  getUpdateState?: () => Promise<UpdateState>;
  setUpdatePolicy?: (policy: UpdatePolicy) => Promise<UpdateState>;
  checkForUpdates?: () => Promise<UpdateState>;
  downloadUpdate?: (version: string) => Promise<UpdateState>;
  skipUpdate?: (version: string) => Promise<UpdateState>;
  onUpdateState?: (callback: (state: UpdateState) => void) => (() => void);
  openUpdateDownload?: () => Promise<boolean>;
}

export function useUpdates() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const request = useRef(0);
  const api = window.electronAPI;

  useEffect(() => {
    mounted.current = true;
    const initialRevision = revision.current;
    const unsubscribe = api?.onUpdateState?.(next => {
      revision.current++;
      if (mounted.current) setState(next);
    });
    if (api?.getUpdateState) {
      Promise.resolve().then(() => api.getUpdateState!()).then(next => {
        if (mounted.current && revision.current === initialRevision) setState(next);
      }).catch(() => { if (mounted.current) setFailed(true); });
    }
    return () => { mounted.current = false; revision.current++; unsubscribe?.(); };
  }, [api]);

  const run = useCallback(async (operation: (() => Promise<UpdateState>) | undefined) => {
    if (!operation) return;
    const currentRequest = ++request.current;
    const initialRevision = revision.current;
    setPending(true);
    setFailed(false);
    try {
      const next = await operation();
      // A push received after the command started is more recent than its reply.
      if (mounted.current && request.current === currentRequest && revision.current === initialRevision) setState(next);
    } catch {
      if (mounted.current && request.current === currentRequest) setFailed(true);
    } finally {
      if (mounted.current && request.current === currentRequest) setPending(false);
    }
  }, []);

  return {
    state, pending, failed,
    setPolicy: (policy: UpdatePolicy) => run(api?.setUpdatePolicy ? () => api.setUpdatePolicy!(policy) : undefined),
    check: () => run(api?.checkForUpdates),
    download: () => run(api?.downloadUpdate && state?.availableVersion ? () => api.downloadUpdate!(state.availableVersion!) : undefined),
    skip: () => run(api?.skipUpdate && state?.availableVersion ? () => api.skipUpdate!(state.availableVersion!) : undefined),
    openDownload: async () => {
      try { if (!await api?.openUpdateDownload?.() && mounted.current) setFailed(true); }
      catch { if (mounted.current) setFailed(true); }
    },
  };
}

export type UpdateControls = ReturnType<typeof useUpdates>;
