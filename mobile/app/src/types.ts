/** Mirrors ARSessionController.Status on the Swift side. */
export interface ScanStatus {
  running: boolean;
  hasLiDAR: boolean;
  /** 'normal' | 'initialising' | 'moving too fast' | 'not enough texture' | … */
  trackingState: string;
  floorFound: boolean;
  /** World Y of the detected floor, metres. */
  floorY: number;
  /** Height of the slice plane above that floor, metres. */
  sliceHeightM: number;
  x: number;
  z: number;
  yawDeg: number;
  fps: number;
  /** Depth samples that landed inside the slab this frame. */
  bandSamples: number;
  /** Bearing bins that got a usable range, out of 256. */
  validBins: number;
  framesSent: number;
  framesDropped: number;
  bytesSent: number;
  rttMs: number;
  relayState: 'idle' | 'connecting' | 'open' | 'closed' | string;
  /** Bonjour name of the relay we auto-connected to, if any. */
  relayName: string;
  /** 'idle' | 'searching' | 'none found' | 'found …' | 'N relays' | 'failed' */
  discovery: string;
  /** Scans not sent because nothing moved — this is the filter working. */
  framesSkipped: number;
  /** Profiler, exponentially smoothed, milliseconds. */
  extractMs: number;
  encodeMs: number;
  frameMs: number;
  /** Camera format ARKit is actually running, e.g. '1280x720@60'. */
  videoFormat: string;
  /** Plane detection turns itself off once the floor is locked. */
  planeDetectionOn: boolean;
  note: string;
}

/** A relay found on the local network via mDNS. */
export interface Relay {
  /** Bonjour instance name, e.g. 'webscan on Ali-MacBook'. */
  name: string;
  host: string;
  port: number;
  tls: boolean;
  /** Ready-made WebSocket URL. */
  url: string;
  displayHost: string;
}

export interface Capabilities {
  worldTracking: boolean;
  /** True only on LiDAR devices. Never infer this from a model-name table. */
  sceneDepth: boolean;
  sceneReconstruction: boolean;
  deviceModel: string;
  systemVersion: string;
}

export interface StartConfig {
  /**
   * Omit (or leave empty) to use whatever discovery found. That is the normal
   * path — an explicit URL is the manual override for networks where mDNS is
   * blocked.
   */
  relayURL?: string;
  room: string;
  /** Height of the horizontal slice above the floor, metres. */
  sliceHeightM: number;
  /** Scans per second sent to the relay. The LiDAR itself runs at 60 Hz. */
  rateHz: number;
}

export const EMPTY_STATUS: ScanStatus = {
  running: false,
  hasLiDAR: false,
  trackingState: 'not available',
  floorFound: false,
  floorY: 0,
  sliceHeightM: 1,
  x: 0,
  z: 0,
  yawDeg: 0,
  fps: 0,
  bandSamples: 0,
  validBins: 0,
  framesSent: 0,
  framesDropped: 0,
  bytesSent: 0,
  rttMs: 0,
  relayState: 'idle',
  relayName: '',
  discovery: 'idle',
  framesSkipped: 0,
  extractMs: 0,
  encodeMs: 0,
  frameMs: 0,
  videoFormat: '',
  planeDetectionOn: true,
  note: '',
};
