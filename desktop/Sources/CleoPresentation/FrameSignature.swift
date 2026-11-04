import CoreGraphics

// Small in-memory comparison; screenshots are never written to disk.
public struct FrameSignature: Sendable {
    private let pixels: [UInt8]
    public init?(image: CGImage) {
        var bytes = [UInt8](repeating: 0, count: 64 * 64)
        let ok = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: 64, height: 64,
                bitsPerComponent: 8, bytesPerRow: 64, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: 64, height: 64))
            return true
        }
        guard ok else { return nil }
        pixels = bytes
    }
    public func differs(from other: FrameSignature) -> Bool {
        // Fail conservatively on visible crop changes. This is a freshness heuristic,
        // not document revision identity or permission to edit the underlying source.
        zip(pixels, other.pixels).contains { abs(Int($0) - Int($1)) > 14 }
    }
}
