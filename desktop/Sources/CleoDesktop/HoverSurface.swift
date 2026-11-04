import AppKit
import CleoPresentation

struct HoverSurface {
    let id: CGWindowID
    let bounds: CGRect
    let region: CGRect
    let screen: NSScreen

    @MainActor static func under(_ point: CGPoint) -> HoverSurface? {
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(point) }),
              let primary = NSScreen.screens.first,
              let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        let windows = info.compactMap { window -> HoverWindow? in
            guard (window[kCGWindowOwnerPID as String] as? Int32) != ProcessInfo.processInfo.processIdentifier,
                  (window[kCGWindowAlpha as String] as? Double ?? 0) > 0,
                  let dictionary = window[kCGWindowBounds as String] as? [String: Any],
                  let quartz = CGRect(dictionaryRepresentation: dictionary as CFDictionary),
                  let layer = window[kCGWindowLayer as String] as? Int,
                  let id = window[kCGWindowNumber as String] as? UInt32 else { return nil }
            let bounds = CGRect(x: quartz.minX, y: primary.frame.maxY - quartz.maxY, width: quartz.width, height: quartz.height)
            return HoverWindow(id: id, bounds: bounds, layer: layer)
        }
        guard let window = HoverWindowResolver.under(point, windows: windows) else { return nil }
        let region = CGRect(x: point.x - 380, y: point.y - 150, width: 760, height: 300)
            .intersection(window.bounds).intersection(screen.frame)
        guard region.width >= 12, region.height >= 12 else { return nil }
        return HoverSurface(id: window.id, bounds: window.bounds, region: region, screen: screen)
    }
}
