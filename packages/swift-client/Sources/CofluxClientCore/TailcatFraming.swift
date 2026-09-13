import Foundation

public enum TailcatFramingError: Error, Equatable, Sendable {
    case invalidRecordLength(Int)
    case brokenStream
}

/// Tailcat TCP 流上的记录格式，与 helper 逐字节相同（`transport/tailcat/internal/ipc/frame.go`
/// 的 ReadRecord/WriteRecord）：`u32be payloadLength || payload`，长度不含 4 字节头，
/// 零长与超限一律拒绝。
///
/// Go 侧 socketpair 只做字节搬运，不重新解释记录，所以切边界是 Swift 自己的事——
/// 这正是 WebSocket 背书的本机 provider 白拿、而远端 provider 必须自己补的一层：
/// `TransportConnection` 承诺的是整条 binary message，socket 给的是字节流。
enum TailcatRecord {
    /// 与 ipc.MaxData / DeviceProtocol.maxFrameBytes 同值；两端上限必须一致。
    static let maxBytes = DeviceProtocol.maxFrameBytes

    static func encode(_ payload: Data) throws -> Data {
        guard !payload.isEmpty, payload.count <= maxBytes else {
            throw TailcatFramingError.invalidRecordLength(payload.count)
        }
        let length = UInt32(payload.count)
        var record = Data(capacity: payload.count + 4)
        record.append(UInt8(truncatingIfNeeded: length >> 24))
        record.append(UInt8(truncatingIfNeeded: length >> 16))
        record.append(UInt8(truncatingIfNeeded: length >> 8))
        record.append(UInt8(truncatingIfNeeded: length))
        record.append(payload)
        return record
    }
}

/// 每条流独享一个重组器，按接收顺序喂入。只累积当前记录，不按 chunk 反复复制整份积压。
/// 读到无效前缀后永久拒绝输入：调用方必须关流，不能继续猜边界。
struct TailcatRecordAssembler {
    private var header: UInt32 = 0
    private var headerBytes = 0
    private var expected: Int?
    private var body = Data()
    private var invalid = false

    init() {}

    mutating func push(_ bytes: Data) throws -> [Data] {
        guard !invalid else { throw TailcatFramingError.brokenStream }
        var cursor = bytes.startIndex
        var records: [Data] = []
        while cursor < bytes.endIndex {
            if expected == nil {
                while headerBytes < 4, cursor < bytes.endIndex {
                    header = (header << 8) | UInt32(bytes[cursor])
                    headerBytes += 1
                    cursor += 1
                }
                guard headerBytes == 4 else { break }
                let length = Int(header)
                header = 0
                headerBytes = 0
                guard length > 0, length <= TailcatRecord.maxBytes else {
                    invalid = true
                    body = Data()
                    throw TailcatFramingError.invalidRecordLength(length)
                }
                expected = length
            }
            if let expected {
                let end = min(bytes.endIndex, cursor + expected - body.count)
                body.append(bytes[cursor ..< end])
                cursor = end
                if body.count == expected {
                    records.append(body)
                    body = Data()
                    self.expected = nil
                }
            }
        }
        return records
    }
}
