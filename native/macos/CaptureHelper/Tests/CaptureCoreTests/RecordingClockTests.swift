import XCTest

@testable import CaptureCore

final class RecordingClockTests: XCTestCase {
    private let second: Int64 = 1_000_000_000

    func testElapsedIsZeroBeforeStart() {
        let clock = RecordingClock()
        XCTAssertEqual(clock.elapsedNs(atHostNs: 5 * second), 0)
        XCTAssertNil(clock.recordingTimeNs(atHostNs: 5 * second))
    }

    func testRecordingTimeIsRelativeToOrigin() throws {
        var clock = RecordingClock()
        try clock.start(atHostNs: 100 * second)
        XCTAssertEqual(clock.recordingTimeNs(atHostNs: 100 * second), 0)
        XCTAssertEqual(clock.recordingTimeNs(atHostNs: 103 * second), 3 * second)
        XCTAssertNil(clock.recordingTimeNs(atHostNs: 99 * second))
    }

    func testPausedSpanIsRemovedFromRecordingTime() throws {
        var clock = RecordingClock()
        try clock.start(atHostNs: 10 * second)
        try clock.pause(atHostNs: 15 * second)
        try clock.resume(atHostNs: 25 * second)

        // Before the pause: unaffected.
        XCTAssertEqual(clock.recordingTimeNs(atHostNs: 14 * second), 4 * second)
        // Inside the pause: not part of the recording, elapsed is frozen.
        XCTAssertNil(clock.recordingTimeNs(atHostNs: 20 * second))
        XCTAssertEqual(clock.elapsedNs(atHostNs: 20 * second), 5 * second)
        // The resume instant continues exactly where the pause began.
        XCTAssertEqual(clock.recordingTimeNs(atHostNs: 25 * second), 5 * second)
        XCTAssertEqual(clock.recordingTimeNs(atHostNs: 27 * second), 7 * second)
    }

    func testOpenPauseFreezesTime() throws {
        var clock = RecordingClock()
        try clock.start(atHostNs: 0)
        try clock.pause(atHostNs: 4 * second)
        XCTAssertTrue(clock.isPaused)
        XCTAssertNil(clock.recordingTimeNs(atHostNs: 4 * second))
        XCTAssertNil(clock.recordingTimeNs(atHostNs: 60 * second))
        XCTAssertEqual(clock.elapsedNs(atHostNs: 60 * second), 4 * second)
        // A frame stamped just before the pause still belongs to the recording.
        XCTAssertEqual(clock.recordingTimeNs(atHostNs: 4 * second - 1), 4 * second - 1)
    }

    func testMultiplePausesAccumulate() throws {
        var clock = RecordingClock()
        try clock.start(atHostNs: 0)
        try clock.pause(atHostNs: 2 * second)
        try clock.resume(atHostNs: 5 * second)
        try clock.pause(atHostNs: 8 * second)
        try clock.resume(atHostNs: 20 * second)

        XCTAssertEqual(clock.elapsedNs(atHostNs: 22 * second), 7 * second)
        XCTAssertEqual(
            clock.pauseMarkers(),
            [
                PauseMarker(atMs: 2000, pausedForMs: 3000),
                PauseMarker(atMs: 5000, pausedForMs: 12000),
            ])
    }

    func testInvalidTransitionsThrow() throws {
        var clock = RecordingClock()
        XCTAssertThrowsError(try clock.pause(atHostNs: 1))
        try clock.start(atHostNs: 0)
        XCTAssertThrowsError(try clock.start(atHostNs: 1))
        XCTAssertThrowsError(try clock.resume(atHostNs: 1))
        try clock.pause(atHostNs: 1)
        XCTAssertThrowsError(try clock.pause(atHostNs: 2))
    }

    func testOutOfOrderTimestampsNeverGoBackwards() throws {
        var clock = RecordingClock()
        try clock.start(atHostNs: 10 * second)
        // A pause stamped before the origin is clamped to the origin.
        try clock.pause(atHostNs: 9 * second)
        // A resume stamped before its pause yields a zero-length pause.
        try clock.resume(atHostNs: 8 * second)
        XCTAssertEqual(clock.elapsedNs(atHostNs: 12 * second), 2 * second)
    }
}
