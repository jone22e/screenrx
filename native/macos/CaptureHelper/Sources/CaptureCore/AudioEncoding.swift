/// How a recorded audio track is encoded, whatever the device delivers.
public enum AudioEncoding {
    /// Sample rates a track is written at as they come.
    static let nativeSampleRates: Set<Double> = [44_100, 48_000]

    /// The sample rate a track is written at.
    ///
    /// Studio rates are kept. Anything else is resampled to the default: a
    /// Bluetooth headset's microphone delivers 16 kHz (8 or 24 kHz on some),
    /// and AAC at such a rate does not accept the bitrate used here — the
    /// encoder refuses to start and the track would be lost.
    public static func sampleRate(forSource sourceRate: Double) -> Double {
        nativeSampleRates.contains(sourceRate) ? sourceRate : CaptureDefaults.audioSampleRate
    }

    /// Mono stays mono; anything wider is written as stereo.
    public static func channels(forSource sourceChannels: Int) -> Int {
        min(2, max(1, sourceChannels))
    }

    /// A hole in the audio shorter than this is left alone: devices stamp
    /// buffers with a little jitter, and that is not missing audio.
    public static let gapToleranceSeconds = 0.010

    /// The longest hole that is filled with silence. A longer one means the
    /// device stopped delivering; pretending it was silent would hide that.
    public static let maxFilledGapSeconds = 30.0

    /// How much silence to write before a buffer so the track has no hole:
    /// the time between where the audio written so far ends and where the
    /// buffer begins. Zero when the two meet, or when the hole is too long
    /// to be a hole.
    ///
    /// Audio arrives late at the start of a recording (the device is still
    /// waking up) and loses a buffer around every pause. A file cannot hold
    /// "nothing" for those stretches — written as it comes, everything after
    /// a hole would play that much too early.
    public static func silenceToFill(writtenUntilSeconds: Double, bufferStartSeconds: Double) -> Double {
        let gap = bufferStartSeconds - writtenUntilSeconds
        return gap > gapToleranceSeconds && gap <= maxFilledGapSeconds ? gap : 0
    }

    public static func bitrate(channels: Int) -> Int {
        CaptureDefaults.audioBitratePerChannel * channels
    }
}
