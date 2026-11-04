import AppKit
import OSLog
import CleoPresentation

// Native code owns coordinates. The model receives text and opaque IDs only.
@MainActor
final class VoiceScreen {
    private let bot: BotPanel
    private let ink: ScreenInk
    private let notepad: NotepadPanel
    private var id = UUID()
    private var lines: [PassageLine] = []
    private var surface: HoverSurface?
    private var region: CGRect?
    private var anchor: CGPoint?
    private var signature: FrameSignature?
    private var watch: Task<Void, Never>?
    private var pendingMarks: [(args: [String: Any], afterPlayback: Int)] = []
    private var playbackSerial = 0
    private var speakingEpoch: Int?
    private var displayedEpoch: Int?
    func didDisplayMark(epoch: Int) -> Bool { displayedEpoch == epoch }
    private var marking: Task<Void, Never>?
    private let logger = Logger(subsystem: "dev.vdfrz.cleo.source-preview", category: "speech-mark")
    var isCurrent: (Int) -> Bool = { _ in false }
    var onSketchOpening: () -> Void = {}
    var onSketchFailure: () -> Void = {}

    init(bot: BotPanel, ink: ScreenInk, notepad: NotepadPanel) {
        self.bot = bot; self.ink = ink; self.notepad = notepad
    }
    func invalidate(reason: String = "reset") {
        logger.notice("Screen snapshot invalidated; reason \(reason, privacy: .public), lines \(self.lines.count), pending \(self.pendingMarks.count)")
        watch?.cancel(); watch = nil; marking?.cancel(); marking = nil; pendingMarks = []; displayedEpoch = nil; id = UUID(); lines = []; signature = nil; ink.clear(); bot.cancelMotion()
    }
    func interrupt() {
        speakingEpoch = nil; pendingMarks = []; marking?.cancel(); marking = nil
        watch?.cancel(); watch = nil
        ink.clear(); bot.cancelMotion()
        Task { await notepad.sketch.call("pause") }
    }
    func clear() { interrupt(); invalidate(); surface = nil; region = nil; anchor = nil }
    func externalViewEvent(at point: CGPoint, reason: String) {
        guard let surface, let region, region.contains(point),
              HoverSurface.under(point)?.id == surface.id else { return }
        invalidate(reason: reason)
    }
    func externalAppActivated() {
        guard let surface, let anchor else { return }
        let current = HoverSurface.under(anchor)
        if current?.id != surface.id || current?.bounds != surface.bounds {
            invalidate(reason: "target_covered_or_moved")
        }
    }
    func playbackStarted(epoch: Int) {
        guard isCurrent(epoch) else { return }
        speakingEpoch = epoch
        playbackSerial += 1
        logger.notice("Speaker playback started; epoch \(epoch)")
        revealPendingMarks(epoch: epoch)
        Task { await notepad.sketch.call("begin", payload: ["epoch": epoch]) }
    }
    func playbackEnded(epoch: Int) {
        if speakingEpoch == epoch { speakingEpoch = nil }
    }
    private func revealPendingMarks(epoch: Int) {
        guard marking == nil, !pendingMarks.isEmpty else { return }
        let token = id
        marking = Task {
            defer { if id == token, isCurrent(epoch) { marking = nil } }
            while speakingEpoch == epoch, isCurrent(epoch), id == token,
                  let pending = pendingMarks.first, pending.afterPlayback < playbackSerial, !Task.isCancelled {
                pendingMarks.removeFirst()
                let receipt = await mark(pending.args, epoch: epoch, reveal: true)
                if receipt["status"] as? String == "ready_for_speech" { break }
            }
        }
    }

