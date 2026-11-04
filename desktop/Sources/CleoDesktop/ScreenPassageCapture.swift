import AppKit
import ScreenCaptureKit
import CleoPresentation

enum ScreenPassageError: LocalizedError {
    case unavailable, permission, display, selection
    var errorDescription: String? {
        switch self {
        case .unavailable: return "Screen passage capture needs macOS 14 or later."
        case .permission: return "macOS denied screen access. Check Cleo in System Settings → Privacy & Security → Screen Recording, then reopen Cleo."
        case .display: return "That display is no longer available. Hover over the passage again."
        case .selection: return "Hover farther inside the document window."
        }
    }
}

enum ScreenPassageCapture {
    @MainActor static func fixturePoint() async throws -> CGPoint {
        let windows = try await content().windows
        guard let primary = NSScreen.screens.first,
              let window = windows.first(where: { $0.title == "Cleo — synthetic agreement for pointing check" }) else {
            throw NSError(domain: "CleoFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Example agreement is missing from shareable windows"])
        }
        let point = CGPoint(x: window.frame.midX, y: primary.frame.maxY-window.frame.midY)
        let front = HoverSurface.under(point)
        guard front?.id == window.windowID else {
            throw NSError(domain: "CleoFixture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Example agreement is covered (expected \(window.windowID), front \(front?.id ?? 0))"])
        }
        return point
    }
    // Ask ScreenCaptureKit itself. The older CG
    // preflight flag can disagree with the actual capture API after development rebuilds.
    @MainActor static func checkAccess() async throws {
        _ = try await content()
    }

    private static func content() async throws -> SCShareableContent {
        do { return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
        catch {
            let failure = error as NSError
            if failure.domain == SCStreamError.errorDomain && failure.code == SCStreamError.Code.userDeclined.rawValue {
                throw ScreenPassageError.permission
            }
            throw error
        }
    }

    @MainActor static func image(region: CGRect, screen: NSScreen) async throws -> CGImage {
        guard #available(macOS 14.0, *) else { throw ScreenPassageError.unavailable }
        guard let crop = PassageGeometry.captureRect(region, display: screen.frame) else { throw ScreenPassageError.selection }
        let content = try await content()
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
              let display = content.displays.first(where: { $0.displayID == number.uint32Value }) else { throw ScreenPassageError.display }
        let ownWindows = content.windows.filter { $0.owningApplication?.processID == ProcessInfo.processInfo.processIdentifier }
        let configuration = SCStreamConfiguration()
        configuration.sourceRect = crop
        let scale = min(screen.backingScaleFactor, 2)
        configuration.width = max(1, Int(crop.width * scale))
        configuration.height = max(1, Int(crop.height * scale))
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        return try await SCScreenshotManager.captureImage(
            contentFilter: SCContentFilter(display: display, excludingWindows: ownWindows), configuration: configuration)
    }
}
