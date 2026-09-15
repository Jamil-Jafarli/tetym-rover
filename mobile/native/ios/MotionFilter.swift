import Foundation

/// Gates transmission on actual movement.
///
/// Standing still and streaming 10 identical scans a second is pure waste: the
/// radio stays awake, the viewer re-integrates observations it already has, and
/// the occupancy grid reinforces whatever tiny pose error it happened to have.
/// The browser sender and the viewer already run this exact filter — running it
/// on the phone too means the packets are never sent in the first place.
///
/// The heartbeat matters: without it a motionless scanner would look dead to
/// the viewer rather than idle.
struct MotionFilter {
    var minTranslationM: Float = 0.04
    var minRotationRad: Float = 2 * .pi / 180
    var maxIntervalMs: Double = 700

    private var has = false
    private var lastX: Float = 0
    private var lastZ: Float = 0
    private var lastYaw: Float = 0
    private var lastMs: Double = 0

    mutating func reset() { has = false }

    mutating func accept(x: Float, z: Float, yaw: Float, tMs: Double) -> Bool {
        if !has {
            has = true
            lastX = x; lastZ = z; lastYaw = yaw; lastMs = tMs
            return true
        }
        let moved = ((x - lastX) * (x - lastX) + (z - lastZ) * (z - lastZ)).squareRoot()
        var dYaw = abs(yaw - lastYaw)
        while dYaw > .pi { dYaw = abs(dYaw - 2 * .pi) }
        let stale = tMs - lastMs > maxIntervalMs

        if moved < minTranslationM && dYaw < minRotationRad && !stale { return false }
        lastX = x; lastZ = z; lastYaw = yaw; lastMs = tMs
        return true
    }
}
