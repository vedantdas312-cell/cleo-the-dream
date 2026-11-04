import AppKit
import QuartzCore

@MainActor
final class ScreenInk {
    private var window: NSWindow?
    private let stroke = CAShapeLayer()

    func circle(_ target: CGRect, on screen: NSScreen) {
        mark([target], style: "circle", on: screen)
    }

    func mark(_ targets: [CGRect], style: String, on screen: NSScreen) {
        clear()
        let panel = BotWindow(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                              backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        let view = NSView(frame: CGRect(origin: .zero, size: screen.frame.size))
        view.wantsLayer = true
        let path = CGMutablePath()
        let marked = style == "selection" ? [targets.reduce(CGRect.null) { $0.union($1) }] : targets
        for target in marked {
            let local = target.offsetBy(dx: -screen.frame.minX, dy: -screen.frame.minY)
            if style == "selection" {
                path.addRect(local.insetBy(dx: -4, dy: -4))
            } else if style == "highlight" {
                path.addRoundedRect(in: local.insetBy(dx: -2, dy: -1), cornerWidth: 3, cornerHeight: 3)
            } else if style == "underline" {
                path.move(to: CGPoint(x: local.minX, y: local.minY - 3))
                path.addLine(to: CGPoint(x: local.maxX, y: local.minY - 3))
            } else {
                let outline = local.insetBy(dx: -5, dy: -3)
                path.addRoundedRect(in: outline, cornerWidth: min(14, outline.height / 2),
                                    cornerHeight: min(14, outline.height / 2))
            }
        }
        stroke.path = path
        stroke.strokeColor = style == "highlight" ? NSColor.clear.cgColor : NSColor.systemMint.cgColor
        stroke.fillColor = style == "highlight" ? NSColor.systemYellow.withAlphaComponent(0.28).cgColor
            : style == "selection" ? NSColor.systemMint.withAlphaComponent(0.07).cgColor : NSColor.clear.cgColor
        stroke.lineWidth = style == "selection" ? 3 : 2.5
        stroke.lineDashPattern = style == "selection" ? [7, 4] : nil
        stroke.lineCap = .round
        stroke.shadowColor = NSColor.white.cgColor
        stroke.shadowOpacity = style == "highlight" ? 0 : 0.9
        stroke.shadowRadius = 1
        stroke.shadowOffset = .zero
        view.layer?.addSublayer(stroke)
        panel.contentView = view
        window = panel
        panel.orderFrontRegardless()
        if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            if style == "selection", let target = marked.first {
                let box = target.offsetBy(dx: -screen.frame.minX, dy: -screen.frame.minY).insetBy(dx: -4, dy: -4)
                let start = CGPoint(x: box.minX, y: box.maxY), end = CGPoint(x: box.maxX, y: box.minY)
                let expand = CABasicAnimation(keyPath: "path")
                expand.fromValue = CGPath(rect: CGRect(x: start.x, y: start.y-1, width: 1, height: 1), transform: nil)
                expand.toValue = path; expand.duration = 0.55
                expand.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                stroke.add(expand, forKey: "selection-drag")
                let tip = CAShapeLayer(), cross = CGMutablePath()
                cross.move(to: CGPoint(x: -5, y: 0)); cross.addLine(to: CGPoint(x: 5, y: 0))
                cross.move(to: CGPoint(x: 0, y: -5)); cross.addLine(to: CGPoint(x: 0, y: 5))
                tip.path = cross; tip.strokeColor = NSColor.systemMint.cgColor; tip.lineWidth = 2
                tip.position = end; tip.opacity = 0; view.layer?.addSublayer(tip)
                let move = CABasicAnimation(keyPath: "position"); move.fromValue = start; move.toValue = end
                let visible = CABasicAnimation(keyPath: "opacity"); visible.fromValue = 1; visible.toValue = 1
                let drag = CAAnimationGroup(); drag.animations = [move, visible]; drag.duration = 0.55
                drag.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut); tip.add(drag, forKey: "drag")
                return
            }
            let reveal = CABasicAnimation(keyPath: style == "highlight" ? "opacity" : "strokeEnd")
            reveal.fromValue = 0
            reveal.toValue = 1
            reveal.duration = 0.45
            reveal.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            stroke.add(reveal, forKey: "reveal")
        }
    }

    func clear() {
        stroke.removeAllAnimations()
        stroke.removeFromSuperlayer()
        window?.orderOut(nil)
        window = nil
    }
}
