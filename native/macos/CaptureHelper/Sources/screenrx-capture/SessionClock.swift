import CaptureCore
import Foundation

/// The session's `RecordingClock`, shareable between capture threads. The
/// screen, each audio track, the webcam and the pointer telemetry all map
/// their host-clock timestamps through this one instance, which is what keeps
/// them aligned across pause and resume.
final class SessionClock: @unchecked Sendable {
    private let lock = NSLock()
    private var clock = RecordingClock()

    private func withLock<Value>(_ body: (inout RecordingClock) throws -> Value) rethrows -> Value {
        lock.lock()
        defer { lock.unlock() }
        return try body(&clock)
    }

    var isStarted: Bool { withLock { $0.isStarted } }
    var isPaused: Bool { withLock { $0.isPaused } }

    func start(atHostNs hostNs: Int64) throws { try withLock { try $0.start(atHostNs: hostNs) } }
    func pause(atHostNs hostNs: Int64) throws { try withLock { try $0.pause(atHostNs: hostNs) } }
    func resume(atHostNs hostNs: Int64) throws { try withLock { try $0.resume(atHostNs: hostNs) } }

    func elapsedNs(atHostNs hostNs: Int64) -> Int64 { withLock { $0.elapsedNs(atHostNs: hostNs) } }

    func recordingTimeNs(atHostNs hostNs: Int64) -> Int64? {
        withLock { $0.recordingTimeNs(atHostNs: hostNs) }
    }

    /// The clock as it stands, for mapping telemetry once the recording has ended.
    func snapshot() -> RecordingClock { withLock { $0 } }

    func reset() { withLock { $0 = RecordingClock() } }
}
