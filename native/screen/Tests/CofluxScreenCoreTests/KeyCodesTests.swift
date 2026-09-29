import XCTest
@testable import CofluxScreenCore

final class KeyCodesTests: XCTestCase {
    func testPhysicalCodesMapToMacVirtualKeys() {
        XCTAssertEqual(KeyCodes.virtualKey(for: "KeyA"), 0x00)
        XCTAssertEqual(KeyCodes.virtualKey(for: "KeyQ"), 0x0C)
        XCTAssertEqual(KeyCodes.virtualKey(for: "Digit1"), 0x12)
        XCTAssertEqual(KeyCodes.virtualKey(for: "Enter"), 0x24)
        XCTAssertEqual(KeyCodes.virtualKey(for: "Space"), 0x31)
        XCTAssertEqual(KeyCodes.virtualKey(for: "MetaLeft"), 0x37)
        XCTAssertEqual(KeyCodes.virtualKey(for: "MetaRight"), 0x36)
        XCTAssertEqual(KeyCodes.virtualKey(for: "ArrowUp"), 0x7E)
        XCTAssertEqual(KeyCodes.virtualKey(for: "F1"), 0x7A)
        XCTAssertEqual(KeyCodes.virtualKey(for: "Numpad0"), 0x52)
    }

    func testUnknownCodesAreNotSent() {
        XCTAssertNil(KeyCodes.virtualKey(for: ""))
        XCTAssertNil(KeyCodes.virtualKey(for: "Unidentified"))
        XCTAssertNil(KeyCodes.virtualKey(for: "Power"))
    }

    func testModifierKeysAreRecognised() {
        XCTAssertTrue(KeyCodes.isModifier("MetaLeft"))
        XCTAssertTrue(KeyCodes.isModifier("ShiftRight"))
        XCTAssertTrue(KeyCodes.isModifier("CapsLock"))
        XCTAssertFalse(KeyCodes.isModifier("KeyA"))
    }

    func testModifierBitsMatchTheWireContract() {
        let modifiers = KeyCodes.Modifiers(rawValue: 8 | 2)
        XCTAssertTrue(modifiers.contains(.command))
        XCTAssertTrue(modifiers.contains(.control))
        XCTAssertFalse(modifiers.contains(.shift))
        let flags = InputInjector.flags(8 | 1 | 32)
        XCTAssertTrue(flags.contains(.maskCommand))
        XCTAssertTrue(flags.contains(.maskShift))
        XCTAssertTrue(flags.contains(.maskSecondaryFn))
        XCTAssertFalse(flags.contains(.maskAlternate))
    }
}
