import ARKit
import Foundation
import simd

/// Turns an `ARFrame`'s depth map into a planar LiDAR-style scan.
///
/// Same shape as the browser pipeline — slice a horizontal band out of a depth
/// image, reduce it to one range per bearing — so the wire format, the relay
/// and the viewer are untouched and the two senders are interchangeable. What
/// changes is that the depth is metric and the pose does not drift.
///
/// THE INNER LOOP
/// A 256x192 depth map is 49 152 pixels, and fewer than 5% of them lie in the
/// slab. The naive form transforms every pixel to world space and then throws
/// almost all of them away. This one precomputes per-column and per-row
/// partials so the height test costs three flops, and only survivors pay for
/// the range, the bearing and the binning.
///
/// The algebra that makes it work: the translation column of `camera.transform`
/// IS the camera position, so
///
///     world.x - camera.x  ==  d * (Ax[u] + Bx[v])
///
/// and the per-pixel "subtract the camera position" step cancels out entirely.
///
/// Measured in C (see `bench/`): 0.218 ms -> 0.110 ms per frame, with a
/// worst-case difference of 0.48 µm, which is three orders of magnitude below
/// the 1 mm quantisation on the wire. Note the absolute numbers, though — at
/// 10 Hz this loop was never more than ~0.1% of a core. It ships because it is
/// also allocation-free, not because it rescued the frame budget.
final class ScanExtractor {

    /// Bearing bins per scan. Matches SCAN_BINS in the web sender.
    static let binCount = 256

    struct Options {
        /// Height of the slice plane above the floor, metres.
        var sliceHeightM: Float = 1.0
        /// Half-thickness of the slab at zero range.
        var bandBaseM: Float = 0.06
        /// Extra half-thickness per metre of range — distant returns are sparser.
        var bandGrowth: Float = 0.015
        var minRangeM: Float = 0.25
        /// The LiDAR is specified to ~5 m; beyond that returns get unreliable.
        var maxRangeM: Float = 5.0
        /// Skip low-confidence depth samples. ARKit grades every pixel 0/1/2.
        var minConfidence: ARConfidenceLevel = .medium
    }

    struct Result {
        var fovRad: Float
        /// Depth samples that landed inside the slab.
        var bandSamples: Int
        var validBins: Int
        /// World-space sensor position and heading this scan was taken from.
        var x: Float
        var z: Float
        var yaw: Float
        /// Wall-clock cost of this extraction, milliseconds.
        var elapsedMs: Double
    }

    /// Ranges for the last extraction. Read it immediately — the next frame
    /// overwrites it in place, which is the point: no per-frame allocation.
    private(set) var ranges = [Float](repeating: 0, count: ScanExtractor.binCount)

    private var best = [Float](repeating: .infinity, count: ScanExtractor.binCount)
    private var second = [Float](repeating: .infinity, count: ScanExtractor.binCount)
    private var hits = [Int32](repeating: 0, count: ScanExtractor.binCount)

    // Per-column and per-row partials, sized on the first frame.
    private var ax = [Float](), ay = [Float](), az = [Float]()
    private var bx = [Float](), by = [Float](), bz = [Float]()
    private var colScale = [Float](), rowScale = [Float]()
    private var tableWidth = 0, tableHeight = 0
    private var lastIntrinsics = SIMD4<Float>(0, 0, 0, 0)   // fx, fy, cx, cy

    private(set) var fovRad: Float = 100 * .pi / 180

