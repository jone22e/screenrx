import AVFoundation
import CaptureCore

struct TrackOutcome {
    let durationMs: Double
    let fileSizeBytes: Int64
    let size: PixelSize?
    let samplesDropped: Int
}

/// Writes one companion track of a session — an audio track (`.m4a`, AAC) or
/// the webcam (`.mp4`, H.264) — from live sample buffers.
///
/// Every buffer is placed at its *recording time*: its host-clock timestamp
/// mapped through the shared `SessionClock`. Buffers stamped before the
/// recording began or inside a pause are dropped, so the track lines up with
/// the screen track without any later correction.
final class MediaTrackWriter: @unchecked Sendable {
    enum Kind {
        case audio
        case video(fps: Int)
    }

    /// Capture callbacks must be delivered on this queue.
    let queue: DispatchQueue

    private let url: URL
    private let kind: Kind
    private let clock: SessionClock
    private let label: String
    private let log = Log(scope: "capture")

    // Confined to `queue`.
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var nextAudioTime = CMTime.invalid
    private var lastVideoTime = CMTime.invalid
    private var lastEnd = CMTime.zero
    private var videoSize: PixelSize?
    private var samplesDropped = 0
    private var closed = false
    /// Recording time at which the session ended; later buffers are not part of it.
    private var endLimitNs = Int64.max

    init(url: URL, kind: Kind, clock: SessionClock, label: String) throws {
        // Recorded assets are immutable: never write over an existing file.
        guard !FileManager.default.fileExists(atPath: url.path) else {
            throw HelperError(.outputUnavailable, "Output file already exists: \(url.path)")
        }
        self.url = url
        self.kind = kind
        self.clock = clock
        self.label = label
        self.queue = DispatchQueue(label: "com.screenrx.capture.track.\(label)")
    }

    /// Must be called on `queue`. `hostTime` is the buffer's timestamp on the host clock.
    func append(_ sampleBuffer: CMSampleBuffer, hostTime: CMTime) {
        guard !closed, sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer),
            let timeNs = clock.recordingTimeNs(atHostNs: hostTime.nanoseconds), timeNs < endLimitNs
        else { return }

        if writer == nil, !open(for: sampleBuffer) {
            closed = true
            return
        }
        guard let writer, let input, writer.status == .writing else {
            fail("writer stopped: \(writer?.error?.localizedDescription ?? "unknown")")
            return
        }

        var time = CMTime(value: timeNs, timescale: 1_000_000_000)
        switch kind {
        case .audio:
            // Dropping whole buffers at a pause can make the next one start a
            // few milliseconds "early"; audio must never overlap, so it is
            // nudged to continue exactly where the previous buffer ended.
            if nextAudioTime.isValid, time < nextAudioTime { time = nextAudioTime }
        case .video:
            if lastVideoTime.isValid, time <= lastVideoTime { return }
        }
        guard input.isReadyForMoreMediaData else {
            samplesDropped += 1
            return
        }
        guard let retimed = Self.retimed(sampleBuffer, to: time) else { return }
        guard input.append(retimed) else {
            fail("append failed: \(writer.error?.localizedDescription ?? "unknown")")
            return
        }

