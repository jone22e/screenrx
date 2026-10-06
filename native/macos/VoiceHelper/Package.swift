// swift-tools-version: 6.2
import PackageDescription

// The voice helper: speech in the user's own voice, in another language, for
// dubbing. It is a package of its own because it pulls in MLX and a speech
// model runtime — minutes to compile — which the capture helper must never
// depend on or wait for.
let package = Package(
    name: "VoiceHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "screenrx-dub", targets: ["screenrx-dub"])
    ],
    dependencies: [
        // The speech runtime, fetched at a pinned revision and patched by
        // scripts/build-voice.mjs (see patches/).
        .package(path: "Vendor/mlx-audio-swift"),
        // The versions that revision was built and tested with. Newer ones change
        // calls it makes, and it stops compiling.
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.31.4"),
        .package(url: "https://github.com/ml-explore/mlx-swift-lm.git", exact: "3.31.4"),
        .package(url: "https://github.com/huggingface/swift-huggingface.git", exact: "0.8.1"),
        .package(url: "https://github.com/huggingface/swift-transformers.git", exact: "1.1.9"),
    ],
    targets: [
        // Pure logic with no model dependencies, so it can be unit tested.
        .target(name: "VoiceCore", swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(
            name: "screenrx-dub",
            dependencies: [
                "VoiceCore",
                .product(name: "MLXAudioTTS", package: "mlx-audio-swift"),
                .product(name: "MLXAudioCore", package: "mlx-audio-swift"),
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "HuggingFace", package: "swift-huggingface"),
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "VoiceCoreTests", dependencies: ["VoiceCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
