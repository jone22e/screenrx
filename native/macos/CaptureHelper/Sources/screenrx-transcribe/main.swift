import AVFoundation
import Foundation
import Speech

// screenrx-transcribe: turns one audio track into words with their times.
//
//   screenrx-transcribe --input <audio file> --locale <BCP 47 id>
//
// Recognition runs on this Mac (SpeechAnalyzer); the audio never leaves it.
// Progress and results are written to stdout as JSON lines:
//
//   {"type":"status","state":"preparing" | "downloading" | "transcribing"}
//   {"type":"words","words":[{"text":"Olá","startMs":0,"endMs":420}],"fraction":0.12}
//   {"type":"done"}
//   {"type":"error","code":"unsupported-os" | "unsupported-locale" | "unreadable-audio" | "failed","detail":"…"}
//
// It is a separate executable from the capture helper on purpose: macOS ties
// a capture stream to its executable, and a transcription must never be able
// to disturb a recording. Cancelling is terminating the process.

struct Word: Encodable {
    let text: String
    let startMs: Double
    let endMs: Double
}

struct Message: Encodable {
    let type: String
    var state: String?
    var words: [Word]?
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

@available(macOS 26.0, *)
func transcribe(input: URL, localeId: String) async {
    emit(Message(type: "status", state: "preparing"))

    let wanted = Locale(identifier: localeId).identifier(.bcp47)
    let supported = await SpeechTranscriber.supportedLocales
    guard let locale = supported.first(where: { $0.identifier(.bcp47) == wanted }) else {
        fail("unsupported-locale", wanted)
    }

    let file: AVAudioFile
    do {
        file = try AVAudioFile(forReading: input)
    } catch {
        fail("unreadable-audio", String(describing: error))
    }
    let durationSeconds = Double(file.length) / file.fileFormat.sampleRate

    let transcriber = SpeechTranscriber(
        locale: locale,
        transcriptionOptions: [],
        reportingOptions: [],
        attributeOptions: [.audioTimeRange])

    do {
        // The language model is downloaded by the system the first time a language is used.
        if await AssetInventory.status(forModules: [transcriber]) != .installed {
            emit(Message(type: "status", state: "downloading"))
        }
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }

        emit(Message(type: "status", state: "transcribing"))
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let results = Task {
            for try await result in transcriber.results {
                var words: [Word] = []
                for run in result.text.runs {
                    guard let range = run.audioTimeRange else { continue }
                    words.append(
                        Word(
                            text: String(result.text[run.range].characters),
                            startMs: range.start.seconds * 1000,
                            endMs: range.end.seconds * 1000))
                }
                guard let last = words.last else { continue }
                let fraction = durationSeconds > 0 ? min(last.endMs / 1000 / durationSeconds, 1) : 1
                emit(Message(type: "words", words: words, fraction: fraction))
            }
        }

        if let lastSample = try await analyzer.analyzeSequence(from: file) {
            try await analyzer.finalizeAndFinish(through: lastSample)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        try await results.value
        emit(Message(type: "done"))
    } catch {
        fail("failed", String(describing: error))
    }
}

guard let inputPath = argument("--input"), let localeId = argument("--locale") else {
    fail("failed", "usage: screenrx-transcribe --input <audio file> --locale <id>")
}

if #available(macOS 26.0, *) {
    await transcribe(input: URL(fileURLWithPath: inputPath), localeId: localeId)
} else {
    fail("unsupported-os", "speech transcription needs macOS 26 or later")
}
