import CofluxProtocol
import Foundation
import Testing
@testable import CofluxClientCore

// MARK: - 测试替身

/// 字节视图替身：喂进来的 chunk 原样交付，可以按任意边界切开——半包是 socket 的常态。
final class FakeTailcatStream: TailcatByteStream, @unchecked Sendable {
    private let lock = NSLock()
    private var inbound: [Data] = []
    private var waiter: CheckedContinuation<Data, any Error>?
    private var written = Data()
    private var didClose = false

    var sent: Data { lock.withLock { written } }
    var closed: Bool { lock.withLock { didClose } }

    func write(_ bytes: Data) async throws {
        try lock.withLock {
            if didClose { throw TransportClosedError() }
            written.append(bytes)
        }
    }

    func read() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let immediate = lock.withLock { () -> Result<Data, any Error>? in
                if !inbound.isEmpty { return .success(inbound.removeFirst()) }
                if didClose { return .failure(TransportClosedError()) }
                waiter = continuation
                return nil
            }
            switch immediate {
            case .success(let data): continuation.resume(returning: data)
            case .failure(let error): continuation.resume(throwing: error)
            case nil: break
            }
        }
    }

    func close() async {
        let pending = lock.withLock { () -> CheckedContinuation<Data, any Error>? in
            didClose = true
            inbound.removeAll()
            let waiter = self.waiter
            self.waiter = nil
            return waiter
        }
        pending?.resume(throwing: TransportClosedError())
    }

    func feed(_ bytes: Data) {
        let pending = lock.withLock { () -> CheckedContinuation<Data, any Error>? in
            if let waiter {
                self.waiter = nil
                return waiter
            }
            inbound.append(bytes)
            return nil
        }
        pending?.resume(returning: bytes)
    }
}

final class FakeTailcatBridge: TailcatNativeBridge, @unchecked Sendable {
    private let lock = NSLock()
    private var streams: [FakeTailcatStream] = []
    private var prepared: [String] = []
    private var dropped: [String] = []
    private var didShutdown = false
    private var dialFails = false
    private var path = DeviceTransportPath(mode: "relay", latencyMs: 42)

    var prepareCount: Int { lock.withLock { prepared.count } }
    var streamCount: Int { lock.withLock { streams.count } }
    var droppedDevices: [String] { lock.withLock { dropped } }
    var wasShutDown: Bool { lock.withLock { didShutdown } }
    var latestStream: FakeTailcatStream? { lock.withLock { streams.last } }

    func failDials() { lock.withLock { dialFails = true } }

    func prepare(device: String) async throws -> String {
        lock.withLock { prepared.append(device) }
        return "nodekey:\(String(repeating: "a", count: 64))"
    }

    func dial(device _: String, address _: String) async throws -> any TailcatByteStream {
        if lock.withLock({ dialFails }) { throw TransportClosedError() }
        let stream = FakeTailcatStream()
        lock.withLock { streams.append(stream) }
        return stream
    }

    func probe(device _: String) async throws -> DeviceTransportPath { lock.withLock { path } }
    func drop(device: String) async { lock.withLock { dropped.append(device) } }
    func shutdown() async { lock.withLock { didShutdown = true } }
}

@MainActor
private final class ControlLog {
    var payloads: [Coflux_V1_ClientToServer.OneOf_Payload] = []
    var connects: [Coflux_V1_DeviceTailcatConnect] {
        payloads.compactMap { if case .deviceTailcatConnect(let value) = $0 { return value } else { return nil } }
    }
    var failures: [String] {
        payloads.compactMap { if case .deviceTailcatFailed(let value) = $0 { return value.channelID } else { return nil } }
    }
    var closes: [String] {
        payloads.compactMap { if case .deviceTailcatClose(let value) = $0 { return value.channelID } else { return nil } }
    }
}

