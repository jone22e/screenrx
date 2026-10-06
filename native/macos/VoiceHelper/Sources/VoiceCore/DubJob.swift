import Foundation

/// One stretch of speech to synthesize.
public struct DubJob: Codable, Equatable {
    public let id: String
    public let text: String
    /// Where the WAV file is written.
    public let output: String
    /// The longest the speech may last, in seconds: the time until the next
    /// stretch begins. Longer speech is generated faster to fit.
    public let maxDurationS: Double?

    public init(id: String, text: String, output: String, maxDurationS: Double?) {
        self.id = id
        self.text = text
        self.output = output
        self.maxDurationS = maxDurationS
    }
}

/// How long a stretch should be asked to last so it fits its slot.
public enum DubTiming {
    /// A slot shorter than this is not a real slot: the stretch keeps its own pace.
    public static let minimumS = 0.4

    /// The most a stretch is sped up. Past this, speech stops sounding natural,
    /// and running a little over its slot is the lesser problem.
    public static let maxSpeedup = 1.35

    /// The duration to ask the model for, or `nil` to keep what it produced.
    ///
    /// The model's own pace is kept whenever it fits. Speech that runs past
    /// its slot is generated again to last exactly as long as the slot —
    /// unless that would need more than `maxSpeedup`, in which case it is
    /// sped up by that much and no more.
    public static func requestedDuration(naturalS: Double, maxDurationS: Double?) -> Double? {
        guard let maxDurationS, maxDurationS >= minimumS, naturalS > maxDurationS else { return nil }
        return max(maxDurationS, naturalS / maxSpeedup)
    }
}
