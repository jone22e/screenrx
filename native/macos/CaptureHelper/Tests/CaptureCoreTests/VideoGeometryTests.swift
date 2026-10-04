import XCTest

@testable import CaptureCore

final class VideoGeometryTests: XCTestCase {
    func testSourcesWithinLimitsKeepTheirSize() {
        let size = VideoGeometry.encodedSize(forSource: PixelSize(width: 3024, height: 1964))
        XCTAssertEqual(size, PixelSize(width: 3024, height: 1964))
    }

    func testOddDimensionsAreRoundedDownToEven() {
        let size = VideoGeometry.encodedSize(forSource: PixelSize(width: 1513, height: 983))
        XCTAssertEqual(size, PixelSize(width: 1512, height: 982))
    }

    func testOversizedSourcesAreScaledPreservingAspect() {
        let size = VideoGeometry.encodedSize(forSource: PixelSize(width: 5120, height: 2880))
        XCTAssertEqual(size, PixelSize(width: 4096, height: 2304))
    }

    func testPortraitSourcesRespectThePixelBudget() {
        let size = VideoGeometry.encodedSize(forSource: PixelSize(width: 2880, height: 5120))
        XCTAssertLessThanOrEqual(size.width * size.height, CaptureDefaults.maxEncodedPixels)
        XCTAssertLessThanOrEqual(size.height, CaptureDefaults.maxEncodedSide)
        XCTAssertEqual(Double(size.width) / Double(size.height), 2880.0 / 5120.0, accuracy: 0.002)
    }

    func testBitrateIsClampedToConfiguredRange() {
        let tiny = VideoGeometry.videoBitrate(for: PixelSize(width: 320, height: 240), fps: 30)
        let huge = VideoGeometry.videoBitrate(for: PixelSize(width: 4096, height: 2304), fps: 120)
        XCTAssertEqual(tiny, CaptureDefaults.minVideoBitrate)
        XCTAssertEqual(huge, CaptureDefaults.maxVideoBitrate)
    }
}