    func perform(_ action: String, args: [String: Any], epoch: Int) async -> [String: Any] {
        guard isCurrent(epoch) else { return ["error": "Turn interrupted"] }
        switch action {
        case "native_capabilities":
            // Probe the actual loaded renderer without opening an unsolicited
            // sketchbook or confusing screen permission with drawing support.
            let canvas = await notepad.sketch.call("read")
            return ["protocolVersion": 1,
                    "buildID": Bundle.main.object(forInfoDictionaryKey: "CleoBuildID") as? String ?? "legacy",
                    "sketch": canvas["error"] == nil && canvas["revision"] is Int ? "ready" : "unavailable",
                    "sketchError": canvas["error"] as? String ?? "",
                    "actions": ["refresh_screen", "mark_passage", "read_notepad", "sketch_notepad"]]
        case "refresh_screen": return await read(epoch: epoch)
        case "mark_passage": return await mark(args, epoch: epoch)
        case "read_notepad":
            onSketchOpening()
            notepad.show(on: surface?.screen ?? NSScreen.main, activate: false)
            var receipt = await notepad.sketch.call("read")
            if receipt["error"] != nil { onSketchFailure() }
            receipt["windowVisible"] = notepad.frame != nil
            return receipt
        case "sketch_notepad":
            onSketchOpening()
            _ = await notepad.sketch.call("read")
            guard isCurrent(epoch) else { return ["error": "Turn interrupted"] }
            var receipt = await notepad.sketch.call("stage", payload: ["patch": args, "epoch": epoch])
            if receipt["ok"] as? Bool == true {
                notepad.show(on: surface?.screen ?? NSScreen.main, activate: false)
            } else { onSketchFailure() }
            receipt["windowVisible"] = notepad.frame != nil
            return receipt
        default: return ["error": "Unknown action"]
        }
    }

    // Device acceptance uses an actual separate document window at a known point.
    // The capture, OCR, freshness checks, glide and ink are the production path.
    func checkPointing(at point: CGPoint, sentence: Bool = false, speechAligned: Bool = false) async -> [String: Any] {
        let snapshot = await read(epoch: 0, at: point)
        guard snapshot["error"] == nil,
              let index = lines.firstIndex(where: { $0.text.contains("thirty days") }) else {
            return ["error": snapshot["error"] ?? "Fixture words were not visible"]
        }
        if sentence {
            guard let start = lines.firstIndex(where: { $0.text.contains("Either party") }),
                  let end = lines.indices.first(where: { $0 >= start && lines[$0].text.hasSuffix("period.") }) else {
                return ["error": "Wrapped fixture sentence was not visible"]
            }
            return await mark(["snapshotID": id.uuidString, "lineIDs": (start...end).map(String.init),
                "quote": "Either party may end this agreement with thirty days of written notice, provided that all outstanding payment obligations continue during the notice period.",
                "style": "selection"], epoch: 0, reveal: !speechAligned, fixture: !speechAligned)
        }
        return await mark(["snapshotID": id.uuidString, "lineIDs": [String(index)],
                          "quote": "thirty days", "style": "highlight"], epoch: 0, reveal: !speechAligned, fixture: !speechAligned)
    }

    private func read(epoch: Int, at pointOverride: CGPoint? = nil) async -> [String: Any] {
        let mouse = pointOverride ?? NSEvent.mouseLocation
        let overCleo = bot.frame.contains(mouse) || notepad.frame?.contains(mouse) == true
        // A follow-up over the bot/notepad continues to refer to the prior clause.
        let candidate = overCleo ? surface : HoverSurface.under(mouse)
        guard let candidate else { return ["error": "No visible document under the pointer. Ask the user to hover over the clause.", "code": "no_document_target"] }
        let point = overCleo ? (anchor ?? mouse) : mouse
        let area = candidate.bounds.intersection(candidate.screen.frame)
        invalidate(reason: "refresh")
        let token = id
        do {
            let image = try await ScreenPassageCapture.image(region: area, screen: candidate.screen)
            let allLines = try await Task.detached(priority: .userInitiated) { try TextRecognition.lines(in: image, region: area) }.value
            guard id == token, isCurrent(epoch) else { return ["error": "Screen observation interrupted", "code": "interrupted"] }
            guard !allLines.isEmpty else { return ["error": "The window was captured but contains no readable text. This is not a permission denial.", "code": "no_readable_text"] }
            // Dense Docs windows include menus and suggestion cards. Keep a bounded
            // contiguous reading window around the pointer instead of rejecting all OCR.
            let nearest = PassageGeometry.line(near: point, in: allLines) ?? 0
            let start = max(0, min(nearest - 40, allLines.count - 80))
            let found = Array(allLines.dropFirst(start).prefix(80))
            self.lines = found; surface = candidate; region = area; anchor = point
            signature = FrameSignature(image: image)
            notepad.state.lines = found; notepad.state.isCurrent = false
            notepad.state.notice = "Visible text shared with OpenAI for this conversation. OCR may contain errors."
            var result: [String: Any] = ["snapshotID": id.uuidString,
                    "markStyles": ["selection", "highlight", "circle", "underline"],
                    "exactPhraseMarks": true,
                    "hoveredLineID": PassageGeometry.line(near: point, in: found).map(String.init) ?? "",
                    "lines": found.enumerated().map { ["id": String($0.offset), "text": String($0.element.text.prefix(1000))] },
                    "observedLineCount": allLines.count, "truncated": allLines.count > 80]
            if let url = BrowserDocumentIdentity.url(for: candidate, at: point) {
                result["browserDocument"] = ["kind": "native_browser_document", "url": url]
            }
            return result
        } catch ScreenPassageError.permission {
            return ["error": "macOS denied Screen Recording permission for Cleo.", "code": "screen_permission_denied"]
        } catch {
            return ["error": "This screen capture failed. It does not establish a permission denial. Keep the document visible and try one fresh read.", "code": "screen_capture_failed"]
        }
    }

