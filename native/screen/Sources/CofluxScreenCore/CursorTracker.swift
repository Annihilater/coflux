import AppKit
import CoreGraphics
import CryptoKit
import Foundation

/// The remote cursor, sent as position plus shape (PNG and hotspot, only when it changes) so the
/// client draws it locally and pointer feel does not wait for video. When the system cursor
/// image cannot be read (`NSCursor.currentSystem` is nil in this process) the session falls back
/// to cursor-in-video and this tracker reports `shapeAvailable == false`.
public final class CursorTracker {
    public struct Shape: Equatable {
        public var png: Data
        public var widthPoints: Int
        public var heightPoints: Int
        public var hotspotX: Double
        public var hotspotY: Double
    }

    public struct Update: Equatable {
        public var x: Double
        public var y: Double
        public var visible: Bool
        public var shape: Shape?
    }

    public var onUpdate: ((Update) -> Void)?
    public private(set) var shapeAvailable = true

    private var timer: DispatchSourceTimer?
    private var lastPosition: CGPoint?
    private var lastVisible: Bool?
    private var lastShapeHash: Data?

    public init() {}

    /// Probe once whether cursor shapes are readable here.
    public static func probeShapeSupport() -> Bool {
        NSCursor.currentSystem?.image.tiffRepresentation != nil
    }

    public func start() {
        guard timer == nil else { return }
        shapeAvailable = Self.probeShapeSupport()
        lastPosition = nil
        lastVisible = nil
        lastShapeHash = nil
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: 1.0 / 30.0)
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        self.timer = timer
    }

    public func stop() {
        timer?.cancel()
        timer = nil
    }

    private func tick() {
        guard let event = CGEvent(source: nil) else { return }
        let position = event.location
        // `CGCursorIsVisible` is gone from macOS; a hidden cursor (a game, a video player) is drawn
        // anyway — the client hides it only while the picture has no cursor shape.
        let visible = true
        var shape: Shape?
        if shapeAvailable, let cursor = NSCursor.currentSystem, let tiff = cursor.image.tiffRepresentation {
            let hash = Data(SHA256.hash(data: tiff))
            if hash != lastShapeHash {
                lastShapeHash = hash
                if let representation = NSBitmapImageRep(data: tiff),
                   let png = representation.representation(using: .png, properties: [:]) {
                    shape = Shape(
                        png: png,
                        widthPoints: Int(cursor.image.size.width.rounded()),
                        heightPoints: Int(cursor.image.size.height.rounded()),
                        hotspotX: cursor.hotSpot.x,
                        hotspotY: cursor.hotSpot.y
                    )
                }
            }
        }
        let moved = lastPosition.map { abs($0.x - position.x) >= 0.5 || abs($0.y - position.y) >= 0.5 } ?? true
        guard moved || visible != lastVisible || shape != nil else { return }
        lastPosition = position
        lastVisible = visible
        onUpdate?(Update(x: position.x, y: position.y, visible: visible, shape: shape))
    }
}
