import {
  NativeEventEmitter,
  NativeModules,
  Platform,
  requireNativeComponent,
  type ViewProps,
} from 'react-native';
import type { Capabilities, Relay, ScanStatus, StartConfig } from '../types';

const LINKING_ERROR =
  `The ARScannerModule native module is not available.\n\n` +
  `Checklist:\n` +
  `  • iOS only — this module does not exist on ${Platform.OS}\n` +
  `  • run 'cd ios && pod install'\n` +
  `  • rebuild from Xcode (a JS reload is not enough after native changes)\n` +
  `  • confirm the Swift files are members of the app target`;

interface ARScannerNative {
  getCapabilities(): Promise<Capabilities>;
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  listRelays(): Promise<Relay[]>;
  start(config: StartConfig): Promise<ScanStatus>;
  stop(): Promise<void>;
  setSliceHeight(metres: number): Promise<void>;
  setRate(hz: number): Promise<void>;
  resetMap(): Promise<void>;
  getStatus(): Promise<ScanStatus>;
}

const native: ARScannerNative | undefined = NativeModules.ARScannerModule;

function requireNative(): ARScannerNative {
  if (!native) throw new Error(LINKING_ERROR);
  return native;
}

export const isAvailable = (): boolean => Platform.OS === 'ios' && native != null;

/**
 * Status updates are pushed from Swift at roughly 5 Hz, NOT once per scan.
 *
 * Scan data never crosses the bridge at all — Swift streams it straight to the
 * relay over its own WebSocket. What arrives here is a small HUD snapshot, so
 * the JS thread stays idle no matter how fast the sensor runs.
 */
const emitter = native
  ? new NativeEventEmitter(NativeModules.ARScannerModule)
  : undefined;

// NativeEventEmitter types its payloads as `Object`, because the bridge cannot
// know what a given module sends. The shapes are defined by ARScannerModule's
// `serialise` on the Swift side, so the cast is asserting a contract that lives
// in Swift — keep the two in step when you add a field.
export function onStatus(handler: (status: ScanStatus) => void): () => void {
  const sub = emitter?.addListener('scanStatus', (payload) =>
    handler(payload as unknown as ScanStatus),
  );
  return () => sub?.remove();
}

export function onError(handler: (message: string) => void): () => void {
  const sub = emitter?.addListener('scanError', (payload) =>
    handler((payload as unknown as { message: string }).message),
  );
  return () => sub?.remove();
}

export const getCapabilities = (): Promise<Capabilities> =>
  requireNative().getCapabilities();
export const startDiscovery = (): Promise<void> => requireNative().startDiscovery();
export const stopDiscovery = (): Promise<void> => requireNative().stopDiscovery();
export const listRelays = (): Promise<Relay[]> => requireNative().listRelays();
export const start = (config: StartConfig): Promise<ScanStatus> =>
  requireNative().start(config);
export const stop = (): Promise<void> => requireNative().stop();
export const setSliceHeight = (metres: number): Promise<void> =>
  requireNative().setSliceHeight(metres);
export const setRate = (hz: number): Promise<void> => requireNative().setRate(hz);
export const resetMap = (): Promise<void> => requireNative().resetMap();
export const getStatus = (): Promise<ScanStatus> => requireNative().getStatus();

/**
 * Live camera preview. Renders the very ARSession being scanned, so mounting
 * it costs nothing extra and unmounting it does not stop a scan in progress.
 */
export interface ARScannerPreviewProps extends ViewProps {
  showFeaturePoints?: boolean;
}

export const ARScannerPreview =
  Platform.OS === 'ios'
    ? requireNativeComponent<ARScannerPreviewProps>('ARScannerPreviewView')
    : (null as never);
