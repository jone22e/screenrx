import AVFoundation
import CaptureCore
import ScreenCaptureKit

/// Records one display or window to an H.264 MP4.
///
/// ScreenCaptureKit delivers frames stamped with the host clock; each frame
/// is mapped through the session's `RecordingClock` and appended at its
/// recording time, so paused spans never reach the file. The stream keeps
/// running while paused, which makes resuming instantaneous.
final class ScreenRecorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private enum Phase {
        case idle, starting, recording, paused, finishing
    }

    private let log = Log(scope: "capture")
    private let queue = DispatchQueue(label: "com.screenrx.capture.recorder")
    private let onInterrupted: @Sendable (RecordingInterruptedPayload) -> Void

    // Everything below is confined to `queue` (which is also the sample handler queue).
    private var phase = Phase.idle
    private let clock = SessionClock()
    private var source: SourceSelector?
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var outputURL: URL?
    private var encodedSize = PixelSize(width: 0, height: 0)
    private var frameIntervalNs: Int64 = 0
    private var lastWrittenNs: Int64 = 0
    private var lastWrittenTime = CMTime.invalid
    private var framesWritten = 0
    private var framesDropped = 0
    /// Most recent frame seen while paused; written at the resume instant so
    /// the video does not show stale pre-pause content if the screen then stays still.
    private var frameHeldDuringPause: CVPixelBuffer?
    private var firstFrameWaiter: CheckedContinuation<Void, Error>?
    private var startFailure: HelperError?
    private var telemetry: ActiveTelemetry?
    private var companions: CompanionTracks?

    private struct ActiveTelemetry {
        let observer: PointerTelemetry
        let rect: CaptureRect
        let cursorURL: URL
        let interactionsURL: URL
    }

    init(onInterrupted: @escaping @Sendable (RecordingInterruptedPayload) -> Void) {
        self.onInterrupted = onInterrupted
    }

    // MARK: - Commands

    func start(_ params: RecordingStartParams) async throws -> RecordingStartResult {
        try queue.sync {
            guard phase == .idle else {
                throw HelperError(.invalidState, "A recording is already in progress")
            }
            phase = .starting
        }
        do {
            return try await beginCapture(params)
        } catch {
            await abortStart()
            throw Self.helperError(from: error)
        }
    }

    func pause() throws -> RecordingTimeMark {
        try queue.sync {
            guard phase == .recording else {
                throw HelperError(.invalidState, "Cannot pause: not recording")
            }
            let now = HostClock.nowNs()
            try clock.pause(atHostNs: now)
            phase = .paused
            return RecordingTimeMark(
                recordingTimeMs: RecordingClock.milliseconds(clock.elapsedNs(atHostNs: now)))
        }
    }

    func resume() throws -> RecordingTimeMark {
        try queue.sync {
            guard phase == .paused else {
                throw HelperError(.invalidState, "Cannot resume: not paused")
            }
            let now = HostClock.nowNs()
            try clock.resume(atHostNs: now)
            phase = .recording
            let resumeNs = clock.elapsedNs(atHostNs: now)
            if let held = frameHeldDuringPause {
                frameHeldDuringPause = nil
                write(held, atNs: resumeNs)
            }
            return RecordingTimeMark(recordingTimeMs: RecordingClock.milliseconds(resumeNs))
        }
    }

    func stop() async throws -> RecordingStopResult {
        let (stream, endNs, companions) = try queue.sync { () -> (SCStream?, Int64, CompanionTracks?) in
            guard phase == .recording || phase == .paused else {
                throw HelperError(.invalidState, "Cannot stop: not recording")
            }
            phase = .finishing
            return (self.stream, clock.elapsedNs(atHostNs: HostClock.nowNs()), self.companions)
        }
        companions?.seal(atNs: endNs)
        await halt(stream)
        return try await finishWriting(endNs: endNs)
    }

    /// Finalizes whatever is in flight so the process can exit without
    /// leaving a truncated file behind.
    func shutdown() async {
        switch queue.sync(execute: { phase }) {
        case .recording, .paused:
            _ = try? await stop()
        case .starting:
            await abortStart()
        case .idle, .finishing:
            break
        }
    }

    // MARK: - Start

    private func beginCapture(_ params: RecordingStartParams) async throws -> RecordingStartResult {
        guard CaptureDefaults.supportedFrameRates.contains(params.fps) else {
            throw HelperError(.invalidRequest, "Unsupported frame rate \(params.fps)")
        }
        guard Permissions.screenRecordingGranted else {
            throw HelperError(.permissionDenied, "Screen Recording permission has not been granted")
        }
        let url = URL(fileURLWithPath: params.outputPath)
        try Self.validateOutput(url)

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let (filter, excludedPids, captureRect) = try Self.makeFilter(
            for: params.source, content: content, excludePids: params.excludePids)
        let telemetry = try params.telemetry.map { request -> ActiveTelemetry in
            let cursorURL = URL(fileURLWithPath: request.cursorPath)
            let interactionsURL = URL(fileURLWithPath: request.interactionsPath)
            for file in [cursorURL, interactionsURL] {
                guard !FileManager.default.fileExists(atPath: file.path) else {
                    throw HelperError(.outputUnavailable, "Output file already exists: \(file.path)")
                }
            }
            return ActiveTelemetry(
                observer: PointerTelemetry(ignoredPids: params.excludePids), rect: captureRect,
                cursorURL: cursorURL, interactionsURL: interactionsURL)
        }

        let companions = try CompanionTracks(params: params, clock: clock)

        let scale = Double(filter.pointPixelScale)
        let sourceSize = PixelSize(
            width: Int((filter.contentRect.width * scale).rounded()),
            height: Int((filter.contentRect.height * scale).rounded()))
        let size = VideoGeometry.encodedSize(forSource: sourceSize)
        let bitrate = VideoGeometry.videoBitrate(for: size, fps: params.fps)

        let configuration = SCStreamConfiguration()
        configuration.width = size.width
        configuration.height = size.height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(params.fps))
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.colorSpaceName = CGColorSpace.sRGB
        configuration.showsCursor = params.showCursor
        configuration.queueDepth = CaptureDefaults.streamQueueDepth
        configuration.scalesToFit = true
        companions.configure(configuration)

        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: Self.videoSettings(size: size, fps: params.fps, bitrate: bitrate))
        input.expectsMediaDataInRealTime = true
        input.mediaTimeScale = CaptureDefaults.mediaTimeScale
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input, sourcePixelBufferAttributes: nil)
        guard writer.canAdd(input) else {
            throw HelperError(.writerFailed, "The encoder rejected the video settings (\(size.width)x\(size.height))")
        }
        writer.add(input)

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try companions.attach(to: stream)

        guard writer.startWriting() else {
            throw Self.writerError(writer.error)
        }
        queue.sync {
            self.source = params.source
            self.stream = stream
            self.writer = writer
            self.videoInput = input
            self.adaptor = adaptor
            self.outputURL = url
            self.encodedSize = size
            self.frameIntervalNs = 1_000_000_000 / Int64(params.fps)
            self.telemetry = telemetry
            self.companions = companions
        }

        // Devices start now so they are already delivering when the first screen
        // frame defines t=0; anything stamped earlier is dropped by the clock.
        companions.start()
        // Observe the pointer from before the first frame, so telemetry covers t=0.
        if let telemetry, let request = params.telemetry {
            telemetry.observer.start(sampleRateHz: request.sampleRateHz)
        }
        launch(stream)
        try await waitForFirstFrame()

        log.info(
            "recording started",
            [
                "size": "\(size.width)x\(size.height)",
                "fps": "\(params.fps)",
                "bitrate": "\(bitrate)",
                "excludedPids": excludedPids.map(String.init).joined(separator: ","),
            ])
        return RecordingStartResult(
            widthPx: size.width, heightPx: size.height, fps: params.fps, videoBitrate: bitrate,
            excludedPids: excludedPids)
    }

    private static func validateOutput(_ url: URL) throws {
        let fileManager = FileManager.default
        var isDirectory: ObjCBool = false
        let parent = url.deletingLastPathComponent().path
        guard url.pathExtension == "mp4",
            fileManager.fileExists(atPath: parent, isDirectory: &isDirectory), isDirectory.boolValue
        else {
            throw HelperError(.outputUnavailable, "Output directory does not exist: \(parent)")
        }
        // Recorded assets are immutable: never write over an existing file.
        guard !fileManager.fileExists(atPath: url.path) else {
            throw HelperError(.outputUnavailable, "Output file already exists: \(url.path)")
        }
    }

    private static func makeFilter(
        for source: SourceSelector, content: SCShareableContent, excludePids: [Int32]
    ) throws -> (SCContentFilter, [Int32], CaptureRect) {
        switch source {
        case .display(let displayId):
            guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
                throw HelperError(.sourceUnavailable, "Display \(displayId) is no longer available")
            }
            // Excluding by application (rather than by window) also covers
            // windows the recorder opens after the capture has started.
            let pids = Set(excludePids)
            let excluded = content.applications.filter { pids.contains($0.processID) }
            let filter = SCContentFilter(
                display: display, excludingApplications: excluded, exceptingWindows: [])
            return (filter, excluded.map(\.processID), Self.captureRect(display.frame))
        case .window(let windowId):
            guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
                throw HelperError(.sourceUnavailable, "Window \(windowId) is no longer available")
            }
            // Captures only this window's content, even when it is covered by others.
            // Telemetry is normalized to where the window was when recording began.
            return (SCContentFilter(desktopIndependentWindow: window), [], Self.captureRect(window.frame))
        }
    }

    private static func captureRect(_ frame: CGRect) -> CaptureRect {
        CaptureRect(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height)
    }

    private static func videoSettings(size: PixelSize, fps: Int, bitrate: Int) -> [String: Any] {
        [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: size.width,
            AVVideoHeightKey: size.height,
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoMaxKeyFrameIntervalDurationKey: CaptureDefaults.keyFrameIntervalSeconds,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoAllowFrameReorderingKey: false,
            ] as [String: Any],
        ]
    }

    /// Starts the stream without awaiting its completion: ScreenCaptureKit
    /// never calls it when the stream is torn down mid-start, which would hang
    /// the request forever. The first complete frame is the success signal.
    private func launch(_ stream: SCStream) {
        stream.startCapture { [weak self] error in
            guard let self, let error else { return }
            self.queue.async { self.failStartup(Self.helperError(from: error)) }
        }
    }

    private func waitForFirstFrame() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                if let failure = self.startFailure {
                    continuation.resume(throwing: failure)
                    return
                }
                if self.clock.isStarted {
                    continuation.resume()
                    return
                }
                self.firstFrameWaiter = continuation
                self.queue.asyncAfter(deadline: .now() + CaptureDefaults.firstFrameTimeoutSeconds) {
                    self.failStartup(HelperError(.noFrames, "The source produced no frames"))
                }
            }
        }
    }

    private func resolveFirstFrame(_ result: Result<Void, Error>) {
        guard let waiter = firstFrameWaiter else { return }
        firstFrameWaiter = nil
        waiter.resume(with: result)
    }

    /// Records why the capture could not start and wakes up `start`, whether
    /// it is already waiting for the first frame or about to. Must be called on `queue`.
    private func failStartup(_ error: HelperError) {
        guard phase == .starting, startFailure == nil else { return }
        startFailure = error
        resolveFirstFrame(.failure(error))
    }

    private func abortStart() async {
        let (stream, writer, url, telemetry, companions) = queue.sync {
            (self.stream, self.writer, self.outputURL, self.telemetry, self.companions)
        }
        _ = telemetry?.observer.stop()
        companions?.cancel()
        await halt(stream)
        if writer?.status == .writing {
            writer?.cancelWriting()
        }
        if let url {
            try? FileManager.default.removeItem(at: url)
        }
        queue.sync { reset() }
    }

    // MARK: - Frames

    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen, sampleBuffer.isValid, Self.isCompleteFrame(sampleBuffer),
            let pixelBuffer = sampleBuffer.imageBuffer
        else { return }
        let hostNs = sampleBuffer.presentationTimeStamp.nanoseconds

        switch phase {
        case .starting:
            // The first complete frame defines t=0 of the recording.
            guard let writer, (try? clock.start(atHostNs: hostNs)) != nil else { return }
            writer.startSession(atSourceTime: .zero)
            phase = .recording
            write(pixelBuffer, atNs: 0)
            resolveFirstFrame(.success(()))
        case .recording, .paused:
            if let timeNs = clock.recordingTimeNs(atHostNs: hostNs) {
                write(pixelBuffer, atNs: timeNs)
            } else if clock.isPaused {
                frameHeldDuringPause = pixelBuffer
            }
        case .idle, .finishing:
            break
        }
    }

    private static func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let rawStatus = attachments.first?[.status] as? Int,
            let status = SCFrameStatus(rawValue: rawStatus)
        else { return false }
        return status == .complete
    }

    private func write(_ pixelBuffer: CVPixelBuffer, atNs timeNs: Int64) {
        guard let writer, let videoInput, let adaptor else { return }
        let time = CMTime.fromNanoseconds(timeNs, timescale: CaptureDefaults.mediaTimeScale)
        // Presentation times must be strictly increasing.
        if lastWrittenTime.isValid, time <= lastWrittenTime { return }
        guard writer.status == .writing else {
            failRecording(Self.writerError(writer.error))
            return
        }
        guard videoInput.isReadyForMoreMediaData else {
            framesDropped += 1
            return
        }
        guard adaptor.append(pixelBuffer, withPresentationTime: time) else {
            failRecording(Self.writerError(writer.error))
            return
        }
        lastWrittenNs = timeNs
        lastWrittenTime = time
        framesWritten += 1
    }

    // MARK: - Finishing

    /// Stops the stream, waiting only a bounded time: ScreenCaptureKit does
    /// not always complete the call once the stream's connection is gone, and
    /// finishing the file must not depend on it.
    private func halt(_ stream: SCStream?) async {
        guard let stream else { return }
        let log = self.log
        await withDeadline(seconds: CaptureDefaults.stopStreamTimeoutSeconds) {
            do {
                try await stream.stopCapture()
            } catch {
                // Typical when the system already stopped the stream itself.
                log.info("stopCapture reported an error", ["error": error.localizedDescription])
            }
        }
    }

    private func finishWriting(endNs: Int64) async throws -> RecordingStopResult {
        let state = queue.sync { () -> FinishState? in
            frameHeldDuringPause = nil
            guard let writer, let videoInput, let outputURL else { return nil }
            return FinishState(
                writer: writer, input: videoInput, url: outputURL, size: encodedSize,
                // The last frame stays on screen until the recording ends.
                endNs: max(endNs, lastWrittenNs + frameIntervalNs),
                framesWritten: framesWritten, framesDropped: framesDropped,
                clock: clock.snapshot(), telemetry: telemetry, companions: companions)
        }
        // Stop observing the pointer whatever happens to the file next.
        let observed = state?.telemetry?.observer.stop()
        defer { queue.sync { reset() } }
        guard let state else {
            throw HelperError(.invalidState, "No recording to finish")
        }

        guard state.writer.status == .writing, state.framesWritten > 0 else {
            let error = state.writer.error
            state.companions?.cancel()
            state.writer.cancelWriting()
            try? FileManager.default.removeItem(at: state.url)
            throw error.map(Self.writerError) ?? HelperError(.noFrames, "No frames were recorded")
        }

        state.input.markAsFinished()
        state.writer.endSession(
            atSourceTime: .fromNanoseconds(state.endNs, timescale: CaptureDefaults.mediaTimeScale))
        await state.writer.finishWriting()
        guard state.writer.status == .completed else {
            state.companions?.cancel()
            try? FileManager.default.removeItem(at: state.url)
            throw Self.writerError(state.writer.error)
        }

        let attributes = try? FileManager.default.attributesOfItem(atPath: state.url.path)
        let fileSize = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
        // Read the duration back from the file as an independent check of what was written.
        let mediaDuration = (try? await AVURLAsset(url: state.url).load(.duration)) ?? .invalid
        let mediaDurationMs = mediaDuration.isNumeric ? mediaDuration.seconds * 1000 : 0

        var telemetryResult: TelemetryResult?
        if let telemetry = state.telemetry, let observed {
            telemetryResult = writeTelemetry(telemetry, observed: observed, clock: state.clock, endNs: state.endNs)
        }

        // A companion track that failed costs that track, never the recording.
        let tracks = await state.companions?.finish(endNs: state.endNs)
        func trackResult(_ outcome: TrackOutcome?) -> TrackResult? {
            outcome.map {
                TrackResult(
                    durationMs: $0.durationMs, fileSizeBytes: $0.fileSizeBytes, widthPx: $0.size?.width,
                    heightPx: $0.size?.height)
            }
        }

        let result = RecordingStopResult(
            outputPath: state.url.path,
            durationMs: RecordingClock.milliseconds(state.endNs),
            mediaDurationMs: mediaDurationMs,
            fileSizeBytes: fileSize,
            widthPx: state.size.width,
            heightPx: state.size.height,
            framesWritten: state.framesWritten,
            framesDropped: state.framesDropped,
            pauses: state.clock.pauseMarkers(),
            telemetry: telemetryResult,
            microphone: trackResult(tracks?.microphone),
            systemAudio: trackResult(tracks?.systemAudio),
            webcam: trackResult(tracks?.webcam))
        log.info(
            "recording finished",
            [
                "durationMs": String(format: "%.1f", result.durationMs),
                "mediaDurationMs": String(format: "%.1f", result.mediaDurationMs),
                "frames": "\(result.framesWritten)",
                "dropped": "\(result.framesDropped)",
                "bytes": "\(result.fileSizeBytes)",
            ])
        return result
    }

    private struct FinishState {
        let writer: AVAssetWriter
        let input: AVAssetWriterInput
        let url: URL
        let size: PixelSize
        let endNs: Int64
        let framesWritten: Int
        let framesDropped: Int
        let clock: RecordingClock
        let telemetry: ActiveTelemetry?
        let companions: CompanionTracks?
    }

    /// Maps the raw pointer observations onto the recording clock and writes
    /// `cursor.json` and `interactions.json`. A failure here costs the
    /// telemetry, never the recording.
    private func writeTelemetry(
        _ telemetry: ActiveTelemetry,
        observed: (samples: [RawPointerSample], events: [RawPointerEvent]),
        clock: RecordingClock, endNs: Int64
    ) -> TelemetryResult? {
        let cursor = TelemetryBuilder.cursorSamples(
            observed.samples, clock: clock, rect: telemetry.rect, endNs: endNs)
        let interactions = TelemetryBuilder.interactions(
            observed.events, clock: clock, rect: telemetry.rect, endNs: endNs)
        do {
            let encoder = JSONEncoder()
            try encoder.encode(cursor).write(to: telemetry.cursorURL, options: .withoutOverwriting)
            try encoder.encode(interactions).write(to: telemetry.interactionsURL, options: .withoutOverwriting)
        } catch {
            log.error("could not write telemetry", ["error": error.localizedDescription])
            return nil
        }
        Log(scope: "cursor").info(
            "telemetry written", ["samples": "\(cursor.count)", "interactions": "\(interactions.count)"])
        return TelemetryResult(cursorSamples: cursor.count, interactions: interactions.count)
    }

    /// Must be called on `queue`.
    private func reset() {
        phase = .idle
        clock.reset()
        source = nil
        companions = nil
        stream = nil
        writer = nil
        videoInput = nil
        adaptor = nil
        outputURL = nil
        encodedSize = PixelSize(width: 0, height: 0)
        frameIntervalNs = 0
        lastWrittenNs = 0
        lastWrittenTime = .invalid
        framesWritten = 0
        framesDropped = 0
        frameHeldDuringPause = nil
        startFailure = nil
        telemetry = nil
    }

    // MARK: - Failures

    /// The writer broke mid-recording (typically a full disk): the file
    /// cannot be completed, so it is discarded. Must be called on `queue`.
    private func failRecording(_ error: HelperError) {
        switch phase {
        case .starting:
            failStartup(error)
        case .recording, .paused:
            phase = .finishing
            log.error("recording failed", ["code": error.code.rawValue, "message": error.message])
            let stream = self.stream
            let writer = self.writer
            let url = self.outputURL
            _ = telemetry?.observer.stop()
            companions?.cancel()
            Task {
                await self.halt(stream)
                writer?.cancelWriting()
                if let url {
                    try? FileManager.default.removeItem(at: url)
                }
                self.queue.sync { self.reset() }
                self.onInterrupted(RecordingInterruptedPayload(error: error, result: nil))
            }
        case .idle, .finishing:
            break
        }
    }

    /// ScreenCaptureKit ended the stream on its own: the window was closed,
    /// the display went away, or the user stopped sharing from the menu bar.
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let nsError = error as NSError
        log.warn(
            "stream stopped by the system",
            ["domain": nsError.domain, "code": "\(nsError.code)", "message": nsError.localizedDescription])
        queue.async {
            let streamError = Self.helperError(from: error)
            switch self.phase {
            case .starting:
                self.failStartup(streamError)
            case .recording, .paused:
                self.phase = .finishing
                let endNs = self.clock.elapsedNs(atHostNs: HostClock.nowNs())
                self.companions?.seal(atNs: endNs)
                let source = self.source
                Task {
                    let reason = await Self.refine(streamError, source: source)
                    self.log.warn(
                        "capture interrupted", ["code": reason.code.rawValue, "message": reason.message])
                    // Keep what was recorded up to the interruption.
                    let result = try? await self.finishWriting(endNs: endNs)
                    self.onInterrupted(RecordingInterruptedPayload(error: reason, result: result))
                }
            case .idle, .finishing:
                break
            }
        }
    }

    /// Distinguishes "the source disappeared" from other stream failures.
    private static func refine(_ error: HelperError, source: SourceSelector?) async -> HelperError {
        guard error.code == .captureFailed, let source,
            let content = try? await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
        else { return error }
        let stillExists: Bool
        switch source {
        case .display(let displayId):
            stillExists = content.displays.contains { $0.displayID == displayId }
        case .window(let windowId):
            stillExists = content.windows.contains { $0.windowID == windowId }
        }
        return stillExists ? error : HelperError(.sourceUnavailable, "The recorded source is no longer available")
    }

    private static func helperError(from error: Error) -> HelperError {
        if let helperError = error as? HelperError {
            return helperError
        }
        let nsError = error as NSError
        if nsError.domain == SCStreamErrorDomain {
            switch SCStreamError.Code(rawValue: nsError.code) {
            case .userDeclined:
                return HelperError(.permissionDenied, "Screen Recording permission has not been granted")
            case .userStopped:
                return HelperError(.stoppedBySystem, "The capture was stopped from the system UI")
            default:
                break
            }
        }
        return HelperError(
            .captureFailed, "\(nsError.localizedDescription) (\(nsError.domain) \(nsError.code))")
    }

    private static func writerError(_ error: Error?) -> HelperError {
        guard let error else {
            return HelperError(.writerFailed, "The video writer failed")
        }
        let message = error.localizedDescription
        return isDiskFull(error as NSError)
            ? HelperError(.diskFull, message)
            : HelperError(.writerFailed, message)
    }

    private static func isDiskFull(_ error: NSError) -> Bool {
        let matches =
            (error.domain == AVFoundationErrorDomain && error.code == AVError.Code.diskFull.rawValue)
            || (error.domain == NSPOSIXErrorDomain && error.code == Int(ENOSPC))
            || (error.domain == NSCocoaErrorDomain && error.code == NSFileWriteOutOfSpaceError)
        if matches { return true }
        guard let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError else { return false }
        return isDiskFull(underlying)
    }
}
