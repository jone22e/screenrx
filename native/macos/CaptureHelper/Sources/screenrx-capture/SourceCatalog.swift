import AppKit
import CaptureCore
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// Enumerates the displays and windows that can be recorded.
enum SourceCatalog {
    private static let log = Log(scope: "capture")

    static func list(_ params: SourcesListParams) async throws -> SourcesListResult {
        guard Permissions.screenRecordingGranted else {
            throw HelperError(.permissionDenied, "Screen Recording permission has not been granted")
        }

        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        } catch {
            throw HelperError(.captureFailed, "Could not enumerate shareable content: \(error.localizedDescription)")
        }

        let excludedPids = Set(params.excludePids)
        let excludedApps = content.applications.filter { excludedPids.contains($0.processID) }
        let screens = await screenDescriptions()

        let displays = await withTaskGroup(of: (Int, DisplayInfo).self) { group in
            for (index, display) in orderedDisplays(content.displays).enumerated() {
                group.addTask {
                    let filter = SCContentFilter(
                        display: display, excludingApplications: excludedApps, exceptingWindows: [])
                    let screen = screens[display.displayID]
                    let scale = Double(filter.pointPixelScale)
                    let info = DisplayInfo(
                        displayId: display.displayID,
                        name: screen?.name ?? "Display \(index + 1)",
                        isMain: display.displayID == CGMainDisplayID(),
                        widthPx: Int((Double(display.width) * scale).rounded()),
                        heightPx: Int((Double(display.height) * scale).rounded()),
                        scaleFactor: scale,
                        thumbnailDataUrl: await thumbnail(filter: filter, maxWidth: params.thumbnailMaxWidth)
                    )
                    return (index, info)
                }
            }
            return await collectOrdered(group)
        }

        guard params.includeWindows else {
            return SourcesListResult(displays: displays, windows: [])
        }

        let candidates = recordableWindows(content.windows, excludedPids: excludedPids)
        let windows = await withTaskGroup(of: (Int, WindowInfo).self) { group in
            for (index, window) in candidates.enumerated() {
                group.addTask {
                    let filter = SCContentFilter(desktopIndependentWindow: window)
                    let scale = Double(filter.pointPixelScale)
                    let info = WindowInfo(
                        windowId: window.windowID,
                        title: window.title ?? "",
                        appName: window.owningApplication?.applicationName ?? "",
                        bundleId: window.owningApplication?.bundleIdentifier ?? "",
                        displayId: displayContaining(window, in: content.displays),
                        widthPx: Int((window.frame.width * scale).rounded()),
                        heightPx: Int((window.frame.height * scale).rounded()),
                        thumbnailDataUrl: await thumbnail(filter: filter, maxWidth: params.thumbnailMaxWidth)
                    )
                    return (index, info)
                }
            }
            return await collectOrdered(group)
        }

        return SourcesListResult(displays: displays, windows: windows)
    }

    // MARK: - Filtering and ordering

    /// Main display first, then by identifier, so "Display 1" is stable.
    static func orderedDisplays(_ displays: [SCDisplay]) -> [SCDisplay] {
        let mainId = CGMainDisplayID()
        return displays.sorted { lhs, rhs in
            if (lhs.displayID == mainId) != (rhs.displayID == mainId) {
                return lhs.displayID == mainId
            }
            return lhs.displayID < rhs.displayID
        }
    }

    /// Regular application windows the user would recognise: normal layer,
    /// titled, reasonably sized, and not owned by the recorder itself.
    private static func recordableWindows(_ windows: [SCWindow], excludedPids: Set<Int32>) -> [SCWindow] {
        let minSide = CaptureDefaults.minListedWindowSidePoints
        let filtered = windows.filter { window in
            guard let app = window.owningApplication else { return false }
            guard window.windowLayer == 0, window.isOnScreen else { return false }
            guard !excludedPids.contains(app.processID) else { return false }
            guard !(window.title ?? "").isEmpty, !app.applicationName.isEmpty else { return false }
            return window.frame.width >= minSide && window.frame.height >= minSide
        }
        let sorted = filtered.sorted { lhs, rhs in
            let lhsApp = lhs.owningApplication?.applicationName ?? ""
            let rhsApp = rhs.owningApplication?.applicationName ?? ""
            if lhsApp != rhsApp {
                return lhsApp.localizedCaseInsensitiveCompare(rhsApp) == .orderedAscending
            }
            return (lhs.title ?? "").localizedCaseInsensitiveCompare(rhs.title ?? "") == .orderedAscending
        }
        return Array(sorted.prefix(CaptureDefaults.maxListedWindows))
    }

    private static func displayContaining(_ window: SCWindow, in displays: [SCDisplay]) -> UInt32? {
        let center = CGPoint(x: window.frame.midX, y: window.frame.midY)
        return displays.first { $0.frame.contains(center) }?.displayID
    }

    private static func collectOrdered<Value>(_ group: TaskGroup<(Int, Value)>) async -> [Value] {
        var indexed: [(Int, Value)] = []
        for await item in group {
            indexed.append(item)
        }
        return indexed.sorted { $0.0 < $1.0 }.map(\.1)
    }

    // MARK: - Screen names

    private struct ScreenDescription {
        let name: String
    }

    @MainActor
    private static func screenDescriptions() -> [CGDirectDisplayID: ScreenDescription] {
        var result: [CGDirectDisplayID: ScreenDescription] = [:]
        for screen in NSScreen.screens {
            let key = NSDeviceDescriptionKey("NSScreenNumber")
            guard let number = screen.deviceDescription[key] as? NSNumber else { continue }
            result[number.uint32Value] = ScreenDescription(name: screen.localizedName)
        }
        return result
    }

    // MARK: - Thumbnails

    private static func thumbnail(filter: SCContentFilter, maxWidth: Int?) async -> String? {
        guard let maxWidth, maxWidth > 0 else { return nil }
        let rect = filter.contentRect
        guard rect.width > 0, rect.height > 0 else { return nil }

        let configuration = SCStreamConfiguration()
        let width = min(Double(maxWidth), rect.width * Double(filter.pointPixelScale))
        configuration.width = max(2, Int(width.rounded()))
        configuration.height = max(2, Int((width * rect.height / rect.width).rounded()))
        configuration.showsCursor = false

        do {
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: configuration)
            return jpegDataUrl(image)
        } catch {
            // A window can disappear between enumeration and capture; the
            // source is still listed, just without a preview.
            log.warn("thumbnail capture failed", ["error": error.localizedDescription])
            return nil
        }
    }

    private static func jpegDataUrl(_ image: CGImage) -> String? {
        let data = NSMutableData()
        guard
            let destination = CGImageDestinationCreateWithData(
                data, UTType.jpeg.identifier as CFString, 1, nil)
        else { return nil }
        let options = [kCGImageDestinationLossyCompressionQuality: CaptureDefaults.thumbnailJpegQuality]
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return "data:image/jpeg;base64," + (data as Data).base64EncodedString()
    }
}
