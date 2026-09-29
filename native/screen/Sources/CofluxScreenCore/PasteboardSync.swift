import AppKit
import CryptoKit
import Foundation

/// Bidirectional clipboard: the general pasteboard is polled (there is no change event) and its
/// text or PNG is reported; content the client set is remembered by hash so it never echoes back.
public final class PasteboardSync {
    public enum Content: Equatable {
        case text(String)
        case png(Data)

        var hash: Data {
            switch self {
            case .text(let text): return Data(SHA256.hash(data: Data("t:".utf8) + Data(text.utf8)))
            case .png(let png): return Data(SHA256.hash(data: Data("p:".utf8) + png))
            }
        }
    }

    public var onChanged: ((Content) -> Void)?
    /// Largest clipboard payload synced either way (an image on the wire is one device frame).
    public static let maxBytes = 16 * 1024 * 1024

    private var timer: DispatchSourceTimer?
    private var lastChangeCount: Int
    private var lastHash: Data?

    public init() {
        lastChangeCount = NSPasteboard.general.changeCount
    }

    public func start() {
        guard timer == nil else { return }
        lastChangeCount = NSPasteboard.general.changeCount
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in self?.poll() }
        timer.resume()
        self.timer = timer
    }

    public func stop() {
        timer?.cancel()
        timer = nil
    }

    /// Put the client's clipboard on this Mac's pasteboard.
    public func apply(_ content: Content) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        switch content {
        case .text(let text):
            pasteboard.setString(text, forType: .string)
        case .png(let png):
            pasteboard.setData(png, forType: .png)
            if let image = NSImage(data: png), let tiff = image.tiffRepresentation {
                pasteboard.setData(tiff, forType: .tiff)
            }
        }
        lastChangeCount = pasteboard.changeCount
        lastHash = content.hash
    }

    private func poll() {
        let pasteboard = NSPasteboard.general
        let count = pasteboard.changeCount
        guard count != lastChangeCount else { return }
        lastChangeCount = count
        guard let content = Self.read(pasteboard) else { return }
        let hash = content.hash
        guard hash != lastHash else { return }
        lastHash = hash
        onChanged?(content)
    }

    static func read(_ pasteboard: NSPasteboard) -> Content? {
        if let text = pasteboard.string(forType: .string) {
            guard text.utf8.count <= maxBytes else { return nil }
            return .text(text)
        }
        if let png = pasteboard.data(forType: .png) {
            guard png.count <= maxBytes else { return nil }
            return .png(png)
        }
        if let tiff = pasteboard.data(forType: .tiff),
           let representation = NSBitmapImageRep(data: tiff),
           let png = representation.representation(using: .png, properties: [:]) {
            guard png.count <= maxBytes else { return nil }
            return .png(png)
        }
        return nil
    }
}
