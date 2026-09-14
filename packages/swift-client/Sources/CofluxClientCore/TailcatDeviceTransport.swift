#if canImport(CryptoKit)
import CofluxProtocol
import CryptoKit
import Foundation

/// worker 受理窗口（`crates/worker/src/tailcat.rs` 的 5 秒 authenticate 超时）。
private let tailcatHandshakeTimeout: Duration = .seconds(5)
/// 中心的 grant 窗口是 30 秒；第一条 hello 记录 worker 侧限 512 字节。
private let tailcatHelloMaxBytes = 512

/// worker 侧 transcript 的精确镜像（`crates/worker/src/tailcat_auth.rs` 的 DOMAIN/transcript）：
/// `"coflux-tailcat-channel-v1\0" || u32be(len(channelId)) || channelId || nonce`。
/// 域分隔符、长度前缀、拼接顺序任何一处不同，worker 都只会静默关流，不给任何诊断。
enum TailcatChannelProof {
    static let domain = Data("coflux-tailcat-channel-v1\0".utf8)
    static let nonceBytes = 32

    static func transcript(channelID: String, nonce: Data) -> Data {
        let identifier = Data(channelID.utf8)
        let length = UInt32(identifier.count)
        var transcript = Data(capacity: domain.count + 4 + identifier.count + nonce.count)
        transcript.append(domain)
        transcript.append(UInt8(truncatingIfNeeded: length >> 24))
        transcript.append(UInt8(truncatingIfNeeded: length >> 16))
        transcript.append(UInt8(truncatingIfNeeded: length >> 8))
        transcript.append(UInt8(truncatingIfNeeded: length))
        transcript.append(identifier)
        transcript.append(nonce)
        return transcript
    }

    static func compute(proofKey: Data, channelID: String, nonce: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(
            for: transcript(channelID: channelID, nonce: nonce),
            using: SymmetricKey(data: proofKey)
        ))
    }
}

/// 握手看门狗的到期标记。超时由看门狗直接关流——不指望取消传播到底层描述符，
/// 任何一步无响应都必须收敛成「关闭 + 可读原因」，而不是悬着。
private final class TailcatDeadlineFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var expired: Bool { lock.withLock { value } }
    func markExpired() { lock.withLock { value = true } }
}

/// 通道握手：新开的流上先发 `{"channelId":"<id>"}`，收 32 字节挑战，回 HMAC 证明，
/// 必须收到字面量 `ok` 才允许承载 DeviceEnvelope。grant 在 worker 侧被原子消费一次
/// （tailcat_auth.rs consume），一次失败的证明也会把它用掉。
func tailcatHandshake(
    _ connection: TailcatRecordConnection,
    channelID: String,
    proofKey: Data,
    timeout: Duration = tailcatHandshakeTimeout
) async throws {
    let flag = TailcatDeadlineFlag()
    let watchdog = Task { [weak connection] in
        do { try await Task.sleep(for: timeout) } catch { return }
        flag.markExpired()
        await connection?.close()
    }
    defer { watchdog.cancel() }
    do {
        let hello = try JSONSerialization.data(withJSONObject: ["channelId": channelID])
        guard hello.count <= tailcatHelloMaxBytes else { throw DeviceRouteError("远程通道标识过长") }
        try await connection.send(hello)
        let nonce = try await connection.receive()
        guard nonce.count == TailcatChannelProof.nonceBytes else {
            throw DeviceRouteError("远程身份挑战无效")
        }
        let proof = TailcatChannelProof.compute(proofKey: proofKey, channelID: channelID, nonce: nonce)
        try await connection.send(proof)
        let accepted = try await connection.receive()
        guard accepted == Data("ok".utf8) else { throw DeviceRouteError("远程身份验证被拒绝") }
    } catch {
        if flag.expired { throw DeviceRouteError("远程身份验证超时", code: "handshake_timeout") }
        throw error
    }
}

/// iOS 的远端 Device 数据面 provider：把中心授权、原生拨号与通道认证串成一条。
///
/// 每台设备一把独立的节点公钥（独立后端不能争抢同一个 DERP 身份，
/// docs/tailcat-transport.md）。设备上的通道全部释放后连原生客户端一起丢掉——这也是远端
/// endpoint 被替换后能自愈的原因：下一次 prepare 换一把新身份、解析新地址。
///
/// proof key 只在 openChannel 的栈上活着，用完立即清零；既不入 Keychain 也不进日志。
@MainActor
public final class TailcatDeviceTransportProvider: RemoteDeviceTransportProvider {
    /// 与 backend.MaxDevices 同值。
    private static let maxDevices = 16

    private final class DeviceState {
        var publicKey: String?
        var preparing: Task<String, any Error>?
        var users = 0
    }

    private let bridge: any TailcatNativeBridge
    private let now: @Sendable () -> Double
    private var devices: [String: DeviceState] = [:]
    private var owners: [String: String] = [:]

    public init(bridge: any TailcatNativeBridge,
                now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.bridge = bridge
        self.now = now
    }