    /// - Parameter floorY: world Y of the floor from plane detection. `nil`
    ///   before a floor is known, in which case the slab follows the camera.
    func extract(frame: ARFrame, floorY: Float?, options: Options) -> Result? {
        let t0 = CACurrentMediaTime()
        guard let depth = frame.smoothedSceneDepth ?? frame.sceneDepth else { return nil }

        let depthMap = depth.depthMap
        let confidenceMap = depth.confidenceMap

        CVPixelBufferLockBaseAddress(depthMap, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(depthMap, .readOnly) }
        if let c = confidenceMap { CVPixelBufferLockBaseAddress(c, .readOnly) }
        defer { if let c = confidenceMap { CVPixelBufferUnlockBaseAddress(c, .readOnly) } }

        guard let depthBase = CVPixelBufferGetBaseAddress(depthMap) else { return nil }
        let width = CVPixelBufferGetWidth(depthMap)
        let height = CVPixelBufferGetHeight(depthMap)
        let depthRowStride = CVPixelBufferGetBytesPerRow(depthMap) / MemoryLayout<Float32>.size

        let confBase = confidenceMap.flatMap { CVPixelBufferGetBaseAddress($0) }
        let confRowStride = confidenceMap.map { CVPixelBufferGetBytesPerRow($0) } ?? 0

        // Intrinsics describe the CAPTURED IMAGE, which is far larger than the
        // depth map. Scale them into depth-map pixels or every ray is wrong by
        // the ratio — and the result still looks like a room, which is what
        // makes that particular bug so easy to ship.
        let imageSize = frame.camera.imageResolution
        let sx = Float(width) / Float(imageSize.width)
        let sy = Float(height) / Float(imageSize.height)
        let k = frame.camera.intrinsics
        let fx = k[0][0] * sx, fy = k[1][1] * sy
        let cx = k[2][0] * sx, cy = k[2][1] * sy

        let transform = frame.camera.transform
        let camX = transform.columns.3.x
        let camY = transform.columns.3.y
        let camZ = transform.columns.3.z

        // ARKit camera space: +X right, +Y up, looking along -Z.
        let forward = -SIMD3<Float>(transform.columns.2.x, transform.columns.2.y, transform.columns.2.z)
        let yaw = atan2(forward.x, -forward.z)

        // Slice plane. With a known floor the slab is absolute, so the operator
        // can raise and lower the phone freely; without one it tracks the
        // camera, which is what the browser pipeline does.
        let planeY = floorY.map { $0 + options.sliceHeightM } ?? camY

        let hFov = 2 * atan(Float(imageSize.width) * 0.5 / k[0][0])
        fovRad = min(.pi * 0.95, hFov * 1.3)
        let halfFov = fovRad * 0.5

        rebuildTablesIfNeeded(width: width, height: height, fx: fx, fy: fy, cx: cx, cy: cy)
        fillPartials(transform: transform, width: width, height: height)

        let dyBase = camY - planeY
        // Conservative band for the cheap test: a superset of the exact one, so
        // nothing the exact test would keep can be rejected here.
        let bandMax = options.bandBaseM + options.bandGrowth * options.maxRangeM
        let minR = options.minRangeM, maxR = options.maxRangeM
        let minConf = options.minConfidence.rawValue
        let binCountF = Float(Self.binCount)
        let invFov = 1 / fovRad

        var bandSamples = 0
        var validBins = 0

        ax.withUnsafeBufferPointer { axp in
        ay.withUnsafeBufferPointer { ayp in
        az.withUnsafeBufferPointer { azp in
        bx.withUnsafeBufferPointer { bxp in
        by.withUnsafeBufferPointer { byp in
        bz.withUnsafeBufferPointer { bzp in
        best.withUnsafeMutableBufferPointer { bestp in
        second.withUnsafeMutableBufferPointer { secondp in
        hits.withUnsafeMutableBufferPointer { hitsp in

            for i in 0..<Self.binCount {
                bestp[i] = .infinity
                secondp[i] = .infinity
                hitsp[i] = 0
            }

            let depthPtr = depthBase.assumingMemoryBound(to: Float32.self)
            let confPtr = confBase?.assumingMemoryBound(to: UInt8.self)

            for v in 0..<height {
                let rowDepth = depthPtr + v * depthRowStride
                let rowConf = confPtr.map { $0 + v * confRowStride }
                let byv = byp[v], bxv = bxp[v], bzv = bzp[v]

                for u in 0..<width {
                    let d = rowDepth[u]
                    if !(d >= minR) || d > maxR { continue }
                    if let rowConf, Int(rowConf[u]) < minConf { continue }

                    // Three flops decide the fate of ~95% of the pixels.
                    let dy = d * (ayp[u] + byv) + dyBase
                    if dy > bandMax || dy < -bandMax { continue }

                    let dx = d * (axp[u] + bxv)
                    let dz = d * (azp[u] + bzv)
                    let range = (dx * dx + dz * dz).squareRoot()
                    if range < minR || range > maxR { continue }

                    let band = options.bandBaseM + options.bandGrowth * range
                    if dy > band || dy < -band { continue }
                    bandSamples += 1

                    var bearing = atan2(dx, -dz) - yaw
                    if bearing > .pi { bearing -= 2 * .pi }
                    else if bearing < -.pi { bearing += 2 * .pi }
                    if bearing < -halfFov || bearing > halfFov { continue }

                    var bin = Int(((bearing + halfFov) * invFov) * binCountF)
                    if bin < 0 { bin = 0 } else if bin >= Self.binCount { bin = Self.binCount - 1 }

                    // Keep the two smallest ranges per bin and report the
                    // second. Even LiDAR produces flyers at object silhouettes,
                    // and one stray reading both plants a false obstacle and
                    // erases the real wall behind it when the viewer casts its
                    // free-space ray.
                    hitsp[bin] += 1
                    if range < bestp[bin] {
                        secondp[bin] = bestp[bin]
                        bestp[bin] = range
                    } else if range < secondp[bin] {
                        secondp[bin] = range
                    }
                }
            }

            self.ranges.withUnsafeMutableBufferPointer { out in
                for i in 0..<Self.binCount {
                    if hitsp[i] >= 2 && secondp[i].isFinite {
                        out[i] = secondp[i]; validBins += 1
                    } else if hitsp[i] == 1 && bestp[i].isFinite {
                        out[i] = bestp[i]; validBins += 1
                    } else {
                        out[i] = 0
                    }
                }
            }
        }}}}}}}}}

        return Result(fovRad: fovRad,
                      bandSamples: bandSamples,
                      validBins: validBins,
                      x: camX,
                      z: camZ,
                      yaw: yaw,
                      elapsedMs: (CACurrentMediaTime() - t0) * 1000)
    }

