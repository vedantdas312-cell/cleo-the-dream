import AVFoundation

/// Converts the microphone channel to the Realtime API's mono PCM16 format.
/// A multichannel VoiceProcessingIO buffer is not a surround-sound mix: its
/// first channel is the microphone. Automatic 5-channel-to-mono mapping can
/// select the silent centre channel instead.
public final class MicrophonePCM {
    private let converter: AVAudioConverter
    private let outputFormat: AVAudioFormat

    public init(format: AVAudioFormat) throws {
        guard format.sampleRate > 0, format.channelCount > 0,
              let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: format, to: output) else {
            throw NSError(domain: "CleoAudio", code: 1)
        }
        converter.channelMap = [0]
        self.converter = converter; outputFormat = output
    }

    public func convert(_ input: AVAudioPCMBuffer) throws -> Data {
        guard input.format == converter.inputFormat else { throw NSError(domain: "CleoAudio", code: 2) }
        let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * 24000 / input.format.sampleRate)) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            throw NSError(domain: "CleoAudio", code: 3)
        }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, state in
            if supplied { state.pointee = .noDataNow; return nil }
            supplied = true; state.pointee = .haveData; return input
        }
        if let error { throw error }
        guard status != .error, let samples = output.int16ChannelData?[0] else {
            throw NSError(domain: "CleoAudio", code: 4)
        }
        return Data(bytes: samples, count: Int(output.frameLength) * 2)
    }
}
