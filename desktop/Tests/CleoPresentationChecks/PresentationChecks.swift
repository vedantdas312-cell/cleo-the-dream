import AppKit
import CleoPresentation

@MainActor
func presentationChecks() async throws {
    var activity = CompanionActivity()
    activity.setVoice("Thinking · mic on")
    activity.sketch = .opening
    activity.setVoice("Cleo speaking")
    precondition(activity.label == "Opening the sketchbook" && activity.isBusy)
    activity.sketch = .drawing
    activity.setVoice("Listening · mic on")
    precondition(activity.label == "Sketching" && !activity.isIdle,
                 "Audio finishing must not hide an in-progress sketch")
    activity.sketch = nil
    precondition(activity.label == "Listening · mic on" && activity.isIdle)
    activity.sketch = .opening
    activity.setVoice("Listening · mic on")
    precondition(activity.sketch == nil, "A read-only canvas check must not leave opening stuck")
    // An external display above/left of the primary display exercises non-zero origins.
    let display = CGRect(x: -1440, y: 600, width: 1440, height: 900)
    let region = CGRect(x: -1200, y: 900, width: 600, height: 200)
    precondition(PassageGeometry.captureRect(region, display: display) == CGRect(x: 240, y: 400, width: 600, height: 200))
    precondition(PassageGeometry.screenRect(CGRect(x: 0.1, y: 0.25, width: 0.8, height: 0.5), in: region)
                 == CGRect(x: -1140, y: 950, width: 480, height: 100))
    precondition(PassageGeometry.captureRect(region.offsetBy(dx: -600, dy: 0), display: display) == nil)
    precondition(PassageGeometry.screenRect(CGRect(x: -0.1, y: 0, width: 0.5, height: 0.5), in: region) == nil)
    precondition(!PassageGeometry.valid(CGRect(x: Double.infinity, y: 0, width: 20, height: 20)))

    // Reproduce the real Mac failure: a cursor overlay covers the whole display
    // at level 1000, before the ordinary document window in WindowServer order.
    let window = HoverWindow(id: 2, bounds: CGRect(x: 0, y: 0, width: 900, height: 700), layer: 0)
    let overlay = HoverWindow(id: 1, bounds: window.bounds, layer: 1000)
    let cursor = CGPoint(x: 400, y: 300)
    precondition(HoverWindowResolver.under(cursor, windows: [overlay, window])?.id == 2,
                 "A cursor overlay must not swallow hover targeting")
    // Floating app overlays and Dock shielding also use levels below 1000.
    let lowerOverlays = [27, 26, 20].enumerated().map {
        HoverWindow(id: UInt32(10 + $0.offset), bounds: window.bounds, layer: $0.element)
    }
    precondition(HoverWindowResolver.under(cursor, windows: [overlay] + lowerOverlays + [window])?.id == 2,
                 "Lower-level overlays must not swallow the underlying app window")
    let menu = HoverWindow(id: 3, bounds: CGRect(x: 350, y: 250, width: 100, height: 100), layer: 101)
    precondition(HoverWindowResolver.under(cursor, windows: [overlay, menu, window])?.id == 2,
                 "Menus do not erase the app capture boundary; OCR uses visible composite pixels")
    precondition(HoverWindowResolver.under(CGPoint(x: 1200, y: 900), windows: [overlay, window]) == nil)

    let frontWindow = HoverWindow(id: 4, bounds: CGRect(x: 300, y: 200, width: 200, height: 200), layer: 0)
    precondition(HoverWindowResolver.under(cursor, windows: lowerOverlays + [frontWindow, window])?.id == 4,
                 "Preserve front-to-back ordering between overlapping app windows")
    precondition(HoverWindowResolver.under(cursor, windows: [overlay] + lowerOverlays) == nil,
                 "An overlay alone is not an app capture boundary")

    let session = PassageSession()
    let old = session.generation
    let newer = session.invalidate()
    let line = PassageLine(text: "Notice is sixty days.", bounds: region)
    precondition(!session.accept([line], generation: old), "An earlier capture must never restore stale marks")
    precondition(session.accept([line], generation: newer))
    session.invalidate()
    precondition(session.lines.isEmpty && !session.accept([line], generation: newer))
    precondition(!session.accept([], generation: session.generation))

    let hoverLines = [PassageLine(text: "First", bounds: CGRect(x: 100, y: 200, width: 300, height: 20)),
                      PassageLine(text: "Second", bounds: CGRect(x: 100, y: 170, width: 300, height: 20))]
    precondition(PassageGeometry.line(near: CGPoint(x: 180, y: 208), in: hoverLines) == 0)
    precondition(PassageGeometry.line(near: CGPoint(x: 180, y: 180), in: hoverLines) == 1)
    precondition(PassageGeometry.line(near: CGPoint(x: 600, y: 208), in: hoverLines) == nil)
    precondition(PassageGeometry.line(near: CGPoint(x: 180, y: 100), in: hoverLines) == nil)

    let page = CGRect(x: 0, y: 0, width: 900, height: 700)
    precondition(PassageGeometry.markRects(hoverLines, in: page)?.count == 2,
                 "A wrapped clause must keep two precise line shapes instead of one large union")
    let distant = PassageLine(text: "Unrelated footer", bounds: CGRect(x: 100, y: 20, width: 300, height: 20))
    precondition(PassageGeometry.markRects([hoverLines[0], distant], in: page) == nil)
    let column = PassageLine(text: "Other column", bounds: CGRect(x: 500, y: 170, width: 200, height: 20))
    precondition(PassageGeometry.markRects([hoverLines[0], column], in: page) == nil)
    let block = PassageLine(text: "Bad OCR block", bounds: CGRect(x: 20, y: 200, width: 800, height: 350))
    precondition(PassageGeometry.markRects([block], in: page) == nil, "Half-screen OCR regions must be rejected")
    precondition(PassageGeometry.markRects([hoverLines[0], hoverLines[0]], in: page) == nil)
    let shiftedLines = hoverLines.map { PassageLine(text: $0.text, bounds: $0.bounds.offsetBy(dx: -1440, dy: 600)) }
    precondition(PassageGeometry.markRects(shiftedLines, in: page.offsetBy(dx: -1440, dy: 600))?.count == 2)

    let image = makeTextImage("Notice is sixty days.")
    let lines = try await Task.detached { try TextRecognition.lines(in: image, region: region) }.value
    precondition(lines.contains(where: { $0.text.contains("Notice is sixty days.") }), "Real Vision recognition did not return the fixture")
    precondition(lines.allSatisfy { region.contains($0.bounds) }, "OCR bounds escaped selected region")
    let quoted = try await Task.detached { try TextRecognition.lines(in: image, region: region, quote: "sixty days") }.value
    let quotedLine = quoted.first { $0.text.contains("sixty days") }!
    precondition(quotedLine.quoteBounds.count == 1)
    let phrase = quotedLine.quoteBounds[0]
    precondition(phrase.width < quotedLine.bounds.width * 0.7 && phrase.minX > quotedLine.bounds.minX,
                 "Exact phrase marks must exclude preceding words, not reuse the full OCR line")
    let missing = try TextRecognition.lines(in: image, region: region, quote: "ninety days")
    precondition(missing.allSatisfy { $0.quoteBounds.isEmpty }, "Never guess bounds for missing words")
    let duplicateImage = makeTextImage("Notice is sixty days.\nPayment is sixty days.")
    let repeated = try TextRecognition.lines(in: duplicateImage, region: region, quote: "sixty days")
    precondition(repeated.flatMap(\.quoteBounds).count == 2,
                 "Repeated phrases must remain ambiguous; fixture OCR: \(repeated.map(\.text)), bounds: \(repeated.map { $0.quoteBounds.count })")
    let wrappedImage = makeTextImage("Notice is sixty days.\nPayment continues meanwhile.")
    let wrappedLines = try TextRecognition.lines(in: wrappedImage, region: region)
    let sentence = try TextRecognition.passage(in: wrappedImage, region: region,
        quote: "sixty days. Payment continues", selectedLines: wrappedLines)
    precondition(sentence.matches.count == 1 && sentence.matches[0].count == 2,
                 "A sentence crossing OCR lines must retain two actual word fragments")
    precondition(sentence.matches[0][0].width < wrappedLines[0].bounds.width)
    precondition(sentence.matches[0][1].width < wrappedLines[1].bounds.width)
    let wrongSentence = try TextRecognition.passage(in: wrappedImage, region: region,
        quote: "sixty days. Payment ends", selectedLines: wrappedLines)
    precondition(wrongSentence.matches.isEmpty, "Do not guess a match for altered sentence wording")
    let duplicateLines = try TextRecognition.lines(in: duplicateImage, region: region)
    let duplicate = try TextRecognition.passage(in: duplicateImage, region: region, quote: "sixty days", selectedLines: duplicateLines)
    precondition(duplicate.matches.count == 2, "Ambiguous sentence matches must be rejected")
    let original = FrameSignature(image: image)!
    precondition(!original.differs(from: FrameSignature(image: image)!))
    precondition(original.differs(from: FrameSignature(image: makeTextImage("Payment is thirty days."))!), "Changed screen text must invalidate its anchor")
    // The old whole-window gate rejected this harmless change before checking
    // the selected words. Re-read the real pixels and distinguish it from edits.
    let chromeChanged = makeTextImage("Notice is sixty days.", chromeChanged: true)
    precondition(original.differs(from: FrameSignature(image: chromeChanged)!))
    let stillVisible = try TextRecognition.passage(in: chromeChanged, region: region,
        quote: "sixty days", selectedLines: lines)
    precondition(PassageGeometry.unchanged(lines, in: stillVisible.lines) && stillVisible.matches.count == 1,
                 "Unrelated toolbar pixels must not invalidate unchanged exact wording")
    let moved = lines.map { PassageLine(text: $0.text, bounds: $0.bounds.offsetBy(dx: 0, dy: 10)) }
    precondition(!PassageGeometry.unchanged(lines, in: moved), "Scrolling must still invalidate the old position")
    precondition(!PassageGeometry.unchanged(lines, in: []), "Covered text must be rejected")
    let changedText = try TextRecognition.lines(in: makeTextImage("Notice is thirty days."), region: region)
    precondition(!PassageGeometry.unchanged(lines, in: changedText), "Edited wording must be rejected")
    print("Passed presentation checks: display transforms, stale-result rejection, real Vision OCR and changed-frame detection.")
}

private func makeTextImage(_ text: String, chromeChanged: Bool = false) -> CGImage {
    let context = CGContext(data: nil, width: 1200, height: 240, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(NSColor.white.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: 1200, height: 240))
    if chromeChanged {
        context.setFillColor(NSColor.gray.cgColor)
        context.fill(CGRect(x: 1050, y: 210, width: 140, height: 20))
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
    (text as NSString).draw(at: CGPoint(x: 50, y: 90), withAttributes: [
        .font: NSFont.systemFont(ofSize: 48), .foregroundColor: NSColor.black
    ])
    NSGraphicsContext.restoreGraphicsState()
    return context.makeImage()!
}
