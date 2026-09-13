import Foundation

/// 把一条纯字节流适配成 `TransportConnection` 承诺的「整条 binary message」语义：
/// 出向加 4 字节长度前缀，入向重组到完整记录才交付。跨记录的半包是常态而非异常。
///
/// 关闭幂等；关闭后挂起的 receive 立即失败，且已缓冲记录一并丢弃——旧 waiter 不得吞掉
/// 后续新连接的数据（ClientContracts.swift 的 TransportConnection 契约）。
final class TailcatRecordConnection: TransportConnection, @unchecked Sendable {
    private let stream: any TailcatByteStream
    private let lock = NSLock()
    private var assembler = TailcatRecordAssembler()
    private var buffered: [Data] = []
    private var closed = false
    /// 串行发送链：记录必须按调用顺序落到 socket，input_seq 连续性契约依赖它。
    private var writeChain: Task<Void, any Error>?

    init(stream: any TailcatByteStream) {
        self.stream = stream
    }

    func send(_ data: Data) async throws {
        let record = try TailcatRecord.encode(data)
        let stream = self.stream
        let task: Task<Void, any Error> = lock.withLock {
            let previous = writeChain
            let next = Task<Void, any Error> {
                _ = try? await previous?.value
                try await stream.write(record)
            }
            writeChain = next
            return next
        }
        do {
            try await task.value
        } catch {
            // 写不出去就不是一条可用通道；关掉而不是让后续帧继续排队。
            await close()
            throw error
        }
    }

    func receive() async throws -> Data {
        while true {
            let ready = try lock.withLock { () throws -> Data? in
                if !buffered.isEmpty { return buffered.removeFirst() }
                if closed { throw TransportClosedError() }
                return nil
            }
            if let ready { return ready }
            let chunk: Data
            do {
                chunk = try await stream.read()
            } catch {
                await close()
                throw error
            }
            do {
                try lock.withLock { buffered.append(contentsOf: try assembler.push(chunk)) }
            } catch {
                // 坏长度前缀之后没有可信的边界可猜：关流，与 Go 侧同语义。
                await close()
                throw error
            }
        }
    }

    func close() async {
        let already = lock.withLock { () -> Bool in
            if closed { return true }
            closed = true
            buffered.removeAll()
            return false
        }
        guard !already else { return }
        await stream.close()
    }
}
