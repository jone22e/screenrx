import Foundation
import HuggingFace
import MLX
import MLXAudioCore
import MLXAudioTTS
import VoiceCore

// screenrx-dub: speech in a cloned voice, on this Mac.
//
//   screenrx-dub prepare    --models <dir>
//   screenrx-dub synthesize --models <dir> --reference <wav> --reference-text <file>
//                           --language <code> --jobs <json file>
//
// `prepare` downloads the voice model into <dir> (once) and unpacks it;
// `synthesize` speaks each job's text in the voice of the reference recording
// and writes one WAV per job. Nothing is uploaded: the model runs here.
//
// Progress and results are JSON lines on stdout:
//
//   {"type":"status","state":"downloading" | "unpacking" | "loading" | "synthesizing"}
//   {"type":"progress","fraction":0.4}
//   {"type":"item","id":"u1","durationMs":2810}
//   {"type":"done"}
//   {"type":"error","code":"model-missing" | "download-failed" | "bad-arguments" | "failed","detail":"…"}
//
// Cancelling is terminating the process.

/// The voice model: OmniVoice, in the compact conversion for Apple Silicon.
let modelRepository = "mlx-community/OmniVoice-4bit"
/// Written next to the weights once they are unpacked.
let unpackedMarker = ".screenrx-unpacked"

struct Message: Encodable {
    let type: String
    var state: String?
    var fraction: Double?
    var id: String?
    var durationMs: Double?
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

/// Generation settings that can be overridden from the command line, for tuning.
struct Tuning {
    var steps = 32
    var guidance: Float = 2.0
    var seed: UInt64?
}

var tuning = Tuning()

/// Where the model's files live under the models directory (the layout the runtime looks for).
func modelDirectory(in models: URL) -> URL {
    models
        .appendingPathComponent("mlx-audio")
        .appendingPathComponent(modelRepository.replacingOccurrences(of: "/", with: "_"))
}

// MARK: - Unpacking the compact weights

/// Turns the compact ("omnivoice-rowwise") weight file into the plain one the
/// runtime reads. The format is described in `RowwiseWeights`; this is the
/// same decoding, done on whole tensors.
func unpackWeights(in directory: URL) throws {
    let marker = directory.appendingPathComponent(unpackedMarker)
    if FileManager.default.fileExists(atPath: marker.path) { return }

    let manifestURL = directory.appendingPathComponent("mlx_manifest.json")
    guard
        let manifestData = try? Data(contentsOf: manifestURL),
        let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
        let quantization = manifest["quantization"] as? [String: Any],
        quantization["format"] as? String == "omnivoice-rowwise",
        let tensors = quantization["tensors"] as? [String: [String: Any]]
    else {
        // Not a compact conversion: the weights are already plain.
        FileManager.default.createFile(atPath: marker.path, contents: nil)
        return
    }

    emit(Message(type: "status", state: "unpacking"))
    let weightsURL = directory.appendingPathComponent("model.safetensors")
    let stored = try MLX.loadArrays(url: weightsURL)
    var plain: [String: MLXArray] = [:]
    var done = 0

    for (key, array) in stored {
        if key.hasSuffix(".scales") { continue }
        guard let info = tensors[key] else {
            plain[key] = array
            continue
        }
        guard
            let bits = info["bits"] as? Int, RowwiseWeights.supportedBits.contains(bits),
            let groupSize = info["group_size"] as? Int,
            let shape = info["shape"] as? [Int], let columns = shape.last,
            let scales = stored["\(key).scales"]
        else {
            throw NSError(domain: "screenrx-dub", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "cannot unpack \(key): unsupported description"
            ])
        }
        let rows = shape.dropLast().reduce(1, *)
        let groups = RowwiseWeights.groupCount(columns: columns, groupSize: groupSize)

        let integers: MLXArray
        if bits == 4 {
            let packed = array.reshaped([rows, groups, groupSize / 2])
            let low = MLX.remainder(packed, MLXArray(UInt8(16)))
            let high = MLX.floorDivide(packed, MLXArray(UInt8(16)))
            // Low half first: interleave the two along a new last axis.
            integers =
                MLX.stacked([low, high], axis: -1).reshaped([rows, groups, groupSize]).asType(.float32)
                - Float(RowwiseWeights.nibbleOffset)
        } else {
            integers = array.reshaped([rows, groups, groupSize]).asType(.float32)
        }
        let values = (integers * scales.asType(.float32).reshaped([rows, groups, 1]))
            .reshaped([rows, groups * groupSize])[0..., ..<columns]
            .reshaped(shape)
            .asType(.float16)
        MLX.eval(values)
        plain[key] = values

        done += 1
        if done % 20 == 0 { emit(Message(type: "progress", fraction: Double(done) / Double(tensors.count))) }
    }

    // Written beside the original and swapped in, so an interrupted unpack leaves nothing half-done.
    let staged = directory.appendingPathComponent("model.unpacked.safetensors")
    try? FileManager.default.removeItem(at: staged)
    try MLX.save(arrays: plain, url: staged)
    _ = try FileManager.default.replaceItemAt(weightsURL, withItemAt: staged)
    FileManager.default.createFile(atPath: marker.path, contents: nil)
}

