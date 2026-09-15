import ARKit
import Foundation
import UIKit

/// React Native bridge for the scanner.
///
/// DESIGN RULE: scan data never crosses this bridge.
///
/// A scan is 256 ranges at 10 Hz, and a point cloud would be 7000 points — 
/// serialising either through the RN bridge on every frame is the classic way
/// to make an otherwise fine AR app unusable. Swift talks to the relay
/// directly over its own WebSocket; the bridge carries only commands going
/// down (start, stop, set slice height) and a throttled status object coming
/// up for the HUD. That keeps the JS thread free no matter what the sensor is
/// doing.
@objc(ARScannerModule)
final class ARScannerModule: RCTEventEmitter {

    /// One controller for the process, so the preview view can attach to the
    /// same ARSession that is being scanned.
    static let controller = ARSessionController()

    private var hasListeners = false

    override init() {
        super.init()
        Self.controller.onStatus = { [weak self] status in
            self?.emit("scanStatus", body: Self.serialise(status))
        }
        Self.controller.onError = { [weak self] message in
            self?.emit("scanError", body: ["message": message])
        }
    }

    // MARK: - RCTEventEmitter

    override static func requiresMainQueueSetup() -> Bool { true }

    override func supportedEvents() -> [String]! {
        ["scanStatus", "scanError"]
    }

    override func startObserving() { hasListeners = true }
    override func stopObserving() { hasListeners = false }

    private func emit(_ name: String, body: Any) {
        guard hasListeners else { return }
        sendEvent(withName: name, body: body)
    }

    // MARK: - Exposed methods

    /// Capability probe. Call this before showing any scan UI — never infer
    /// LiDAR from a device-model string table, which goes stale every autumn.
    @objc(getCapabilities:rejecter:)
    func getCapabilities(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve([
            "worldTracking": ARWorldTrackingConfiguration.isSupported,
            "sceneDepth": ARSessionController.supportsSceneDepth,
            "sceneReconstruction": ARSessionController.supportsSceneReconstruction,
            "deviceModel": UIDevice.current.model,
            "systemVersion": UIDevice.current.systemVersion,
        ])
    }

    /// Start browsing the local network for a relay. Safe to call repeatedly.
    @objc(startDiscovery:rejecter:)
    func startDiscovery(_ resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            Self.controller.beginDiscovery()
            resolve(nil)
        }
    }

    @objc(stopDiscovery:rejecter:)
    func stopDiscovery(_ resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            Self.controller.endDiscovery()
            resolve(nil)
        }
    }

    /// Relays currently visible on the network.
    @objc(listRelays:rejecter:)
    func listRelays(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(Self.controller.visibleRelays().map { relay in
            [
                "name": relay.name,
                "host": relay.host,
                "port": Int(relay.port),
                "tls": relay.tls,
                "url": relay.url,
                "displayHost": relay.displayHost,
            ]
        })
    }

    /// `relayURL` is optional. Omit it and the scanner uses whatever discovery
    /// found — which is the normal path, and the reason nobody types an IP.
    @objc(start:resolver:rejecter:)
    func start(_ config: NSDictionary,
               resolver resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
        let relayURL = config["relayURL"] as? String
        let room = (config["room"] as? String) ?? "default"
        let sliceHeight = Float(truncating: (config["sliceHeightM"] as? NSNumber) ?? 1.0)
        let rate = Double(truncating: (config["rateHz"] as? NSNumber) ?? 10)

        DispatchQueue.main.async {
            Self.controller.start(relayURL: relayURL,
                                  room: room,
                                  sliceHeightM: sliceHeight,
                                  rateHz: rate)
            resolve(Self.serialise(Self.controller.snapshot()))
        }
    }

    @objc(stop:rejecter:)
    func stop(_ resolve: @escaping RCTPromiseResolveBlock,
              rejecter reject: RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            Self.controller.stop()
            resolve(nil)
        }
    }

    @objc(setSliceHeight:resolver:rejecter:)
    func setSliceHeight(_ metres: NSNumber,
                        resolver resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: RCTPromiseRejectBlock) {
        Self.controller.setSliceHeight(Float(truncating: metres))
        resolve(nil)
    }

    @objc(setRate:resolver:rejecter:)
    func setRate(_ hz: NSNumber,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: RCTPromiseRejectBlock) {
        Self.controller.setRate(Double(truncating: hz))
        resolve(nil)
    }

    @objc(resetMap:rejecter:)
    func resetMap(_ resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            Self.controller.resetMap()
            resolve(nil)
        }
    }

    @objc(getStatus:rejecter:)
    func getStatus(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(Self.serialise(Self.controller.snapshot()))
    }

    // MARK: - Serialisation

    private static func serialise(_ s: ARSessionController.Status) -> [String: Any] {
        [
            "running": s.running,
            "hasLiDAR": s.hasLiDAR,
            "trackingState": s.trackingState,
            "floorFound": s.floorFound,
            "floorY": s.floorY,
            "sliceHeightM": s.sliceHeightM,
            "x": s.x,
            "z": s.z,
            "yawDeg": s.yawDeg,
            "fps": s.fps,
            "bandSamples": s.bandSamples,
            "validBins": s.validBins,
            "framesSent": s.framesSent,
            "framesDropped": s.framesDropped,
            "bytesSent": s.bytesSent,
            "rttMs": s.rttMs,
            "relayState": s.relayState,
            "relayName": s.relayName,
            "discovery": s.discovery,
            "framesSkipped": s.framesSkipped,
            "extractMs": s.extractMs,
            "encodeMs": s.encodeMs,
            "frameMs": s.frameMs,
            "videoFormat": s.videoFormat,
            "planeDetectionOn": s.planeDetectionOn,
            "note": s.note,
        ]
    }
}
