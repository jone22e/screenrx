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

    func testBitrateGrowsWithChannels() {
        XCTAssertEqual(AudioEncoding.bitrate(channels: 2), AudioEncoding.bitrate(channels: 1) * 2)
    }
}