    // MARK: - Tables

    /// Column and row scales depend only on the intrinsics, which are constant
    /// for a session — so this runs once, not once per frame.
    private func rebuildTablesIfNeeded(width: Int, height: Int,
                                       fx: Float, fy: Float, cx: Float, cy: Float) {
        let intrinsics = SIMD4<Float>(fx, fy, cx, cy)
        if width == tableWidth && height == tableHeight && intrinsics == lastIntrinsics { return }

        tableWidth = width
        tableHeight = height
        lastIntrinsics = intrinsics

        colScale = [Float](repeating: 0, count: width)
        rowScale = [Float](repeating: 0, count: height)
        ax = [Float](repeating: 0, count: width)
        ay = [Float](repeating: 0, count: width)
        az = [Float](repeating: 0, count: width)
        bx = [Float](repeating: 0, count: height)
        by = [Float](repeating: 0, count: height)
        bz = [Float](repeating: 0, count: height)

        let invFx = 1 / fx, invFy = 1 / fy
        for u in 0..<width { colScale[u] = (Float(u) - cx) * invFx }
        for v in 0..<height { rowScale[v] = -(Float(v) - cy) * invFy }
    }

    /// The camera rotation changes every frame, so these do — but they are
    /// 256 + 192 entries, not 49 152.
    private func fillPartials(transform: simd_float4x4, width: Int, height: Int) {
        let c0 = transform.columns.0, c1 = transform.columns.1, c2 = transform.columns.2
        for u in 0..<width {
            let s = colScale[u]
            ax[u] = c0.x * s; ay[u] = c0.y * s; az[u] = c0.z * s
        }
        for v in 0..<height {
            let s = rowScale[v]
            bx[v] = c1.x * s - c2.x
            by[v] = c1.y * s - c2.y
            bz[v] = c1.z * s - c2.z
        }
    }
}

/// Metric calibration does not exist here: ARKit depth is already metres.
/// The browser pipeline needs a floor-calibration step; this one does not, and
/// that difference is why the app never asks the operator for a distance.
