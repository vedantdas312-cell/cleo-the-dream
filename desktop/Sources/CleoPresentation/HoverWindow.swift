import Foundation

public struct HoverWindow {
    public let id: UInt32
    public let bounds: CGRect
    public let layer: Int
    public init(id: UInt32, bounds: CGRect, layer: Int) {
        self.id = id; self.bounds = bounds; self.layer = layer
    }
}

public enum HoverWindowResolver {
    /// Locate the frontmost ordinary app window as the capture boundary. Overlay
    /// levels vary between apps, including values below the screen-saver level.
    /// This is not an occlusion test: OCR reads the composited display, so visible
    /// menus/overlays are read as shown, never hidden text from a backing window.
    public static func under(_ point: CGPoint, windows: [HoverWindow]) -> HoverWindow? {
        windows.first { $0.layer == 0 && $0.bounds.contains(point) }
    }
}
