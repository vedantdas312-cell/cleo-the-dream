import AVFoundation
import CleoPresentation

func audioChecks() throws {
    func labels(_ events: [ResponsePlaybackQueue.Event]) -> [String] {
        events.map { event in switch event {
            case .started(let id): return "start:\(id)"
            case .buffer(let id, let data): return "buffer:\(id):\(data.count)"
            case .finished(let id): return "finish:\(id)"
        } }
    }
    var queue = ResponsePlaybackQueue()
    precondition(labels(queue.enqueue(Data([0, 0]), id: "first")) == ["start:first", "buffer:first:2"])
    precondition(queue.enqueue(Data([0, 0, 0, 0]), id: "sketch-explanation").isEmpty,
                 "A queued later explanation must not start its sketch over earlier speech")
    precondition(queue.generationDone("sketch-explanation").isEmpty,
                 "Generation finishing is not speaker playback finishing")
    precondition(queue.played("first").isEmpty, "A temporary gap must keep streamed response order")
    precondition(labels(queue.enqueue(Data([0, 0]), id: "first")) == ["buffer:first:2"])
    precondition(queue.generationDone("first").isEmpty)
    precondition(labels(queue.played("first")) == ["finish:first", "start:sketch-explanation", "buffer:sketch-explanation:4"])
    precondition(labels(queue.played("sketch-explanation")) == ["finish:sketch-explanation"])
    _ = queue.enqueue(Data([0, 0]), id: "interrupted")
    _ = queue.enqueue(Data([0, 0]), id: "abandoned")
    queue.reset()
    precondition(queue.played("interrupted").isEmpty)
    precondition(labels(queue.enqueue(Data([0, 0]), id: "new-turn")) == ["start:new-turn", "buffer:new-turn:2"])

    // Regression: automatic 5.0-to-mono mapping picks channel 2 (centre),
    // which is silent in the observed VoiceProcessingIO microphone buffer.
    for interleaved in [false, true] {
        for rate in [44100.0, 48000.0] {
            let layout = AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_MPEG_5_0_A)!
            let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, interleaved: interleaved, channelLayout: layout)
            let converter = try MicrophonePCM(format: format)
            var totalSamples = 0
            for block in 0..<20 {
                let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800)!
                input.frameLength = 4800
                for channel in 0..<5 {
                    for frame in 0..<4800 {
                        let samples = input.floatChannelData![interleaved ? 0 : channel]
                        samples[frame * input.stride + (interleaved ? channel : 0)] = channel == 0
                            ? Float(sin(Double(frame + block * 4800) * 0.1)) * 0.2 : 0
                    }
                }
                let pcm = try converter.convert(input)
                precondition(pcm.count % 2 == 0)
                totalSamples += pcm.count / 2
                let peak = pcm.withUnsafeBytes { bytes in
                    stride(from: 0, to: pcm.count, by: 2).map {
                        abs(Int(Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: $0, as: Int16.self))))
                    }.max() ?? 0
                }
                precondition(peak > 5000 && peak < 7500, "Microphone signal must survive multichannel conversion")
            }
            let expected = 20 * 4800 * 24000 / rate
            // A streaming resampler retains its filter tail until more input.
            // Over two seconds, allow <43 ms of buffered audio, not per-packet loss.
            precondition(abs(Double(totalSamples) - expected) < 1024, "Resampling must preserve duration")
        }
    }
    print("Passed audio checks: microphone channel survives 5-channel interleaved/noninterleaved conversion at 44.1/48 kHz.")
}
