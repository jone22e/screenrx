public struct PixelSize: Equatable, Sendable {
    public let width: Int
    public let height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }
}

public enum VideoGeometry {
    /// Size the encoder will use for a source: never upscaled, aspect
    /// preserved, within the codec limits and with even dimensions
    /// (required by 4:2:0 chroma subsampling).
    public static func encodedSize(
        forSource source: PixelSize,
        maxPixels: Int = CaptureDefaults.maxEncodedPixels,
        maxSide: Int = CaptureDefaults.maxEncodedSide
    ) -> PixelSize {
        let width = Double(max(source.width, 2))
        let height = Double(max(source.height, 2))
        let areaScale = (Double(maxPixels) / (width * height)).squareRoot()
        let scale = min(1, areaScale, Double(maxSide) / width, Double(maxSide) / height)
        return PixelSize(
            width: evenFloor(width * scale),
            height: evenFloor(height * scale)
        )
    }

    public static func videoBitrate(for size: PixelSize, fps: Int) -> Int {
        let raw = Double(size.width * size.height * fps) * CaptureDefaults.bitsPerPixelPerFrame
        return min(max(Int(raw), CaptureDefaults.minVideoBitrate), CaptureDefaults.maxVideoBitrate)
    }

    private static func evenFloor(_ value: Double) -> Int {
        let floored = Int(value.rounded(.down))
        return max(2, floored - floored % 2)
    }
}
