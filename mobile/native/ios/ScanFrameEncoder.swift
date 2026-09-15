import Foundation

/// Binary encoder for the `SCN1` planar-scan frame.
///
/// This is a byte-for-byte port of webscan's `packages/protocol/src/index.ts`;
/// in tetym-rover the same format is `public/lidar.js`. The web
/// sender, this app, the Node relay and the browser viewer all speak exactly
/// this layout, which is why swapping the phone-side implementation changes
/// nothing anywhere else in the stack.
///
///     offset size  field
///     ------ ----  ---------------------------------------------
///          0   4   magic          uint32   'SCN1'
///          4   1   version        uint8
///          5   1   flags          uint8
///          6   2   binCount       uint16
///          8   4   seq            uint32
///         12   4   x              float32  world metres
///         16   4   z              float32  world metres
///         20   4   yaw            float32  radians
///         24   8   tMs            float64  capture time (epoch ms)
///         32   4   fovRad         float32  angular span of the bins
///         36   4   matchScore     float32  tracking confidence 0..1
///         40   4   cameraHeightM  float32  height of the slice plane
///         44   4   reserved       uint32
///     ------ ----
///         48       header
///         48 ->    binCount * uint16  ranges in millimetres (0 = no return)
///
/// Everything is little-endian, which is native on ARM64 — so the integer
/// writes below are plain memory stores, not byte shuffles.
enum ScanFrameEncoder {

    static let magic: UInt32 = 0x314E_4353   // 'S','C','N','1' read as LE uint32
    static let version: UInt8 = 1
    static let headerBytes = 48

    struct Flags: OptionSet {
        let rawValue: UInt8
        /// Ranges are true metres. ARKit depth always is, so this is always set.
        static let calibrated  = Flags(rawValue: 1 << 1)
        /// Pose is trusted (ARKit tracking state is `.normal`).
        static let tracked     = Flags(rawValue: 1 << 2)
        /// Pose is degraded — relocalising, or too little visual texture.
        static let trackingLost = Flags(rawValue: 1 << 3)
    }

    struct Frame {
        var seq: UInt32
        var timestampMs: Double
        var x: Float
        var z: Float
        var yaw: Float
        var fovRad: Float
        var confidence: Float
        var sliceHeightM: Float
        var flags: Flags
        /// Metres per bearing bin. 0, negative or non-finite means "no return".
        var ranges: [Float]
    }

    static func encode(_ frame: Frame) -> Data {
        let binCount = frame.ranges.count
        var data = Data(count: headerBytes + binCount * 2)

        data.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
            guard let base = raw.baseAddress else { return }

            base.storeBytes(of: magic.littleEndian, toByteOffset: 0, as: UInt32.self)
            base.storeBytes(of: version, toByteOffset: 4, as: UInt8.self)
            base.storeBytes(of: frame.flags.rawValue, toByteOffset: 5, as: UInt8.self)
            base.storeBytes(of: UInt16(binCount).littleEndian, toByteOffset: 6, as: UInt16.self)
            base.storeBytes(of: frame.seq.littleEndian, toByteOffset: 8, as: UInt32.self)

            // Float32/Float64 have no `littleEndian` property; go through their
            // bit patterns so the byte order is explicit rather than assumed.
            base.storeBytes(of: frame.x.bitPattern.littleEndian, toByteOffset: 12, as: UInt32.self)
            base.storeBytes(of: frame.z.bitPattern.littleEndian, toByteOffset: 16, as: UInt32.self)
            base.storeBytes(of: frame.yaw.bitPattern.littleEndian, toByteOffset: 20, as: UInt32.self)
            base.storeBytes(of: frame.timestampMs.bitPattern.littleEndian, toByteOffset: 24, as: UInt64.self)
            base.storeBytes(of: frame.fovRad.bitPattern.littleEndian, toByteOffset: 32, as: UInt32.self)
            base.storeBytes(of: frame.confidence.bitPattern.littleEndian, toByteOffset: 36, as: UInt32.self)
            base.storeBytes(of: frame.sliceHeightM.bitPattern.littleEndian, toByteOffset: 40, as: UInt32.self)
            base.storeBytes(of: UInt32(0), toByteOffset: 44, as: UInt32.self)

            for i in 0..<binCount {
                let metres = frame.ranges[i]
                var mm: UInt16 = 0
                if metres.isFinite && metres > 0 {
                    let scaled = (metres * 1000).rounded()
                    mm = scaled >= 65535 ? 65535 : UInt16(scaled)
                }
                base.storeBytes(of: mm.littleEndian,
                                toByteOffset: headerBytes + i * 2,
                                as: UInt16.self)
            }
        }
        return data
    }
}
