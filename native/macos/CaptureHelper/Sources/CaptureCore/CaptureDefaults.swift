/// Tunables of the capture pipeline, kept in one place.
public enum CaptureDefaults {
    /// Bumped whenever the JSON protocol with the Electron main process changes shape.
    public static let protocolVersion = 2

    /// H.264 level 5.1/5.2 frame-size ceiling (4096x2304). Larger sources
    /// (5K/6K displays) are scaled down to fit before encoding.
    public static let maxEncodedPixels = 4096 * 2304
    public static let maxEncodedSide = 4096

    /// Screen content is mostly static, so a modest bits-per-pixel budget
    /// yields a visually lossless editing master.
    public static let bitsPerPixelPerFrame = 0.08
    public static let minVideoBitrate = 6_000_000
    public static let maxVideoBitrate = 50_000_000

    /// Short GOP keeps scrubbing in the editor responsive.
    public static let keyFrameIntervalSeconds = 1

    /// MP4 track timescale (MPEG's customary 90 kHz).
    public static let mediaTimeScale: Int32 = 90_000

    public static let audioSampleRate = 48_000.0
    public static let audioBitratePerChannel = 96_000

    /// Number of surfaces ScreenCaptureKit keeps in flight.
    public static let streamQueueDepth = 6

    /// How long `recording.start` waits for the first complete frame.
    public static let firstFrameTimeoutSeconds = 5.0

    /// How long to wait for ScreenCaptureKit to acknowledge a stop.
    public static let stopStreamTimeoutSeconds = 3.0

    public static let supportedFrameRates = 1...120

    public static let thumbnailJpegQuality = 0.7
    public static let maxListedWindows = 60
    public static let minListedWindowSidePoints = 80.0
}
