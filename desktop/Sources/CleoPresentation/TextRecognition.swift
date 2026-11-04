import Foundation
import Vision

public enum TextRecognition {
    public struct PassageObservation: Sendable {
        public let lines: [PassageLine]
        public let matches: [[CGRect]]
    }

    /// Match a verbatim sentence across OCR line breaks, retaining Vision's real
    /// bounds for each fragment. Whitespace may vary; wording and punctuation may not.
    public static func passage(in image: CGImage, region: CGRect, quote: String,
                               selectedLines: [PassageLine]) throws -> PassageObservation {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate; request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        let records: [(text: VNRecognizedText, bounds: CGRect)] = (request.results ?? []).prefix(80).compactMap { observation in
            guard let text = observation.topCandidates(1).first, text.confidence >= 0.65,
                  let bounds = PassageGeometry.screenRect(observation.boundingBox, in: region) else { return nil }
            return (text, bounds)
        }.sorted { $0.bounds.midY != $1.bounds.midY ? $0.bounds.midY > $1.bounds.midY : $0.bounds.minX < $1.bounds.minX }
        let allLines = records.map { PassageLine(text: $0.text.string, bounds: $0.bounds) }
        let chosen = records.filter { record in selectedLines.contains { line in
            line.text == record.text.string && abs(line.bounds.midX-record.bounds.midX)<3 && abs(line.bounds.midY-record.bounds.midY)<3
        } }
        var joined = "", offsets: [(line: Int, range: Range<String.Index>)?] = []
        for (line, record) in chosen.enumerated() {
            let source = record.text.string
            if !joined.isEmpty, joined.last != " " { joined.append(" "); offsets.append(nil) }
            for index in source.indices {
                let char = source[index]
                if char.isWhitespace {
                    if !joined.isEmpty, joined.last != " " { joined.append(" "); offsets.append(nil) }
                } else {
                    joined.append(char); offsets.append((line, index..<source.index(after: index)))
                }
            }
        }
        let needle = quote.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        var matches: [[CGRect]] = [], start = joined.startIndex
        if !needle.isEmpty {
            while start < joined.endIndex, matches.count < 2,
                  let range = joined.range(of: needle, options: .literal, range: start..<joined.endIndex) {
                let lower = joined.distance(from: joined.startIndex, to: range.lowerBound)
                let upper = joined.distance(from: joined.startIndex, to: range.upperBound)
                let pieces = offsets[lower..<upper].compactMap { $0 }
                var bounds: [CGRect] = []
                for index in chosen.indices {
                    let pieces = pieces.filter { $0.line == index }
                    guard let first = pieces.first, let last = pieces.last else { continue }
                    if let box = try? chosen[index].text.boundingBox(for: first.range.lowerBound..<last.range.upperBound),
                       let rect = PassageGeometry.screenRect(box.boundingBox, in: region) { bounds.append(rect) }
                    else { bounds = []; break }
                }
                // Keep failed matches as empty entries so ambiguity is never hidden.
                matches.append(bounds); start = range.upperBound
            }
        }
        return PassageObservation(lines: allLines, matches: matches)
    }

    public static func lines(in image: CGImage, region: CGRect, quote: String? = nil) throws -> [PassageLine] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).prefix(80).compactMap { observation in
            guard let text = observation.topCandidates(1).first, text.confidence >= 0.65,
                  let rect = PassageGeometry.screenRect(observation.boundingBox, in: region) else { return nil }
            var matches: [CGRect] = []
            if let quote, !quote.isEmpty {
                var start = text.string.startIndex
                while start < text.string.endIndex,
                      let range = text.string.range(of: quote, options: .literal, range: start..<text.string.endIndex) {
                    if let observation = try? text.boundingBox(for: range),
                       let bounds = PassageGeometry.screenRect(observation.boundingBox, in: region) {
                        matches.append(bounds)
                    }
                    start = range.upperBound
                }
            }
            return PassageLine(text: text.string, bounds: rect, quoteBounds: matches)
        }.sorted { a, b in
            a.bounds.midY != b.bounds.midY ? a.bounds.midY > b.bounds.midY : a.bounds.minX < b.bounds.minX
        }
    }
}
