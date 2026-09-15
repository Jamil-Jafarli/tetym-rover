import ARKit
import Foundation
import QuartzCore

/// Owns the ARKit session, turns frames into scans, and pushes them to the relay.
///
/// Everything expensive happens on ARKit's own delegate queue. The only things
/// that cross to the main thread are a throttled stats snapshot for the UI and
/// the shared `ARSession` the preview view attaches to.
///
/// WHAT ACTUALLY COSTS POWER HERE
/// Not the depth loop — that is ~0.1 ms a frame (see `bench/`). The real draw is
/// the ARKit session itself, the preview renderer and the radio, so the
/// optimisations that matter are the ones below: run the camera at the smallest
/// useful resolution, stop plane detection once the floor is known, and do not
/// transmit when nothing has moved.
final class ARSessionController: NSObject {

    struct Status {
        var running = false
        var hasLiDAR = false
        var trackingState = "not available"
        var floorFound = false
        var floorY: Float = 0
        var sliceHeightM: Float = 1.0
        var x: Float = 0
        var z: Float = 0
        var yawDeg: Float = 0
        var fps: Double = 0
        var bandSamples = 0
        var validBins = 0
        var framesSent = 0
        var framesDropped = 0
        var framesSkipped = 0
        var bytesSent = 0
        var rttMs: Double = 0
        var relayState = "idle"
        var relayName = ""
        var discovery = "idle"
        var note = ""
        // Profiler, exponentially smoothed.
        var extractMs: Double = 0
        var encodeMs: Double = 0
        var frameMs: Double = 0
        var videoFormat = ""
        var planeDetectionOn = true
    }

    /// Shared with the preview so the camera feed is the very session being
    /// scanned, not a second one competing for the camera.
    let session = ARSession()

    private let extractor = ScanExtractor()
    private let relay = RelayClient()
    let discovery = RelayDiscovery()

    private var options = ScanExtractor.Options()
    private var motionFilter = MotionFilter()
    private var seq: UInt32 = 0
    private var floorY: Float?
    private var floorSamples = 0
    private var planeDetectionOn = true
    private var running = false
    private var room = "default"

    /// Target send rate. The LiDAR runs at 60 Hz; a floor map does not need that.
    private var targetHz: Double = 10
    private var lastProcessedAt: TimeInterval = 0

    private var frameTimestamps: [TimeInterval] = []
    private var status = Status()
    private let statusLock = NSLock()
    private var lastStatusPush: TimeInterval = 0

    var onStatus: ((Status) -> Void)?
    var onError: ((String) -> Void)?

    override init() {
        super.init()
        session.delegate = self
        session.delegateQueue = DispatchQueue(label: "webscan.arsession", qos: .userInitiated)

        relay.onState = { [weak self] state in
            guard let self else { return }
            self.mutate { $0.relayState = state.rawValue }
            if state == .open { self.relay.sendSenderState(active: self.running) }
            self.pushStatus(force: true)
        }
        relay.onError = { [weak self] message in self?.onError?(message) }

        discovery.onChange = { [weak self] state in self?.handleDiscovery(state) }
    }

    // MARK: - Capability

    static var supportsSceneDepth: Bool {
        ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    }
    static var supportsSceneReconstruction: Bool {
        ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    }

    // MARK: - Discovery

    /// Browse the local network. The caller does not have to know an address.
    func beginDiscovery() {
        mutate { $0.discovery = "searching" }
        pushStatus(force: true)
        discovery.start()
    }

    func endDiscovery() {
        discovery.stop()
        mutate { $0.discovery = "idle" }
        pushStatus(force: true)
    }

    private func handleDiscovery(_ state: RelayDiscovery.State) {
        switch state {
        case .idle:
            mutate { $0.discovery = "idle" }
        case .searching:
            mutate { $0.discovery = "searching" }
        case .none:
            mutate { $0.discovery = "none found" }
        case .found(let relays):
            let names = relays.map(\.name).joined(separator: ", ")
            mutate { $0.discovery = relays.count == 1 ? "found \(names)" : "\(relays.count) relays" }
        case .failed(let message):
            mutate { $0.discovery = "failed" }
            onError?(message)
        }
        pushStatus(force: true)
    }

    /// Relays currently visible, best candidate first.
    func visibleRelays() -> [RelayDiscovery.Relay] {
        if case let .found(relays) = discovery.state { return relays }
        return []
    }

    // MARK: - Control