/// 测试自己按字面量解析线格式，不复用被测重组器——否则分帧错了两边会一起错。
private func decodeRecords(_ data: Data) -> [Data] {
    var records: [Data] = []
    var cursor = data.startIndex
    while data.endIndex - cursor >= 4 {
        var length = 0
        for offset in 0 ..< 4 { length = (length << 8) | Int(data[cursor + offset]) }
        guard data.endIndex - cursor - 4 >= length else { break }
        records.append(Data(data[(cursor + 4) ..< (cursor + 4 + length)]))
        cursor += 4 + length
    }
    return records
}

private func record(_ payload: Data) -> Data {
    let length = UInt32(payload.count)
    var framed = Data([
        UInt8(truncatingIfNeeded: length >> 24), UInt8(truncatingIfNeeded: length >> 16),
        UInt8(truncatingIfNeeded: length >> 8), UInt8(truncatingIfNeeded: length),
    ])
    framed.append(payload)
    return framed
}

private func hex(_ value: String) -> Data {
    var bytes = Data()
    var index = value.startIndex
    while index < value.endIndex {
        let next = value.index(index, offsetBy: 2)
        bytes.append(UInt8(value[index ..< next], radix: 16)!)
        index = next
    }
    return bytes
}

private let fixtureProofKey = Data(repeating: 9, count: 32)
private let fixtureNonce = Data(repeating: 7, count: 32)
/// 独立于本实现生成（Python hmac）；夹具与 worker 单测同值。
private let fixtureProofHex = "20448a7b83b9dbea8aa9e9611e4847fe35dbaf1a00da3ca0e5c8bd10f8aae126"

private func makeGrant(_ payload: Coflux_V1_ClientToServer.OneOf_Payload,
                       scopes: [Coflux_V1_DeviceScope] = [.sessionRead, .sessionControl],
                       expiresAt: UInt64 = 2_000) throws -> Coflux_V1_ServerToClient.OneOf_Payload {
    guard case .deviceTailcatConnect(let connect) = payload else {
        throw DeviceRouteError("unexpected control payload")
    }
    var result = Coflux_V1_DeviceTailcatResult()
    result.channelID = connect.channelID
    result.ok = true
    result.address = "tailcat-fixture-address"
    result.proofKey = fixtureProofKey
    result.expiresAt = expiresAt
    result.scopes = scopes
    return .deviceTailcatResult(result)
}

@MainActor
private func completeHandshake(_ stream: FakeTailcatStream, channelID: String) async -> Bool {
    guard await waitUntil({ decodeRecords(stream.sent).count == 1 }) else { return false }
    stream.feed(record(fixtureNonce))
    guard await waitUntil({ decodeRecords(stream.sent).count == 2 }) else { return false }
    let expected = TailcatChannelProof.compute(proofKey: fixtureProofKey, channelID: channelID, nonce: fixtureNonce)
    guard decodeRecords(stream.sent)[1] == expected else { return false }
    stream.feed(record(Data("ok".utf8)))
    return true
}

// MARK: - 记录分帧

struct TailcatFramingTests {
    @Test func encodesBigEndianLengthPrefixWithoutCountingTheHeader() throws {
        let encoded = try TailcatRecord.encode(Data([0xAA, 0xBB, 0xCC]))
        #expect(Array(encoded) == [0, 0, 0, 3, 0xAA, 0xBB, 0xCC])
    }

