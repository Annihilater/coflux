import CofluxClientCore
import Darwin
import Dispatch
import Foundation

/// Go c-archive 的返回码；错误只以码穿过语言边界，地址、节点密钥与 grant 永不出现在里面。
private enum TailcatResult {
    static let ok: Int32 = 0
    static let invalid: Int32 = -1
    static let closed: Int32 = -2
    static let limit: Int32 = -3
    static let dial: Int32 = -4
    static let probe: Int32 = -5
}

struct TailcatBridgeError: LocalizedError {
    let code: Int32

    var errorDescription: String? {
        switch code {
        case TailcatResult.invalid: "远程连接参数无效"
        case TailcatResult.closed: "原生网络组件已停止"
        case TailcatResult.limit: "同时连接的设备或通道过多"
        case TailcatResult.dial: "无法建立远程连接"
        case TailcatResult.probe: "远程路径探测失败"
        default: "原生网络组件不可用"
        }
    }
}

/// cgo 生成的声明是 `char *`（不是 `const char *`）。Go 侧只读并立即复制，
/// 就地去掉 const 是安全的，也省掉一次 strdup/free。
private func withMutableCString<R>(_ value: String, _ body: (UnsafeMutablePointer<CChar>) -> R) -> R {
    value.withCString { body(UnsafeMutablePointer(mutating: $0)) }
}

/// socketpair 在 Swift 这一端的字节视图。DispatchIO 负责非阻塞读写和部分写续写；
/// 描述符所有权随之转移，cleanup handler 里 close(2) 恰好一次。
final class TailcatSocketStream: TailcatByteStream, @unchecked Sendable {
    private let channel: DispatchIO
    private let queue: DispatchQueue
    private let onClose: @Sendable () -> Void
    private let lock = NSLock()
    private var buffered: [Data] = []
    private var reader: CheckedContinuation<Data, any Error>?
    private var drained = false
    private var closed = false

    init(descriptor: Int32, onClose: @escaping @Sendable () -> Void) {
        self.onClose = onClose
        let queue = DispatchQueue(label: "dev.coflux.tailcat.stream", qos: .userInitiated)
        self.queue = queue
        channel = DispatchIO(type: .stream, fileDescriptor: descriptor, queue: queue) { _ in
            Darwin.close(descriptor)
        }
        // 有一个字节就交付：记录边界由上层切，这里不做任何攒包。
        channel.setLimit(lowWater: 1)
        startReading()
    }

    private func startReading() {
        channel.read(offset: 0, length: Int.max, queue: queue) { [weak self] done, data, _ in
            guard let self else { return }
            if let data, !data.isEmpty { self.deliver(Data(data)) }
            if done { self.finishReading() }
        }
    }

    private func deliver(_ bytes: Data) {
        let waiter = lock.withLock { () -> CheckedContinuation<Data, any Error>? in
            if let reader {
                self.reader = nil
                return reader
            }
            buffered.append(bytes)
            return nil
        }
        waiter?.resume(returning: bytes)
    }

    private func finishReading() {
        let waiter = lock.withLock { () -> CheckedContinuation<Data, any Error>? in
            drained = true
            let waiter = reader
            reader = nil
            return waiter
        }
        waiter?.resume(throwing: TransportClosedError())
    }