    /// Start scanning. Pass `relayURL: nil` to use whatever discovery found —
    /// which is the normal path, and the reason nobody types an IP.
    func start(relayURL: String?, room: String, sliceHeightM: Float, rateHz: Double) {
        guard ARWorldTrackingConfiguration.isSupported else {
            onError?("ARKit world tracking is not supported on this device.")
            return
        }

        var chosenURL = relayURL
        var chosenName = ""
        if chosenURL == nil || chosenURL?.isEmpty == true {
            let relays = visibleRelays()
            guard let pick = RelayDiscovery.preferred(from: relays) else {
                onError?(relays.isEmpty
                    ? "No relay found on this network yet. Make sure it is running, or enter an address manually."
                    : "More than one relay is on this network — pick one.")
                return
            }
            chosenURL = pick.url
            chosenName = pick.name
            discovery.remember(pick)
        }
        guard let url = chosenURL, !url.isEmpty else { return }

        self.room = room
        options.sliceHeightM = sliceHeightM
        targetHz = max(1, min(30, rateHz))
        seq = 0
        floorY = nil
        floorSamples = 0
        motionFilter.reset()

        let configuration = makeConfiguration(planeDetection: true)
        planeDetectionOn = true

        mutate {
            $0.hasLiDAR = Self.supportsSceneDepth
            $0.running = true
            $0.sliceHeightM = sliceHeightM
            $0.relayName = chosenName
            $0.planeDetectionOn = true
            $0.note = Self.supportsSceneDepth
                ? "LiDAR scene depth active"
                : "No LiDAR on this device — dense depth unavailable"
        }

        session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        running = true
        relay.connect(baseURL: url, room: room)
        pushStatus(force: true)

        if !Self.supportsSceneDepth {
            onError?("This iPhone has no LiDAR. ARKit tracking works, but there is no dense depth to slice.")
        }
    }

    func stop() {
        running = false
        session.pause()
        relay.sendSenderState(active: false)
        relay.disconnect()
        mutate { $0.running = false }
        pushStatus(force: true)
    }

    func setSliceHeight(_ metres: Float) {
        options.sliceHeightM = max(0.1, min(3.0, metres))
        mutate { $0.sliceHeightM = self.options.sliceHeightM }
        pushStatus(force: true)
    }

    func setRate(_ hz: Double) { targetHz = max(1, min(30, hz)) }

    func resetMap() {
        relay.sendReset()
        floorY = nil
        floorSamples = 0
        seq = 0
        motionFilter.reset()
        guard running else { return }
        planeDetectionOn = true
        mutate { $0.planeDetectionOn = true; $0.floorFound = false }
        session.run(makeConfiguration(planeDetection: true),
                    options: [.resetTracking, .removeExistingAnchors])
    }

    func snapshot() -> Status {
        statusLock.lock(); defer { statusLock.unlock() }
        return status
    }

    // MARK: - Configuration

    private func makeConfiguration(planeDetection: Bool) -> ARWorldTrackingConfiguration {
        let configuration = ARWorldTrackingConfiguration()
        // Gravity-aligned world, so "horizontal" means horizontal in the room
        // rather than relative to however the phone was held at t=0.
        configuration.worldAlignment = .gravity
        configuration.planeDetection = planeDetection ? [.horizontal] : []
        configuration.environmentTexturing = .none
        configuration.isLightEstimationEnabled = false

        if Self.supportsSceneDepth {
            // Smoothed depth trades a little latency for markedly less
            // frame-to-frame flicker, which is what an occupancy grid wants.
            if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
                configuration.frameSemantics.insert(.smoothedSceneDepth)
            } else {
                configuration.frameSemantics.insert(.sceneDepth)
            }
        }

        if let format = Self.lowestUsefulVideoFormat() {
            configuration.videoFormat = format
            let r = format.imageResolution
            mutate { $0.videoFormat = "\(Int(r.width))x\(Int(r.height))@\(format.framesPerSecond)" }
        }
        return configuration
    }

    /// The colour image is used for tracking and for the on-screen preview, and
    /// for nothing else — the scan comes entirely from the depth map. Running
    /// the camera at 4K to throw the pixels away is the single easiest power
    /// saving available here, so take the smallest format that still gives
    /// ARKit 60 fps to track with.
    private static func lowestUsefulVideoFormat() -> ARConfiguration.VideoFormat? {
        let formats = ARWorldTrackingConfiguration.supportedVideoFormats
        guard !formats.isEmpty else { return nil }
        let fastEnough = formats.filter { $0.framesPerSecond >= 60 }
        let pool = fastEnough.isEmpty ? formats : fastEnough
        return pool.min { a, b in
            let areaA = a.imageResolution.width * a.imageResolution.height
            let areaB = b.imageResolution.width * b.imageResolution.height
            return areaA < areaB
        }
    }

    // MARK: - Internals

    private func mutate(_ body: (inout Status) -> Void) {
        statusLock.lock(); body(&status); statusLock.unlock()
    }

    private func pushStatus(force: Bool = false) {
        let now = CACurrentMediaTime()
        if !force && now - lastStatusPush < 0.2 { return }
        lastStatusPush = now

        let relayStats = relay.stats
        mutate {
            $0.framesSent = relayStats.framesSent
            $0.framesDropped = relayStats.framesDropped
            $0.bytesSent = relayStats.bytesSent
            $0.rttMs = relayStats.rttMs
        }
        let snap = snapshot()
        DispatchQueue.main.async { [weak self] in self?.onStatus?(snap) }
    }

    /// Lowest sizeable horizontal plane wins. Small planes are table tops and
    /// seats; using one as "the floor" would misplace the slice for the whole
    /// session.
    private func updateFloor(from anchors: [ARAnchor]) {
        var changed = false
        for anchor in anchors {
            guard let plane = anchor as? ARPlaneAnchor, plane.alignment == .horizontal else { continue }
            let area = plane.planeExtent.width * plane.planeExtent.height
            guard area > 0.6 else { continue }
            let y = anchor.transform.columns.3.y
            if floorY == nil || y < floorY! - 0.02 {
                floorY = y
                changed = true
                mutate { $0.floorFound = true; $0.floorY = y }
            }
        }
        if changed { floorSamples = 0 } else if floorY != nil { floorSamples += 1 }

        // Plane detection is continuous geometry work, and once the floor has
        // held steady there is nothing left for it to find that we use. Turning
        // it off without resetting tracking keeps the world and the anchors.
        if planeDetectionOn, floorY != nil, floorSamples >= 30 {
            planeDetectionOn = false
            mutate { $0.planeDetectionOn = false }
            session.run(makeConfiguration(planeDetection: false), options: [])
        }
    }
}