    private func mark(_ args: [String: Any], epoch: Int, reveal: Bool = false, fixture: Bool = false) async -> [String: Any] {
        let started = Date()
        func reject(_ code: String, _ message: String) -> [String: Any] {
            logger.notice("Highlight rejected; code \(code, privacy: .public), epoch \(epoch), reveal \(reveal), elapsedMs \(Int(Date().timeIntervalSince(started) * 1000)), lines \(self.lines.count), requested \((args["lineIDs"] as? [String])?.count ?? -1), quoteLength \((args["quote"] as? String)?.count ?? -1)")
            return ["error": message, "code": code]
        }
        guard let snapshotID = args["snapshotID"] as? String, snapshotID == id.uuidString else {
            return reject("mark_snapshot_mismatch", "Stale target; refresh_screen first")
        }
        guard let ids = args["lineIDs"] as? [String], !ids.isEmpty, ids.count <= 6 else {
            return reject("mark_invalid_line_count", "Select one to six current line IDs.")
        }
        guard let surface, let region, let anchor, let signature else {
            return reject("mark_no_snapshot", "Stale target; refresh_screen first")
        }
        let indices = ids.compactMap(Int.init)
        guard indices.count == ids.count, Set(indices).count == indices.count,
              indices.allSatisfy({ lines.indices.contains($0) }) else { return reject("mark_invalid_line_ids", "Unknown or repeated line ID") }
        guard let quote = args["quote"] as? String, !quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              quote.count <= 1000 else { return reject("mark_invalid_quote", "Provide the exact phrase or sentence to mark from the visible text.") }
        let selected = indices.map { lines[$0] }
        guard PassageGeometry.markRects(selected, in: region) != nil else {
            return reject("mark_geometry_rejected", "Select neighboring lines from one sentence or clause, not separate text blocks.")
        }
        let style = args["style"] as? String ?? "circle"
        guard ["selection", "highlight", "circle", "underline"].contains(style) else { return reject("mark_unknown_style", "Unknown drawing style") }
        let token = id
        guard let current = HoverSurface.under(anchor), current.id == surface.id, current.bounds == surface.bounds else {
            invalidate(reason: "window_changed"); return reject("mark_window_changed", "Window moved or was covered; refresh_screen first")
        }
        do {
            let image = try await ScreenPassageCapture.image(region: region, screen: surface.screen)
            guard let check = FrameSignature(image: image) else {
                return reject("mark_capture_failed", "Could not verify screen target")
            }
            let frameChanged = check.differs(from: signature)
            // Re-read target text as a second check; a coarse image signature alone
            // can miss a small scroll or an edit in a large document window.
            let observation = try await Task.detached {
                try TextRecognition.passage(in: image, region: region, quote: quote, selectedLines: selected)
            }.value
            let fresh = observation.lines
            guard id == token, isCurrent(epoch) else { return reject("mark_interrupted", "Turn interrupted") }
            guard PassageGeometry.unchanged(selected, in: fresh) else {
                invalidate(reason: "wording_moved"); return reject("mark_wording_moved", "Wording moved; refresh_screen first")
            }
            guard observation.matches.count == 1, let targets = observation.matches.first,
                  !targets.isEmpty, targets.count <= 6, targets.allSatisfy({
                    PassageGeometry.valid($0) && region.contains($0) && $0.height <= 44
                  }) else {
                return reject("mark_quote_unresolved", "Wording missing, ambiguous or too large. Copy the exact sentence and its visible line IDs; no mark was drawn.")
            }
            if frameChanged {
                logger.notice("Highlight target verified despite unrelated frame changes")
            }
            // Keep a validated mark invisible until actual speaker playback.
            // Playback re-enters this validation so an old page cannot be marked.
            if !fixture && (!reveal || speakingEpoch != epoch) {
                guard pendingMarks.count < 8 else { return reject("mark_pending_limit", "Too many pending marks; explain the selected wording first.") }
                pendingMarks.append((args: args, afterPlayback: playbackSerial))
                logger.notice("Exact mark ready for speech; epoch \(epoch)")
                return ["ok": true, "status": "ready_for_speech", "quote": quote, "style": style,
                        "lineIDs": ids, "instruction": "Explain this wording aloud now. The native app reveals the mark during speaker playback; it is not visible yet."]
            }
            let target = targets.reduce(CGRect.null) { $0.union($1) }
            let above = CGPoint(x: target.minX - 8, y: target.maxY + 10)
            let position = above.y + 60 <= surface.screen.visibleFrame.maxY ? above : CGPoint(x: target.minX - 8, y: target.minY - 70)
            bot.place(near: position, on: surface.screen, animated: true) { [weak self] in
                guard let self else { return }
                guard self.id == token, self.isCurrent(epoch), fixture || self.speakingEpoch == epoch else {
                    let reason = self.id != token ? "snapshot_changed" : !self.isCurrent(epoch) ? "turn_interrupted" : "speech_ended"
                    self.logger.notice("Highlight reveal cancelled; reason \(reason, privacy: .public), epoch \(epoch)")
                    return
                }
                self.ink.mark(targets, style: style, on: surface.screen)
                self.displayedEpoch = epoch
                self.logger.notice("Exact mark displayed during playback; epoch \(epoch), fixture \(fixture)")
            }
            try await Task.sleep(for: .milliseconds(400))
            guard id == token, isCurrent(epoch) else { return reject("mark_interrupted", "Turn interrupted") }
            watch?.cancel()
            watch = Task { [weak self] in
                var lastFrame = check
                while !Task.isCancelled {
                    do {
                        try await Task.sleep(for: .milliseconds(750))
                        guard let self, self.id == token, self.isCurrent(epoch) else { return }
                        guard let current = HoverSurface.under(anchor), current.id == surface.id, current.bounds == surface.bounds else {
                            self.invalidate(reason: "watch_window_changed"); return
                        }
                        let frame = try await ScreenPassageCapture.image(region: region, screen: surface.screen)
                        guard !Task.isCancelled, self.id == token else { return }
                        guard let next = FrameSignature(image: frame) else {
                            self.invalidate(reason: "watch_capture_failed"); return
                        }
                        if next.differs(from: lastFrame) {
                            let observation = try await Task.detached {
                                try TextRecognition.passage(in: frame, region: region, quote: quote, selectedLines: selected)
                            }.value
                            guard !Task.isCancelled, self.id == token else { return }
                            guard PassageGeometry.unchanged(selected, in: observation.lines),
                                  observation.matches.count == 1, observation.matches.first?.count == targets.count else {
                                self.invalidate(reason: "watch_target_changed"); return
                            }
                        }
                        lastFrame = next
                    } catch {
                        guard !Task.isCancelled, let self, self.id == token else { return }
                        self.invalidate(reason: "watch_capture_failed"); return
                    }
                }
            }
            return ["ok": true, "markedLineIDs": ids, "quote": quote, "style": style]
        } catch { return reject("mark_capture_failed", "Could not verify screen target") }
    }
}