    func read() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let immediate = lock.withLock { () -> Result<Data, any Error>? in
                if !buffered.isEmpty { return .success(buffered.removeFirst()) }
                if drained || closed { return .failure(TransportClosedError()) }
                reader = continuation
                return nil
            }
            switch immediate {
            case .success(let data): continuation.resume(returning: data)
            case .failure(let error): continuation.resume(throwing: error)
            case nil: break
            }
        }
    }

    func write(_ bytes: Data) async throws {
        guard !bytes.isEmpty else { return }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            if lock.withLock({ closed }) {
                continuation.resume(throwing: TransportClosedError())
                return
            }
            // 提交是同步的，所以并发调用者的顺序就是落到 socket 的顺序。
            let region = bytes.withUnsafeBytes { DispatchData(bytes: $0) }
            channel.write(offset: 0, data: region, queue: queue) { done, _, error in
                guard done else { return }
                if error == 0 { continuation.resume() } else { continuation.resume(throwing: TransportClosedError()) }
            }
        }
    }

    func close() async {
        let waiter = lock.withLock { () -> CheckedContinuation<Data, any Error>? in
            let waiter = reader
            reader = nil
            return waiter
        }
        waiter?.resume(throwing: TransportClosedError())
        let first = lock.withLock { () -> Bool in
            if closed { return false }
            closed = true
            drained = true
            buffered.removeAll()
            return true
        }
        guard first else { return }
        // .stop 会让在飞的读写立刻以错误收尾，pending 的 write 不会悬着。
        channel.close(flags: .stop)
        onClose()
    }
}

/// 进程内 Tailcat 客户端的 Swift 门面。
///
/// 所有 C 调用都排到一条并发后台队列上：`dial` 会阻塞（Go 侧 15 秒上限），而
/// `close` 必须能在拨号还卡着时把它取消，两者不能互相排队。
final class CofluxTailcatBridge: TailcatNativeBridge, @unchecked Sendable {
    private let queue = DispatchQueue(label: "dev.coflux.tailcat.bridge", qos: .userInitiated, attributes: .concurrent)
    private let lock = NSLock()
    private var nextStream: Int64 = 1

    init() {}

    private func reserveStream() -> Int64 {
        lock.withLock {
            let stream = nextStream
            nextStream += 1
            return stream
        }
    }

    private func perform<T: Sendable>(_ body: @escaping @Sendable () -> Result<T, any Error>) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { continuation.resume(with: body()) }
        }
    }

    func prepare(device: String) async throws -> String {
        try await perform {
            var key: UnsafeMutablePointer<CChar>?
            let code = withMutableCString(device) { coflux_tailcat_prepare($0, &key) }
            guard code == TailcatResult.ok, let key else { return .failure(TailcatBridgeError(code: code)) }
            let value = String(cString: key)
            coflux_tailcat_free(key)
            return .success(value)
        }
    }

    func dial(device: String, address: String) async throws -> any TailcatByteStream {
        let stream = reserveStream()
        let queue = self.queue
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<any TailcatByteStream, any Error>) in
                queue.async {
                    var descriptor: Int32 = -1
                    let code = withMutableCString(device) { devicePointer in
                        withMutableCString(address) { addressPointer in
                            coflux_tailcat_dial(stream, devicePointer, addressPointer, &descriptor)
                        }
                    }
                    guard code == TailcatResult.ok, descriptor >= 0 else {
                        continuation.resume(throwing: TailcatBridgeError(code: code))
                        return
                    }
                    continuation.resume(returning: TailcatSocketStream(descriptor: descriptor) {
                        queue.async { coflux_tailcat_close(stream) }
                    })
                }
            }
        } onCancel: {
            // 按 stream id 撤销还在飞的拨号——ID 是调用方分配的，正是为了这一步。
            queue.async { coflux_tailcat_close(stream) }
        }
    }

    func probe(device: String) async throws -> DeviceTransportPath {
        try await perform {
            var mode: UnsafeMutablePointer<CChar>?
            var latency = 0.0
            let code = withMutableCString(device) { coflux_tailcat_probe($0, &mode, &latency) }
            guard code == TailcatResult.ok, let mode else { return .failure(TailcatBridgeError(code: code)) }
            let value = String(cString: mode)
            coflux_tailcat_free(mode)
            return .success(DeviceTransportPath(mode: value, latencyMs: latency > 0 ? latency : nil))
        }
    }

    func drop(device: String) async {
        await withCheckedContinuation { continuation in
            queue.async {
                withMutableCString(device) { coflux_tailcat_drop($0) }
                continuation.resume()
            }
        }
    }

    func shutdown() async {
        await withCheckedContinuation { continuation in
            queue.async {
                coflux_tailcat_shutdown()
                continuation.resume()
            }
        }
    }
}
