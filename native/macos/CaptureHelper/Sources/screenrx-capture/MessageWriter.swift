import CaptureCore
import Foundation

/// Serializes protocol messages to stdout, one JSON document per line.
final class MessageWriter: @unchecked Sendable {
    static let shared = MessageWriter()

    private let lock = NSLock()
    private let output = FileHandle.standardOutput
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return encoder
    }()

    func send<Message: Encodable>(_ message: Message) {
        lock.lock()
        defer { lock.unlock() }
        guard var data = try? encoder.encode(message) else { return }
        data.append(0x0A)
        // The parent may already be gone; SIGPIPE is ignored, so this just fails.
        try? output.write(contentsOf: data)
    }

    func respond<Result: Encodable>(id: String, result: Result) {
        send(SuccessEnvelope(id: id, result: result))
    }

    func fail(id: String, error: HelperError) {
        send(FailureEnvelope(id: id, error: error))
    }

    func emit<Payload: Encodable>(event name: String, payload: Payload) {
        send(EventEnvelope(name: name, payload: payload))
    }
}

/// Structured logger; entries travel over the protocol so the main process
/// can merge them into its own log, in order.
struct Log {
    let scope: String

    func info(_ message: String, _ data: [String: String]? = nil) {
        write("info", message, data)
    }

    func warn(_ message: String, _ data: [String: String]? = nil) {
        write("warn", message, data)
    }

    func error(_ message: String, _ data: [String: String]? = nil) {
        write("error", message, data)
    }

    private func write(_ level: String, _ message: String, _ data: [String: String]?) {
        MessageWriter.shared.send(LogEnvelope(level: level, scope: scope, message: message, data: data))
    }
}
