import AppKit

@main
enum CleoApp {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { application.run() }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var hotkey: SummonHotkey?
    private var companion: ScreenCompanion?
    private var fixture: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if CommandLine.arguments.contains("--permission-check") {
            Task { await DesktopPermissionCheck.run(); NSApp.terminate(nil) }
            return
        }
        if CommandLine.arguments.contains("--document-fixture") {
            let window = NSWindow(contentRect: CGRect(x: 100, y: 180, width: 950, height: 550),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Cleo — synthetic agreement for pointing check"
            window.isReleasedWhenClosed = false
            let text = NSTextView(frame: CGRect(x: 35, y: 35, width: 880, height: 460))
            text.isEditable = false; text.font = .systemFont(ofSize: 25)
            text.string = "SERVICES AGREEMENT — EXAMPLE\n\n6. Termination\n\nEither party may end this agreement with thirty days of written notice,\nprovided that all outstanding payment obligations continue during the notice period.\n\nThis is a fictional document for a local display test."
            text.textColor = .black; text.backgroundColor = .white
            window.contentView?.wantsLayer = true
            window.contentView?.layer?.backgroundColor = NSColor.white.cgColor
            window.contentView?.addSubview(text)
            fixture = window; window.makeKeyAndOrderFront(nil); window.orderFrontRegardless()
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let mainMenu = NSMenu(), applicationItem = NSMenuItem(), applicationMenu = NSMenu()
        let talk = applicationMenu.addItem(withTitle: "Start / pause Cleo", action: #selector(showCleo), keyEquivalent: "")
        talk.target = self
        applicationMenu.addItem(withTitle: "Quit Cleo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        applicationItem.submenu = applicationMenu
        mainMenu.addItem(applicationItem)
        NSApp.mainMenu = mainMenu
        let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "sparkle", accessibilityDescription: "Cleo")
        let menu = NSMenu()
        let show = menu.addItem(withTitle: "Start / pause Cleo  ⌃C", action: #selector(showCleo), keyEquivalent: "")
        show.target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Cleo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = menu
        self.statusItem = statusItem
        let companion = ScreenCompanion()
        self.companion = companion
        if CommandLine.arguments.contains("--highlight-live-check") {
            companion.checkHighlights()
            return
        }
        if CommandLine.arguments.contains("--screen-context-check") {
            companion.checkContext()
            return
        }
        if CommandLine.arguments.contains("--pointing-live-check") {
            companion.checkPointing(sentence: CommandLine.arguments.contains("--sentence-selection-check"),
                                    speechAligned: CommandLine.arguments.contains("--speech-mark-check"))
            return
        }
        if CommandLine.arguments.contains("--notepad-live-check") {
            companion.checkNotepad()
            return
        }
        hotkey = SummonHotkey { [weak companion] in companion?.converse() }
        if hotkey?.start() != true {
            let alert = NSAlert()
            alert.messageText = "Control-C is unavailable"
            alert.informativeText = "Use Start / pause Cleo in the menu bar. Another app may already use this shortcut."
            alert.runModal()
        }
        companion.show()
    }

    @objc private func showCleo() { companion?.converse() }

    func applicationWillTerminate(_ notification: Notification) { hotkey?.stop(); companion?.shutdown() }

    // Closing the panel must leave the menu-bar app and its hotkey available.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if CommandLine.arguments.contains("--document-fixture") {
            NSApp.activate(ignoringOtherApps: true); fixture?.makeKeyAndOrderFront(nil); fixture?.orderFrontRegardless()
            return true
        }
        if CommandLine.arguments.contains("--notepad-live-check") || CommandLine.arguments.contains("--pointing-live-check")
            { return true }
        companion?.show()
        return true
    }
}
