import AppKit

// The parent process may disappear at any time; a write to a closed pipe
// must not kill the helper before it has finalized the recording.
signal(SIGPIPE, SIG_IGN)

let server = CommandServer()

// Terminate gracefully: finish the file, then exit.
let signalSources = [SIGTERM, SIGINT].map { signalNumber -> DispatchSourceSignal in
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler { server.shutdown(reason: "signal \(signalNumber)") }
    source.resume()
    return source
}

// AppKit gives the process a window-server connection (needed for NSScreen,
// ScreenCaptureKit and global mouse monitoring). As an accessory it has no
// Dock icon, no menu bar and no UI of its own.
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
server.start()
application.run()
