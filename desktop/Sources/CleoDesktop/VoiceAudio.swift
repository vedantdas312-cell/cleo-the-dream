import AVFoundation
import OSLog
import CleoPresentation

@MainActor
final class VoiceAudio {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var tapped = false
    private var generation = 0
    private var playbackGeneration = 0
    private var playbackQueue = ResponsePlaybackQueue()
    private let logger = Logger(subsystem: "dev.vdfrz.cleo.source-preview", category: "voice-audio")
    var onInput: (Data) -> Void = { _ in }
    var onPlayback: (String, Bool) -> Void = { _, _ in }

    func start(captureInput: Bool = true) throws {
        // Device acceptance can exercise the real speaker/renderer without opening
        // the microphone or reading whatever happens to be under the pointer.
        if !captureInput {
            guard let format = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1) else {
                throw NSError(domain: "CleoAudio", code: 1)
            }
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            engine.prepare(); try engine.start(); player.play()
            return
        }
        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        let hardware = input.outputFormat(forBus: 0)
        guard hardware.sampleRate > 0, hardware.channelCount > 0,
              let playback = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1) else {
            throw NSError(domain: "CleoAudio", code: 1)
        }
        let converter = try MicrophonePCM(format: hardware)
        engine.attach(player)
        // VoiceProcessingIO requires matching client input/output rates. Connecting
        // only the 24 kHz player lets the mixer propagate that rate to the output,
        // while the input tap remains at the device's voice-processing rate.
        // Keep both I/O sides at that rate; the mixer resamples model playback.
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: hardware)
        engine.connect(player, to: engine.mainMixerNode, format: playback)
        let token = generation
        let audioLogger = logger
        var lastReport = 0.0
        input.installTap(onBus: 0, bufferSize: 2048, format: hardware) { [weak self] buffer, _ in
            let data: Data
            do { data = try converter.convert(buffer) }
            catch { audioLogger.error("Microphone conversion failed; code \((error as NSError).code)"); return }
            let now = Date.timeIntervalSinceReferenceDate
            if now - lastReport >= 2 {
                lastReport = now
                let peaks = (0..<Int(buffer.format.channelCount)).map { channel -> Float in
                    let interleaved = buffer.format.isInterleaved
                    guard let samples = buffer.floatChannelData?[interleaved ? 0 : channel] else { return -1 }
                    return (0..<Int(buffer.frameLength)).reduce(Float(0)) {
                        max($0, abs(samples[$1 * buffer.stride + (interleaved ? channel : 0)]))
                    }
                }
                audioLogger.notice("Input tap: frames \(buffer.frameLength), channel peaks \(String(describing: peaks), privacy: .public), converted bytes \(data.count)")
            }
            guard !data.isEmpty else { return }
            Task { @MainActor in
                guard let self, self.generation == token else { return }
                self.onInput(data)
            }
        }
        tapped = true
        engine.prepare()
        try engine.start()
        player.play()
        logger.notice("Audio started; input rate \(hardware.sampleRate), output rate \(self.engine.outputNode.inputFormat(forBus: 0).sampleRate), voice processing \(input.isVoiceProcessingEnabled), muted \(input.isVoiceProcessingInputMuted)")
    }

    func enqueue(_ data: Data, id: String) {
        guard engine.isRunning, data.count > 0, data.count % 2 == 0, data.count <= 256000 else { return }
        play(playbackQueue.enqueue(data, id: id))
    }
    private func play(_ events: [ResponsePlaybackQueue.Event]) {
        for event in events {
            switch event {
            case .started(let id): onPlayback(id, true)
            case .finished(let id): onPlayback(id, false)
            case .buffer(let id, let data): schedule(data, id: id)
            }
        }
    }
    private func schedule(_ data: Data, id: String) {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(data.count / 2)),
              let samples = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = buffer.frameCapacity
        data.withUnsafeBytes { bytes in
            for i in 0..<Int(buffer.frameLength) {
                samples[i] = Float(Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))) / 32768
            }
        }
        let token = playbackGeneration
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.playbackGeneration == token else { return }
                self.play(self.playbackQueue.played(id))
            }
        }
        if !player.isPlaying { player.play() }
    }

    func generationDone(_ id: String) { play(playbackQueue.generationDone(id)) }
    func interrupt() {
        // Audio input remains live when output is interrupted.
        playbackGeneration += 1
        player.stop()
        playbackQueue.reset()
    }
    func stop() {
        generation += 1
        interrupt()
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        engine.stop()
    }
}
