import AppKit
import SwiftUI
import WebKit
import CleoPresentation

@MainActor
final class NotepadState: ObservableObject {
    // Screen observations are internal grounding; they are not another UI tab.
    @Published var lines: [PassageLine] = []
    @Published var isCurrent = false
    @Published var notice = ""
    @Published var voiceActive = false
}

@MainActor
final class NotepadPanel {
    let state = NotepadState()
    let sketch = SketchCanvas(root: Bundle.main.object(forInfoDictionaryKey: "CleoWorkspace") as? String ?? FileManager.default.currentDirectoryPath)
    private let window: NSPanel

    init() {
        window = NSPanel(contentRect: CGRect(x: 0, y: 0, width: 470, height: 680),
                         styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: false)
        window.title = "Cleo · Sketchbook"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            window.standardWindowButton(button)?.isHidden = true
        }
        window.minSize = CGSize(width: 390, height: 470)
        window.isFloatingPanel = true
        window.isMovableByWindowBackground = true
        window.level = .floating
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.contentView = NSHostingView(rootView: NotepadView(sketch: sketch, close: { [weak self] in self?.hide() })
            .preferredColorScheme(.light))
    }

    func show(on screen: NSScreen?, activate: Bool = true) {
        if !window.isVisible, let screen {
            let area = screen.visibleFrame
            window.setFrameOrigin(CGPoint(x: max(area.minX, area.maxX - window.frame.width - 24),
                                          y: max(area.minY, area.midY - window.frame.height / 2)))
        }
        if activate { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil) }
        else { window.orderFrontRegardless() }
    }

    func hide() {
        window.orderOut(nil)
        Task { await sketch.call("pause") }
    }
    var frame: CGRect? { window.isVisible ? window.frame : nil }
}

private struct SketchCanvasView: NSViewRepresentable {
    let sketch: SketchCanvas
    func makeNSView(context: Context) -> WKWebView { sketch.view }
    func updateNSView(_ view: WKWebView, context: Context) {}
}

private struct NotepadView: View {
    let sketch: SketchCanvas
    let close: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Cleo").font(.system(size: 13))
                Spacer()
                Button(action: close) { Image(systemName: "xmark").font(.system(size: 14, weight: .semibold)).frame(width: 30, height: 30) }
                    .buttonStyle(.plain).accessibilityLabel("Close sketchbook").help("Close sketchbook")
            }
            .foregroundStyle(Color(red: 0.384, green: 0.435, blue: 0.380))
            .padding(.horizontal, 22).padding(.top, 20).padding(.bottom, 4)
            SketchCanvasView(sketch: sketch)
        }
        .background(Color(red: 0.988, green: 0.984, blue: 0.965))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
