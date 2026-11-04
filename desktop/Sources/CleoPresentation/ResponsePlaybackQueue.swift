import Foundation

// A later response may arrive while an earlier one is still audible. Do not
// announce its playback (or start its drawing) until the earlier buffers finish.
public struct ResponsePlaybackQueue {
    public enum Event {
        case started(String), buffer(String, Data), finished(String)
    }
    private var active: String?
    private var inFlight = 0
    private var queued: [(String, Data)] = []
    private var done = Set<String>()
    public init() {}

    public mutating func enqueue(_ data: Data, id: String) -> [Event] {
        if active == id { inFlight += 1; return [.buffer(id, data)] }
        queued.append((id, data))
        return advance()
    }
    public mutating func generationDone(_ id: String) -> [Event] {
        done.insert(id)
        return finishIfReady()
    }
    public mutating func played(_ id: String) -> [Event] {
        guard active == id, inFlight > 0 else { return [] }
        inFlight -= 1
        return finishIfReady()
    }
    private mutating func finishIfReady() -> [Event] {
        guard let id = active, done.contains(id), inFlight == 0 else { return [] }
        active = nil; done.remove(id)
        return [.finished(id)] + advance()
    }
    private mutating func advance() -> [Event] {
        guard active == nil, let first = queued.first else { return [] }
        active = first.0
        let ready = queued.filter { $0.0 == first.0 }
        queued.removeAll { $0.0 == first.0 }
        inFlight = ready.count
        return [.started(first.0)] + ready.map { .buffer($0.0, $0.1) }
    }
    public mutating func reset() { self = Self() }
}
