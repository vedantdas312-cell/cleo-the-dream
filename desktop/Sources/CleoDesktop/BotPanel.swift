import AppKit
import SwiftUI

final class BotWindow: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class BotPanel {
    let state = BotState()
    private let window: NSPanel
    private var greeting: Task<Void, Never>?
    private var movement: Task<Void, Never>?

    init() {
        window = BotWindow(contentRect: NSRect(x: 0, y: 0, width: 390, height: 60),
                           styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.isMovableByWindowBackground = true
        window.contentView = NSHostingView(rootView: BotView(state: state))
    }

    var frame: CGRect { window.frame }

    func show() {
        cancelMotion()
        park()
        NSApp.unhide(nil)
        window.orderFrontRegardless()
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { state.gaze = 0; return }
        greeting = Task { [weak self] in
            for offset: CGFloat in [-3, 3, 0] {
                guard !Task.isCancelled, let self else { return }
                withAnimation(.easeInOut(duration: 0.18)) { self.state.gaze = offset }
                try? await Task.sleep(for: .milliseconds(240))
            }
        }
    }

    func park() {
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(window.frame.origin) }) ?? NSScreen.main else { return }
        let area = screen.visibleFrame
        place(near: CGPoint(x: area.minX + 20, y: area.minY + 20), on: screen, animated: false)
    }

    func place(near point: CGPoint, on screen: NSScreen, animated: Bool, arrival: @escaping () -> Void = {}) {
        movement?.cancel()
        let available = screen.visibleFrame.insetBy(dx: 10, dy: 10)
        let origin = CGPoint(x: min(max(point.x, available.minX), max(available.minX, available.maxX - 390)),
                             y: min(max(point.y, available.minY), max(available.minY, available.maxY - 60)))
        if animated && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            let start = window.frame.origin
            movement = Task { [weak self] in
                let clock = ContinuousClock(), began = ContinuousClock.now
                while !Task.isCancelled {
                    guard let self else { return }
                    let elapsed = began.duration(to: clock.now).components
                    let seconds = Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
                    let t = min(1, seconds / 0.32)
                    let eased = t * t * (3 - 2 * t)
                    self.window.setFrameOrigin(CGPoint(x: start.x + (origin.x - start.x) * eased,
                                                      y: start.y + (origin.y - start.y) * eased))
                    if t >= 1 { arrival(); return }
                    try? await Task.sleep(for: .milliseconds(16))
                }
            }
        } else { window.setFrameOrigin(origin); arrival() }
    }

    func cancelMotion() {
        greeting?.cancel()
        greeting = nil
        movement?.cancel()
        movement = nil
        state.gaze = 0
    }

    func hide() { cancelMotion(); window.orderOut(nil) }
}
