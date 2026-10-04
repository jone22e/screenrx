// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CaptureHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "screenrx-capture", targets: ["screenrx-capture"])
    ],
    targets: [
        // Pure logic (clock, geometry, telemetry, wire protocol) with no
        // capture framework dependencies, so it can be unit tested.
        .target(name: "CaptureCore"),
        .executableTarget(
            name: "screenrx-capture",
            dependencies: ["CaptureCore"]),
        .testTarget(name: "CaptureCoreTests", dependencies: ["CaptureCore"]),
    ]
)
