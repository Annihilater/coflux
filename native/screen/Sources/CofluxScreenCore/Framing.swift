import Foundation

/// The worker ⟷ helper socket framing: `length:u32 BE || ScreenHelperFrame`, the same record
/// layout as the worker's other local sockets (`coflux_protocol::write_record`).
public enum Framing {
    /// Largest record accepted or produced; matches the worker's `MAX_IPC_RECORD_BYTES` closely
    /// enough (30 MiB device frames plus headroom).
    public static let maxRecordBytes = 30 * 1024 * 1024 + 4096

    public enum Error: Swift.Error, Equatable {
        case recordTooLarge(Int)
    }

    public static func encode(_ payload: Data) throws -> Data {
        guard payload.count <= maxRecordBytes else { throw Error.recordTooLarge(payload.count) }
        var out = Data(capacity: 4 + payload.count)
        var length = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
        out.append(payload)
        return out
    }
}

/// Accumulating record parser: feed any byte chunks, get whole records back in order.
public struct RecordParser {
    private var buffer = Data()

    public init() {}

    public mutating func push(_ chunk: Data) throws -> [Data] {
        buffer.append(chunk)
        var records: [Data] = []
        var position = 0
        while buffer.count - position >= 4 {
            let length = buffer.withUnsafeBytes { raw -> Int in
                let base = raw.baseAddress!.advanced(by: position)
                return Int(UInt32(bigEndian: base.loadUnaligned(as: UInt32.self)))
            }
            if length > Framing.maxRecordBytes {
                buffer.removeAll()
                throw Framing.Error.recordTooLarge(length)
            }
            if buffer.count - position < 4 + length { break }
            records.append(buffer.subdata(in: (position + 4)..<(position + 4 + length)))
            position += 4 + length
        }
        if position > 0 { buffer.removeSubrange(0..<position) }
        return records
    }
}