    @Test func rejectsEmptyAndOversizedRecords() {
        #expect(throws: TailcatFramingError.invalidRecordLength(0)) { _ = try TailcatRecord.encode(Data()) }
        let tooLarge = TailcatRecord.maxBytes + 1
        #expect(throws: TailcatFramingError.invalidRecordLength(tooLarge)) {
            _ = try TailcatRecord.encode(Data(repeating: 1, count: tooLarge))
        }
    }

    @Test func reassemblesRecordsSplitAcrossReadsIncludingTheLengthPrefix() throws {
        var assembler = TailcatRecordAssembler()
        let payload = Data("device-envelope".utf8)
        let framed = record(payload) + record(Data([1, 2]))
        var delivered: [Data] = []
        // 一次一个字节：长度前缀本身也会被切开，这是最坏也最常见的半包形态。
        for byte in framed {
            delivered.append(contentsOf: try assembler.push(Data([byte])))
        }
        #expect(delivered == [payload, Data([1, 2])])
    }

    @Test func coalescesMultipleRecordsArrivingInOneRead() throws {
        var assembler = TailcatRecordAssembler()
        let delivered = try assembler.push(record(Data([9])) + record(Data([8, 7])))
        #expect(delivered == [Data([9]), Data([8, 7])])
    }

    @Test func rejectsOversizedLengthPrefixAndStaysBrokenAfterwards() {
        var assembler = TailcatRecordAssembler()
        let oversized = TailcatRecord.maxBytes + 1
        let length = UInt32(oversized)
        let header = Data([
            UInt8(truncatingIfNeeded: length >> 24), UInt8(truncatingIfNeeded: length >> 16),
            UInt8(truncatingIfNeeded: length >> 8), UInt8(truncatingIfNeeded: length),
        ])
        #expect(throws: TailcatFramingError.invalidRecordLength(oversized)) { _ = try assembler.push(header) }
        // 坏前缀之后不允许再猜边界：调用方必须关流。
        #expect(throws: TailcatFramingError.brokenStream) { _ = try assembler.push(record(Data([1]))) }
    }

    @Test func rejectsZeroLengthRecords() {
        var assembler = TailcatRecordAssembler()
        #expect(throws: TailcatFramingError.invalidRecordLength(0)) { _ = try assembler.push(Data([0, 0, 0, 0])) }
    }
}

// MARK: - 记录连接

struct TailcatRecordConnectionTests {
    @Test func deliversWholeMessagesAcrossChunkBoundaries() async throws {
        let stream = FakeTailcatStream()
        let connection = TailcatRecordConnection(stream: stream)
        let payload = Data(repeating: 0x5A, count: 300)
        let framed = record(payload)
        stream.feed(Data(framed[framed.startIndex ..< (framed.startIndex + 7)]))
        stream.feed(Data(framed[(framed.startIndex + 7) ..< framed.endIndex]))
        let received = try await connection.receive()
        #expect(received == payload)
        await connection.close()
    }

    @Test func prefixesOutboundMessagesAndKeepsThemInOrder() async throws {
        let stream = FakeTailcatStream()
        let connection = TailcatRecordConnection(stream: stream)
        try await connection.send(Data([1, 2, 3]))
        try await connection.send(Data([4]))
        #expect(decodeRecords(stream.sent) == [Data([1, 2, 3]), Data([4])])
        await connection.close()
    }

    @Test func closesTheStreamOnAnInvalidLengthInsteadOfHanging() async throws {
        let stream = FakeTailcatStream()
        let connection = TailcatRecordConnection(stream: stream)
        stream.feed(Data([0xFF, 0xFF, 0xFF, 0xFF]))
        await #expect(throws: (any Error).self) { _ = try await connection.receive() }
        #expect(stream.closed)
        // 关闭后挂起的 receive 立刻失败，不得吞掉后续数据。
        await #expect(throws: (any Error).self) { _ = try await connection.receive() }
    }

    @Test func closeIsIdempotentAndFailsLaterReceives() async throws {
        let stream = FakeTailcatStream()
        let connection = TailcatRecordConnection(stream: stream)
        await connection.close()
        await connection.close()
        #expect(stream.closed)
        await #expect(throws: (any Error).self) { _ = try await connection.receive() }
    }
}

// MARK: - 通道握手

