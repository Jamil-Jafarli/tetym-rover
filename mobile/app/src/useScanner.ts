import { useCallback, useEffect, useRef, useState } from 'react';
import * as ARScanner from './native/ARScanner';
import { EMPTY_STATUS, type Capabilities, type Relay, type ScanStatus } from './types';

export interface StartOptions {
  room: string;
  sliceHeightM: number;
  rateHz?: number;
  /** Manual override. Omit to use whatever discovery found. */
  relayURL?: string;
}

export interface ScannerController {
  status: ScanStatus;
  capabilities: Capabilities | null;
  relays: Relay[];
  error: string | null;
  available: boolean;
  start: (options: StartOptions) => Promise<void>;
  stop: () => Promise<void>;
  setSliceHeight: (metres: number) => Promise<void>;
  resetMap: () => Promise<void>;
  clearError: () => void;
}

export function useScanner(): ScannerController {
  const [status, setStatus] = useState<ScanStatus>(EMPTY_STATUS);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [relays, setRelays] = useState<Relay[]>([]);
  const [error, setError] = useState<string | null>(null);
  const available = ARScanner.isAvailable();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!available) {
      setError('Native scanner module not found — see the console for the checklist.');
      return () => { mounted.current = false; };
    }

    const offStatus = ARScanner.onStatus((s) => { if (mounted.current) setStatus(s); });
    const offError = ARScanner.onError((message) => { if (mounted.current) setError(message); });

    ARScanner.getCapabilities()
      .then((c) => { if (mounted.current) setCapabilities(c); })
      .catch((e: Error) => { if (mounted.current) setError(e.message); });

    // Start browsing immediately. By the time the user has read the screen the
    // relay is usually already found, so Start just works with nothing typed.
    void ARScanner.startDiscovery().catch(() => {});

    return () => {
      mounted.current = false;
      offStatus();
      offError();
      void ARScanner.stopDiscovery().catch(() => {});
    };
  }, [available]);

  // The native status event tells us WHEN discovery changed; the list itself is
  // pulled, so the event payload stays small and fixed-shape.
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    ARScanner.listRelays()
      .then((found) => { if (!cancelled && mounted.current) setRelays(found); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [available, status.discovery]);

  // Stopping on unmount matters: the ARSession holds the camera and the LiDAR,
  // and leaving it running drains the battery long after the screen is gone.
  useEffect(() => () => { void ARScanner.stop().catch(() => {}); }, []);

  const start = useCallback(async (options: StartOptions) => {
    setError(null);
    try {
      const next = await ARScanner.start({
        relayURL: options.relayURL,
        room: options.room,
        sliceHeightM: options.sliceHeightM,
        rateHz: options.rateHz ?? 10,
      });
      if (mounted.current) setStatus(next);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stop = useCallback(async () => {
    try { await ARScanner.stop(); } catch { /* already stopped */ }
  }, []);

  const setSliceHeight = useCallback(async (metres: number) => {
    try { await ARScanner.setSliceHeight(metres); } catch { /* not running */ }
  }, []);

  const resetMap = useCallback(async () => {
    try { await ARScanner.resetMap(); } catch { /* not running */ }
  }, []);

  return {
    status, capabilities, relays, error, available,
    start, stop, setSliceHeight, resetMap,
    clearError: () => setError(null),
  };
}
