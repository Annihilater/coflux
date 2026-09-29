import CoreMedia
import Foundation
import ScreenCaptureKit

/// ScreenCaptureKit stream of the virtual display. Frames are handed to `onFrame` on the main
/// queue only when complete (no idle/dropped placeholders); the session decides, by credit,
/// whether each one is encoded or dropped at the source.
public final class CaptureEngine: NSObject, SCStreamOutput, SCStreamDelegate {
    public var onFrame: ((CMSampleBuffer) -> Void)?
    public var onStopped: ((Error?) -> Void)?

    private var stream: SCStream?
    private let queue = DispatchQueue(label: "dev.coflux.screen.capture")
    private var generation = 0

    public override init() {
        super.init()
    }

    public var running: Bool { stream != nil }

    /// Start capturing `displayID` at `width`×`height` pixels. `showsCursor` is the cursor-in-video
    /// fallback for when the cursor shape cannot be read.
    public func start(displayID: CGDirectDisplayID, width: Int, height: Int, showsCursor: Bool, completion: @escaping (Error?) -> Void) {
        generation += 1
        let generation = generation
        Task { @MainActor in
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
                    throw HelperError.capture("virtual display \(displayID) is not shareable")
                }
                let filter = SCContentFilter(display: display, excludingWindows: [])
                let configuration = SCStreamConfiguration()
                configuration.width = width
                configuration.height = height
                configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
                configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
                configuration.queueDepth = 4
                configuration.showsCursor = showsCursor
                configuration.colorSpaceName = CGColorSpace.sRGB
                let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
                try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue)
                try await stream.startCapture()
                guard generation == self.generation else {
                    try? await stream.stopCapture()
                    return
                }
                self.stream = stream
                completion(nil)
            } catch {
                guard generation == self.generation else { return }
                completion(error)
            }
        }
    }

    public func stop() {
        generation += 1
        guard let stream else { return }
        self.stream = nil
        Task { try? await stream.stopCapture() }
    }

    public func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int,
              status == SCFrameStatus.complete.rawValue
        else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.stream === stream else { return }
            self.onFrame?(sampleBuffer)
        }
    }

    public func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.stream === stream else { return }
            self.stream = nil
            self.onStopped?(error)
        }
    }
}
