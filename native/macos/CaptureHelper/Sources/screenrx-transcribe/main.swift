import AVFoundation
import Foundation
import NaturalLanguage
import Speech

// screenrx-transcribe: turns one audio track into words with their times.
//
//   screenrx-transcribe --input <audio file> --locale <BCP 47 id>
//   screenrx-transcribe --detect --input <short clip> --locales <id,id,…>
//
// Detecting: the clip is transcribed in each candidate language whose model
// is already on this Mac, and the text that reads as its own language best
// wins. Output:
//
//   {"type":"candidate","locale":"en-US","installed":true,"confidence":0.91,"words":48}
//   {"type":"detected","locale":"en-US"}   (locale null when no candidate could be scored)
//   {"type":"done"}
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
    var locale: String?
    var installed: Bool?
    var confidence: Double?
    var count: Int?
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
func supportedLocale(_ localeId: String) async -> Locale? {
    let wanted = Locale(identifier: localeId).identifier(.bcp47)
    return await SpeechTranscriber.supportedLocales.first(where: { $0.identifier(.bcp47) == wanted })
}

func openAudio(_ input: URL) -> AVAudioFile {
    do {
        return try AVAudioFile(forReading: input)
    } catch {
        fail("unreadable-audio", String(describing: error))
    }
}

/// Runs the recognizer over the whole file; each batch of words goes to `report` as it comes.
@available(macOS 26.0, *)
func recognize(file: AVAudioFile, locale: Locale, report: @escaping ([Word], Double) -> Void) async throws {
    let durationSeconds = Double(file.length) / file.fileFormat.sampleRate
    let transcriber = SpeechTranscriber(
        locale: locale,
        transcriptionOptions: [],
        reportingOptions: [],
        attributeOptions: [.audioTimeRange])

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
            report(words, fraction)
        }
    }

    if let lastSample = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: lastSample)
    } else {
        await analyzer.cancelAndFinishNow()
    }
    try await results.value
}

@available(macOS 26.0, *)
func transcribe(input: URL, localeId: String) async {
    emit(Message(type: "status", state: "preparing"))
    guard let locale = await supportedLocale(localeId) else {
        fail("unsupported-locale", localeId)
    }
    let file = openAudio(input)
    do {
        try await recognize(file: file, locale: locale) { words, fraction in
            emit(Message(type: "words", words: words, fraction: fraction))
        }
        emit(Message(type: "done"))
    } catch {
        fail("failed", String(describing: error))
    }
}

/// How much `text` reads as the language of `locale`, 0…1, by the system's language recognizer.
func languageConfidence(of text: String, for locale: Locale) -> Double {
    guard let code = locale.language.languageCode?.identifier else { return 0 }
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)
    let hypotheses = recognizer.languageHypotheses(withMaximum: 5)
    return hypotheses
        .filter { $0.key.rawValue == code || $0.key.rawValue.hasPrefix("\(code)-") }
        .map(\.value)
        .max() ?? 0
}

/// Enough words for the language recognizer to be worth listening to.
let detectionWordsForFullScore = 12.0

/**
 Which of the candidate languages the clip is spoken in. Each candidate whose
 model is on this Mac transcribes the clip; the one whose text the language
 recognizer most agrees with wins. A candidate without its model cannot be
 tried (downloading them all would take long) and is reported as not installed.
 */
@available(macOS 26.0, *)
func detect(input: URL, localeIds: [String]) async {
    emit(Message(type: "status", state: "preparing"))
    // Opened once up front so an unreadable clip fails before any model is touched.
    _ = openAudio(input)
    var best: (locale: String, score: Double)? = nil

    // The languages whose models are on this Mac, as the system lists them.
    let installed = Set(await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) })

    for localeId in localeIds {
        guard let locale = await supportedLocale(localeId) else {
            emit(Message(type: "candidate", detail: "unsupported", locale: localeId, installed: false))
            continue
        }
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
        let status = await AssetInventory.status(forModules: [transcriber])
        guard installed.contains(locale.identifier(.bcp47)) || status == .installed else {
            emit(Message(type: "candidate", detail: "status \(String(describing: status))", locale: localeId, installed: false))
            continue
        }
        var collected: [Word] = []
        do {
            // A fresh read for every language: the analyzer consumes the file.
            try await recognize(file: openAudio(input), locale: locale) { words, _ in collected.append(contentsOf: words) }
        } catch {
            emit(Message(type: "candidate", detail: String(describing: error), locale: localeId, installed: true, confidence: 0, count: 0))
            continue
        }
        let text = collected.map(\.text).joined(separator: " ")
        let confidence = languageConfidence(of: text, for: locale)
        let score = confidence * min(1, Double(collected.count) / detectionWordsForFullScore)
        emit(Message(type: "candidate", locale: localeId, installed: true, confidence: confidence, count: collected.count))
        if let current = best, current.score >= score { continue }
        best = (localeId, score)
    }

    let detected: String? = (best?.score ?? 0) > 0 ? best?.locale : nil
    emit(Message(type: "detected", locale: detected))
    emit(Message(type: "done"))
}

guard let inputPath = argument("--input") else {
    fail("failed", "usage: screenrx-transcribe --input <audio file> --locale <id> | --detect --locales <id,…>")
}

if #available(macOS 26.0, *) {
    if CommandLine.arguments.contains("--detect") {
        let ids = (argument("--locales") ?? "").split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if ids.isEmpty { fail("failed", "--detect needs --locales") }
        await detect(input: URL(fileURLWithPath: inputPath), localeIds: ids)
    } else {
        guard let localeId = argument("--locale") else {
            fail("failed", "usage: screenrx-transcribe --input <audio file> --locale <id>")
        }
        await transcribe(input: URL(fileURLWithPath: inputPath), localeId: localeId)
    }
} else {
    fail("unsupported-os", "speech transcription needs macOS 26 or later")
}