@MainActor
struct TailcatChannelProofTests {
    /// 已知答案向量：域分隔符、u32be 长度前缀、拼接顺序任何一处改动都会让这条断言失败，
    /// 而 worker 对错误证明只会静默关流、不给任何诊断。
    @Test func proofMatchesTheWorkerTranscriptKnownAnswer() {
        let expectedTranscript = hex(
            "636f666c75782d7461696c6361742d6368616e6e656c2d76310000000007"
                + "6368616e6e656c" + String(repeating: "07", count: 32)
        )
        #expect(TailcatChannelProof.transcript(channelID: "channel", nonce: fixtureNonce) == expectedTranscript)
        #expect(TailcatChannelProof.compute(proofKey: fixtureProofKey, channelID: "channel", nonce: fixtureNonce)
            == hex(fixtureProofHex))
    }

    @Test func handshakeSendsHelloThenProofAndRequiresLiteralAcceptance() async throws {
        let stream = FakeTailcatStream()
        let connection = TailcatRecordConnection(stream: stream)
        let handshake = Task {
            try await tailcatHandshake(connection, channelID: "channel", proofKey: fixtureProofKey)
        }
        #expect(await waitUntil { decodeRecords(stream.sent).count == 1 })
        let hello = try #require(decodeRecords(stream.sent).first)
        let decoded = try JSONSerialization.jsonObject(with: hello) as? [String: String]
        #expect(decoded == ["channelId": "channel"])
        stream.feed(record(fixtureNonce))
        #expect(await waitUntil { decodeRecords(stream.sent).count == 2 })
        #expect(decodeRecords(stream.sent)[1] == hex(fixtureProofHex))
        stream.feed(record(Data("ok".utf8)))
        try await handshake.value
        #expect(!stream.closed)
        await connection.close()
    }

    @Test func handshakeRejectsAChallengeOfTheWrongLength() async throws {
        let stream = FakeTailcatStream()
        let connection = TailcatRecordConnection(stream: stream)
        let handshake = Task {
            try await tailcatHandshake(connection, channelID: "channel", proofKey: fixtureProofKey)
        }
        #expect(await waitUntil { decodeRecords(stream.sent).count == 1 })
        stream.feed(record(Data(repeating: 7, count: 8)))
        await #expect(throws: (any Error).self) { try await handshake.value }
    }

    @Test func handshakeRejectsAnythingButTheLiteralAcceptance() async throws {
        let stream = FakeTailcatStream()
        let connection = TailcatRecordConnection(stream: stream)
        let handshake = Task {
            try await tailcatHandshake(connection, channelID: "channel", proofKey: fixtureProofKey)
        }
        #expect(await waitUntil { decodeRecords(stream.sent).count == 1 })
        stream.feed(record(fixtureNonce))
        #expect(await waitUntil { decodeRecords(stream.sent).count == 2 })
        stream.feed(record(Data("okay".utf8)))
        await #expect(throws: (any Error).self) { try await handshake.value }
    }

    /// 对端不回话时必须关流收敛，而不是永远挂着一个 receive。
    @Test func handshakeDeadlineClosesTheStreamRatherThanHanging() async throws {
        let stream = FakeTailcatStream()
        let connection = TailcatRecordConnection(stream: stream)
        do {
            try await tailcatHandshake(connection, channelID: "channel",
                                       proofKey: fixtureProofKey, timeout: .milliseconds(60))
            Issue.record("A silent peer must not leave the handshake pending")
        } catch let error as DeviceRouteError {
            #expect(error.code == "handshake_timeout")
        }
        #expect(stream.closed)
    }
}

// MARK: - Provider

@MainActor
struct TailcatDeviceTransportProviderTests {
    @Test func openPreparesAKeyThenGrantsThenDialsThenAuthenticates() async throws {
        let bridge = FakeTailcatBridge(), log = ControlLog()
        let provider = TailcatDeviceTransportProvider(bridge: bridge, now: { 1_000 })
        let opening = Task {
            try await provider.open(daemonID: "d1", accountID: "account", clientInstanceID: "client",
                                    generation: 7, elevated: false,
                                    authorize: { payload in log.payloads.append(payload); return try makeGrant(payload) },
                                    notify: { log.payloads.append($0) })
        }
        #expect(await waitUntil { bridge.latestStream != nil })
        let stream = try #require(bridge.latestStream)
        let connect = try #require(log.connects.first)
        #expect(connect.daemonID == "d1")
        #expect(connect.clientInstanceID == "client")
        #expect(connect.transportGeneration == 7)
        // DEVICE_PROTOCOL_VERSION 仍是 1；升到 2 的是控制面协议。
        #expect(connect.protocolVersion == 1)
        #expect(connect.nodePublicKey.hasPrefix("nodekey:"))
        #expect(connect.scope == .sessionControl)
        #expect(bridge.prepareCount == 1)
        #expect(await completeHandshake(stream, channelID: connect.channelID))
        let channel = try await opening.value
        #expect(channel.channelID == connect.channelID)
        #expect(channel.scopes == [.sessionRead, .sessionControl])
        // 认证通过前不得有第三条记录发出；通过后通道才承载 DeviceEnvelope。
        #expect(decodeRecords(stream.sent).count == 2)
        try await channel.connection.send(Data([1, 2, 3]))
        #expect(decodeRecords(stream.sent).count == 3)
    }

