import XCTest

@testable import CaptureCore

final class AudioEncodingTests: XCTestCase {
    func testStudioSampleRatesAreKept() {
        XCTAssertEqual(AudioEncoding.sampleRate(forSource: 48_000), 48_000)
        XCTAssertEqual(AudioEncoding.sampleRate(forSource: 44_100), 44_100)
    }

    func testBluetoothAndOtherRatesAreResampledToTheDefault() {
        // 16 kHz is what a Bluetooth headset's microphone delivers.
        for rate in [8_000.0, 16_000, 24_000, 32_000, 96_000, 0, -1] {
            XCTAssertEqual(AudioEncoding.sampleRate(forSource: rate), CaptureDefaults.audioSampleRate, "\(rate)")
        }
    }

    func testChannelsAreMonoOrStereo() {
        XCTAssertEqual(AudioEncoding.channels(forSource: 1), 1)
        XCTAssertEqual(AudioEncoding.channels(forSource: 2), 2)
        XCTAssertEqual(AudioEncoding.channels(forSource: 6), 2)
        XCTAssertEqual(AudioEncoding.channels(forSource: 0), 1)
    }

    func testAHoleInTheAudioIsFilledWithSilence() {
        // The first buffer arrives 44 ms into the recording.
        XCTAssertEqual(AudioEncoding.silenceToFill(writtenUntilSeconds: 0, bufferStartSeconds: 0.044), 0.044)
        // A buffer was lost around a pause.
        XCTAssertEqual(
            AudioEncoding.silenceToFill(writtenUntilSeconds: 2.5, bufferStartSeconds: 2.6), 0.1, accuracy: 0.0001)
    }

    func testJitterAndOverlapAreNotHoles() {
        XCTAssertEqual(AudioEncoding.silenceToFill(writtenUntilSeconds: 1.0, bufferStartSeconds: 1.004), 0)
        XCTAssertEqual(AudioEncoding.silenceToFill(writtenUntilSeconds: 1.0, bufferStartSeconds: 1.0), 0)
        XCTAssertEqual(AudioEncoding.silenceToFill(writtenUntilSeconds: 1.0, bufferStartSeconds: 0.99), 0)
    }

    func testADeviceThatStoppedDeliveringIsNotPaperedOver() {
        XCTAssertEqual(AudioEncoding.silenceToFill(writtenUntilSeconds: 1.0, bufferStartSeconds: 45.0), 0)
    }

    func testBitrateGrowsWithChannels() {
        XCTAssertEqual(AudioEncoding.bitrate(channels: 2), AudioEncoding.bitrate(channels: 1) * 2)
    }
}
