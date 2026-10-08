// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CaptureHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "screenrx-capture", targets: ["screenrx-capture"]),
        .executable(name: "screenrx-transcribe", targets: ["screenrx-transcribe"]),
        .executable(name: "screenrx-track", targets: ["screenrx-track"]),
    ],
    targets: [
        // Pure logic (clock, geometry, telemetry, wire protocol) with no
        // capture framework dependencies, so it can be unit tested.
        .target(name: "CaptureCore"),
        .executableTarget(
            name: "screenrx-capture",
            dependencies: ["CaptureCore"]),
        // Speech-to-text for captions. A separate executable: it must never
        // share a process (or an executable identity) with a running capture.
        .executableTarget(name: "screenrx-transcribe"),
        // Follows an object through a video (Vision), for the frame that tracks it. Separate for the same reason.
        .executableTarget(name: "screenrx-track"),
        .testTarget(name: "CaptureCoreTests", dependencies: ["CaptureCore"]),
    ]
)
