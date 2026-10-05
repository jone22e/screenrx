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

    public static func bitrate(channels: Int) -> Int {
        CaptureDefaults.audioBitratePerChannel * channels
    }
}