extension ARSessionController: ARSessionDelegate {

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) { updateFloor(from: anchors) }
    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) { updateFloor(from: anchors) }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        let text: String
        switch camera.trackingState {
        case .normal: text = "normal"
        case .notAvailable: text = "not available"
        case .limited(let reason):
            switch reason {
            case .initializing: text = "initialising"
            case .excessiveMotion: text = "moving too fast"
            case .insufficientFeatures: text = "not enough texture"
            case .relocalizing: text = "relocalising"
            @unknown default: text = "limited"
            }
        }
        mutate { $0.trackingState = text }
        pushStatus(force: true)
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        onError?(error.localizedDescription)
        mutate { $0.running = false }
        pushStatus(force: true)
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard running else { return }

        // Rate limit before doing any work. ARKit delivers at 60 Hz and holds
        // the frame while we are in here, so the cheapest thing we can do with
        // a frame we do not want is return from it immediately.
        let now = frame.timestamp
        if now - lastProcessedAt < 1.0 / targetHz { return }
        lastProcessedAt = now

        let frameStart = CACurrentMediaTime()
        guard let scan = extractor.extract(frame: frame, floorY: floorY, options: options) else { return }

        let tMs = Date().timeIntervalSince1970 * 1000

        // Nothing moved: skip the encode and the radio entirely. The viewer runs
        // this same filter, so these frames would have been discarded anyway —
        // better to never put them on the air.
        guard motionFilter.accept(x: scan.x, z: scan.z, yaw: scan.yaw, tMs: tMs) else {
            mutate { $0.framesSkipped += 1; $0.extractMs = $0.extractMs * 0.9 + scan.elapsedMs * 0.1 }
            pushStatus()
            return
        }

        frameTimestamps.append(frameStart)
        while let first = frameTimestamps.first, frameStart - first > 2 { frameTimestamps.removeFirst() }

        var flags: ScanFrameEncoder.Flags = [.calibrated]
        var confidence: Float = 0
        switch frame.camera.trackingState {
        case .normal: flags.insert(.tracked); confidence = 1
        case .limited: flags.insert(.trackingLost); confidence = 0.3
        case .notAvailable: flags.insert(.trackingLost); confidence = 0
        }

        let encodeStart = CACurrentMediaTime()
        let payload = extractor.ranges.withUnsafeBufferPointer { _ in
            ScanFrameEncoder.encode(
                ScanFrameEncoder.Frame(
                    seq: seq,
                    timestampMs: tMs,
                    x: scan.x,
                    z: scan.z,
                    yaw: scan.yaw,
                    fovRad: scan.fovRad,
                    confidence: confidence,
                    sliceHeightM: options.sliceHeightM,
                    flags: flags,
                    ranges: extractor.ranges
                )
            )
        }
        let encodeMs = (CACurrentMediaTime() - encodeStart) * 1000
        seq &+= 1
        relay.sendScan(payload)

        let frameMs = (CACurrentMediaTime() - frameStart) * 1000
        mutate {
            $0.x = scan.x
            $0.z = scan.z
            $0.yawDeg = scan.yaw * 180 / .pi
            $0.bandSamples = scan.bandSamples
            $0.validBins = scan.validBins
            $0.fps = Double(self.frameTimestamps.count) / 2.0
            $0.extractMs = $0.extractMs * 0.9 + scan.elapsedMs * 0.1
            $0.encodeMs = $0.encodeMs * 0.9 + encodeMs * 0.1
            $0.frameMs = $0.frameMs * 0.9 + frameMs * 0.1
        }
        pushStatus()
    }
}
