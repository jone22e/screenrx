/// The single time base of a recording session.
///
/// Every capture subsystem stamps its data with the host clock
/// (mach absolute time, in nanoseconds) and maps it through this clock to
/// get *recording time*: time since the first frame, with paused spans
/// removed. Screen, audio, webcam and cursor telemetry all go through the
/// same mapping, so they stay aligned across pause/resume.
public struct RecordingClock: Sendable {
    public struct Pause: Equatable, Sendable {
        public let startHostNs: Int64
        public var endHostNs: Int64?
    }

    public enum ClockError: Error, Equatable {
        case alreadyStarted
        case notStarted
        case alreadyPaused
        case notPaused
    }

    public private(set) var originHostNs: Int64?
    public private(set) var pauses: [Pause] = []

    public init() {}

    public var isStarted: Bool { originHostNs != nil }

    public var isPaused: Bool {
        guard let last = pauses.last else { return false }
        return last.endHostNs == nil
    }

    public mutating func start(atHostNs hostNs: Int64) throws {
        guard originHostNs == nil else { throw ClockError.alreadyStarted }
        originHostNs = hostNs
    }

    public mutating func pause(atHostNs hostNs: Int64) throws {
        guard let origin = originHostNs else { throw ClockError.notStarted }
        guard !isPaused else { throw ClockError.alreadyPaused }
        // A pause can never begin before the origin or before the previous resume.
        let floor = pauses.last?.endHostNs ?? origin
        pauses.append(Pause(startHostNs: max(hostNs, floor), endHostNs: nil))
    }

    public mutating func resume(atHostNs hostNs: Int64) throws {
        guard isStarted else { throw ClockError.notStarted }
        guard isPaused, let index = pauses.indices.last else { throw ClockError.notPaused }
        pauses[index].endHostNs = max(hostNs, pauses[index].startHostNs)
    }

    /// Recording time elapsed at `hostNs`. Inside a pause this is frozen at
    /// the instant the pause began; before the origin it is zero.
    public func elapsedNs(atHostNs hostNs: Int64) -> Int64 {
        guard let origin = originHostNs, hostNs > origin else { return 0 }
        var paused: Int64 = 0
        for pause in pauses where pause.startHostNs < hostNs {
            let end = min(pause.endHostNs ?? hostNs, hostNs)
            paused += end - pause.startHostNs
        }
        return hostNs - origin - paused
    }

    /// Recording time for media stamped at `hostNs`, or `nil` when that
    /// instant is not part of the recording (before the origin or inside a pause).
    public func recordingTimeNs(atHostNs hostNs: Int64) -> Int64? {
        guard let origin = originHostNs, hostNs >= origin else { return nil }
        for pause in pauses where hostNs >= pause.startHostNs {
            guard let end = pause.endHostNs else { return nil }
            if hostNs < end { return nil }
        }
        return elapsedNs(atHostNs: hostNs)
    }

    /// Completed pauses expressed in recording time, for the session manifest.
    public func pauseMarkers() -> [PauseMarker] {
        pauses.compactMap { pause in
            guard let end = pause.endHostNs else { return nil }
            return PauseMarker(
                atMs: Self.milliseconds(elapsedNs(atHostNs: pause.startHostNs)),
                pausedForMs: Self.milliseconds(end - pause.startHostNs)
            )
        }
    }

    public static func milliseconds(_ ns: Int64) -> Double {
        Double(ns) / 1_000_000
    }
}
