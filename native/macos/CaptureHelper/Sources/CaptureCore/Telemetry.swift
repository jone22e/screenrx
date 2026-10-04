// Pointer telemetry: where the cursor was and what the mouse did, recorded
// independently of the video frames but on the same recording clock.
//
// Positions are normalized to the captured area — (0,0) top-left, (1,1)
// bottom-right — so nothing downstream depends on the capture resolution.
// Values outside 0…1 mean the pointer was outside the captured area.

/// The captured area in global screen points (origin at the top-left of the main display).
public struct CaptureRect: Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public func normalized(x globalX: Double, y globalY: Double) -> (x: Double, y: Double) {
        guard width > 0, height > 0 else { return (0, 0) }
        return ((globalX - x) / width, (globalY - y) / height)
    }
}

public enum PointerButton: String, Codable, Sendable {
    case left, right, middle, other
}

/// A pointer position as sampled, stamped with the host clock.
public struct RawPointerSample: Sendable {
    public let hostNs: Int64
    public let x: Double
    public let y: Double

    public init(hostNs: Int64, x: Double, y: Double) {
        self.hostNs = hostNs
        self.x = x
        self.y = y
    }
}

/// A mouse button transition as observed, stamped with the host clock.
public struct RawPointerEvent: Sendable {
    public enum Transition: Sendable {
        case down, up
    }

    public let hostNs: Int64
    public let x: Double
    public let y: Double
    public let transition: Transition
    public let button: PointerButton
    /// 1 for a single click, 2 for the second click of a double click, and so on.
    public let clickCount: Int

    public init(
        hostNs: Int64, x: Double, y: Double, transition: Transition, button: PointerButton, clickCount: Int
    ) {
        self.hostNs = hostNs
        self.x = x
        self.y = y
        self.transition = transition
        self.button = button
        self.clickCount = clickCount
    }
}

/// One entry of `cursor.json`.
public struct CursorSample: Codable, Equatable, Sendable {
    public let timeMs: Double
    public let x: Double
    public let y: Double
}

public enum InteractionType: String, Codable, Sendable {
    case mouseDown, mouseUp, click, doubleClick, rightClick, middleClick
}

/// One entry of `interactions.json`.
public struct InteractionEvent: Codable, Equatable, Sendable {
    public let timeMs: Double
    public let type: InteractionType
    public let x: Double
    public let y: Double
    public let button: PointerButton
}

/// Converts raw, host-clock observations into the session's telemetry files.
/// Anything stamped inside a pause or outside the recording is dropped by
/// the same `RecordingClock` that retimes the video.
public enum TelemetryBuilder {
    public static func cursorSamples(
        _ raw: [RawPointerSample], clock: RecordingClock, rect: CaptureRect, endNs: Int64
    ) -> [CursorSample] {
        raw.compactMap { sample in
            guard let timeNs = clock.recordingTimeNs(atHostNs: sample.hostNs), timeNs <= endNs else {
                return nil
            }
            let point = rect.normalized(x: sample.x, y: sample.y)
            return CursorSample(timeMs: milliseconds(timeNs), x: coordinate(point.x), y: coordinate(point.y))
        }
    }

    public static func interactions(
        _ raw: [RawPointerEvent], clock: RecordingClock, rect: CaptureRect, endNs: Int64
    ) -> [InteractionEvent] {
        var events: [InteractionEvent] = []
        var pressed: Set<PointerButton> = []
        for event in raw {
            guard let timeNs = clock.recordingTimeNs(atHostNs: event.hostNs), timeNs <= endNs else {
                continue
            }
            let point = rect.normalized(x: event.x, y: event.y)
            func emit(_ type: InteractionType) {
                events.append(
                    InteractionEvent(
                        timeMs: milliseconds(timeNs), type: type, x: coordinate(point.x),
                        y: coordinate(point.y), button: event.button))
            }
            switch event.transition {
            case .down:
                pressed.insert(event.button)
                emit(.mouseDown)
            case .up:
                // The system sometimes reports a release twice (after a drag),
                // and a press may have been outside the recording; a release
                // only counts when its press was recorded.
                guard pressed.remove(event.button) != nil else { continue }
                emit(.mouseUp)
                // A release completes the gesture; that is the interaction auto zoom reacts to.
                switch event.button {
                case .left: emit(event.clickCount >= 2 ? .doubleClick : .click)
                case .right: emit(.rightClick)
                case .middle: emit(.middleClick)
                case .other: break
                }
            }
        }
        return events
    }

    /// Tenths of a millisecond are plenty and keep the files compact.
    private static func milliseconds(_ ns: Int64) -> Double {
        (Double(ns) / 100_000).rounded() / 10
    }

    private static func coordinate(_ value: Double) -> Double {
        (value * 10_000).rounded() / 10_000
    }
}
