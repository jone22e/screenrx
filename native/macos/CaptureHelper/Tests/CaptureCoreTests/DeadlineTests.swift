import XCTest

@testable import CaptureCore

final class DeadlineTests: XCTestCase {
    func testReturnsAsSoonAsTheOperationFinishes() async {
        let started = Date()
        await withDeadline(seconds: 5) {}
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
    }

    func testStopsWaitingForAnOperationThatNeverFinishes() async {
        let started = Date()
        await withDeadline(seconds: 0.2) {
            try? await Task.sleep(nanoseconds: 30_000_000_000)
        }
        let waited = Date().timeIntervalSince(started)
        XCTAssertGreaterThanOrEqual(waited, 0.2)
        XCTAssertLessThan(waited, 2)
    }
}
