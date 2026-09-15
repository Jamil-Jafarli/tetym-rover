import XCTest
@testable import WebScanner

/// Cross-language conformance test.
///
/// The expected bytes below were produced by the TypeScript encoder in
/// `packages/protocol` — the same code the Node relay and the browser viewer
/// use to read these frames. Asserting against them here is what actually
/// guarantees the Swift sender and the JS receiver agree, rather than each
/// being internally consistent and silently incompatible.
///
/// Regenerate with webscan's  pnpm exec tsx scripts/golden-scan-frame.ts ; the
/// same vector is pinned in tetym-rover's test/test_lidar.mjs.
final class ScanFrameEncoderTests: XCTestCase {

    /// Bytes 0..<48 of the reference frame, as hex.
    private let expectedHeaderHex =
        "53434e3101060001785634120000a03f000060c007f0463f" +
        "00b827c655917942f366df3f0000603f0000803f00000000"

    /// `h = h * 31 + byte` over every byte, wrapping at 32 bits.
    private let expectedChecksum: UInt32 = 2_225_435_042
    private let expectedPayloadChecksum: UInt32 = 888_287_967

    private func referenceFrame() -> ScanFrameEncoder.Frame {
        var ranges = [Float](repeating: 0, count: 256)
        for i in 0..<256 {
            if i % 17 == 0 { ranges[i] = 0; continue }        // no return
            if i == 5 { ranges[i] = 99; continue }            // clamps to 65535 mm
            ranges[i] = 0.25 + Float(i % 91) * 0.0537
        }
        return ScanFrameEncoder.Frame(
            seq: 0x1234_5678,
            timestampMs: 1_757_000_000_123.5,
            x: 1.25,
            z: -3.5,
            yaw: 0.7771,
            fovRad: 1.7453292519943295,   // 100 degrees
            confidence: 0.875,
            sliceHeightM: 1.0,
            flags: [.calibrated, .tracked],
            ranges: ranges
        )
    }

    private func checksum<S: Sequence>(_ bytes: S) -> UInt32 where S.Element == UInt8 {
        var h: UInt32 = 0
        for b in bytes { h = h &* 31 &+ UInt32(b) }
        return h
    }

    func testFrameSizeMatchesLayout() {
        let data = ScanFrameEncoder.encode(referenceFrame())
        XCTAssertEqual(data.count, ScanFrameEncoder.headerBytes + 256 * 2, "expected 560 bytes")
    }

    func testHeaderMatchesTypeScriptEncoder() {
        let data = ScanFrameEncoder.encode(referenceFrame())
        let header = data.prefix(ScanFrameEncoder.headerBytes)
        let hex = header.map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(hex, expectedHeaderHex,
                       "Swift header bytes diverged from the TypeScript reference")
    }

    func testWholeFrameMatchesTypeScriptEncoder() {
        let data = ScanFrameEncoder.encode(referenceFrame())
        XCTAssertEqual(checksum(data), expectedChecksum, "full-frame bytes diverged")
        XCTAssertEqual(checksum(data.dropFirst(ScanFrameEncoder.headerBytes)),
                       expectedPayloadChecksum, "range payload diverged")
    }

    func testNoReturnAndClampEncodings() {
        let data = ScanFrameEncoder.encode(referenceFrame())
        func range(at bin: Int) -> UInt16 {
            let offset = ScanFrameEncoder.headerBytes + bin * 2
            return UInt16(data[offset]) | (UInt16(data[offset + 1]) << 8)
        }
        XCTAssertEqual(range(at: 0), 0, "bin 0 is a no-return and must encode as 0")
        XCTAssertEqual(range(at: 5), 65535, "99 m must clamp to the uint16 ceiling")
        XCTAssertEqual(range(at: 1), 304, "0.3037 m rounds to 304 mm")
    }

    func testMagicIsLittleEndianSCN1() {
        let data = ScanFrameEncoder.encode(referenceFrame())
        XCTAssertEqual(Array(data.prefix(4)), [0x53, 0x43, 0x4E, 0x31], "'S','C','N','1'")
    }
}
