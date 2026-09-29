import CoreGraphics
import Foundation

/// Posts the client's keyboard, pointer and scroll events as HID-level CGEvents. Coordinates are
/// display points with the origin at the top-left of the virtual display, which is the main
/// display while a session exists — exactly CoreGraphics' global coordinate space.
public final class InputInjector {
    private let source = CGEventSource(stateID: .hidSystemState)
    private var heldButtons: Set<UInt32> = []

    public init() {}

    public static func flags(_ modifiers: UInt32) -> CGEventFlags {
        let set = KeyCodes.Modifiers(rawValue: modifiers)
        var flags: CGEventFlags = []
        if set.contains(.shift) { flags.insert(.maskShift) }
        if set.contains(.control) { flags.insert(.maskControl) }
        if set.contains(.option) { flags.insert(.maskAlternate) }
        if set.contains(.command) { flags.insert(.maskCommand) }
        if set.contains(.capsLock) { flags.insert(.maskAlphaShift) }
        if set.contains(.function) { flags.insert(.maskSecondaryFn) }
        return flags
    }

    public func key(code: String, down: Bool, modifiers: UInt32) {
        guard let virtualKey = KeyCodes.virtualKey(for: code),
              let event = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: down)
        else { return }
        if KeyCodes.isModifier(code) {
            event.type = .flagsChanged
        }
        event.flags = Self.flags(modifiers)
        event.post(tap: .cghidEventTap)
    }

    public enum PointerAction {
        case move, down, up
    }

    public func pointer(_ action: PointerAction, x: Double, y: Double, button: UInt32, modifiers: UInt32, clickCount: UInt32) {
        let point = CGPoint(x: x, y: y)
        let cgButton: CGMouseButton
        switch button {
        case 0: cgButton = .left
        case 1: cgButton = .right
        default: cgButton = .center
        }
        let type: CGEventType
        switch action {
        case .down:
            heldButtons.insert(button)
            type = button == 0 ? .leftMouseDown : button == 1 ? .rightMouseDown : .otherMouseDown
        case .up:
            heldButtons.remove(button)
            type = button == 0 ? .leftMouseUp : button == 1 ? .rightMouseUp : .otherMouseUp
        case .move:
            if heldButtons.contains(0) {
                type = .leftMouseDragged
            } else if heldButtons.contains(1) {
                type = .rightMouseDragged
            } else if !heldButtons.isEmpty {
                type = .otherMouseDragged
            } else {
                type = .mouseMoved
            }
        }
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: cgButton) else { return }
        if action != .move {
            event.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, clickCount)))
        }
        if button >= 2 {
            event.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button))
        }
        event.flags = Self.flags(modifiers)
        event.post(tap: .cghidEventTap)
    }

    public func scroll(x: Double, y: Double, deltaX: Double, deltaY: Double, modifiers: UInt32, precise: Bool) {
        // DOM deltas are positive when scrolling down/right; CoreGraphics wheel deltas are
        // positive when scrolling up/left.
        let wheel1 = Int32((-deltaY).rounded())
        let wheel2 = Int32((-deltaX).rounded())
        guard let event = CGEvent(
            scrollWheelEvent2Source: source,
            units: precise ? .pixel : .line,
            wheelCount: 2,
            wheel1: wheel1,
            wheel2: wheel2,
            wheel3: 0
        ) else { return }
        event.location = CGPoint(x: x, y: y)
        event.flags = Self.flags(modifiers)
        event.post(tap: .cghidEventTap)
    }

    /// Release anything still held when the session ends, so the remote is not left dragging.
    public func releaseAll() {
        for button in heldButtons {
            pointer(.up, x: 0, y: 0, button: button, modifiers: 0, clickCount: 1)
        }
        heldButtons.removeAll()
    }
}
