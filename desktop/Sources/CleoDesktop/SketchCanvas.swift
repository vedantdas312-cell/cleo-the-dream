import AppKit
import WebKit

// Trusted, local renderer lives outside the signed shell so UI edits do not change
// its signing identity. Model output is data passed as arguments, never code.
@MainActor
final class SketchCanvas: NSObject, WKNavigationDelegate {
    let view: WKWebView
    private let index: URL
    private var ready = false
    var onActivity: (String, Int) -> Void = { _, _ in }
    init(root: String) {
        index = URL(fileURLWithPath: root).appendingPathComponent("desktop/NotepadWeb/index.html").standardizedFileURL
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        view = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        configuration.userContentController.add(SketchActivityHandler(owner: self), name: "sketchActivity")
        view.navigationDelegate = self
        view.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready = true }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url?.standardizedFileURL == index ? .allow : .cancel)
    }
    func call(_ method: String, payload: [String: Any] = [:]) async -> [String: Any] {
        guard ["read", "stage", "begin", "pause", "pace"].contains(method), JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload), data.count <= 64000 else {
            return ["error": "Invalid sketch request"]
        }
        for _ in 0..<100 {
            if ready { break }
            try? await Task.sleep(for: .milliseconds(30))
        }
        guard ready else { return ["error": "Notepad is still loading"] }
        do {
            return try await view.callAsyncJavaScript("return window.cleoSketch[method](payload)",
                arguments: ["method": method, "payload": payload], in: nil, contentWorld: .page) as? [String: Any]
                ?? ["error": "Notepad did not return a drawing receipt"]
        } catch { return ["error": "Notepad renderer unavailable"] }
    }
}

// WKWebView retains its message handlers, so the handler must not retain the
// canvas. Only the trusted main-frame renderer can report bounded lifecycle data.
@MainActor
private final class SketchActivityHandler: NSObject, WKScriptMessageHandler {
    weak var owner: SketchCanvas?
    init(owner: SketchCanvas) { self.owner = owner }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let data = message.body as? [String: Any],
              let phase = data["phase"] as? String, ["queued", "drawing", "idle"].contains(phase),
              let epoch = data["epoch"] as? Int else { return }
        owner?.onActivity(phase, epoch)
    }
}
