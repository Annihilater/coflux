import Foundation

/// Credit-based video flow control, drop-at-source (see device.proto, "Remote screen").
///
/// The client grants credit in bytes; every chunk of `ScreenVideoFrame.data` sent consumes that
/// many; the client returns what it handed to its decoder. A frame that does not fit is dropped
/// whole (never queued, never partially sent) and the next frame sent must be a keyframe, because
/// the dropped one broke the reference chain. Capture is not even encoded while credit is below
/// `encodeFloor`, which saves the encoder's work when the link is stalled.
public struct CreditAccount: Equatable {
    /// Bytes the receiver has credited and the sender has not yet used.
    public private(set) var available: Int
    /// Bytes sent and not yet returned as credit.
    public private(set) var outstanding: Int = 0
    /// A frame was dropped since the last frame sent: the next one must be a keyframe.
    public private(set) var needsKeyframe: Bool = true
    public private(set) var droppedFrames: Int = 0
    /// Below this much credit, captured frames are dropped before encoding.
    public let encodeFloor: Int

    public init(initialCredit: Int, encodeFloor: Int = 32 * 1024) {
        self.available = max(0, initialCredit)
        self.encodeFloor = encodeFloor
    }

    /// The client returned credit for bytes it consumed; never more than is outstanding.
    public mutating func grant(_ bytes: Int) {
        let returned = min(max(0, bytes), outstanding)
        outstanding -= returned
        available += returned
        // Credit above what was ever outstanding (a fresh attach's initial window) is honoured too.
        let extra = max(0, bytes) - returned
        available += extra
    }

    /// Is it worth encoding a captured frame right now?
    public var shouldEncode: Bool { available >= encodeFloor }

    /// Try to send an encoded frame of `bytes`. `true` consumes the credit; `false` drops the
    /// frame and arms the keyframe requirement.
    public mutating func trySend(bytes: Int) -> Bool {
        guard bytes > 0 else { return true }
        if bytes <= available {
            available -= bytes
            outstanding += bytes
            needsKeyframe = false
            return true
        }
        droppedFrames += 1
        needsKeyframe = true
        return false
    }

    /// A keyframe was requested by the receiver or forced by a resize/resume.
    public mutating func requireKeyframe() {
        needsKeyframe = true
    }

    /// An encoded frame was discarded for a reason other than credit (it could not be decoded
    /// after an earlier drop); counts as a drop for rate adaptation.
    public mutating func drop() {
        droppedFrames += 1
        needsKeyframe = true
    }

    /// Replace the window (a new video lane attached): nothing sent on the old lane is still in
    /// flight for the new one.
    public mutating func reset(initialCredit: Int) {
        available = max(0, initialCredit)
        outstanding = 0
        needsKeyframe = true
    }
}

/// Encoder bitrate chosen from delivered-frame feedback: the credit window the client granted
/// sets the starting point (a relayed path grants less), and dropped frames or a persistently
/// full window lower it while a quiet window raises it back, between `minimum` and `maximum`.
public struct BitrateController: Equatable {
    public private(set) var bitsPerSecond: Int
    public let minimum: Int
    public let maximum: Int
    private var quietTicks = 0

    /// `initialCredit` in bytes: 2 MiB (relay) starts around 8 Mbps, 8 MiB (direct) around 30.
    public init(initialCredit: Int, minimum: Int = 1_500_000, maximum: Int = 40_000_000) {
        self.minimum = minimum
        self.maximum = maximum
        let start = initialCredit * 8 / 2
        self.bitsPerSecond = min(maximum, max(minimum, start))
    }

    /// Called about once per second with the window state since the last tick.
    /// Returns true when the bitrate changed.
    public mutating func tick(droppedFrames: Int, outstanding: Int, window: Int) -> Bool {
        let before = bitsPerSecond
        let pressure = window > 0 ? Double(outstanding) / Double(window) : 0
        if droppedFrames > 0 || pressure > 0.75 {
            bitsPerSecond = max(minimum, bitsPerSecond * 3 / 4)
            quietTicks = 0
        } else if pressure < 0.25 {
            quietTicks += 1
            if quietTicks >= 5 {
                bitsPerSecond = min(maximum, bitsPerSecond * 11 / 10)
                quietTicks = 0
            }
        } else {
            quietTicks = 0
        }
        return bitsPerSecond != before
    }
}
