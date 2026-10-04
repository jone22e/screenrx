import Foundation

// JSON-lines protocol spoken with the Electron main process.
//
//   request   (stdin)  {"id":"7","method":"recording.start","params":{...}}
//   response  (stdout) {"type":"response","id":"7","ok":true,"result":{...}}
//                      {"type":"response","id":"7","ok":false,"error":{"code":"...","message":"..."}}
//   event     (stdout) {"type":"event","name":"recording.interrupted","payload":{...}}
//   log       (stdout) {"type":"log","level":"info","scope":"capture","message":"...","data":{...}}
//
// The TypeScript mirror of these types lives in src/main/capture/macos/helperProtocol.ts.

public enum Method: String, Sendable {
    case hello
    case permissionsStatus = "permissions.status"
    case permissionsRequestScreenRecording = "permissions.requestScreenRecording"
    case permissionsRequestMedia = "permissions.requestMedia"
    case devicesList = "devices.list"
    case sourcesList = "sources.list"
    case recordingStart = "recording.start"
    case recordingPause = "recording.pause"
    case recordingResume = "recording.resume"
    case recordingStop = "recording.stop"
}

public enum ErrorCode: String, Codable, Sendable {
    case invalidRequest = "invalid-request"
    case unknownMethod = "unknown-method"
    case invalidState = "invalid-state"
    case permissionDenied = "permission-denied"
    case sourceUnavailable = "source-unavailable"
    case outputUnavailable = "output-unavailable"
    case captureFailed = "capture-failed"
    case noFrames = "no-frames"
    case diskFull = "disk-full"
    case writerFailed = "writer-failed"
    case stoppedBySystem = "stopped-by-system"
    case microphonePermissionDenied = "microphone-permission-denied"
    case cameraPermissionDenied = "camera-permission-denied"
    case deviceUnavailable = "device-unavailable"
}

public struct HelperError: Error, Encodable, Sendable {
    public let code: ErrorCode
    public let message: String

    public init(_ code: ErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }
}

// MARK: - Requests

public struct RequestHeader: Decodable {
    public let id: String
    public let method: String
}

public struct RequestBody<Params: Decodable>: Decodable {
    public let params: Params
}

public struct SourcesListParams: Decodable {
    /// Processes whose windows are left out of the list and of the thumbnails.
    public let excludePids: [Int32]
    public let includeWindows: Bool
    /// `nil` skips thumbnail capture entirely.
    public let thumbnailMaxWidth: Int?
}

public enum SourceSelector: Decodable, Equatable, Sendable {
    case display(displayId: UInt32)
    case window(windowId: UInt32)

    private enum CodingKeys: String, CodingKey {
        case kind, displayId, windowId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "display":
            self = .display(displayId: try container.decode(UInt32.self, forKey: .displayId))
        case "window":
            self = .window(windowId: try container.decode(UInt32.self, forKey: .windowId))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: container, debugDescription: "unknown source kind \(kind)")
        }
    }
}

public struct TelemetryParams: Decodable {
    /// Files to create when the recording ends; they must not exist yet.
    public let cursorPath: String
    public let interactionsPath: String
    public let sampleRateHz: Int
}

public enum MediaKind: String, Decodable, Sendable {
    case microphone, camera
}

public struct MediaRequestParams: Decodable {
    public let kind: MediaKind
}

/// A device-backed track to record; `deviceId` `nil` means the system default.
public struct DeviceTrackParams: Decodable {
    public let deviceId: String?
    public let outputPath: String
}

public struct WebcamTrackParams: Decodable {
    public let deviceId: String?
    public let outputPath: String
    public let fps: Int
}

public struct SystemAudioParams: Decodable {
    public let outputPath: String
}

public struct RecordingStartParams: Decodable {
    public let outputPath: String
    public let source: SourceSelector
    /// Applications (by PID) removed from display captures — the recorder's own UI.
    public let excludePids: [Int32]
    public let fps: Int
    public let showCursor: Bool
    /// Pointer telemetry is recorded only when requested.
    public let telemetry: TelemetryParams?
    /// Companion tracks, each recorded to its own file when requested.
    public let microphone: DeviceTrackParams?
    public let systemAudio: SystemAudioParams?
    public let webcam: WebcamTrackParams?
}

