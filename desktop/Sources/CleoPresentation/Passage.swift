import Foundation

public struct PassageLine: Equatable, Sendable {
    public let text: String
    public let bounds: CGRect
    public let quoteBounds: [CGRect]
    public init(text: String, bounds: CGRect, quoteBounds: [CGRect] = []) {
        self.text = text; self.bounds = bounds; self.quoteBounds = quoteBounds
    }
}

public enum PassageGeometry {
    /// A toolbar, scrollbar or unrelated page region may change while the target
    /// is still valid. Fresh OCR must confirm the same wording and geometry.
    public static func unchanged(_ selected: [PassageLine], in fresh: [PassageLine]) -> Bool {
        !selected.isEmpty && selected.allSatisfy { old in fresh.contains { new in
            old.text == new.text && abs(old.bounds.midX - new.bounds.midX) < 3
                && abs(old.bounds.midY - new.bounds.midY) < 3
                && abs(old.bounds.width - new.bounds.width) < 3
                && abs(old.bounds.height - new.bounds.height) < 3
        } }
    }

    /// Mark a compact run of text, not the empty rectangle between unrelated lines.
    /// Bounds stay in AppKit screen points, including displays with negative origins.
    public static func markRects(_ lines: [PassageLine], in region: CGRect) -> [CGRect]? {
        guard valid(region), !lines.isEmpty, lines.count <= 6 else { return nil }
        let rects = lines.map(\.bounds).sorted { $0.midY > $1.midY }
        guard rects.allSatisfy({ valid($0) && region.contains($0)
            && $0.height <= min(64, region.height * 0.12)
            && $0.width <= min(1100, region.width * 0.95) }) else { return nil }
        let union = rects.reduce(CGRect.null) { $0.union($1) }
        guard union.height <= min(220, region.height * 0.30),
              union.width * union.height <= region.width * region.height * 0.22 else { return nil }
        for (upper, lower) in zip(rects, rects.dropFirst()) {
            let overlap = min(upper.maxX, lower.maxX) - max(upper.minX, lower.minX)
            guard upper.midY - lower.midY >= min(upper.height, lower.height) * 0.6,
                  upper.minY - lower.maxY <= max(upper.height, lower.height) * 1.6,
                  overlap >= min(upper.width, lower.width) * 0.45 else { return nil }
        }
        return rects
    }

    /// Pick only nearby text, never a distant line across blank document space.
    public static func line(near point: CGPoint, in lines: [PassageLine]) -> Int? {
        let candidates = lines.indices.filter { lines[$0].bounds.insetBy(dx: -10, dy: -8).contains(point) }
        return candidates.min { abs(lines[$0].bounds.midY - point.y) < abs(lines[$1].bounds.midY - point.y) }
    }

    // Vision normalized coordinates and AppKit screen coordinates both start at bottom left.
    public static func screenRect(_ normalized: CGRect, in region: CGRect) -> CGRect? {
        guard valid(region), valid(normalized), normalized.minX >= 0, normalized.minY >= 0,
              normalized.maxX <= 1.001, normalized.maxY <= 1.001 else { return nil }
        return CGRect(x: region.minX + normalized.minX * region.width,
                      y: region.minY + normalized.minY * region.height,
                      width: normalized.width * region.width, height: normalized.height * region.height)
    }

    public static func captureRect(_ region: CGRect, display: CGRect) -> CGRect? {
        guard valid(region), display.contains(region), region.width >= 12, region.height >= 12 else { return nil }
        // ScreenCaptureKit uses top-left display-relative points, not Retina pixels.
        return CGRect(x: region.minX - display.minX, y: display.maxY - region.maxY,
                      width: region.width, height: region.height)
    }

    public static func valid(_ rect: CGRect) -> Bool {
        [rect.origin.x, rect.origin.y, rect.width, rect.height].allSatisfy(\.isFinite)
            && rect.width > 0 && rect.height > 0
    }
}

@MainActor
public final class PassageSession {
    public private(set) var generation = UUID()
    public private(set) var lines: [PassageLine] = []
    public init() {}

    @discardableResult public func invalidate() -> UUID {
        generation = UUID()
        lines = []
        return generation
    }

    @discardableResult public func accept(_ result: [PassageLine], generation: UUID) -> Bool {
        guard generation == self.generation, !result.isEmpty, result.count <= 80,
              result.allSatisfy({ !$0.text.isEmpty && $0.text.count <= 4000 && PassageGeometry.valid($0.bounds) }) else { return false }
        lines = result
        return true
    }
}
