import AppKit
import AVFoundation
import OSLog

@MainActor
final class VoiceBridge {
    private var process: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var buffer = Data()
    private var audio: VoiceAudio?
    private var generation = UUID()
    private var epoch = 0
    private var microphoneEnabled = true
    private var playingResponses = Set<String>()
    private var playbackSequence = 0
    private let writes = DispatchQueue(label: "dev.vdfrz.cleo.voice-input")
    private let logger = Logger(subsystem: "dev.vdfrz.cleo.source-preview", category: "voice-audio")
    var onState: (String) -> Void = { _ in }
    var onSpeech: () -> Void = {}
    var onEnded: () -> Void = {}
    var onPlaybackStart: (Int) -> Void = { _ in }
    var onPlaybackEnd: (Int) -> Void = { _ in }
    var onSpeechDuration: (Double) -> Void = { _ in }
    var onAction: (String, [String: Any], Int) async -> [String: Any] = { _, _, _ in ["error": "Unavailable"] }
    var isActive: Bool { process != nil }
    func isCurrent(_ value: Int) -> Bool { isActive && epoch == value }

    func start(acceptanceCheck: Bool = false, highlightCheck: Bool = false) {
        stop()
        microphoneEnabled = !acceptanceCheck && !highlightCheck
        guard let node = Bundle.main.object(forInfoDictionaryKey: "CleoNodeExecutable") as? String,
              let root = Bundle.main.object(forInfoDictionaryKey: "CleoWorkspace") as? String else {
            onState("Voice needs a development build · mic off"); return
        }
        let child = Process(), stdin = Pipe(), stdout = Pipe()
        child.executableURL = URL(fileURLWithPath: node)
        child.arguments = [root + (highlightCheck ? "/scripts/highlight-live-check.mjs" : acceptanceCheck ? "/scripts/notepad-live-check.mjs" : "/scripts/voice-sidecar.mjs")]
        child.currentDirectoryURL = URL(fileURLWithPath: root)
        logger.notice("Voice launch: bundle \(Bundle.main.bundleURL.path, privacy: .public), workspace \(root, privacy: .public), node \(node, privacy: .public)")
        child.environment = ["PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory()]
        child.standardInput = stdin; child.standardOutput = stdout
        child.standardError = FileHandle.nullDevice // Never log credentials or contract text.
        let token = generation
        input = stdin.fileHandleForWriting; output = stdout.fileHandleForReading
        output?.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { @MainActor in
                guard let self, self.generation == token else { return }
                if data.isEmpty { self.stop(); return }
                self.receive(data)
            }
        }
        child.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == token else { return }
                self.onState("Voice disconnected · mic off"); self.stop()
            }
        }
        do { try child.run(); process = child; onState("Connecting voice · mic off") }
        catch { onState("Could not start voice · mic off"); stop() }
    }

    private func receive(_ data: Data) {
        buffer.append(data)
        guard buffer.count <= 512000 else { onState("Voice data limit reached"); stop(); return }
        while let end = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: end); buffer.removeSubrange(...end)
            guard let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
            handle(message)
        }
    }
    private func handle(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "ready":
            let token = generation
            onState(microphoneEnabled ? "Allow microphone access…" : "Sketch check · mic off")
            Task { [weak self] in
                let allowed = self?.microphoneEnabled == false ? true : await AVCaptureDevice.requestAccess(for: .audio)
                guard let self, self.generation == token else { return }
                guard allowed else { self.onState("Microphone access needed"); self.stop(); return }
                let audio = VoiceAudio()
                audio.onInput = { [weak self] data in self?.send(["type": "audio", "data": data.base64EncodedString()]) }
                audio.onPlayback = { [weak self] id, started in
                    guard let self else { return }
                    if started { self.playingResponses.insert(id); self.onPlaybackStart(self.epoch) }
                    else {
                        self.playingResponses.remove(id)
                        if self.playingResponses.isEmpty { self.onPlaybackEnd(self.epoch) }
                    }
                    if started {
                        self.playbackSequence += 1
                        self.logger.notice("Speaker segment started; sequence \(self.playbackSequence), concurrent \(self.playingResponses.count)")
                    } else {
                        self.logger.notice("Speaker segment ended; concurrent \(self.playingResponses.count)")
                    }
                    self.send(["type": started ? "playback_started" : "playback_finished", "id": id])
                    // Playback can be only a preamble to tools. The sidecar
                    // decides when the complete turn is ready to listen again.
                    self.onState(self.playingResponses.isEmpty ? "Thinking · mic on" : "Cleo speaking")
                }
                self.audio = audio
                do { try audio.start(captureInput: self.microphoneEnabled); self.onState(self.microphoneEnabled ? "Listening · mic on" : "Sketch check · mic off") }
                catch {
                    let failure = error as NSError
                    self.logger.error("Audio startup failed; domain \(failure.domain, privacy: .public), code \(failure.code)")
                    self.onState("Audio startup failed (\(failure.code)) · mic off"); self.stop()
                }
            }
        case "speech_started":
            epoch = message["epoch"] as? Int ?? epoch + 1
            playingResponses.removeAll()
            audio?.interrupt(); onSpeech(); onState("Listening · mic on")
        case "speech_stopped": onState("Thinking · mic on")
        case "turn_state":
            guard let turn = message["epoch"] as? Int, isCurrent(turn), playingResponses.isEmpty else { return }
            if message["state"] as? String == "thinking" { onState("Thinking · mic on") }
            else { onState(microphoneEnabled ? "Listening · mic on" : "Sketch check · mic off") }
        case "interrupt": playingResponses.removeAll(); audio?.interrupt(); onSpeech()
        case "audio":
            if let id = message["id"] as? String, let encoded = message["data"] as? String,
               let data = Data(base64Encoded: encoded) { audio?.enqueue(data, id: id) }
        case "audio_done":
            if let seconds = message["durationSeconds"] as? Double { onSpeechDuration(seconds) }
            if let id = message["id"] as? String { audio?.generationDone(id) }
        case "action":
            guard let id = message["id"] as? String, let action = message["action"] as? String,
                  let args = message["args"] as? [String: Any], let turn = message["epoch"] as? Int else { return }
            let token = generation
            Task { [weak self] in
                guard let self, self.generation == token, self.isCurrent(turn) else { return }
                let result = await self.onAction(action, args, turn)
                guard self.generation == token else { return }
                self.send(["type": "result", "id": id, "result": result])
            }
        case "error": onState((message["message"] as? String ?? "Voice unavailable") + " · mic off"); stop()
        case "closed": stop()
        default: break
        }
    }
    private func send(_ message: [String: Any]) {
        guard let input, let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        writes.async { try? input.write(contentsOf: data + Data([10])) }
    }
    func stop() {
        let wasActive = isActive
        generation = UUID(); epoch = 0
        playingResponses.removeAll()
        audio?.stop(); audio = nil
        output?.readabilityHandler = nil; try? output?.close(); output = nil
        try? input?.close(); input = nil
        if let process, process.isRunning { process.terminate() }
        process = nil; buffer.removeAll()
        if wasActive { onEnded() }
    }
}
