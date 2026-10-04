import AVFoundation
import CaptureCore

/// Microphones and cameras available to record, and access to them.
enum Devices {
    static func microphones() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified
        ).devices
    }

    static func cameras() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera], mediaType: .video,
            position: .unspecified
        ).devices
    }

    static func list() -> DevicesListResult {
        let defaultMicrophone = AVCaptureDevice.default(for: .audio)?.uniqueID
        let defaultCamera = AVCaptureDevice.default(for: .video)?.uniqueID
        return DevicesListResult(
            microphones: microphones().map {
                DeviceInfo(id: $0.uniqueID, name: $0.localizedName, isDefault: $0.uniqueID == defaultMicrophone)
            },
            cameras: cameras().map {
                DeviceInfo(id: $0.uniqueID, name: $0.localizedName, isDefault: $0.uniqueID == defaultCamera)
            })
    }

    /// The device with `id`, or the system default when `id` is `nil`.
    static func find(id: String?, mediaType: AVMediaType) -> AVCaptureDevice? {
        guard let id else { return AVCaptureDevice.default(for: mediaType) }
        let candidates = mediaType == .audio ? microphones() : cameras()
        return candidates.first { $0.uniqueID == id }
    }

    /// Reads the authorization without prompting.
    static func access(to mediaType: AVMediaType) -> MediaAccess {
        switch AVCaptureDevice.authorizationStatus(for: mediaType) {
        case .authorized: return .granted
        case .notDetermined: return .undetermined
        default: return .denied
        }
    }

    /// Shows the system prompt the first time; afterwards only reports the state.
    static func requestAccess(to mediaType: AVMediaType) async -> MediaAccess {
        _ = await AVCaptureDevice.requestAccess(for: mediaType)
        return access(to: mediaType)
    }
}

/// Captures one microphone or camera into a `MediaTrackWriter`.
final class DeviceCapture: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate,
    AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable
{
    private let session = AVCaptureSession()
    private let writer: MediaTrackWriter
    private let hostClock = CMClockGetHostTimeClock()

    init(device: AVCaptureDevice, writer: MediaTrackWriter) throws {
        self.writer = writer
        super.init()

        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            throw HelperError(.deviceUnavailable, "\(device.localizedName): \(error.localizedDescription)")
        }
        guard session.canAddInput(input) else {
            throw HelperError(.deviceUnavailable, "\(device.localizedName) cannot be captured")
        }
        session.addInput(input)

        let output: AVCaptureOutput
        if device.hasMediaType(.video) {
            let video = AVCaptureVideoDataOutput()
            video.alwaysDiscardsLateVideoFrames = true
            video.videoSettings = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            ]
            video.setSampleBufferDelegate(self, queue: writer.queue)
            output = video
        } else {
            let audio = AVCaptureAudioDataOutput()
            audio.setSampleBufferDelegate(self, queue: writer.queue)
            output = audio
        }
        guard session.canAddOutput(output) else {
            throw HelperError(.deviceUnavailable, "\(device.localizedName) cannot be captured")
        }
        session.addOutput(output)
    }

    /// Starting a capture session blocks for a moment, so it happens off the caller's thread.
    func start() {
        DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
    }

    func stop() {
        session.stopRunning()
    }

    func captureOutput(
        _ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection
    ) {
        // Capture sessions stamp buffers with their own clock; the session
        // timeline is on the host clock, so convert before mapping.
        let timestamp = sampleBuffer.presentationTimeStamp
        let hostTime =
            session.synchronizationClock.map { CMSyncConvertTime(timestamp, from: $0, to: hostClock) }
            ?? timestamp
        writer.append(sampleBuffer, hostTime: hostTime)
    }
}
