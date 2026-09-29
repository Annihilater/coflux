import ApplicationServices
import CoreGraphics
import Foundation

/// TCC and lock state of the remote Mac, reported to the client and never worked around. The
/// helper runs inside the Coflux.app process tree, so what it sees is what Coflux was granted.
public struct PermissionState: Equatable {
    public var screenRecording: Bool
    public var accessibility: Bool
    public var locked: Bool

    public static func current() -> PermissionState {
        PermissionState(
            screenRecording: CGPreflightScreenCaptureAccess(),
            accessibility: AXIsProcessTrusted(),
            locked: Self.sessionLocked()
        )
    }

    /// `CGSSessionScreenIsLocked` of the current login session.
    static func sessionLocked() -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        if let locked = session["CGSSessionScreenIsLocked"] as? Bool { return locked }
        if let locked = session["CGSSessionScreenIsLocked"] as? Int { return locked != 0 }
        return false
    }
}

/// Raises the system prompts once per session so someone at that Mac can grant with one click.
public final class PermissionPrompter {
    private var promptedScreenRecording = false
    private var promptedAccessibility = false

    public init() {}

    public func reset() {
        promptedScreenRecording = false
        promptedAccessibility = false
    }

    public func promptIfMissing(_ state: PermissionState) {
        if !state.screenRecording && !promptedScreenRecording {
            promptedScreenRecording = true
            _ = CGRequestScreenCaptureAccess()
        }
        if !state.accessibility && !promptedAccessibility {
            promptedAccessibility = true
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        }
    }
}
