import AppKit
import AVFoundation

// Runs only when explicitly requested by the development acceptance command.
// No permission requests, saved audio/images, network calls, or TCC changes.
@MainActor
enum DesktopPermissionCheck {
    static func run() async {
        var result: [String: Any] = [
            "bundlePath": Bundle.main.bundleURL.path,
            "buildID": Bundle.main.object(forInfoDictionaryKey: "CleoBuildID") as? String ?? "legacy",
            "pid": ProcessInfo.processInfo.processIdentifier, "parentPID": getppid(),
            "microphoneAuthorized": AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
            "screenAuthorized": CGPreflightScreenCaptureAccess()
        ]
        if result["screenAuthorized"] as? Bool == true, let screen = NSScreen.main {
            do {
                let image = try await ScreenPassageCapture.image(region: screen.frame, screen: screen)
                result["screenCaptured"] = image.width > 0 && image.height > 0
                result["screenWidth"] = image.width; result["screenHeight"] = image.height
            } catch { result["screenErrorCode"] = (error as NSError).code }
        }
        if result["microphoneAuthorized"] as? Bool == true {
            let audio = VoiceAudio()
            var bytes = 0
            audio.onInput = { bytes += $0.count }
            do {
                try audio.start()
                try await Task.sleep(for: .seconds(2))
                result["microphoneBytes"] = bytes
                result["microphoneCaptured"] = bytes > 0
            } catch { result["microphoneErrorCode"] = (error as NSError).code }
            audio.stop()
        }
        result["passed"] = result["screenCaptured"] as? Bool == true && result["microphoneCaptured"] as? Bool == true
        if let workspace = Bundle.main.object(forInfoDictionaryKey: "CleoWorkspace") as? String,
           let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
            let path = URL(fileURLWithPath: workspace).appendingPathComponent(".local/desktop-permission-check.json")
            try? data.write(to: path, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        }
    }
}