// MARK: - Commands

func prepare(models: URL) async {
    do {
        try FileManager.default.createDirectory(at: models, withIntermediateDirectories: true)
        let directory = modelDirectory(in: models)
        let weights = directory.appendingPathComponent("model.safetensors")
        if !FileManager.default.fileExists(atPath: weights.path) {
            emit(Message(type: "status", state: "downloading"))
        }
        guard let repository = Repo.ID(rawValue: modelRepository) else { fail("failed", "bad repository id") }
        let cache = HubCache(cacheDirectory: models)
        _ = try await ModelUtils.resolveOrDownloadModel(
            client: HubClient(cache: cache),
            cache: cache,
            repoID: repository,
            requiredExtension: "safetensors",
            additionalMatchingPatterns: ["audio_tokenizer/*"],
            progressHandler: { progress in
                emit(Message(type: "progress", fraction: progress.fractionCompleted))
            })
        try unpackWeights(in: directory)
        emit(Message(type: "done"))
    } catch {
        fail("download-failed", String(describing: error))
    }
}

func synthesize(models: URL, reference: URL, referenceText: String, language: String, jobs: [DubJob]) async {
    let directory = modelDirectory(in: models)
    guard FileManager.default.fileExists(atPath: directory.appendingPathComponent(unpackedMarker).path) else {
        fail("model-missing", "the voice model has not been downloaded")
    }
    do {
        emit(Message(type: "status", state: "loading"))
        // Bounds the memory MLX keeps for reuse between stretches.
        Memory.cacheLimit = 512 * 1024 * 1024
        let model = try await OmniVoiceModel.fromPretrained(modelRepository, cache: HubCache(cacheDirectory: models))
        let (_, voice) = try loadAudioArray(from: reference, sampleRate: model.sampleRate)

        emit(Message(type: "status", state: "synthesizing"))
        for (index, job) in jobs.enumerated() {
            func speak(duration: Double?) async throws -> [Float] {
                let audio = try await model.generate(
                    text: job.text,
                    refAudio: voice,
                    refText: referenceText,
                    language: language,
                    ovParameters: OmniVoiceGenerateParameters(
                        numStep: tuning.steps,
                        guidanceScale: tuning.guidance,
                        duration: duration.map { Float($0) },
                        seed: tuning.seed))
                return audio.asArray(Float.self)
            }

            var samples = try await speak(duration: nil)
            let naturalS = Double(samples.count) / Double(model.sampleRate)
            // Speech that runs past its slot is spoken again, a little faster, to fit.
            if let fitted = DubTiming.requestedDuration(naturalS: naturalS, maxDurationS: job.maxDurationS) {
                samples = try await speak(duration: fitted)
            }

            let output = URL(fileURLWithPath: job.output)
            try AudioUtils.writeWavFile(samples: samples, sampleRate: model.sampleRate, fileURL: output)
            emit(Message(
                type: "item", id: job.id,
                durationMs: Double(samples.count) / Double(model.sampleRate) * 1000))
            emit(Message(type: "progress", fraction: Double(index + 1) / Double(jobs.count)))
        }
        emit(Message(type: "done"))
    } catch {
        fail("failed", String(describing: error))
    }
}

// Lines are read as they are written, also when stdout is a pipe.
setvbuf(stdout, nil, _IOLBF, 0)

guard CommandLine.arguments.count > 1, let modelsPath = argument("--models") else {
    fail("bad-arguments", "usage: screenrx-dub prepare|synthesize --models <dir> …")
}
let models = URL(fileURLWithPath: modelsPath)
// The runtime looks models up in the Hugging Face cache of the environment,
// whatever cache it is handed: point that at the app's own models directory,
// so nothing is read from or written to the user's personal cache.
setenv("HF_HUB_CACHE", models.path, 1)
setenv("HF_HOME", models.path, 1)

if let steps = argument("--steps").flatMap({ Int($0) }) { tuning.steps = steps }
if let guidance = argument("--guidance").flatMap({ Float($0) }) { tuning.guidance = guidance }
if let seed = argument("--seed").flatMap({ UInt64($0) }) { tuning.seed = seed }

switch CommandLine.arguments[1] {
case "prepare":
    await prepare(models: models)
case "synthesize":
    guard
        let referencePath = argument("--reference"),
        let referenceTextPath = argument("--reference-text"),
        let language = argument("--language"),
        let jobsPath = argument("--jobs"),
        let referenceText = try? String(contentsOfFile: referenceTextPath, encoding: .utf8),
        let jobsData = try? Data(contentsOf: URL(fileURLWithPath: jobsPath)),
        let jobs = try? JSONDecoder().decode([DubJob].self, from: jobsData)
    else {
        fail("bad-arguments", "synthesize needs --reference, --reference-text, --language and --jobs")
    }
    await synthesize(
        models: models,
        reference: URL(fileURLWithPath: referencePath),
        referenceText: referenceText.trimmingCharacters(in: .whitespacesAndNewlines),
        language: language,
        jobs: jobs)
default:
    fail("bad-arguments", "unknown command \(CommandLine.arguments[1])")
}