        let duration = sampleBuffer.duration.isNumeric ? sampleBuffer.duration : .zero
        nextAudioTime = time + duration
        lastVideoTime = time
        lastEnd = time + duration
    }

    /// Marks where the recording ended. Devices keep delivering for a moment
    /// after a stop is requested; anything stamped later is left out, so the
    /// track ends where the screen track does.
    func seal(atNs endNs: Int64) {
        queue.async { self.endLimitNs = min(self.endLimitNs, endNs) }
    }

    /// Finalizes the file. Returns `nil` when the track ended up with no media.
    func finish(endNs: Int64) async -> TrackOutcome? {
        let state = queue.sync { () -> (AVAssetWriter, AVAssetWriterInput, CMTime, PixelSize?, Int)? in
            closed = true
            guard let writer, let input, writer.status == .writing else { return nil }
            return (writer, input, lastEnd, videoSize, samplesDropped)
        }
        guard let (writer, input, lastEnd, size, dropped) = state else {
            discard()
            return nil
        }

        input.markAsFinished()
        writer.endSession(atSourceTime: max(lastEnd, CMTime(value: endNs, timescale: 1_000_000_000)))
        await writer.finishWriting()
        guard writer.status == .completed else {
            log.error("\(label) track could not be finalized", ["error": writer.error?.localizedDescription ?? ""])
            discard()
            return nil
        }

        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        let duration = (try? await AVURLAsset(url: url).load(.duration)) ?? .invalid
        return TrackOutcome(
            durationMs: duration.isNumeric ? duration.seconds * 1000 : 0,
            fileSizeBytes: (attributes?[.size] as? NSNumber)?.int64Value ?? 0,
            size: size,
            samplesDropped: dropped)
    }

    /// Abandons the track and removes whatever was written.
    func cancel() {
        queue.sync { closed = true }
        discard()
    }

    private func discard() {
        let writer = queue.sync { self.writer }
        if writer?.status == .writing { writer?.cancelWriting() }
        try? FileManager.default.removeItem(at: url)
    }

    /// Must be called on `queue`.
    private func fail(_ reason: String) {
        guard !closed else { return }
        closed = true
        log.error("\(label) track failed", ["reason": reason])
    }

    /// Creates the writer from the format of the first buffer. Must be called on `queue`.
    private func open(for sampleBuffer: CMSampleBuffer) -> Bool {
        guard let format = sampleBuffer.formatDescription else { return false }
        let fileType: AVFileType
        let mediaType: AVMediaType
        let settings: [String: Any]

        switch kind {
        case .audio:
            guard let description = format.audioStreamBasicDescription else { return false }
            let channels = AudioEncoding.channels(forSource: Int(description.mChannelsPerFrame))
            fileType = .m4a
            mediaType = .audio
            // The writer resamples when the device's rate is not the one written.
            settings = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: AudioEncoding.sampleRate(forSource: description.mSampleRate),
                AVNumberOfChannelsKey: channels,
                AVEncoderBitRateKey: AudioEncoding.bitrate(channels: channels),
            ]
        case .video(let fps):
            let dimensions = CMVideoFormatDescriptionGetDimensions(format)
            let size = VideoGeometry.encodedSize(
                forSource: PixelSize(width: Int(dimensions.width), height: Int(dimensions.height)))
            videoSize = size
            fileType = .mp4
            mediaType = .video
            settings = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: size.width,
                AVVideoHeightKey: size.height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: VideoGeometry.videoBitrate(for: size, fps: fps),
                    AVVideoExpectedSourceFrameRateKey: fps,
                    AVVideoMaxKeyFrameIntervalDurationKey: CaptureDefaults.keyFrameIntervalSeconds,
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                    AVVideoAllowFrameReorderingKey: false,
                ] as [String: Any],
            ]
        }

        do {
            let writer = try AVAssetWriter(outputURL: url, fileType: fileType)
            let input = AVAssetWriterInput(mediaType: mediaType, outputSettings: settings, sourceFormatHint: format)
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else {
                log.error("\(label) track settings rejected")
                return false
            }
            writer.add(input)
            guard writer.startWriting() else {
                log.error("\(label) track could not start", ["error": writer.error?.localizedDescription ?? ""])
                return false
            }
            // Every track of a session shares the same zero.
            writer.startSession(atSourceTime: .zero)
            self.writer = writer
            self.input = input
            return true
        } catch {
            log.error("\(label) track could not be created", ["error": error.localizedDescription])
            return false
        }
    }

    /// A copy of the buffer whose first sample is presented at `time`.
    private static func retimed(_ sampleBuffer: CMSampleBuffer, to time: CMTime) -> CMSampleBuffer? {
        var count: CMItemCount = 0
        CMSampleBufferGetSampleTimingInfoArray(
            sampleBuffer, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count)
        guard count > 0 else { return nil }
        var timing = [CMSampleTimingInfo](repeating: .invalid, count: count)
        CMSampleBufferGetSampleTimingInfoArray(
            sampleBuffer, entryCount: count, arrayToFill: &timing, entriesNeededOut: &count)

        let shift = time - sampleBuffer.presentationTimeStamp
        for index in timing.indices {
            timing[index].presentationTimeStamp = timing[index].presentationTimeStamp + shift
            timing[index].decodeTimeStamp = .invalid
        }
        var copy: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault, sampleBuffer: sampleBuffer, sampleTimingEntryCount: count,
            sampleTimingArray: &timing, sampleBufferOut: &copy)
        return copy
    }
}