// MARK: - Results

public struct HelloResult: Encodable {
    public let protocolVersion: Int
    public let osVersion: String

    public init(protocolVersion: Int, osVersion: String) {
        self.protocolVersion = protocolVersion
        self.osVersion = osVersion
    }
}

public enum MediaAccess: String, Encodable, Sendable {
    case granted, denied, undetermined
}

public struct PermissionsResult: Encodable {
    public let screenRecording: Bool
    public let microphone: MediaAccess
    public let camera: MediaAccess
    /// Executable the system attributes this process's permissions to, when known.
    public let responsibleExecutable: String?

    public init(
        screenRecording: Bool, microphone: MediaAccess, camera: MediaAccess, responsibleExecutable: String?
    ) {
        self.screenRecording = screenRecording
        self.microphone = microphone
        self.camera = camera
        self.responsibleExecutable = responsibleExecutable
    }
}

public struct DeviceInfo: Encodable {
    public let id: String
    public let name: String
    public let isDefault: Bool

    public init(id: String, name: String, isDefault: Bool) {
        self.id = id
        self.name = name
        self.isDefault = isDefault
    }
}

public struct DevicesListResult: Encodable {
    public let microphones: [DeviceInfo]
    public let cameras: [DeviceInfo]

    public init(microphones: [DeviceInfo], cameras: [DeviceInfo]) {
        self.microphones = microphones
        self.cameras = cameras
    }
}

/// A finished companion track.
public struct TrackResult: Encodable {
    public let durationMs: Double
    public let fileSizeBytes: Int64
    public let widthPx: Int?
    public let heightPx: Int?

    public init(durationMs: Double, fileSizeBytes: Int64, widthPx: Int?, heightPx: Int?) {
        self.durationMs = durationMs
        self.fileSizeBytes = fileSizeBytes
        self.widthPx = widthPx
        self.heightPx = heightPx
    }
}

public struct DisplayInfo: Encodable {
    public let displayId: UInt32
    public let name: String
    public let isMain: Bool
    public let widthPx: Int
    public let heightPx: Int
    public let scaleFactor: Double
    public let thumbnailDataUrl: String?

    public init(
        displayId: UInt32, name: String, isMain: Bool, widthPx: Int, heightPx: Int,
        scaleFactor: Double, thumbnailDataUrl: String?
    ) {
        self.displayId = displayId
        self.name = name
        self.isMain = isMain
        self.widthPx = widthPx
        self.heightPx = heightPx
        self.scaleFactor = scaleFactor
        self.thumbnailDataUrl = thumbnailDataUrl
    }
}

public struct WindowInfo: Encodable {
    public let windowId: UInt32
    public let title: String
    public let appName: String
    public let bundleId: String
    public let displayId: UInt32?
    public let widthPx: Int
    public let heightPx: Int
    public let thumbnailDataUrl: String?

    public init(
        windowId: UInt32, title: String, appName: String, bundleId: String, displayId: UInt32?,
        widthPx: Int, heightPx: Int, thumbnailDataUrl: String?
    ) {
        self.windowId = windowId
        self.title = title
        self.appName = appName
        self.bundleId = bundleId
        self.displayId = displayId
        self.widthPx = widthPx
        self.heightPx = heightPx
        self.thumbnailDataUrl = thumbnailDataUrl
    }
}

public struct SourcesListResult: Encodable {
    public let displays: [DisplayInfo]
    public let windows: [WindowInfo]

    public init(displays: [DisplayInfo], windows: [WindowInfo]) {
        self.displays = displays
        self.windows = windows
    }
}

public struct RecordingStartResult: Encodable {
    public let widthPx: Int
    public let heightPx: Int
    public let fps: Int
    public let videoBitrate: Int
    /// Applications actually removed from the capture (subset of `excludePids` that own windows).
    public let excludedPids: [Int32]

