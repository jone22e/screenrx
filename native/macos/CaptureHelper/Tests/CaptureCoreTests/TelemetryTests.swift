import XCTest

@testable import CaptureCore

final class TelemetryTests: XCTestCase {
    private let second: Int64 = 1_000_000_000
    private let rect = CaptureRect(x: 100, y: 50, width: 1000, height: 500)

    /// Recording starts at host time 10 s and is paused between 12 s and 15 s.
    private func pausedClock() throws -> RecordingClock {
        var clock = RecordingClock()
        try clock.start(atHostNs: 10 * second)
        try clock.pause(atHostNs: 12 * second)
        try clock.resume(atHostNs: 15 * second)
        return clock
    }

    func testPositionsAreNormalizedToTheCapturedArea() {
        let point = rect.normalized(x: 600, y: 300)
        XCTAssertEqual(point.x, 0.5)
        XCTAssertEqual(point.y, 0.5)
        // Outside the captured area the values simply leave the 0…1 range.
        XCTAssertLessThan(rect.normalized(x: 0, y: 0).x, 0)
    }

    func testCursorSamplesFollowTheRecordingClock() throws {
        let raw = [
            RawPointerSample(hostNs: 9 * second, x: 100, y: 50),  // before the recording
            RawPointerSample(hostNs: 11 * second, x: 350, y: 175),
            RawPointerSample(hostNs: 13 * second, x: 600, y: 300),  // during the pause
            RawPointerSample(hostNs: 16 * second, x: 1100, y: 550),
            RawPointerSample(hostNs: 30 * second, x: 100, y: 50),  // after the end
        ]
        let samples = TelemetryBuilder.cursorSamples(
            raw, clock: try pausedClock(), rect: rect, endNs: 5 * second)
        XCTAssertEqual(
            samples,
            [
                CursorSample(timeMs: 1000, x: 0.25, y: 0.25),
                CursorSample(timeMs: 3000, x: 1, y: 1),
            ])
    }

    func testAReleaseYieldsTheClickKind() throws {
        func event(
            _ hostSeconds: Int64, _ transition: RawPointerEvent.Transition, _ button: PointerButton,
            clicks: Int = 1
        ) -> RawPointerEvent {
            RawPointerEvent(
                hostNs: hostSeconds * second, x: 600, y: 300, transition: transition, button: button,
                clickCount: clicks)
        }
        let raw = [
            event(11, .down, .left), event(11, .up, .left),
            event(13, .down, .left), event(13, .up, .left),  // during the pause: dropped
            event(16, .down, .left, clicks: 2), event(16, .up, .left, clicks: 2),
            event(16, .up, .left, clicks: 2),  // duplicate release: ignored
            event(17, .down, .right), event(17, .up, .right),
            event(17, .down, .middle), event(17, .up, .middle),
            event(17, .down, .other), event(17, .up, .other),
            event(18, .up, .right),  // release without a recorded press: ignored
        ]
        let types = TelemetryBuilder.interactions(
            raw, clock: try pausedClock(), rect: rect, endNs: 60 * second
        ).map(\.type)
        XCTAssertEqual(
            types,
            [
                .mouseDown, .mouseUp, .click,
                .mouseDown, .mouseUp, .doubleClick,
                .mouseDown, .mouseUp, .rightClick,
                .mouseDown, .mouseUp, .middleClick,
                .mouseDown, .mouseUp,
            ])
    }
}
