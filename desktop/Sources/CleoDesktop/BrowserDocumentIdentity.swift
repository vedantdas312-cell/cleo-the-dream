import AppKit
import ApplicationServices

// Read-only document identity from the browser surface under the user's pointer.
// Never inspect page links or infer identity from OCR. No permission prompt.
enum BrowserDocumentIdentity {
    @MainActor static var diagnostic: [String: Any] = [:]
    @MainActor static func url(for surface: HoverSurface, at point: CGPoint) -> String? {
        diagnostic = ["status": "unavailable"]
        guard AXIsProcessTrusted(),
              let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, surface.id) as? [[String: Any]],
              let pid = windows.first?[kCGWindowOwnerPID as String] as? pid_t,
              let app = NSRunningApplication(processIdentifier: pid),
              ["com.apple.Safari", "com.google.Chrome", "com.microsoft.edgemac", "org.mozilla.firefox", "com.openai.codex"].contains(app.bundleIdentifier ?? ""),
              let primary = NSScreen.screens.first else { return nil }
        diagnostic["browser"] = app.bundleIdentifier ?? ""
        func attribute(_ node: AXUIElement, _ name: String) -> CFTypeRef? {
            var value: CFTypeRef?
            return AXUIElementCopyAttributeValue(node, name as CFString, &value) == .success ? value : nil
        }
        let root = AXUIElementCreateApplication(pid)
        // Electron/WebKit can need a cold accessibility-tree round trip. A 25 ms
        // deadline incorrectly reports cannotComplete on a readable browser.
        AXUIElementSetMessagingTimeout(root, 0.5)
        var hit: AXUIElement?
        let hitResult = AXUIElementCopyElementAtPosition(root, Float(point.x), Float(primary.frame.maxY-point.y), &hit)
        diagnostic["hitResult"] = hitResult.rawValue
        guard hitResult == .success else { return nil }
        var node = hit, documentURL: URL?, matchedWindow = false
        let deadline = Date().addingTimeInterval(1.5)
        // Use the outermost web area in the hit's ancestry. An embedded Doc in an
        // unrelated page cannot select a matter; sibling tabs/pages are not read.
        for _ in 0..<40 {
            guard let current=node, Date()<deadline else { break }
            AXUIElementSetMessagingTimeout(current, 0.1)
            let role=attribute(current,kAXRoleAttribute) as? String
            diagnostic["lastRole"] = role ?? "missing"
            if role == "AXWebArea" {
                let value=attribute(current,"AXURL")
                documentURL=(value as? URL) ?? (value as? String).flatMap(URL.init(string:))
            }
            if role == kAXWindowRole {
                guard let position=attribute(current,kAXPositionAttribute), let size=attribute(current,kAXSizeAttribute),
                      CFGetTypeID(position)==AXValueGetTypeID(), CFGetTypeID(size)==AXValueGetTypeID() else { return nil }
                var origin=CGPoint.zero, dimensions=CGSize.zero
                guard AXValueGetValue(position as! AXValue,.cgPoint,&origin), AXValueGetValue(size as! AXValue,.cgSize,&dimensions) else { return nil }
                let bounds=CGRect(x:origin.x,y:primary.frame.maxY-origin.y-dimensions.height,width:dimensions.width,height:dimensions.height)
                matchedWindow=abs(bounds.minX-surface.bounds.minX)<3 && abs(bounds.minY-surface.bounds.minY)<3
                    && abs(bounds.width-surface.bounds.width)<3 && abs(bounds.height-surface.bounds.height)<3
                diagnostic["matchedWindow"] = matchedWindow
                break
            }
            guard let parent=attribute(current,kAXParentAttribute), CFGetTypeID(parent)==AXUIElementGetTypeID() else { break }
            node=(parent as! AXUIElement)
        }
        diagnostic["hasURL"] = documentURL != nil
        guard matchedWindow, let url=documentURL, url.scheme=="https", url.host=="docs.google.com", url.user==nil, url.password==nil,
              url.path.range(of:"^/document/d/[A-Za-z0-9_-]+(?:/|$)",options:.regularExpression) != nil else { return nil }
        diagnostic["status"] = "identified"
        return "https://docs.google.com"+url.path
    }
}
