import AVFoundation
import CaptureCore
import ScreenCaptureKit

/// Feeds the audio ScreenCaptureKit captures from the system into its track.
final class SystemAudioOutput: NSObject, SCStreamOutput {
    let writer: MediaTrackWriter

    init(writer: MediaTrackWriter) {
        self.writer = writer
    }

    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType
    ) {
        guard type == .audio else { return }
        writer.append(sampleBuffer, hostTime: sampleBuffer.presentationTimeStamp)
    }
}

/// The tracks recorded alongside the screen: microphone, system audio and
/// webcam. Each goes to its own file, so the editor can later mix, move or
/// drop them independently — nothing is burned into the screen track.
final class CompanionTracks: @unchecked Sendable {
    private var microphone: (capture: DeviceCapture, writer: MediaTrackWriter)?
    private var webcam: (capture: DeviceCapture, writer: MediaTrackWriter)?
    private var systemAudio: SystemAudioOutput?

    /// Validates permissions, devices and output files up front, so a
    /// recording never starts only to discover a track cannot be captured.
    init(params: RecordingStartParams, clock: SessionClock) throws {
        if let request = params.microphone {
            guard Devices.access(to: .audio) == .granted else {
                throw HelperError(.microphonePermissionDenied, "Microphone access has not been granted")
            }
            guard let device = Devices.find(id: request.deviceId, mediaType: .audio) else {
                throw HelperError(.deviceUnavailable, "The selected microphone is not available")
            }
            let writer = try MediaTrackWriter(
                url: URL(fileURLWithPath: request.outputPath), kind: .audio, clock: clock, label: "microphone")
            microphone = (try DeviceCapture(device: device, writer: writer), writer)
        }
        if let request = params.webcam {
            guard Devices.access(to: .video) == .granted else {
                throw HelperError(.cameraPermissionDenied, "Camera access has not been granted")
            }
            guard let device = Devices.find(id: request.deviceId, mediaType: .video) else {
                throw HelperError(.deviceUnavailable, "The selected camera is not available")
            }
            let writer = try MediaTrackWriter(
                url: URL(fileURLWithPath: request.outputPath), kind: .video(fps: request.fps), clock: clock,
                label: "webcam")
            webcam = (try DeviceCapture(device: device, writer: writer), writer)
        }
        if let request = params.systemAudio {
            let writer = try MediaTrackWriter(
                url: URL(fileURLWithPath: request.outputPath), kind: .audio, clock: clock, label: "system-audio")
            systemAudio = SystemAudioOutput(writer: writer)
        }
    }

    /// System audio is captured by the screen stream itself.
    func configure(_ configuration: SCStreamConfiguration) {
        configuration.capturesAudio = systemAudio != nil
        guard systemAudio != nil else { return }
        configuration.sampleRate = Int(CaptureDefaults.audioSampleRate)
        configuration.channelCount = 2
        // The recorder's own sounds are never part of the recording.
        configuration.excludesCurrentProcessAudio = true
    }

    func attach(to stream: SCStream) throws {
        guard let systemAudio else { return }
        try stream.addStreamOutput(systemAudio, type: .audio, sampleHandlerQueue: systemAudio.writer.queue)
    }

    func start() {
        microphone?.capture.start()
        webcam?.capture.start()
    }

    /// Fixes the instant the recording ended for every companion track.
    /// Whether any of the tracks is audio, which arrives later than it is heard.
    var recordsAudio: Bool { microphone != nil || systemAudio != nil }

    func seal(atNs endNs: Int64) {
        microphone?.writer.seal(atNs: endNs)
        webcam?.writer.seal(atNs: endNs)
        systemAudio?.writer.seal(atNs: endNs)
    }

    func finish(endNs: Int64) async -> (microphone: TrackOutcome?, systemAudio: TrackOutcome?, webcam: TrackOutcome?) {
        microphone?.capture.stop()
        webcam?.capture.stop()
        async let microphoneOutcome = microphone?.writer.finish(endNs: endNs)
        async let systemOutcome = systemAudio?.writer.finish(endNs: endNs)
        async let webcamOutcome = webcam?.writer.finish(endNs: endNs)
        return await (microphoneOutcome, systemOutcome, webcamOutcome)
    }

    func cancel() {
        microphone?.capture.stop()
        webcam?.capture.stop()
        microphone?.writer.cancel()
        webcam?.writer.cancel()
        systemAudio?.writer.cancel()
    }
}
