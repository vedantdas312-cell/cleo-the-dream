import AppKit
import Carbon
import OSLog

// Register only Control-C. No all-key event tap or Input Monitoring permission.
@MainActor
final class SummonHotkey {
    private var hotkey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let show: () -> Void

    init(show: @escaping () -> Void) { self.show = show }

    func start() -> Bool {
        var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, context in
            guard let context else { return OSStatus(eventNotHandledErr) }
            let monitor = Unmanaged<SummonHotkey>.fromOpaque(context).takeUnretainedValue()
            MainActor.assumeIsolated {
                Logger(subsystem: "dev.vdfrz.cleo.source-preview", category: "hotkey").info("Summon shortcut invoked")
                monitor.show()
            }
            return noErr
        }, 1, &type, context, &handler)
        guard installed == noErr else { return false }
        let id = EventHotKeyID(signature: 0x434C454F, id: 1)
        return RegisterEventHotKey(UInt32(kVK_ANSI_C), UInt32(controlKey), id,
                                   GetApplicationEventTarget(), 0, &hotkey) == noErr
    }

    func stop() {
        if let hotkey { UnregisterEventHotKey(hotkey) }
        if let handler { RemoveEventHandler(handler) }
        hotkey = nil
        handler = nil
    }
}
