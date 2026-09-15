# Mobile app — iPhone LiDAR scanner (webscan · ARKit)

The rover has no LiDAR sensor of its own; this app turns an iPhone Pro's LiDAR
into one. It came from webscan's `apps/ios` and lives here now, next to the
server it talks to: the relay is this repo's `lidar_relay.js`, on the same port
as every page, and the map is drawn on `/dashboard`, `/panel` and `/lidar`.
The wire format and the `_webscan._tcp` announcement are unchanged, so the app
still works against webscan's own relay too.

Native iOS sender for the same relay and viewer as the browser scanner.
React Native + TypeScript on top, a Swift ARKit module underneath.

```
iPhone (LiDAR)                        tetym-rover         Any browser
┌────────────────────────────────┐   ┌─────────────┐   ┌───────────────┐
│ ARKit sceneDepth  (metric)     │   │ Express+ws  │   │ radar / plan  │
│ VIO pose          (no drift)   │──►│ /ws relay   │──►│ /lidar, panel │
│ horizontal slice → 256 bins    │WS └─────────────┘   └───────────────┘
│ SCN1 frame, 560 bytes          │560B      ▲
└────────────────────────────────┘          │ _webscan._tcp (mDNS)
   React Native ▲ status only (~5 Hz)       └─ the app finds this by itself
   Scan data never crosses the bridge.
```

## What this fixes

The browser scanner's one real limitation was that **walking drifts**: monocular
depth re-normalises every frame, a scale wobble is indistinguishable from a
translation, and the position random-walks by metres over a 12 m path. ARKit
removes that channel entirely.

| | Browser (Safari) | This app (ARKit) |
|---|---|---|
| Depth | neural network, relative | LiDAR, metric ±1–2 cm |
| Scale calibration | manual, per room | none needed |
| Position while walking | drifts 2–7 m / 12 m | VIO, no drift |
| Standing still | good (10 cm map) | good |
| Walking | shape only | **as accurate as standing** |
| Slice plane | at the phone's height | at a fixed height **above the detected floor** |
| Install | none | Xcode / TestFlight |

That last row is a genuine usability win, not just accuracy: ARKit's world frame
is gravity-aligned and persistent, so the slice sits 1.0 m above the *floor*.
Raise and lower your hand mid-scan and the map does not care.

## Finding the relay

Nobody types an IP address. The relay advertises `_webscan._tcp` over mDNS and
the app browses for it, so the flow is: open the app, press Start.

* **One relay on the network** — the normal case — connects with nothing to
  choose. The screen just says which machine it found.
* **More than one** shows a short picker. Whichever you used last wins next
  time, so a second phone in the same room stays on the same relay.
* **mDNS blocked** (some guest and corporate Wi-Fi drop multicast) — open
  *Enter an address manually* and type it once. Everything else still works.

The TXT record carries `tls` and `path`, so the app builds `ws://host:8443` or
`wss://host:443` from what the relay actually is rather than assuming. The relay
also sends goodbye packets on shutdown; without those a phone keeps a stale
entry and dials a relay that is not there, which looks exactly like a network
fault from the app side. `npm run test:lidar` checks both halves.

Turn it off with `node server.js --no-advertise` where multicast is pointless or
unwelcome.

## Requirements

* **macOS** with Xcode 15+ (`sudo xcode-select -s /Applications/Xcode.app`)
* Node 20+, CocoaPods (`sudo gem install cocoapods`), the xcodeproj gem
  (`sudo gem install xcodeproj`)
* **An iPhone with LiDAR** — 12 Pro/Pro Max, 13 Pro, 14 Pro, 15 Pro, 16 Pro, or an
  iPad Pro. Non-Pro phones track fine but have no dense depth, so the map stays
  empty; the app detects this and says so.
* iOS 16+
* **A real device.** ARKit does not exist in the simulator. The app builds for it
  and then fails at runtime.

Capability is detected with
`ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)` — never from a
device-model table, which goes stale every autumn.

## Setup

```bash
cd mobile
./setup.sh                    # or: ./setup.sh MyAppName /path/to/dir
```

That generates a React Native project with the official CLI, copies the sources
in, registers the Swift files with the Xcode target, creates the bridging
header, patches `Info.plist`, and runs `pod install`.

An `.xcodeproj` is a generated artefact — its format tracks the Xcode release and
its contents track the React Native version you actually install. Checking one in
produces a file that looks right and breaks on the next machine, so the script
generates it instead.

<details>
<summary>Manual setup, if the script fails</summary>