    public init(widthPx: Int, heightPx: Int, fps: Int, videoBitrate: Int, excludedPids: [Int32]) {
        self.widthPx = widthPx
        self.heightPx = heightPx
        self.fps = fps
        self.videoBitrate = videoBitrate
        self.excludedPids = excludedPids
    }
}

/// Recording time at the moment a pause/resume took effect.
public struct RecordingTimeMark: Encodable {
    public let recordingTimeMs: Double

    public init(recordingTimeMs: Double) {
        self.recordingTimeMs = recordingTimeMs
    }
}

public struct PauseMarker: Encodable, Equatable, Sendable {
    /// Recording time at which the pause happened.
    public let atMs: Double
    /// Wall time the recording stayed paused (not part of the media).
    public let pausedForMs: Double

    public init(atMs: Double, pausedForMs: Double) {
        self.atMs = atMs
        self.pausedForMs = pausedForMs
    }
}

public struct RecordingStopResult: Encodable {
    public let outputPath: String
    /// Duration according to the recording clock.
    public let durationMs: Double
    /// Duration read back from the finished file.
    public let mediaDurationMs: Double
    public let fileSizeBytes: Int64
    public let widthPx: Int
    public let heightPx: Int
    public let framesWritten: Int
    public let framesDropped: Int
    public let pauses: [PauseMarker]
    /// Present when telemetry was requested and its files were written.
    public let telemetry: TelemetryResult?
    /// Companion tracks that were requested and ended up with media.
    public let microphone: TrackResult?
    public let systemAudio: TrackResult?
    public let webcam: TrackResult?

    public init(
        outputPath: String, durationMs: Double, mediaDurationMs: Double, fileSizeBytes: Int64,
        widthPx: Int, heightPx: Int, framesWritten: Int, framesDropped: Int, pauses: [PauseMarker],
        telemetry: TelemetryResult?, microphone: TrackResult?, systemAudio: TrackResult?, webcam: TrackResult?
    ) {
        self.outputPath = outputPath
        self.durationMs = durationMs
        self.mediaDurationMs = mediaDurationMs
        self.fileSizeBytes = fileSizeBytes
        self.widthPx = widthPx
        self.heightPx = heightPx
        self.framesWritten = framesWritten
        self.framesDropped = framesDropped
        self.pauses = pauses
        self.telemetry = telemetry
        self.microphone = microphone
        self.systemAudio = systemAudio
        self.webcam = webcam
    }
}

public struct TelemetryResult: Encodable {
    public let cursorSamples: Int
    public let interactions: Int

    public init(cursorSamples: Int, interactions: Int) {
        self.cursorSamples = cursorSamples
        self.interactions = interactions
    }
}

/// Payload of the `recording.interrupted` event: the capture ended without a
/// stop request. `result` is present when the file could still be finalized.
public struct RecordingInterruptedPayload: Encodable {
    public let error: HelperError
    public let result: RecordingStopResult?

    public init(error: HelperError, result: RecordingStopResult?) {
        self.error = error
        self.result = result
    }
}

// MARK: - Outgoing envelopes

public struct SuccessEnvelope<Result: Encodable>: Encodable {
    public let type = "response"
    public let id: String
    public let ok = true
    public let result: Result

    public init(id: String, result: Result) {
        self.id = id
        self.result = result
    }
}

public struct FailureEnvelope: Encodable {
    public let type = "response"
    public let id: String
    public let ok = false
    public let error: HelperError

    public init(id: String, error: HelperError) {
        self.id = id
        self.error = error
    }
}

public struct EventEnvelope<Payload: Encodable>: Encodable {
    public let type = "event"
    public let name: String
    public let payload: Payload

    public init(name: String, payload: Payload) {
        self.name = name
        self.payload = payload
    }
}

public struct LogEnvelope: Encodable {
    public let type = "log"
    public let level: String
    public let scope: String
    public let message: String
    public let data: [String: String]?

    public init(level: String, scope: String, message: String, data: [String: String]?) {
        self.level = level
        self.scope = scope
        self.message = message
        self.data = data
    }
}

public struct EmptyResult: Encodable {
    public init() {}
}
