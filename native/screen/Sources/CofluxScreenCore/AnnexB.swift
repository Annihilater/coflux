import Foundation

/// H.264 byte-stream shaping: VideoToolbox emits AVCC (length-prefixed NAL units) and keeps the
/// parameter sets in the format description; the wire carries Annex B with SPS/PPS in band on
/// every keyframe so the decoder configures from the stream alone.
public enum AnnexB {
    public static let startCode = Data([0, 0, 0, 1])

    /// Convert AVCC NAL units with `lengthSize`-byte big-endian prefixes into Annex B.
    public static func fromAVCC(_ avcc: Data, lengthSize: Int) -> Data {
        var out = Data(capacity: avcc.count + 16)
        var offset = 0
        let bytes = [UInt8](avcc)
        while offset + lengthSize <= bytes.count {
            var length = 0
            for index in 0..<lengthSize {
                length = (length << 8) | Int(bytes[offset + index])
            }
            offset += lengthSize
            guard length > 0, offset + length <= bytes.count else { break }
            out.append(startCode)
            out.append(contentsOf: bytes[offset..<(offset + length)])
            offset += length
        }
        return out
    }

    /// Prefix parameter sets (each already a raw NAL unit) as Annex B.
    public static func parameterSets(_ sets: [Data]) -> Data {
        var out = Data()
        for set in sets {
            out.append(startCode)
            out.append(set)
        }
        return out
    }

    /// Split an encoded frame into chunks of at most `chunkBytes`; the last one is flagged.
    public static func chunks(_ frame: Data, chunkBytes: Int) -> [(data: Data, last: Bool)] {
        guard chunkBytes > 0 else { return [(frame, true)] }
        if frame.isEmpty { return [(frame, true)] }
        var out: [(Data, Bool)] = []
        var offset = 0
        while offset < frame.count {
            let end = min(frame.count, offset + chunkBytes)
            out.append((frame.subdata(in: offset..<end), end == frame.count))
            offset = end
        }
        return out
    }
}
