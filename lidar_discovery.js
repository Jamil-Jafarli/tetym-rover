/**
 * Announcing the LiDAR relay on the network, so the phone finds it by itself.
 *
 * Ported from webscan (apps/server/src/discovery.ts). The webscan ARKit app no
 * longer asks for an address: it browses mDNS for `_webscan._tcp`, reads `tls`
 * and `path` from the TXT record, and connects. This server advertises the
 * same service type with the same TXT keys, so the app lists the rover exactly
 * as it would list webscan's own relay — open it, press Start.
 *
 * It matters more here than it did in webscan. The Pi is usually on two
 * networks at once — the ESP32's access point and a router — and "which of my
 * addresses do you type into the phone" has no answer that fits in a banner.
 * mDNS answers from every interface, and the phone connects to whichever one
 * it can actually reach.
 *
 * Goodbye packets on shutdown are the half that is easy to forget: without
 * them the phone keeps a stale entry and dials a server that is gone, which
 * from the app looks exactly like a network fault.
 */

import os from 'node:os';

export const SERVICE_TYPE = 'webscan';

/** The name in the app's picker — the machine, and that it is the rover. */
export function serviceName() {
  const host = os.hostname().replace(/\.local$/i, '').slice(0, 40);
  return `tetym-rover on ${host}`;
}

/**
 * Start advertising. Never throws: a relay that cannot be announced is still
 * reachable at its address, so this is a degraded mode, not a failure.
 *
 * @returns {Promise<{name: string|null, error: string|null, stop: () => Promise<void>}>}
 */
export async function advertise({ port, tls = false, path = '/ws' }) {
  let Bonjour;
  try {
    ({ Bonjour } = await import('bonjour-service'));
  } catch {
    return { name: null, error: 'bonjour-service is not installed (npm install)',
             stop: async () => {} };
  }

  let bonjour;
  const state = { name: serviceName(), error: null };
  try {
    bonjour = new Bonjour({}, (err) => {
      state.error = err && err.message ? err.message : String(err);
    });
    const service = bonjour.publish({
      name: state.name, type: SERVICE_TYPE, protocol: 'tcp', port,
      // Strings only: TXT values are bytes on the wire and some stacks refuse
      // anything else. Same keys as webscan, which is what the app reads.
      txt: { tls: tls ? '1' : '0', path, v: '1', host: os.hostname(), app: 'tetym-rover' },
    });
    service.on('error', (err) => {
      state.error = err && err.message ? err.message : String(err);
      console.warn(`lidar: mDNS announcement failed: ${state.error} — `
        + 'the phone can still connect by address');
    });
  } catch (err) {
    return { name: null, error: err.message || String(err), stop: async () => {} };
  }

  let stopped = false;
  return {
    get name() { return state.name; },
    get error() { return state.error; },
    stop() {
      if (stopped) return Promise.resolve();
      stopped = true;
      return new Promise((resolve) => {
        const t = setTimeout(resolve, 1500);
        t.unref();
        try {
          bonjour.unpublishAll(() => {
            try { bonjour.destroy(); } catch { /* already closed */ }
            clearTimeout(t);
            resolve();
          });
        } catch { resolve(); }
      });
    },
  };
}