    @Test func elevatedLaneRequestsTheRpcScope() async throws {
        let bridge = FakeTailcatBridge(), log = ControlLog()
        let provider = TailcatDeviceTransportProvider(bridge: bridge, now: { 1_000 })
        let opening = Task {
            try await provider.open(daemonID: "d1", accountID: "account", clientInstanceID: "client",
                                    generation: 1, elevated: true,
                                    authorize: { payload in
                                        log.payloads.append(payload)
                                        return try makeGrant(payload, scopes: [.rpc, .lifecycle])
                                    },
                                    notify: { log.payloads.append($0) })
        }
        #expect(await waitUntil { bridge.latestStream != nil })
        let stream = try #require(bridge.latestStream)
        let connect = try #require(log.connects.first)
        #expect(connect.scope == .rpc)
        #expect(await completeHandshake(stream, channelID: connect.channelID))
        let channel = try await opening.value
        #expect(channel.scopes == [.rpc, .lifecycle])
    }

    @Test func rejectsAGrantThatDoesNotCoverTheRequestedLane() async throws {
        let bridge = FakeTailcatBridge(), log = ControlLog()
        let provider = TailcatDeviceTransportProvider(bridge: bridge, now: { 1_000 })
        do {
            _ = try await provider.open(daemonID: "d1", accountID: "account", clientInstanceID: "client",
                                        generation: 1, elevated: true,
                                        authorize: { payload in try makeGrant(payload, scopes: [.sessionRead, .sessionControl]) },
                                        notify: { log.payloads.append($0) })
            Issue.record("An elevated lane must not accept a session-scoped grant")
        } catch let error as DeviceRouteError {
            #expect(error.code == "scope_denied")
        }
        // 范围不足在拨号之前就拒掉，不留一条无用的原生流。
        #expect(bridge.streamCount == 0)
    }

