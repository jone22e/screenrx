import AVFoundation
import CaptureCore
import Foundation

/// Reads requests from stdin and dispatches them. Closing stdin (the parent
/// quit or crashed) is the shutdown signal: any recording in progress is
/// finalized before the process exits.
final class CommandServer: @unchecked Sendable {
    private let log = Log(scope: "capture")
    private let out = MessageWriter.shared
    private let decoder = JSONDecoder()
    private let recorder: ScreenRecorder
    private let shutdownLock = NSLock()
    private var isShuttingDown = false

    init() {
        recorder = ScreenRecorder { payload in
            MessageWriter.shared.emit(event: "recording.interrupted", payload: payload)
        }
    }

    func start() {
        let reader = Thread { [self] in
            while let line = readLine(strippingNewline: true) {
                guard !line.isEmpty else { continue }
                let data = Data(line.utf8)
                Task { await self.handle(data) }
            }
            self.shutdown(reason: "stdin closed")
        }
        reader.name = "screenrx.stdin"
        reader.start()
    }

    func shutdown(reason: String) {
        shutdownLock.lock()
        let alreadyShuttingDown = isShuttingDown
        isShuttingDown = true
        shutdownLock.unlock()
        guard !alreadyShuttingDown else { return }

        log.info("shutting down", ["reason": reason])
        Task {
            await recorder.shutdown()
            exit(0)
        }
    }

    private func handle(_ data: Data) async {
        guard let header = try? decoder.decode(RequestHeader.self, from: data) else {
            log.error("discarding malformed request")
            return
        }
        guard let method = Method(rawValue: header.method) else {
            out.fail(id: header.id, error: HelperError(.unknownMethod, "Unknown method \(header.method)"))
            return
        }

        do {
            switch method {
            case .hello:
                out.respond(
                    id: header.id,
                    result: HelloResult(
                        protocolVersion: CaptureDefaults.protocolVersion,
                        osVersion: ProcessInfo.processInfo.operatingSystemVersionString))
            case .permissionsStatus:
                out.respond(id: header.id, result: permissions(screenRecording: Permissions.screenRecordingGranted))
            case .permissionsRequestScreenRecording:
                out.respond(id: header.id, result: permissions(screenRecording: Permissions.requestScreenRecording()))
            case .permissionsRequestMedia:
                let params: MediaRequestParams = try params(from: data)
                _ = await Devices.requestAccess(to: params.kind == .microphone ? .audio : .video)
                out.respond(id: header.id, result: permissions(screenRecording: Permissions.screenRecordingGranted))
            case .devicesList:
                out.respond(id: header.id, result: Devices.list())
            case .sourcesList:
                let params: SourcesListParams = try params(from: data)
                out.respond(id: header.id, result: try await SourceCatalog.list(params))
            case .recordingStart:
                let params: RecordingStartParams = try params(from: data)
                out.respond(id: header.id, result: try await recorder.start(params))
            case .recordingPause:
                out.respond(id: header.id, result: try recorder.pause())
            case .recordingResume:
                out.respond(id: header.id, result: try recorder.resume())
            case .recordingStop:
                out.respond(id: header.id, result: try await recorder.stop())
            }
        } catch let error as HelperError {
            out.fail(id: header.id, error: error)
        } catch {
            out.fail(id: header.id, error: HelperError(.captureFailed, error.localizedDescription))
        }
    }

    private func permissions(screenRecording: Bool) -> PermissionsResult {
        PermissionsResult(
            screenRecording: screenRecording,
            microphone: Devices.access(to: .audio),
            camera: Devices.access(to: .video),
            responsibleExecutable: Permissions.responsibleExecutable)
    }

    private func params<Params: Decodable>(from data: Data) throws -> Params {
        do {
            return try decoder.decode(RequestBody<Params>.self, from: data).params
        } catch {
            throw HelperError(.invalidRequest, "Invalid params: \(error)")
        }
    }
}
