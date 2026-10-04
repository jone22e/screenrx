import AppKit
import CaptureCore

/// Observes the pointer for the duration of a recording: its position at a
/// fixed rate, and every mouse button press and release anywhere on screen.
///
/// Observations are kept raw, stamped with the host clock; they are mapped
/// to recording time when the recording ends, by the same clock that retimed
/// the video. Sampling is therefore independent of the video frame rate.
final class PointerTelemetry: @unchecked Sendable {
    private let log = Log(scope: "cursor")
    private let lock = NSLock()
    private let sampleQueue = DispatchQueue(label: "com.screenrx.capture.pointer", qos: .userInteractive)
    private let ignoredPids: Set<Int32>
    private var timer: DispatchSourceTimer?
    private var monitor: Any?
    private var samples: [RawPointerSample] = []
    private var events: [RawPointerEvent] = []

    /// - Parameter ignoredPids: applications whose windows are not part of the
    ///   recording (the recorder's own HUD); clicks landing on them are dropped.
    init(ignoredPids: [Int32]) {
        self.ignoredPids = Set(ignoredPids)
    }

    func start(sampleRateHz: Int) {
        // A repeating dispatch timer fires on an absolute schedule, so a late
        // tick under load does not push every later tick back (no drift).
        let timer = DispatchSource.makeTimerSource(flags: .strict, queue: sampleQueue)
        timer.schedule(
            deadline: .now(), repeating: .nanoseconds(1_000_000_000 / max(sampleRateHz, 1)),
            leeway: .milliseconds(1))
        timer.setEventHandler { [weak self] in self?.samplePosition() }
        timer.resume()
        self.timer = timer

        let mask: NSEvent.EventTypeMask = [
            .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp,
        ]
        DispatchQueue.main.async {
            // Global monitors see mouse events delivered to every other application.
            self.monitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
                self?.record(event)
            }
            if self.monitor == nil {
                self.log.warn("could not install the global mouse monitor; clicks will not be recorded")
            }
        }
    }

    /// Stops observing and hands back everything collected.
    func stop() -> (samples: [RawPointerSample], events: [RawPointerEvent]) {
        timer?.cancel()
        timer = nil
        DispatchQueue.main.async {
            if let monitor = self.monitor {
                NSEvent.removeMonitor(monitor)
                self.monitor = nil
            }
        }
        lock.lock()
        defer { lock.unlock() }
        return (samples, events)
    }

    private func samplePosition() {
        guard let location = CGEvent(source: nil)?.location else { return }
        let sample = RawPointerSample(hostNs: HostClock.nowNs(), x: location.x, y: location.y)
        lock.lock()
        samples.append(sample)
        lock.unlock()
    }

    /// Runs on the main thread.
    private func record(_ event: NSEvent) {
        guard let location = event.cgEvent?.location ?? CGEvent(source: nil)?.location else { return }
        guard !isOverIgnoredWindow(location) else { return }

        let transition: RawPointerEvent.Transition
        let button: PointerButton
        switch event.type {
        case .leftMouseDown: (transition, button) = (.down, .left)
        case .leftMouseUp: (transition, button) = (.up, .left)
        case .rightMouseDown: (transition, button) = (.down, .right)
        case .rightMouseUp: (transition, button) = (.up, .right)
        case .otherMouseDown: (transition, button) = (.down, event.buttonNumber == 2 ? .middle : .other)
        case .otherMouseUp: (transition, button) = (.up, event.buttonNumber == 2 ? .middle : .other)
        default: return
        }
        // Event timestamps count seconds since boot on the host clock.
        let raw = RawPointerEvent(
            hostNs: Int64(event.timestamp * 1_000_000_000), x: location.x, y: location.y,
            transition: transition, button: button, clickCount: event.clickCount)
        lock.lock()
        events.append(raw)
        lock.unlock()
    }

    /// Whether the topmost window under a global point belongs to an ignored application.
    private func isOverIgnoredWindow(_ point: CGPoint) -> Bool {
        guard !ignoredPids.isEmpty, let mainScreen = NSScreen.screens.first else { return false }
        // AppKit's screen space has its origin at the bottom-left of the main display.
        let appKitPoint = NSPoint(x: point.x, y: mainScreen.frame.height - point.y)
        let windowNumber = NSWindow.windowNumber(at: appKitPoint, belowWindowWithWindowNumber: 0)
        guard windowNumber > 0,
            let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(windowNumber))
                as? [[CFString: Any]],
            let ownerPid = info.first?[kCGWindowOwnerPID] as? Int32
        else { return false }
        return ignoredPids.contains(ownerPid)
    }
}
