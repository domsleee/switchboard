import AppKit

final class Switchboard: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var item: NSStatusItem!
    let status = NSMenuItem(title: "Checking Switchboard…", action: nil, keyEquivalent: "")
    let webStatus = NSMenuItem(title: "Checking web server…", action: nil, keyEquivalent: "")
    var startingWeb = false
    let label = "dev.zellij.switchboard"
    let zellij = Bundle.main.object(forInfoDictionaryKey: "SwitchboardZellij") as? String ?? ""
    let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/zellij-switchboard.log")

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "terminal", accessibilityDescription: "Switchboard")
        item.button?.image?.isTemplate = true
        let menu = NSMenu()
        menu.delegate = self
        add(menu, "Open Switchboard", #selector(openBoard))
        menu.addItem(status)
        menu.addItem(webStatus)
        menu.addItem(.separator())
        add(menu, "Start Switchboard", #selector(startRelay))
        add(menu, "Start web server", #selector(startWeb))
        add(menu, "Open logs", #selector(openLogs))
        menu.addItem(.separator())
        add(menu, "Quit menu bar app", #selector(quit))
        item.menu = menu
        startRelay()
        startWeb()
    }

    func add(_ menu: NSMenu, _ title: String, _ action: Selector) {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: "")
        entry.target = self
        menu.addItem(entry)
    }

    func run(_ command: [String], completion: @escaping (Int32) -> Void) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: command[0])
        task.arguments = Array(command.dropFirst())
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        task.terminationHandler = { task in
            DispatchQueue.main.async { completion(task.terminationStatus) }
        }
        do { try task.run() } catch { completion(-1) }
    }

    func menuWillOpen(_ menu: NSMenu) {
        URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:8090/")!) { _, response, _ in
            let online = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { self.status.title = online ? "Switchboard running" : "Switchboard offline" }
        }.resume()
        checkWeb { online in self.webStatus.title = online ? "Web server running" : "Web server offline" }
    }

    func checkWeb(_ completion: @escaping (Bool) -> Void) {
        guard !zellij.isEmpty else { completion(false); return }
        run([zellij, "web", "--status", "--timeout", "2"]) { completion($0 == 0) }
    }

    @objc func openBoard() { NSWorkspace.shared.open(URL(string: "https://switchboard.localhost/")!) }
    @objc func openLogs() { NSWorkspace.shared.open(log) }
    @objc func startRelay() {
        // launchd owns the relay; starting an already running job leaves it alone.
        run(["/bin/launchctl", "kickstart", "gui/\(getuid())/\(label)"]) { code in
            self.status.title = code == 0 ? "Switchboard running" : "Switchboard service unavailable"
        }
    }
    @objc func startWeb() {
        guard !startingWeb else { return }
        startingWeb = true
        checkWeb { online in
            if online { self.webStatus.title = "Web server running"; self.startingWeb = false; return }
            guard !self.zellij.isEmpty else { self.webStatus.title = "Zellij executable missing"; self.startingWeb = false; return }
            self.webStatus.title = "Starting web server…"
            self.run([self.zellij, "web", "--daemonize"]) { code in
                self.webStatus.title = code == 0 ? "Web server running" : "Web server failed to start"
                self.startingWeb = false
            }
        }
    }
    // Quitting this icon leaves terminal sessions and the supervised relay running.
    @objc func quit() { NSApplication.shared.terminate(nil) }
}

let app = NSApplication.shared
let delegate = Switchboard()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
