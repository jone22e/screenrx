import CoreMedia

/// The host clock (mach absolute time) — the time base ScreenCaptureKit,
/// AVFoundation and CGEvent timestamps all share.
enum HostClock {
    static func nowNs() -> Int64 {
        CMClockGetTime(CMClockGetHostTimeClock()).nanoseconds
    }
}

extension CMTime {
    var nanoseconds: Int64 {
        CMTimeConvertScale(self, timescale: 1_000_000_000, method: .roundHalfAwayFromZero).value
    }

    static func fromNanoseconds(_ ns: Int64, timescale: Int32) -> CMTime {
        CMTimeConvertScale(
            CMTime(value: ns, timescale: 1_000_000_000),
            timescale: timescale,
            method: .roundHalfAwayFromZero
        )
    }
}
