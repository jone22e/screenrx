import AVFoundation
import Foundation
import Vision

// screenrx-track: follows one object through a video and reports where it is.
//
//   screenrx-track --input <video> --start-ms <n> --rect <x,y,w,h> [--end-ms <n>]
//
// The rectangle is where the object is at --start-ms, normalized to the frame
// with the origin at the top left. Tracking runs on this Mac (Vision); the
// video never leaves it. One JSON line per event on stdout:
//
//   {"type":"status","state":"preparing" | "tracking"}
//   {"type":"sample","timeMs":1234,"x":0.52,"y":0.41,"w":0.1,"h":0.08,"confidence":0.93}
//   {"type":"progress","fraction":0.3}
//   {"type":"lost","timeMs":5678}        the object could not be followed any further
//   {"type":"done"}
//   {"type":"error","code":"unreadable-video" | "bad-arguments" | "failed","detail":"…"}
//
// A separate executable, like the transcriber: it must never share a process
// with a running capture. Cancelling is terminating the process.

struct Message: Encodable {
    let type: String
    var state: String?
    var timeMs: Double?
    var x: Double?
    var y: Double?
    var w: Double?
    var h: Double?
    var confidence: Double?
    var fraction: Double?
    var code: String?
    var detail: String?
}

func emit(_ message: Message) {
    guard var line = try? JSONEncoder().encode(message) else { return }
    line.append(0x0A)
    FileHandle.standardOutput.write(line)
}

func fail(_ code: String, _ detail: String) -> Never {
    emit(Message(type: "error", code: code, detail: detail))
    exit(1)
}

func argument(_ name: String) -> String? {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

/// Frames in a row the tracker may be unsure about before the object counts as lost.
let lostFramesLimit = 20
/// Below this the tracker's own confidence is treated as not knowing.
let minimumConfidence: Float = 0.3
/// How often progress is reported, in frames.
let progressEvery = 15

func track(input: URL, startMs: Double, endMs: Double?, rect: CGRect) async {
    emit(Message(type: "status", state: "preparing"))
    let asset = AVURLAsset(url: input)
    guard let videoTrack = try? await asset.loadTracks(withMediaType: .video).first,
          let duration = try? await asset.load(.duration) else {
        fail("unreadable-video", "no video track in \(input.path)")
    }
    let durationMs = duration.seconds * 1000
    let stopMs = min(endMs ?? durationMs, durationMs)
    guard stopMs > startMs else { fail("bad-arguments", "nothing to track after \(startMs) ms") }

    let reader: AVAssetReader
    do {
        reader = try AVAssetReader(asset: asset)
    } catch {
        fail("unreadable-video", String(describing: error))
    }
    reader.timeRange = CMTimeRange(
        start: CMTime(seconds: startMs / 1000, preferredTimescale: 600),
        end: CMTime(seconds: stopMs / 1000, preferredTimescale: 600))
    let output = AVAssetReaderTrackOutput(
        track: videoTrack,
        outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    output.alwaysCopiesSampleData = false
    reader.add(output)
    guard reader.startReading() else {
        fail("unreadable-video", String(describing: reader.error))
    }

    // Vision's rectangles have their origin at the bottom left.
    let visionRect = CGRect(x: rect.minX, y: 1 - rect.maxY, width: rect.width, height: rect.height)
    let request = VNTrackObjectRequest(detectedObjectObservation: VNDetectedObjectObservation(boundingBox: visionRect))
    request.trackingLevel = .accurate
    let handler = VNSequenceRequestHandler()

    emit(Message(type: "status", state: "tracking"))
    var unsure = 0
    var frames = 0
    while let sample = output.copyNextSampleBuffer() {
        guard let pixels = CMSampleBufferGetImageBuffer(sample) else { continue }
        let timeMs = CMSampleBufferGetPresentationTimeStamp(sample).seconds * 1000
        do {
            try handler.perform([request], on: pixels, orientation: .up)
        } catch {
            fail("failed", String(describing: error))
        }
        guard let observation = request.results?.first as? VNDetectedObjectObservation else {
            emit(Message(type: "lost", timeMs: timeMs))
            break
        }
        let box = observation.boundingBox
        emit(Message(
            type: "sample",
            timeMs: timeMs,
            x: box.midX,
            y: 1 - box.midY,
            w: box.width,
            h: box.height,
            confidence: Double(observation.confidence)))
        if observation.confidence < minimumConfidence {
            unsure += 1
            if unsure >= lostFramesLimit {
                emit(Message(type: "lost", timeMs: timeMs))
                break
            }
        } else {
            unsure = 0
        }
        request.inputObservation = observation
        frames += 1
        if frames % progressEvery == 0 {
            emit(Message(type: "progress", fraction: min(1, (timeMs - startMs) / (stopMs - startMs))))
        }
    }
    reader.cancelReading()
    emit(Message(type: "done"))
}

guard let inputPath = argument("--input"), let startText = argument("--start-ms"), let rectText = argument("--rect"),
      let startMs = Double(startText) else {
    fail("bad-arguments", "usage: screenrx-track --input <video> --start-ms <n> --rect <x,y,w,h> [--end-ms <n>]")
}
let parts = rectText.split(separator: ",").compactMap { Double($0) }
guard parts.count == 4, parts[2] > 0, parts[3] > 0 else { fail("bad-arguments", "rect must be x,y,w,h") }
let endMs = argument("--end-ms").flatMap(Double.init)
await track(
    input: URL(fileURLWithPath: inputPath),
    startMs: startMs,
    endMs: endMs,
    rect: CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3]))
