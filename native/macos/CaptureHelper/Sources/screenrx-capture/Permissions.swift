import CoreGraphics
import Darwin

enum Permissions {
    /// Reads the Screen Recording grant without ever prompting.
    ///
    /// The answer is cached per process by the system, so the main process
    /// respawns the helper to observe a grant made after launch.
    static var screenRecordingGranted: Bool {
        CGPreflightScreenCaptureAccess()
    }

    /// Shows the system prompt the first time it is called for this app;
    /// afterwards it only reports the current state.
    static func requestScreenRecording() -> Bool {
        CGRequestScreenCaptureAccess()
    }

    /// Executable of the process macOS holds *responsible* for this one: the
    /// identity privacy permissions are attributed to and listed under in
    /// System Settings. For the packaged app that is the app itself; in
    /// development it is whatever launched it (a terminal, an IDE…).
    ///
    /// The lookup uses a system function that has no public header, so it is
    /// resolved at run time and simply reports `nil` if it ever goes away.
    static var responsibleExecutable: String? {
        typealias ResponsiblePid = @convention(c) (pid_t) -> pid_t
        let defaultHandle = UnsafeMutableRawPointer(bitPattern: -2)  // RTLD_DEFAULT
        guard let symbol = dlsym(defaultHandle, "responsibility_get_pid_responsible_for_pid") else {
            return nil
        }
        let responsiblePid = unsafeBitCast(symbol, to: ResponsiblePid.self)(getpid())
        guard responsiblePid > 0 else { return nil }
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(responsiblePid, &path, UInt32(path.count)) > 0 else { return nil }
        return String(cString: path)
    }
}
