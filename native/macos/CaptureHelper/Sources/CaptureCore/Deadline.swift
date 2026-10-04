import Foundation

/// Runs `operation` but stops waiting for it after `seconds`. The operation
/// itself is not cancelled; this only bounds how long the caller is held up
/// by system calls that may never complete.
public func withDeadline(seconds: Double, _ operation: @escaping @Sendable () async -> Void) async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let gate = ResumeOnce(continuation)
        Task {
            await operation()
            gate.resume()
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
            gate.resume()
        }
    }
}

/// Resumes a continuation exactly once, whichever caller gets there first.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?

    init(_ continuation: CheckedContinuation<Void, Never>) {
        self.continuation = continuation
    }

    func resume() {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume()
    }
}
