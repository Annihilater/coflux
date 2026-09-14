import CofluxProtocol
import Foundation

/// 远端通道实际走的路径，语义与 Go 侧 `backend.Path` 一致：
/// `direct` = 探测到直连端点；`relay` = 落在某个 DERP 区域；`unknown` = 还没测出来。
/// 本地管道从来不构成「直连」证据（docs/tailcat-transport.md）。
public struct DeviceTransportPath: Equatable, Sendable {
    public let mode: String
    public let latencyMs: Double?

    public init(mode: String, latencyMs: Double? = nil) {
        self.mode = mode
        self.latencyMs = latencyMs
    }
}

public struct RemoteDeviceChannel: Sendable {
    public let connection: any TransportConnection
    public let channelID: String
    public let scopes: [Coflux_V1_DeviceScope]

    public init(connection: any TransportConnection, channelID: String, scopes: [Coflux_V1_DeviceScope]) {
        self.connection = connection
        self.channelID = channelID
        self.scopes = scopes
    }
}

/// 远端 Device 数据面 provider，与本机 provider 同形：路由负责竞争、代际与回退，
/// provider 负责取中心授权、拨号与通道认证。
///
/// 控制面授权一律复用 App 已有的账号 WebSocket（`authorize`/`notify` 闭包），provider
/// 不自己开连接。开出来的通道**不是**本机直连：中心离线时只保留 session lane 的
/// 15 秒宽限，elevated 一律关闭。
@MainActor public protocol RemoteDeviceTransportProvider: AnyObject {
    func open(daemonID: String, accountID: String, clientInstanceID: String, generation: UInt64, elevated: Bool,
              authorize: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) async throws -> Coflux_V1_ServerToClient.OneOf_Payload,
              notify: @escaping @MainActor @Sendable (Coflux_V1_ClientToServer.OneOf_Payload) -> Void) async throws -> RemoteDeviceChannel
    /// 通道已关闭；该设备最后一条通道释放时 provider 须一并释放它的原生客户端。
    func closeChannel(channelID: String)
    /// 最近一次可测路径；nil = 该设备当前没有可探测的原生客户端。
    func probePath(daemonID: String) async -> DeviceTransportPath?
    /// 中心明确移除设备：丢弃它的通道与原生客户端。
    func dropDevice(daemonID: String)
    /// 登出、换账号或进后台：丢弃全部原生网络状态。
    func closeAll()
}

/// 一条已建立的 Tailcat 流的字节视图。Go 把 socketpair 的另一端交给 Swift，两侧只搬字节；
/// 记录边界由 `TailcatRecordConnection` 自己切。
public protocol TailcatByteStream: Sendable {
    /// 原样写出全部字节；实现负责处理部分写，并保证同一条流上的提交顺序。
    func write(_ bytes: Data) async throws
    /// 下一段可读字节（至少 1 字节）；对端关闭时抛 `TransportClosedError`。
    func read() async throws -> Data
    /// 幂等关闭，并释放底层描述符。
    func close() async
}

/// Go c-archive 的 Swift 门面。实现只做搬运，不持有任何凭据：channel grant 与 32 字节
/// proof key 始终留在 Swift 侧。
public protocol TailcatNativeBridge: Sendable {
    /// 为该设备取一把独立的节点公钥；同一设备重复调用必须返回同一把——独立后端不能争抢
    /// 同一个 DERP 身份（docs/tailcat-transport.md「Client owners first call prepare」）。
    func prepare(device: String) async throws -> String
    /// 拨到中心授权下发的地址，返回这条流的字节视图。
    func dial(device: String, address: String) async throws -> any TailcatByteStream
    func probe(device: String) async throws -> DeviceTransportPath
    /// 关掉该设备的流与它的 Tailcat 客户端；下次 prepare 会换一把新身份。
    func drop(device: String) async
    /// 关掉全部流与客户端。
    func shutdown() async
}
