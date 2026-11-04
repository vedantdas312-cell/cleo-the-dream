// Renderer progress takes precedence over transient audio callbacks. The
// microphone can remain active while Cleo is preparing or drawing a sketch.
public struct CompanionActivity {
    public enum Sketch { case opening, drawing }
    public var sketch: Sketch?
    public private(set) var voice = "Ready · mic off"
    public init() {}
    public mutating func setVoice(_ value: String) {
        voice = value
        // A read without a subsequent drawing must not leave "opening" stuck.
        if value == "Listening · mic on", sketch == .opening { sketch = nil }
    }
    public var label: String {
        switch sketch {
        case .opening: return "Opening the sketchbook"
        case .drawing: return "Sketching"
        case nil: return voice
        }
    }
    public var isBusy: Bool { sketch != nil || voice == "Thinking · mic on" }
    public var isIdle: Bool { sketch == nil && voice == "Listening · mic on" }
}
