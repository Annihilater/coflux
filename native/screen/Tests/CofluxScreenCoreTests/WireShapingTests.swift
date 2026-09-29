import XCTest
@testable import CofluxScreenCore

final class WireShapingTests: XCTestCase {
    func testRecordFramingRoundTripsAcrossChunkBoundaries() throws {
        let first = try Framing.encode(Data([1, 2, 3]))
        let second = try Framing.encode(Data())
        let third = try Framing.encode(Data(repeating: 9, count: 70_000))
        XCTAssertEqual([UInt8](first.prefix(4)), [0, 0, 0, 3])
        var stream = first + second + third
        var parser = RecordParser()
        var records: [Data] = []
        while !stream.isEmpty {
            let take = min(1000, stream.count)
            records += try parser.push(stream.prefix(take))
            stream.removeFirst(take)
        }
        XCTAssertEqual(records.count, 3)
        XCTAssertEqual(records[0], Data([1, 2, 3]))
        XCTAssertEqual(records[1], Data())
        XCTAssertEqual(records[2].count, 70_000)
        // A declared length past the cap is refused rather than buffered.
        var oversized = RecordParser()
        XCTAssertThrowsError(try oversized.push(Data([0x7F, 0xFF, 0xFF, 0xFF])))
    }

    func testAVCCBecomesAnnexBWithParameterSetsOnKeyframes() {
        let avcc = Data([0, 0, 0, 2, 0x65, 0xAA, 0, 0, 0, 1, 0x41])
        let annexB = AnnexB.fromAVCC(avcc, lengthSize: 4)
        XCTAssertEqual(annexB, Data([0, 0, 0, 1, 0x65, 0xAA, 0, 0, 0, 1, 0x41]))
        let sets = AnnexB.parameterSets([Data([0x67, 1]), Data([0x68, 2])])
        XCTAssertEqual(sets, Data([0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2]))
        // A truncated NAL is cut off, not read past the buffer.
        XCTAssertEqual(AnnexB.fromAVCC(Data([0, 0, 0, 9, 1, 2]), lengthSize: 4), Data())
        XCTAssertEqual(AnnexB.fromAVCC(Data([0, 3, 7, 8, 9]), lengthSize: 2), Data([0, 0, 0, 1, 7, 8, 9]))
    }

    func testFramesAreChunkedWithTheLastFlagOnTheFinalPiece() {
        let frame = Data(repeating: 1, count: 2500)
        let chunks = AnnexB.chunks(frame, chunkBytes: 1000)
        XCTAssertEqual(chunks.map { $0.data.count }, [1000, 1000, 500])
        XCTAssertEqual(chunks.map { $0.last }, [false, false, true])
        let single = AnnexB.chunks(Data([1]), chunkBytes: 1000)
        XCTAssertEqual(single.count, 1)
        XCTAssertTrue(single[0].last)
        XCTAssertEqual(AnnexB.chunks(Data(), chunkBytes: 1000).count, 1)
    }

    func testHolderArbiterMirrorsTerminalTakeover() {
        var arbiter = HolderArbiter()
        XCTAssertEqual(arbiter.open(clientInstanceID: "a", controlLane: "a-control", force: false), .held(epoch: 1, detachedLane: nil))
        XCTAssertTrue(arbiter.attachVideo(lane: "a-video", epoch: 1))
        XCTAssertFalse(arbiter.attachVideo(lane: "x", epoch: 7))
        // Another client without force is refused while a lane is alive.
        XCTAssertEqual(arbiter.open(clientInstanceID: "b", controlLane: "b-control", force: false), .refused)
        // The same client reconnecting keeps its epoch.
        XCTAssertEqual(arbiter.open(clientInstanceID: "a", controlLane: "a-control-2", force: false), .held(epoch: 1, detachedLane: nil))
        XCTAssertEqual(arbiter.holder?.controlLane, "a-control-2")
        // 重新接管: force preempts, the old control lane is told, the epoch moves on.
        XCTAssertEqual(arbiter.open(clientInstanceID: "b", controlLane: "b-control", force: true), .held(epoch: 2, detachedLane: "a-control-2"))
        XCTAssertTrue(arbiter.isCurrent(epoch: 2))
        XCTAssertFalse(arbiter.isCurrent(epoch: 1))
        // Once every lane is gone the holder is orphaned (grace starts) but not replaced.
        XCTAssertTrue(arbiter.attachVideo(lane: "b-video", epoch: 2))
        XCTAssertFalse(arbiter.laneClosed("b-video"))
        XCTAssertTrue(arbiter.laneClosed("b-control"))
        // An orphaned holder may be taken without force.
        XCTAssertEqual(arbiter.open(clientInstanceID: "c", controlLane: "c-control", force: false), .held(epoch: 3, detachedLane: nil))
        arbiter.end()
        XCTAssertNil(arbiter.holder)
    }
}
