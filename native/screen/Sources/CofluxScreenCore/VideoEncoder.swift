import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// VideoToolbox hardware H.264: High profile, no B-frames, real-time, low-latency rate control.
/// Output is Annex B with SPS/PPS in band on keyframes (see `AnnexB`). Outputs arrive on the
/// main queue in presentation order.
public final class VideoEncoder {
    public struct Output {
        public var data: Data
        public var keyframe: Bool
        public var ptsMicros: UInt64
        public var width: Int
        public var height: Int
    }

    public var onOutput: ((Output) -> Void)?
    public let width: Int
    public let height: Int
    private var session: VTCompressionSession?
    private var bitrate: Int

    public init(width: Int, height: Int, bitrate: Int) throws {
        self.width = width
        self.height = height
        self.bitrate = bitrate
        let specification: [CFString: Any] = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue!,
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: kCFBooleanTrue!,
        ]
        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: specification as CFDictionary,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &session
        )
        guard status == noErr, let session else {
            throw HelperError.encoder("VTCompressionSessionCreate failed (\(status))")
        }
        self.session = session
        set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue!)
        set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel)
        set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse!)
        set(kVTCompressionPropertyKey_H264EntropyMode, kVTH264EntropyMode_CABAC)
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, 3600 as CFNumber)
        set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 60 as CFNumber)
        set(kVTCompressionPropertyKey_ExpectedFrameRate, 60 as CFNumber)
        set(kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, kCFBooleanTrue!)
        applyBitrate()
        VTCompressionSessionPrepareToEncodeFrames(session)
    }

    deinit {
        invalidate()
    }

    public func invalidate() {
        guard let session else { return }
        VTCompressionSessionInvalidate(session)
        self.session = nil
    }

    public func setBitrate(_ bitsPerSecond: Int) {
        guard bitsPerSecond != bitrate else { return }
        bitrate = bitsPerSecond
        applyBitrate()
    }

    private func applyBitrate() {
        set(kVTCompressionPropertyKey_AverageBitRate, bitrate as CFNumber)
        // Hard cap per second at 1.5× the average so a busy frame cannot burst past the credit window.
        let limits: [Any] = [Double(bitrate) / 8 * 1.5, 1.0]
        set(kVTCompressionPropertyKey_DataRateLimits, limits as CFArray)
    }

    private func set(_ key: CFString, _ value: CFTypeRef) {
        guard let session else { return }
        VTSessionSetProperty(session, key: key, value: value)
    }

    /// Encode one captured frame. The output handler runs on VideoToolbox's thread and is
    /// re-dispatched to the main queue.
    public func encode(_ sample: CMSampleBuffer, forceKeyframe: Bool) {
        guard let session, let image = CMSampleBufferGetImageBuffer(sample) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let properties: CFDictionary? = forceKeyframe
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as CFDictionary
            : nil
        let width = self.width
        let height = self.height
        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: image,
            presentationTimeStamp: pts,
            duration: .invalid,
            frameProperties: properties,
            infoFlagsOut: nil
        ) { [weak self] status, _, encoded in
            guard status == noErr, let encoded, let output = VideoEncoder.shape(encoded, width: width, height: height) else { return }
            DispatchQueue.main.async { self?.onOutput?(output) }
        }
    }

    /// AVCC sample → Annex B frame with parameter sets on keyframes.
    static func shape(_ sample: CMSampleBuffer, width: Int, height: Int) -> Output? {
        guard let block = CMSampleBufferGetDataBuffer(sample),
              let format = CMSampleBufferGetFormatDescription(sample)
        else { return nil }
        var keyframe = true
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]],
           let notSync = attachments.first?[kCMSampleAttachmentKey_NotSync as String] as? Bool {
            keyframe = !notSync
        }
        var nalLength: Int32 = 4
        var parameterSets: [Data] = []
        if keyframe {
            var count = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: &nalLength)
            for index in 0..<count {
                var pointer: UnsafePointer<UInt8>?
                var size = 0
                let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
                guard status == noErr, let pointer else { return nil }
                parameterSets.append(Data(bytes: pointer, count: size))
            }
        } else {
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: nil, nalUnitHeaderLengthOut: &nalLength)
        }
        let length = CMBlockBufferGetDataLength(block)
        var avcc = Data(count: length)
        let copied = avcc.withUnsafeMutableBytes { raw -> OSStatus in
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
        }
        guard copied == noErr else { return nil }
        var frame = keyframe ? AnnexB.parameterSets(parameterSets) : Data()
        frame.append(AnnexB.fromAVCC(avcc, lengthSize: Int(nalLength)))
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let micros = pts.isNumeric ? UInt64(max(0, pts.seconds * 1_000_000)) : 0
        return Output(data: frame, keyframe: keyframe, ptsMicros: micros, width: width, height: height)
    }
}
