import Foundation

/// Pure geometry for the virtual display: what the client asked for in points and scale, what
/// the display is created with, and which of the modes the system then offers is the HiDPI one
/// to select (the first apply lands on a 1× mode of doubled point size — measured, see the plan).
public struct DisplayGeometry: Equatable {
    public var widthPoints: Int
    public var heightPoints: Int
    /// 1 or 2.
    public var scale: Int
    public var widthPixels: Int { widthPoints * scale }
    public var heightPixels: Int { heightPoints * scale }

    public init(widthPoints: Int, heightPoints: Int, scale: Int) {
        self.widthPoints = widthPoints
        self.heightPoints = heightPoints
        self.scale = scale
    }
}

public enum DisplayModeSelection {
    /// Largest pixel edge the virtual display is created with (the descriptor's max).
    public static let maxPixels = 8192
    public static let minPoints = 320

    /// Sanitise a requested geometry: even pixel dimensions (H.264 needs them), scale 1 or 2,
    /// bounded on both ends. Returns nil for nonsense (zero size).
    public static func requested(widthPoints: Int, heightPoints: Int, scale: Int) -> DisplayGeometry? {
        guard widthPoints > 0, heightPoints > 0 else { return nil }
        let scale = scale >= 2 ? 2 : 1
        let maxPoints = maxPixels / scale
        var width = min(max(widthPoints, minPoints), maxPoints)
        var height = min(max(heightPoints, minPoints), maxPoints)
        // Points × 2 is always even; at 1× make the point size even for the encoder.
        if scale == 1 {
            width &= ~1
            height &= ~1
        }
        return DisplayGeometry(widthPoints: width, heightPoints: height, scale: scale)
    }

    /// One mode as the system reports it: pixel size and point size.
    public struct Candidate: Equatable {
        public var pixelWidth: Int
        public var pixelHeight: Int
        public var pointWidth: Int
        public var pointHeight: Int
        public var refreshRate: Double
        public init(pixelWidth: Int, pixelHeight: Int, pointWidth: Int, pointHeight: Int, refreshRate: Double) {
            self.pixelWidth = pixelWidth
            self.pixelHeight = pixelHeight
            self.pointWidth = pointWidth
            self.pointHeight = pointHeight
            self.refreshRate = refreshRate
        }
    }

    /// Index of the candidate that is exactly the requested geometry (pixels and points), taking
    /// the highest refresh rate among equals; nil when the system offers no such mode.
    public static func select(_ geometry: DisplayGeometry, from candidates: [Candidate]) -> Int? {
        var best: (index: Int, rate: Double)?
        for (index, candidate) in candidates.enumerated() {
            guard candidate.pixelWidth == geometry.widthPixels,
                  candidate.pixelHeight == geometry.heightPixels,
                  candidate.pointWidth == geometry.widthPoints,
                  candidate.pointHeight == geometry.heightPoints
            else { continue }
            if best == nil || candidate.refreshRate > best!.rate {
                best = (index, candidate.refreshRate)
            }
        }
        return best?.index
    }
}