    @Test func rejectsAnExpiredGrantBeforeDialing() async throws {
        let bridge = FakeTailcatBridge(), log = ControlLog()
        let provider = TailcatDeviceTransportProvider(bridge: bridge, now: { 5_000 })
        await #expect(throws: (any Error).self) {
            _ = try await provider.open(daemonID: "d1", accountID: "account", clientInstanceID: "client",
                                        generation: 1, elevated: false,
                                        authorize: { payload in try makeGrant(payload, expiresAt: 2_000) },
                                        notify: { log.payloads.append($0) })
        }
        #expect(bridge.streamCount == 0)
    }

    @Test func reportsOnlyGenuineDialFailuresToTheCenter() async throws {
        let bridge = FakeTailcatBridge(), log = ControlLog()
        bridge.failDials()
        let provider = TailcatDeviceTransportProvider(bridge: bridge, now: { 1_000 })
        await #expect(throws: (any Error).self) {
            _ = try await provider.open(daemonID: "d1", accountID: "account", clientInstanceID: "client",
                                        generation: 1, elevated: false,
                                        authorize: { payload in log.payloads.append(payload); return try makeGrant(payload) },
                                        notify: { log.payloads.append($0) })
        }
        let channelID = try #require(log.connects.first?.channelID)
        #expect(log.failures == [channelID])
        // 拨号失败不再额外发 close：中心的 failed 分支已经回收了这条通道。
        #expect(log.closes.isEmpty)
        #expect(await waitUntil { bridge.droppedDevices == ["d1"] })
    }

    @Test func failedHandshakeClosesTheStreamAndHandsTheGrantBack() async throws {
        let bridge = FakeTailcatBridge(), log = ControlLog()
        let provider = TailcatDeviceTransportProvider(bridge: bridge, now: { 1_000 })
        let opening = Task {
            try await provider.open(daemonID: "d1", accountID: "account", clientInstanceID: "client",
                                    generation: 1, elevated: false,
                                    authorize: { payload in log.payloads.append(payload); return try makeGrant(payload) },
                                    notify: { log.payloads.append($0) })
        }
        #expect(await waitUntil { bridge.latestStream != nil })
        let stream = try #require(bridge.latestStream)
        #expect(await waitUntil { decodeRecords(stream.sent).count == 1 })
        stream.feed(record(fixtureNonce))
        #expect(await waitUntil { decodeRecords(stream.sent).count == 2 })
        stream.feed(record(Data("denied".utf8)))
        await #expect(throws: (any Error).self) { _ = try await opening.value }
        #expect(stream.closed)
        let channelID = try #require(log.connects.first?.channelID)
        #expect(log.closes == [channelID])
        #expect(await waitUntil { bridge.droppedDevices == ["d1"] })
    }

    @Test func lastChannelReleaseDropsTheNativeClientAndTheNextOpenRePrepares() async throws {
        let bridge = FakeTailcatBridge(), log = ControlLog()
        let provider = TailcatDeviceTransportProvider(bridge: bridge, now: { 1_000 })
        let opening = Task {
            try await provider.open(daemonID: "d1", accountID: "account", clientInstanceID: "client",
                                    generation: 1, elevated: false,
                                    authorize: { payload in log.payloads.append(payload); return try makeGrant(payload) },
                                    notify: { log.payloads.append($0) })
        }
        #expect(await waitUntil { bridge.latestStream != nil })
        let stream = try #require(bridge.latestStream)
        let channelID = try #require(log.connects.first?.channelID)
        #expect(await completeHandshake(stream, channelID: channelID))
        _ = try await opening.value
        #expect(bridge.droppedDevices.isEmpty)
        provider.closeChannel(channelID: channelID)
        #expect(await waitUntil { bridge.droppedDevices == ["d1"] })
        // 身份随客户端一起丢掉：远端 endpoint 被替换后靠这一步自愈。
        let reopening = Task {
            try await provider.open(daemonID: "d1", accountID: "account", clientInstanceID: "client",
                                    generation: 2, elevated: false,
                                    authorize: { payload in log.payloads.append(payload); return try makeGrant(payload) },
                                    notify: { log.payloads.append($0) })
        }
        #expect(await waitUntil { bridge.prepareCount == 2 && bridge.streamCount == 2 })
        if let pending = bridge.latestStream { await pending.close() }
        _ = try? await reopening.value
    }

    @Test func closeAllDropsEveryNativeClientForTheBackgroundTransition() async throws {
        let bridge = FakeTailcatBridge()
        let provider = TailcatDeviceTransportProvider(bridge: bridge, now: { 1_000 })
        provider.closeAll()
        #expect(await waitUntil { bridge.wasShutDown })
    }

    @Test func probePathIsUnavailableWithoutALiveNativeClient() async throws {
        let bridge = FakeTailcatBridge()
        let provider = TailcatDeviceTransportProvider(bridge: bridge, now: { 1_000 })
        #expect(await provider.probePath(daemonID: "d1") == nil)
    }
}

// MARK: - 路由接线

@MainActor
final class FakeRemoteProvider: RemoteDeviceTransportProvider {
    var opened: [(connection: FakeConnection, channelID: String, generation: UInt64, elevated: Bool)] = []
    var closedChannels: [String] = []
    var droppedDevices: [String] = []
    var closeAllCount = 0
    var path: DeviceTransportPath? = DeviceTransportPath(mode: "relay", latencyMs: 12)

