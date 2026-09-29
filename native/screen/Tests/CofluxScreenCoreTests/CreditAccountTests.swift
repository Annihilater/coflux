import XCTest
@testable import CofluxScreenCore

final class CreditAccountTests: XCTestCase {
    func testSendsWithinCreditAndDropsBeyondIt() {
        var account = CreditAccount(initialCredit: 1000, encodeFloor: 100)
        XCTAssertTrue(account.needsKeyframe, "the first frame after attach is a keyframe")
        XCTAssertTrue(account.trySend(bytes: 600))
        XCTAssertFalse(account.needsKeyframe)
        XCTAssertEqual(account.available, 400)
        XCTAssertEqual(account.outstanding, 600)
        // 500 > 400: dropped whole, never partially sent, and the chain is broken.
        XCTAssertFalse(account.trySend(bytes: 500))
        XCTAssertEqual(account.available, 400)
        XCTAssertEqual(account.outstanding, 600)
        XCTAssertEqual(account.droppedFrames, 1)
        XCTAssertTrue(account.needsKeyframe)
        XCTAssertTrue(account.trySend(bytes: 400))
        XCTAssertEqual(account.available, 0)
        XCTAssertFalse(account.shouldEncode)
    }

    func testReturnedCreditNeverExceedsOutstanding() {
        var account = CreditAccount(initialCredit: 100, encodeFloor: 10)
        XCTAssertTrue(account.trySend(bytes: 100))
        account.grant(60)
        XCTAssertEqual(account.available, 60)
        XCTAssertEqual(account.outstanding, 40)
        // An inflated return is honoured only as far as it was outstanding; the rest is a fresh
        // window the client chose to add.
        account.grant(1000)
        XCTAssertEqual(account.outstanding, 0)
        XCTAssertEqual(account.available, 60 + 40 + 960)
    }

    func testResetForgetsTheOldLane() {
        var account = CreditAccount(initialCredit: 100)
        XCTAssertTrue(account.trySend(bytes: 50))
        account.reset(initialCredit: 20)
        XCTAssertEqual(account.available, 20)
        XCTAssertEqual(account.outstanding, 0)
        XCTAssertTrue(account.needsKeyframe)
    }

    func testEncodeFloorGatesCaptureBeforeEncoding() {
        var account = CreditAccount(initialCredit: 50, encodeFloor: 32)
        XCTAssertTrue(account.shouldEncode)
        XCTAssertTrue(account.trySend(bytes: 30))
        XCTAssertFalse(account.shouldEncode)
        account.grant(30)
        XCTAssertTrue(account.shouldEncode)
    }

    func testBitrateStartsFromTheWindowAndAdapts() {
        var relay = BitrateController(initialCredit: 2 * 1024 * 1024)
        var direct = BitrateController(initialCredit: 8 * 1024 * 1024)
        XCTAssertLessThan(relay.bitsPerSecond, direct.bitsPerSecond)
        let before = relay.bitsPerSecond
        XCTAssertTrue(relay.tick(droppedFrames: 3, outstanding: 0, window: 1000))
        XCTAssertEqual(relay.bitsPerSecond, before * 3 / 4)
        // Pressure without drops also lowers.
        let pressured = direct.bitsPerSecond
        XCTAssertTrue(direct.tick(droppedFrames: 0, outstanding: 900, window: 1000))
        XCTAssertLessThan(direct.bitsPerSecond, pressured)
        // Five quiet ticks raise it again, never above the maximum.
        var quiet = BitrateController(initialCredit: 64 * 1024 * 1024, maximum: 40_000_000)
        XCTAssertEqual(quiet.bitsPerSecond, 40_000_000)
        for _ in 0..<5 { _ = quiet.tick(droppedFrames: 0, outstanding: 0, window: 1000) }
        XCTAssertEqual(quiet.bitsPerSecond, 40_000_000)
        var low = BitrateController(initialCredit: 1000, minimum: 1_500_000)
        XCTAssertEqual(low.bitsPerSecond, 1_500_000)
        var raised = false
        for _ in 0..<5 { raised = low.tick(droppedFrames: 0, outstanding: 0, window: 1000) || raised }
        XCTAssertTrue(raised)
        XCTAssertEqual(low.bitsPerSecond, 1_650_000)
    }
}