1. `npx @react-native-community/cli init WebScanner`
2. Copy `app/App.tsx` and `app/src/` into the project root.
3. Drag `native/ios/` into Xcode, ticked for the app target. Accept the
   "create bridging header" prompt.
4. Paste the contents of `native/ios/WebScanner-Bridging-Header.h` into the
   header Xcode made.
5. In Build Settings: Swift Version 5.0, iOS Deployment Target 16.0.
6. Add to `Info.plist`: `NSCameraUsageDescription`,
   `NSLocalNetworkUsageDescription`, `UIRequiredDeviceCapabilities = [arkit]`,
   and `NSAppTransportSecurity.NSAllowsLocalNetworking = true`.
7. `cd ios && pod install`, then open the **`.xcworkspace`**, not the project.
</details>

## Running

1. Start the rover server, from the repo root (on the Pi, or any machine on the
   same network):
   ```bash
   node server.js --marlin     # the rover, Ender 3 Pro board on USB
   npm run fake                # or: no hardware, simulated board and LiDAR
   ```
   It prints its LAN address (`ws://<ip>:8090`) and the Bonjour name it
   announced. You will not need the address unless mDNS is blocked on your
   network. Leave `--lidar-sim` off when the phone is the scanner.

2. `open ios/WebScanner.xcworkspace`, select your iPhone, set
   **Signing & Capabilities → Team** to your Apple ID, press ⌘R.

3. In the app: the rover should already be listed. Keep the room `default` (or
   start the server with `--lidar-room <name>`), press Start.

4. Open the map anywhere on the network:
   `http://192.168.1.20:8090/lidar` — or `/dashboard`, or `/panel`.

The phone and the rover must be on the same network. `ws://` to a LAN address works
because `NSAllowsLocalNetworking` is set; a relay on the open internet should be
`wss://`, and then that exemption is not involved at all.

## Architecture

```
native/ios/
  ScanFrameEncoder.swift      SCN1 binary frame — byte-for-byte the TS format
  ScanExtractor.swift         depth map → horizontal slice → 256 bearing bins
  ARSessionController.swift   ARSession, floor lock, rate limiting, profiler
  RelayDiscovery.swift        NWBrowser: find the relay, resolve it to host:port
  RelayClient.swift           URLSessionWebSocketTask, reconnect, backpressure
  MotionFilter.swift          do not transmit when nothing moved
  ARScannerModule.swift/.m    the RN bridge (commands down, status up)
  ARScannerPreviewView.swift  live preview on the SAME ARSession
app/
  App.tsx                     UI
  src/useScanner.ts           hook: status, discovery, errors, lifecycle
  src/native/ARScanner.ts     typed wrapper over the native module
bench/
  scan_loop_bench.c           the inner loop, naive vs optimised, in C
```

**Scan data never crosses the React Native bridge.** 256 ranges at 10 Hz — or a
point cloud, if you extend this — serialised through the bridge every frame is
the classic way to make an otherwise fine AR app unusable. Swift owns its own
WebSocket and talks to the relay directly; the bridge carries commands down and a
throttled HUD snapshot (~5 Hz) up. The JS thread stays idle regardless of what
the sensor is doing.

Other decisions worth knowing:

* **Intrinsics are scaled.** `camera.intrinsics` describes the captured image
  (1920×1440); the depth map is 256×192. Unprojecting with unscaled intrinsics
  gives rays that are wrong by a factor of 7.5 — and the result still *looks*
  like a room, which is what makes it a nasty bug.
* **Confidence filtering.** ARKit grades every depth pixel 0/1/2; low-confidence
  samples are dropped before they reach the slice.
* **Second-smallest per bin.** Even LiDAR produces flyers at object silhouettes,
  and one stray reading both plants a false obstacle and erases the real wall
  behind it when the viewer casts its free-space ray.
* **Smoothed depth** (`.smoothedSceneDepth`) is preferred over raw: a little
  latency for markedly less frame-to-frame flicker, which is what an occupancy
  grid wants.
* **Lowest sizeable horizontal plane is the floor.** Small planes are table tops
  and seats; using one as "the floor" would misplace the slice for the whole
  session.

## What actually costs

The app has an on-screen profiler, because optimisation claims that nobody
measured are just opinions. Numbers below are split into what was measured and
what was reasoned — those are different things.

**Measured** (C, `-O2`, see `bench/`; the Swift mirrors it, it is not the same
binary):

| | before | after |
|---|---|---|
| depth → scan loop | 0.218 ms/frame | **0.110 ms/frame** |
| worst-case difference in the result | — | 0.48 µm |

