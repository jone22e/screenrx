import XCTest

@testable import VoiceCore

final class RowwiseWeightsTests: XCTestCase {
    func testLowHalfOfAByteComesFirstAndValuesAreSigned() {
        // 0x80: low half 0 → −8, high half 8 → 0. 0xF7: low 7 → −1, high 15 → 7.
        let values = RowwiseWeights.decode4Bit(
            packed: [0x80, 0xF7], scales: [0.5], rows: 1, columns: 4, groupSize: 4)
        XCTAssertEqual(values, [-4, 0, -0.5, 3.5])
    }

    func testEveryGroupHasItsOwnScale() {
        // Two rows of one group each; every value is 9 → +1.
        let values = RowwiseWeights.decode4Bit(
            packed: [0x99, 0x99], scales: [2, 10], rows: 2, columns: 2, groupSize: 2)
        XCTAssertEqual(values, [2, 2, 10, 10])
    }

    func testPaddingOfTheLastGroupIsDropped() {
        // Five columns in groups of four: two groups, the second with one real value.
        XCTAssertEqual(RowwiseWeights.groupCount(columns: 5, groupSize: 4), 2)
        let values = RowwiseWeights.decode4Bit(
            packed: [0x99, 0x99, 0xFA, 0xFF], scales: [1, 3], rows: 1, columns: 5, groupSize: 4)
        XCTAssertEqual(values, [1, 1, 1, 1, 6])
    }
}

final class DubTimingTests: XCTestCase {
    func testSpeechThatFitsKeepsItsOwnPace() {
        XCTAssertNil(DubTiming.requestedDuration(naturalS: 2.0, maxDurationS: 3.0))
        XCTAssertNil(DubTiming.requestedDuration(naturalS: 2.0, maxDurationS: nil))
    }

    func testSpeechThatRunsOverIsAskedToFitItsSlot() {
        XCTAssertEqual(DubTiming.requestedDuration(naturalS: 3.6, maxDurationS: 3.0), 3.0)
    }

    func testSpeechIsNeverSpedUpPastTheLimit() {
        // Fitting 6 s into 3 s would be twice as fast: it is only sped up to the limit.
        let requested = DubTiming.requestedDuration(naturalS: 6.0, maxDurationS: 3.0)
        XCTAssertEqual(requested ?? 0, 6.0 / DubTiming.maxSpeedup, accuracy: 0.0001)
    }

    func testASlotTooShortToMeanAnythingIsIgnored() {
        XCTAssertNil(DubTiming.requestedDuration(naturalS: 4.0, maxDurationS: 0.1))
    }

    func testJobsRoundTripThroughJSON() throws {
        let job = DubJob(id: "u1", text: "Hello", output: "/tmp/u1.wav", maxDurationS: 2.5)
        let decoded = try JSONDecoder().decode([DubJob].self, from: JSONEncoder().encode([job]))
        XCTAssertEqual(decoded, [job])
        let withoutLimit = try JSONDecoder().decode(
            DubJob.self, from: Data(#"{"id":"u2","text":"Hi","output":"/tmp/u2.wav"}"#.utf8))
        XCTAssertNil(withoutLimit.maxDurationS)
    }
}
