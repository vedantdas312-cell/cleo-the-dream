import AppKit
import OSLog
import CleoPresentation

@MainActor
final class ScreenCompanion {
    let bot = BotPanel()
    private let ink = ScreenInk()
    private let notepad = NotepadPanel()
    private let voice = VoiceBridge()
    private lazy var voiceScreen = VoiceScreen(bot: bot, ink: ink, notepad: notepad)
    private var work: Task<Void, Never>?
    private var active = false
    private var activation = UUID()
    private var activity = CompanionActivity()
    private let logger = Logger(subsystem: "dev.vdfrz.cleo.source-preview", category: "activity")
    private var monitor: Any?
    private var activationObserver: NSObjectProtocol?
    private var displayObserver: NSObjectProtocol?

    init() {
        voice.onState = { [weak self] status in
            guard let self else { return }
            self.activity.setVoice(status)
            self.presentActivity()
        }
        voiceScreen.onSketchOpening = { [weak self] in
            if self?.activity.sketch == nil { self?.activity.sketch = .opening }
            self?.presentActivity()
        }
        voiceScreen.onSketchFailure = { [weak self] in
            self?.activity.sketch = nil
            self?.presentActivity()
        }
        notepad.sketch.onActivity = { [weak self] phase, epoch in
            guard let self, self.voice.isCurrent(epoch) else { return }
            self.activity.sketch = phase == "idle" ? nil : .drawing
            self.presentActivity()
        }
        voice.onSpeech = { [weak self] in
            self?.activity.sketch = nil
            self?.voiceScreen.interrupt()
            self?.presentActivity()
        }
        voice.onPlaybackStart = { [weak self] epoch in self?.voiceScreen.playbackStarted(epoch: epoch) }
        voice.onPlaybackEnd = { [weak self] epoch in self?.voiceScreen.playbackEnded(epoch: epoch) }
        voice.onSpeechDuration = { [weak self] seconds in
            Task { await self?.notepad.sketch.call("pace", payload: ["seconds": seconds]) }
        }
        voice.onEnded = { [weak self] in
            self?.notepad.state.voiceActive = false
            self?.voiceScreen.clear()
            self?.activity.sketch = nil
            if let self, ["Cleo speaking", "Thinking · mic on", "Listening · mic on", "Sketch check · mic off"].contains(self.activity.voice) {
                self.activity.setVoice("Ready · ⌃C to talk")
            }
            self?.presentActivity()
            self?.bot.park()
        }
        voice.onAction = { [weak self] action, args, epoch in
            guard let self else { return ["error": "Cleo closed"] }
            return await self.voiceScreen.perform(action, args: args, epoch: epoch)
        }
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.scrollWheel, .leftMouseDown, .rightMouseDown, .leftMouseDragged]) { [weak self] event in
            let point = NSEvent.mouseLocation
            let reason = event.type == .scrollWheel ? "target_scroll" : event.type == .leftMouseDragged ? "target_drag" : "target_click"
            Task { @MainActor in self?.viewChanged(at: point, reason: reason) }
        }
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] event in
                guard let app = event.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                      app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
                Task { @MainActor in self?.voiceScreen.externalAppActivated() }
            }
        displayObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.stop() }
            }
    }

    // Only an explicit hotkey/menu action starts microphone access.
    func converse() {
        if voice.isActive { stop(); return }
        stop()
        active = true
        bot.show()
        voiceScreen.isCurrent = { [weak self] epoch in self?.voice.isCurrent(epoch) == true }
        voice.start()
        notepad.state.voiceActive = voice.isActive
    }

    func checkNotepad() {
        stop(); bot.show()
        voiceScreen.isCurrent = { [weak self] epoch in self?.voice.isCurrent(epoch) == true }
        voice.onAction = { [weak self] action, args, epoch in
            guard let self, ["native_capabilities", "read_notepad", "sketch_notepad"].contains(action) else {
                return ["error": "This fixture-only acceptance run does not read the screen or mark documents."]
            }
            return await self.voiceScreen.perform(action, args: args, epoch: epoch)
        }
        voice.start(acceptanceCheck: true)
    }

    // Explicit live model/native marking exercise. No microphone or document edits.
    func checkHighlights() {
        stop(); bot.show(); active = true
        voiceScreen.isCurrent = { [weak self] epoch in self?.voice.isCurrent(epoch) == true }
        voice.onAction = { [weak self] action, args, epoch in
            guard let self else { return ["error": "Cleo closed"] }
            if action == "highlight_check_status" {
                return ["displayed": self.voiceScreen.didDisplayMark(epoch: epoch)]
            }
            if action == "refresh_screen" {
                // Never capture an authentication page or an unrelated app in
                // this explicit document-only diagnostic.
                let point = NSEvent.mouseLocation
                guard let surface = HoverSurface.under(point),
                      let raw = BrowserDocumentIdentity.url(for: surface, at: point),
                      let url = URL(string: raw), url.host == "docs.google.com",
                      url.path.hasPrefix("/document/d/") else {
                    return ["error": "Point at the Google Doc before this check.", "code": "no_document_target"]
                }
            }
            guard ["native_capabilities", "refresh_screen", "mark_passage", "read_notepad", "sketch_notepad"].contains(action) else {
                return ["error": "Action unavailable in the highlight check"]
            }
            return await self.voiceScreen.perform(action, args: args, epoch: epoch)
        }
        voice.start(highlightCheck: true)
    }

    // Explicit, microphone-free check of the real hovered document. Store only
    // bounded status/identity metadata, never the captured contract text.
    func checkContext() {
        stop()
        voiceScreen.isCurrent = { $0 == 0 }
        work = Task {
            let snapshot=await voiceScreen.perform("refresh_screen", args: [:], epoch: 0)
            let lines=snapshot["lines"] as? [[String: String]] ?? []
            let report: [String: Any] = ["readableLines":lines.count,
                "hoveredLineAvailable":!(snapshot["hoveredLineID"] as? String ?? "").isEmpty,
                "browserDocument":snapshot["browserDocument"] ?? NSNull(),
                "code":snapshot["code"] ?? "ok", "microphoneUsed":false,
                "accessibilityTrusted":AXIsProcessTrusted(),
                "browserIdentityDiagnostic":BrowserDocumentIdentity.diagnostic]
            if let root=Bundle.main.object(forInfoDictionaryKey:"CleoWorkspace") as? String,
               let data=try? JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted]) {
                let path=URL(fileURLWithPath:root).appendingPathComponent(".local/screen-context-check.json")
                try? data.write(to:path,options:.atomic)
                try? FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:path.path)
            }
            NSApp.terminate(nil)
        }
    }

    func checkPointing(sentence: Bool = false, speechAligned: Bool = false) {
        stop(); bot.show()
        let token = activation
        voiceScreen.isCurrent = { [weak self] in $0 == 0 && self?.activation == token }
        work = Task {
            var result: [String: Any] = ["error": "Example agreement did not become visible"]
            for _ in 0..<90 {
                guard !Task.isCancelled else { return }
                do {
                    let point = try await ScreenPassageCapture.fixturePoint()
                    result = await voiceScreen.checkPointing(at: point, sentence: sentence, speechAligned: speechAligned)
                    if speechAligned, result["ok"] as? Bool == true,
                       let root = Bundle.main.object(forInfoDictionaryKey: "CleoWorkspace") as? String {
                        let silentBeforeSpeech = !voiceScreen.didDisplayMark(epoch: 0)
                        let pcm = try Data(contentsOf: URL(fileURLWithPath: root).appendingPathComponent(".local/speech-mark-check.pcm"))
                        let speaker = VoiceAudio()
                        speaker.onPlayback = { [weak self] _, started in
                            if started { self?.voiceScreen.playbackStarted(epoch: 0) }
                            else { self?.voiceScreen.playbackEnded(epoch: 0) }
                        }
                        try speaker.start(captureInput: false)
                        // Match production's bounded streamed audio chunks.
                        for offset in stride(from: 0, to: pcm.count, by: 4800) {
                            speaker.enqueue(pcm.subdata(in: offset..<min(offset + 4800, pcm.count)), id: "speech-mark-check")
                        }
                        speaker.generationDone("speech-mark-check")
                        try await Task.sleep(for: .seconds(Double(pcm.count) / 48000 + 0.5))
                        speaker.stop()
                        result["silentBeforeSpeech"] = silentBeforeSpeech
                        result["displayedDuringSpeech"] = voiceScreen.didDisplayMark(epoch: 0)
                        result["ok"] = silentBeforeSpeech && voiceScreen.didDisplayMark(epoch: 0)
                    }
                    break
                } catch {
                    let failure = error as NSError
                    if failure.domain == "CleoFixture" && failure.code == 2 {
                        bot.state.status = "Bring example agreement forward · mic off"
                        try? await Task.sleep(for: .milliseconds(400))
                    } else {
                        result = ["error": error.localizedDescription, "domain": failure.domain, "code": failure.code]; break
                    }
                }
            }
            bot.state.status = result["ok"] as? Bool == true ? "Exact words · mic off" : "Pointing check failed · see diagnostics"
            if let workspace = Bundle.main.object(forInfoDictionaryKey: "CleoWorkspace") as? String,
               let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted]) {
                try? data.write(to: URL(fileURLWithPath: workspace).appendingPathComponent(".local/pointing-live-check.json"))
            }
        }
    }

    // Idle Cleo is parked. Screen capture happens only in a spoken turn or
    // an explicitly invoked device check, never from cursor movement.
    func show() {
        stop()
        bot.show()
        bot.state.status = "Ready · ⌃C to talk"
    }

    func stop() {
        voice.stop()
        voiceScreen.clear()
        active = false
        activation = UUID()
        work?.cancel(); work = nil
        ink.clear()
        bot.cancelMotion()
        bot.state.isBusy = false
        activity = CompanionActivity()
        bot.state.status = "Paused · ⌃C resumes"
        bot.park()
    }

    func dismiss() { stop(); bot.hide(); notepad.hide() }

    func shutdown() {
        dismiss()
        if let monitor { NSEvent.removeMonitor(monitor) }
        if let activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(activationObserver) }
        if let displayObserver { NotificationCenter.default.removeObserver(displayObserver) }
    }

    private func presentActivity() {
        if bot.state.status != activity.label { logger.notice("Companion status: \(self.activity.label, privacy: .public)") }
        bot.state.status = activity.label
        bot.state.isBusy = activity.isBusy
        if activity.isIdle { bot.park() }
    }

    private func viewChanged(at point: CGPoint, reason: String) {
        guard active, voice.isActive else { return }
        voiceScreen.externalViewEvent(at: point, reason: reason)
    }
}