The loop transforms 49 152 pixels but fewer than 5% land in the slab, so the
naive form spends almost all of its time on pixels it throws away. Precomputing
per-column and per-row partials reduces the height test to three flops, and only
survivors pay for the range, the bearing and the binning. The algebra that makes
this exact: the translation column of `camera.transform` *is* the camera
position, so the per-pixel "subtract the camera" step cancels out.

**Read the absolute number, not the ratio.** 0.11 ms at 10 Hz is ~0.1% of one
core. This loop was never the bottleneck, and doubling its speed buys no battery
life you can feel. It ships because it is also allocation-free and, once the
algebra is written down, simpler.

**Reasoned, and visible in the profiler on device** — these are where the power
actually goes:

* **Camera format.** ARKit defaults to a large video format; the colour image is
  used for tracking and the preview and nothing else, since the scan comes
  entirely from the depth map. The session now picks the smallest format that
  still gives ARKit 60 fps to track with. The HUD shows which one it chose.
* **Plane detection stops.** It runs continuous geometry work, and once the
  floor has been stable for 30 updates there is nothing left for it to find that
  we use. Reconfiguring without `.horizontal` and *without* `resetTracking`
  keeps the world and the anchors intact.
* **No transmission when still.** The browser sender and the viewer already run
  a motion filter; running it on the phone means the packets are never sent at
  all. Standing still now costs one heartbeat every 700 ms instead of ten scans
  a second — and the map is unaffected, because those scans were being discarded
  at the other end anyway. The HUD counts them as "skipped (still)".
* **Preview is a viewfinder.** 30 fps, no antialiasing, no automatic lighting,
  no continuous rendering. The operator is looking at where the phone points,
  not at motion detail.
* **Rate limit before work.** ARKit delivers at 60 Hz and holds the frame while
  the delegate is running, so a frame we do not want returns immediately rather
  than after the extraction.

The profiler shows extract, encode and total per frame. If total stays well under
the send interval (100 ms at 10 Hz), the scanner is not the bottleneck — ARKit,
the LiDAR and the radio are, and further micro-optimisation here is wasted effort.

## Tests

⌘U in Xcode runs `ScanFrameEncoderTests`, which asserts the Swift encoder's bytes
against a golden vector produced by the **TypeScript** encoder the relay and
viewer use. That is what actually guarantees the two languages agree on the wire
format, rather than each being internally consistent and silently incompatible.

The same vector is pinned in this repo's `test/test_lidar.mjs`, against the
JavaScript encoder in `public/lidar.js`. A protocol change updates all three
together — the Swift encoder, `public/lidar.js`, and both tests.

On the repo side:

```bash
npm run test:lidar       # SCN1 bytes, relay end to end, mDNS appears AND withdraws
cc -O2 -o bench bench/scan_loop_bench.c -lm && ./bench   # the loop, both forms
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `ARScannerModule is not available` | Native change without a native rebuild. ⌘R in Xcode; a JS reload is not enough. |
| Build error: bridging header not found | `SWIFT_OBJC_BRIDGING_HEADER` path is wrong. Re-run `scripts/add_native_files.rb`. |
| App dies the moment scanning starts | `NSCameraUsageDescription` missing. iOS terminates rather than warns. |
| `relayState: connecting` forever | Different network, or the relay is on HTTPS while the app uses `ws://`. Use `wss://` for a TLS relay. |
| "no relay found yet" forever | `NSBonjourServices` missing from Info.plist — NWBrowser refuses to browse an undeclared type, silently. Re-run `scripts/patch_ios_config.sh`. |
| "local network access blocked" | iOS asks once. Settings → Privacy & Security → Local Network → your app. |
| Found a relay that is not running | A stale entry, meaning the relay died without sending goodbye packets (`kill -9`). It ages out; `npm run test:lidar` verifies clean shutdowns. |
| Map empty, `LiDAR: no` | Non-Pro iPhone. Tracking works; there is no dense depth to slice. |
| `tracking: not enough texture` | Blank walls. Point at something with detail for a few seconds to let VIO lock on. |
| Duplicate symbols after re-running setup | The Ruby script removes and re-adds its own group; if you also dragged the files in by hand, delete one copy. |

## Limits

* LiDAR is specified to about 5 m; `maxRangeM` is set there. Beyond it, returns
  get sparse and noisy.
* The slice is one horizontal plane. Furniture below or above it is invisible —
  that is the point of a floor plan, but it does surprise people.
* No auth on the relay. Anyone with the room name can watch, or send — and now
  anyone on the network can *find* it too, which is the point of mDNS and worth
  knowing before running this on a network you do not control.