    public func open(daemonID: String, accountID _: String, clientInstanceID: String, generation: UInt64,
                     elevated: Bool,
                     authorize: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) async throws -> Coflux_V1_ServerToClient.OneOf_Payload,
                     notify: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) -> Void) async throws -> RemoteDeviceChannel {
        guard !daemonID.isEmpty, !clientInstanceID.isEmpty, generation > 0 else {
            throw DeviceRouteError("远程连接参数无效")
        }
        let state: DeviceState
        if let existing = devices[daemonID] {
            state = existing
        } else {
            guard devices.count < Self.maxDevices else { throw DeviceRouteError("同时连接的设备过多") }
            state = DeviceState()
            devices[daemonID] = state
        }
        // 先占位再建连：同一设备第二条 lane 正在建立时，第一条关闭不得把原生客户端抽走。
        state.users += 1
        do {
            return try await openChannel(daemonID: daemonID, state: state, clientInstanceID: clientInstanceID,
                                         generation: generation, elevated: elevated,
                                         authorize: authorize, notify: notify)
        } catch {
            release(daemonID, state)
            throw error
        }
    }

    private func openChannel(daemonID: String, state: DeviceState, clientInstanceID: String, generation: UInt64,
                             elevated: Bool,
                             authorize: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) async throws -> Coflux_V1_ServerToClient.OneOf_Payload,
                             notify: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) -> Void) async throws -> RemoteDeviceChannel {
        // 顺序不可换：先 prepare 拿到本设备专属公钥，再带着它去中心换 grant，最后才拨号。
        let nodePublicKey = try await preparedKey(daemonID, state)
        let channelID = UUID().uuidString
        var connect = Coflux_V1_DeviceTailcatConnect()
        connect.daemonID = daemonID
        connect.channelID = channelID
        connect.clientInstanceID = clientInstanceID
        connect.transportGeneration = generation
        connect.protocolVersion = DeviceProtocol.version
        connect.nodePublicKey = nodePublicKey
        connect.scope = elevated ? .rpc : .sessionControl

        let response = try await authorize(.deviceTailcatConnect(connect))
        guard case .deviceTailcatResult(let grant) = response, grant.channelID == channelID else {
            throw DeviceRouteError("远程授权响应与请求不匹配")
        }
        guard grant.ok, grant.hasAddress, !grant.address.isEmpty, grant.address.utf8.count <= 32768,
              grant.proofKey.count == TailcatChannelProof.nonceBytes, Double(grant.expiresAt) > now()
        else {
            throw DeviceRouteError(grant.hasError && !grant.error.isEmpty ? grant.error : "远程连接授权失败")
        }
        let required: Set<Coflux_V1_DeviceScope> = elevated ? [.rpc, .lifecycle] : [.sessionRead, .sessionControl]
        guard Set(grant.scopes).isSuperset(of: required) else {
            throw DeviceRouteError("远程连接授权范围不足", code: "scope_denied")
        }
        // 工作副本用完即清零；授权响应本身是局部值，随本帧一起出栈。
        var proofKey = grant.proofKey
        defer { proofKey.resetBytes(in: proofKey.startIndex ..< proofKey.endIndex) }

        let stream: any TailcatByteStream
        do {
            stream = try await bridge.dial(device: daemonID, address: grant.address)
        } catch {
            // 只有真实拨号失败才上报，取消与授权失败不上报（DeviceTailcatFailed 的契约）。
            if !(error is CancellationError), !Task.isCancelled {
                var failed = Coflux_V1_DeviceTailcatFailed()
                failed.channelID = channelID
                notify(.deviceTailcatFailed(failed))
            }
            throw error
        }
        let connection = TailcatRecordConnection(stream: stream)
        do {
            try await tailcatHandshake(connection, channelID: channelID, proofKey: proofKey)
        } catch {
            await connection.close()
            // 未被消费的 grant 交回中心撤销，不等它的 30 秒窗口自然过期。
            var close = Coflux_V1_DeviceTailcatClose()
            close.channelID = channelID
            notify(.deviceTailcatClose(close))
            throw error
        }
        owners[channelID] = daemonID
        return RemoteDeviceChannel(connection: connection, channelID: channelID, scopes: grant.scopes)
    }

    private func preparedKey(_ daemonID: String, _ state: DeviceState) async throws -> String {
        if let publicKey = state.publicKey { return publicKey }
        let preparing: Task<String, any Error>
        if let existing = state.preparing {
            preparing = existing
        } else {
            let bridge = self.bridge
            preparing = Task { try await bridge.prepare(device: daemonID) }
            state.preparing = preparing
        }
        do {
            let publicKey = try await preparing.value
            guard !publicKey.isEmpty else { throw DeviceRouteError("远程设备身份无效") }
            if devices[daemonID] === state, state.preparing == preparing {
                state.publicKey = publicKey
                state.preparing = nil
            }
            return publicKey
        } catch {
            // 失败的准备任务不得留在缓存里，否则这台设备再也换不回可用身份。
            if devices[daemonID] === state, state.preparing == preparing { state.preparing = nil }
            throw error
        }
    }

    public func closeChannel(channelID: String) {
        guard let daemonID = owners.removeValue(forKey: channelID), let state = devices[daemonID] else { return }
        release(daemonID, state)
    }

    private func release(_ daemonID: String, _ state: DeviceState) {
        state.users -= 1
        guard state.users <= 0, devices[daemonID] === state else { return }
        devices[daemonID] = nil
        owners = owners.filter { $0.value != daemonID }
        let bridge = self.bridge
        Task { await bridge.drop(device: daemonID) }
    }

    public func probePath(daemonID: String) async -> DeviceTransportPath? {
        guard devices[daemonID] != nil else { return nil }
        return try? await bridge.probe(device: daemonID)
    }

    public func dropDevice(daemonID: String) {
        guard devices.removeValue(forKey: daemonID) != nil else { return }
        owners = owners.filter { $0.value != daemonID }
        let bridge = self.bridge
        Task { await bridge.drop(device: daemonID) }
    }

    public func closeAll() {
        devices.removeAll()
        owners.removeAll()
        let bridge = self.bridge
        Task { await bridge.shutdown() }
    }
}
#endif