    func open(daemonID _: String, accountID _: String, clientInstanceID _: String, generation: UInt64, elevated: Bool,
              authorize _: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) async throws -> Coflux_V1_ServerToClient.OneOf_Payload,
              notify _: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) -> Void) async throws -> RemoteDeviceChannel {
        let connection = FakeConnection(), channelID = UUID().uuidString
        opened.append((connection, channelID, generation, elevated))
        return RemoteDeviceChannel(connection: connection, channelID: channelID,
                                   scopes: elevated ? [.rpc, .lifecycle] : [.sessionRead, .sessionControl])
    }

    func closeChannel(channelID: String) { closedChannels.append(channelID) }
    func probePath(daemonID _: String) async -> DeviceTransportPath? { path }
    func dropDevice(daemonID: String) { droppedDevices.append(daemonID) }
    func closeAll() { closeAllCount += 1 }
}

@MainActor
struct DeviceRouterRemoteTransportTests {
    @Test func remoteChannelReportsItsRealPathAndIsNeverLabelledLocal() async throws {
        let provider = FakeRemoteProvider()
        let harness = DeviceHarness(remoteProvider: provider)
        harness.router.setControlOnline(true)
        defer { harness.router.reset() }
        let release = harness.router.retainMeasure(daemonID: "d1")
        defer { release() }
        #expect(await waitUntil { harness.transportModes.last == "relay" })
        #expect(harness.transportDetails.last == "Device 数据经 DERP 中转")
        provider.path = DeviceTransportPath(mode: "direct", latencyMs: 8)
        let active = try #require(provider.opened.first)
        active.connection.finish()
        #expect(await waitUntil { harness.transportDetails.contains("Tailcat 远程连接 连接已关闭") })
        // 诊断与断开原因都不得复用本机直连的措辞，relayHost 也不冒充一个节点名。
        #expect(!harness.transportDetails.contains("同机 Device 数据直连本地 daemon"))
        #expect(!harness.transportDetails.contains("本机直连 连接已关闭"))
        #expect(harness.transportEvents.allSatisfy { $0.relayHost == nil })
        #expect(provider.closedChannels.contains(active.channelID))
        #expect(harness.controlSent.contains {
            if case .deviceTailcatClose(let value) = $0 { return value.channelID == active.channelID }
            return false
        })
    }

    @Test func centralRevocationClosesTheNamedRemoteChannel() async throws {
        let provider = FakeRemoteProvider()
        let harness = DeviceHarness(remoteProvider: provider)
        harness.router.setControlOnline(true)
        defer { harness.router.reset() }
        let release = harness.router.retainMeasure(daemonID: "d1")
        defer { release() }
        // 等到路径已上报，说明通道确实成为 active lane，而不仅仅是 provider 返回过。
        #expect(await waitUntil { harness.transportModes.last == "relay" })
        let active = try #require(provider.opened.first)
        var closed = Coflux_V1_DeviceTailcatClosed()
        closed.channelID = active.channelID
        #expect(harness.router.handleControlPayload(.deviceTailcatClosed(closed)))
        #expect(await waitUntil { provider.closedChannels.contains(active.channelID) })
        #expect(harness.transportDetails.contains("远程连接已被中心撤销"))
    }

    @Test func backgroundingDropsEveryNativeClient() async throws {
        let provider = FakeRemoteProvider()
        let harness = DeviceHarness(remoteProvider: provider)
        harness.router.setControlOnline(true)
        defer { harness.router.reset() }
        let release = harness.router.retainMeasure(daemonID: "d1")
        defer { release() }
        #expect(await waitUntil { harness.transportModes.last == "relay" })
        harness.router.suspendRemoteTransport()
        #expect(provider.closeAllCount >= 1)
        #expect(provider.closedChannels.contains(provider.opened[0].channelID))
    }

    @Test func removingADeviceDropsItsNativeClient() async throws {
        let provider = FakeRemoteProvider()
        let harness = DeviceHarness(remoteProvider: provider)
        harness.router.setControlOnline(true)
        defer { harness.router.reset() }
        harness.router.removeDaemon("d1")
        #expect(provider.droppedDevices == ["d1"])
    }
}
