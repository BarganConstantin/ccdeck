// ccdeck's menu-bar icon on macOS (#1160).
//
// A small accessory app: an NSStatusItem with the deck's ring, a menu that
// opens the deck and flips its notification switch, and — the reason it is a
// real .app rather than another osascript call — notifications raised under
// the app's own name and icon instead of Script Editor's.
//
// It talks to the deck the way hook/hook.js does. The deck writes its port and
// a per-run token to `<config dir>/agent-dag/<pid>.json` at mode 0600; this
// reads that file, asks the listener to prove it holds the token
// (`/api/hook-challenge`), and only then sends the token back as
// `x-ccdeck-token`. A discovery file left behind by a deck that died names a
// port that may belong to anything by now, and the challenge is what tells the
// two apart.
//
// Two command-line modes besides the menu bar, both used by the build and by
// the deck rather than by people:
//
//   --render-icon <png> <px>   draw the app icon, so build.sh makes the .icns
//                              from the same drawing code the menu bar uses
//   --notify <title> <body>    raise one notification as ccdeck and exit
import AppKit
import CryptoKit
import UserNotifications

// MARK: - The deck this talks to

struct Deck {
    let pid: Int32
    let port: Int
    let token: String
    let version: String
    let startedAt: String

    var base: URL { URL(string: "http://127.0.0.1:\(port)")! }
}

/// Where the deck keeps its discovery files. Claude Code's config directory,
/// which `CLAUDE_CONFIG_DIR` moves — the deck follows it, so this does too.
func discoveryDir() -> URL {
    let env = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"]
    let root = env.flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude")
    return root.appendingPathComponent("agent-dag")
}

/// A pid that answers. EPERM counts: the process exists and belongs to
/// somebody else, which for our own discovery file means the pid was reused —
/// the challenge below is what settles that, not this.
func isAlive(_ pid: Int32) -> Bool {
    kill(pid, 0) == 0 || errno == EPERM
}

/// The newest deck whose process is still there. Only `<digits>.json` —
/// prefs.json and the rest of that directory are not discovery files.
func findDeck() -> Deck? {
    let dir = discoveryDir()
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return nil }
    var found: [Deck] = []
    for name in names where name.hasSuffix(".json") && name.dropLast(5).allSatisfy(\.isNumber) {
        guard
            let data = try? Data(contentsOf: dir.appendingPathComponent(name)),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let pid = (obj["pid"] as? NSNumber)?.int32Value,
            let port = (obj["port"] as? NSNumber)?.intValue,
            let token = obj["token"] as? String, !token.isEmpty,
            isAlive(pid)
        else { continue }
        found.append(Deck(
            pid: pid, port: port, token: token,
            version: obj["version"] as? String ?? "",
            startedAt: obj["startedAt"] as? String ?? ""))
    }
    // ISO timestamps sort as strings.
    return found.max { $0.startedAt < $1.startedAt }
}

// MARK: - Talking to it

final class DeckClient {
    let deck: Deck
    init(_ deck: Deck) { self.deck = deck }

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                         authed: Bool = true) async throws -> [String: Any] {
        var req = URLRequest(url: deck.base.appendingPathComponent(path), timeoutInterval: 3)
        req.httpMethod = method
        if authed { req.setValue(deck.token, forHTTPHeaderField: "x-ccdeck-token") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, _) = try await URLSession.shared.data(for: req)
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    /// Does the listener on this port hold the token? Asked before the token
    /// is ever sent, with a nonce it has never seen — the same exchange the
    /// hook makes, and for the same reason.
    func verify() async -> Bool {
        let nonce = UUID().uuidString
        guard
            var comps = URLComponents(url: deck.base.appendingPathComponent("/api/hook-challenge"),
                                      resolvingAgainstBaseURL: false)
        else { return false }
        comps.queryItems = [URLQueryItem(name: "nonce", value: nonce)]
        guard let url = comps.url,
              let (data, _) = try? await URLSession.shared.data(from: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let proof = obj["proof"] as? String
        else { return false }
        let expected = SHA256.hash(data: Data("\(deck.token):\(nonce)".utf8))
            .map { String(format: "%02x", $0) }.joined()
        return proof == expected
    }

    func notificationsOn() async -> Bool? {
        guard let obj = try? await request("/api/prefs"),
              let prefs = obj["prefs"] as? [String: Any] else { return nil }
        return prefs["notifications"] as? Bool
    }

    func setNotifications(_ on: Bool) async -> Bool? {
        guard let obj = try? await request("/api/prefs", method: "POST", body: ["notifications": on]),
              let prefs = obj["prefs"] as? [String: Any] else { return nil }
        return prefs["notifications"] as? Bool
    }

    func shutdown() async {
        _ = try? await request("/api/shutdown", method: "POST", body: [:])
    }
}

// MARK: - The ring

/// The deck's mark: the favicon's ring (src/web/ambient.ts), a circle of
/// radius 12 and stroke 5 on a 32-unit canvas, scaled to `rect`.
func drawRing(in rect: NSRect, color: NSColor) {
    let unit = min(rect.width, rect.height) / 32
    let centre = NSPoint(x: rect.midX, y: rect.midY)
    let path = NSBezierPath()
    path.appendArc(withCenter: centre, radius: 12 * unit, startAngle: 0, endAngle: 360)
    path.lineWidth = 5 * unit
    color.setStroke()
    path.stroke()
}

/// The menu-bar image. A template, so macOS tints it for a light or dark bar
/// and for the highlighted state; `dim` when there is no deck to talk to.
func statusImage(dim: Bool) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
        drawRing(in: rect.insetBy(dx: 1, dy: 1), color: NSColor.black.withAlphaComponent(dim ? 0.45 : 1))
        return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "ccdeck"
    return image
}

/// The app icon, drawn with the same ring: a dark rounded square and the
/// running blue from ambient.ts. build.sh turns this into the .icns that
/// notifications show beside their title.
func renderIcon(to path: String, px: Int) -> Bool {
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0)
    else { return false }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let size = CGFloat(px)
    // Apple's icon grid: the tile is inset from the canvas edge.
    let tile = NSRect(x: 0, y: 0, width: size, height: size).insetBy(dx: size * 0.1, dy: size * 0.1)
    NSColor(srgbRed: 0x1f / 255, green: 0x1f / 255, blue: 0x1f / 255, alpha: 1).setFill()
    NSBezierPath(roundedRect: tile, xRadius: tile.width * 0.225, yRadius: tile.width * 0.225).fill()
    drawRing(in: tile.insetBy(dx: tile.width * 0.2, dy: tile.width * 0.2),
             color: NSColor(srgbRed: 0x2a / 255, green: 0x90 / 255, blue: 0xd4 / 255, alpha: 1))
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { return false }
    return (try? png.write(to: URL(fileURLWithPath: path))) != nil
}

// MARK: - Notifications

/// Raise one notification as ccdeck. Permission is asked the first time; after
/// a refusal this does nothing, which is macOS's rule and not ours to argue.
func post(title: String, body: String, completion: @escaping (Bool) -> Void) {
    let center = UNUserNotificationCenter.current()
    center.requestAuthorization(options: [.alert, .sound]) { granted, err in
        guard granted else {
            FileHandle.standardError.write(Data("ccdeck: notifications not authorised\(err.map { ": \($0)" } ?? "")\n".utf8))
            completion(false)
            return
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        center.add(req) { err in
            if let err { FileHandle.standardError.write(Data("ccdeck: notification refused: \(err)\n".utf8)) }
            completion(err == nil)
        }
    }
}

// MARK: - The menu bar

final class MenuBar: NSObject, NSApplicationDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate {
    private var item: NSStatusItem!
    private var client: DeckClient?
    private var notifyOn: Bool?
    /// When the deck was last seen. The icon leaves once it has been gone for
    /// `goneAfter`: a stopped deck should not leave a ring behind for good, and
    /// a restart or an update is back well inside the window — a new deck
    /// starts the icon again anyway (menubar.mjs).
    private var lastSeen = Date()
    private let goneAfter: TimeInterval = 60

    // Before launch finishes, not after: a click on a notification while this
    // app is not running LAUNCHES it to deliver the click, and a delegate set
    // later than this misses it.
    func applicationWillFinishLaunching(_ note: Notification) {
        UNUserNotificationCenter.current().delegate = self
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        retireOlderIcons()
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = statusImage(dim: true)
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        Task { await refresh() }
        // The deck comes and goes — a restart, an update, `ccdeck --stop` — and
        // the icon should say so without anybody opening the menu.
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
    }

    /// One icon, and it is the newest. Every deck start runs `open` on the app
    /// from its own install, and an update moves the install — so the icon
    /// already in the bar can be the previous version's, from a directory npx
    /// may clean up. The one starting now came from the deck starting now.
    /// Only other ACCESSORY instances: a `--notify` process carries the same
    /// bundle id for the second it lives, and is nobody's icon.
    private func retireOlderIcons() {
        let me = NSRunningApplication.current
        guard let id = Bundle.main.bundleIdentifier else { return }
        for other in NSRunningApplication.runningApplications(withBundleIdentifier: id)
        where other != me && other.activationPolicy == .accessory {
            other.terminate()
        }
    }

    /// Find the deck again, and keep the old client when it is the same one:
    /// the challenge is a round trip, and five seconds is often.
    @MainActor
    private func refresh() async {
        guard let deck = findDeck() else {
            client = nil
            item.button?.image = statusImage(dim: true)
            if Date().timeIntervalSince(lastSeen) > goneAfter { NSApp.terminate(nil) }
            return
        }
        lastSeen = Date()
        if client?.deck.pid != deck.pid || client?.deck.token != deck.token {
            let candidate = DeckClient(deck)
            client = await candidate.verify() ? candidate : nil
        }
        item.button?.image = statusImage(dim: client == nil)
        if let client { notifyOn = await client.notificationsOn() }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        guard let client else {
            menu.addItem(disabled("No deck running"))
            menu.addItem(disabled("Start one with npx ccdeck"))
            menu.addItem(.separator())
            menu.addItem(action("Quit menu-bar icon", #selector(quit), key: "q"))
            return
        }
        let deck = client.deck
        menu.addItem(disabled("ccdeck \(deck.version.isEmpty ? "" : "v\(deck.version) · ")port \(deck.port)"))
        menu.addItem(.separator())
        menu.addItem(action("Open deck", #selector(openDeck), key: "o"))
        menu.addItem(.separator())
        let notify = action("Notifications while closed", #selector(toggleNotifications))
        notify.state = notifyOn == true ? .on : .off
        notify.isEnabled = notifyOn != nil
        menu.addItem(notify)
        menu.addItem(action("Send a test notification", #selector(testNotification)))
        menu.addItem(.separator())
        menu.addItem(action("Stop deck", #selector(stopDeck)))
        menu.addItem(action("Quit menu-bar icon", #selector(quit), key: "q"))
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        it.isEnabled = false
        return it
    }

    private func action(_ title: String, _ sel: Selector, key: String = "") -> NSMenuItem {
        let it = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        it.target = self
        return it
    }

    @objc private func openDeck() {
        if let url = client?.deck.base { NSWorkspace.shared.open(url) }
    }

    @objc private func toggleNotifications() {
        guard let client, let on = notifyOn else { return }
        Task { @MainActor in
            notifyOn = await client.setNotifications(!on) ?? on
        }
    }

    @objc private func testNotification() {
        post(title: "ccdeck", body: "Notifications from the menu-bar icon arrive like this.") { ok in
            if !ok { NSLog("ccdeck: the test notification was not delivered (permission refused?)") }
        }
    }

    @objc private func stopDeck() {
        guard let client else { return }
        Task { @MainActor in
            await client.shutdown()
            await refresh()
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // Shown even while this app counts as frontmost — an accessory app has no
    // window to be looking at, so "the user can already see it" never holds.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list, .sound])
    }

    // A click opens the deck: the one thing a notification about the deck
    // should lead to. Read straight from the discovery file rather than from
    // `client`, because the click may be what launched this app and the first
    // refresh has not finished yet.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let url = client?.deck.base ?? findDeck()?.base
        DispatchQueue.main.async { if let url { NSWorkspace.shared.open(url) } }
        done()
    }
}

// MARK: - Entry

let args = CommandLine.arguments
if args.count >= 4, args[1] == "--render-icon" {
    exit(renderIcon(to: args[2], px: Int(args[3]) ?? 1024) ? 0 : 1)
}
/// `--notify`: raise one notification and leave. It runs as a real, if
/// windowless, NSApplication — macOS answers "Notifications are not allowed for
/// this application" to a process that asks before the app has finished
/// launching, however it was started — and exits once macOS has taken the
/// notification, or after 30 seconds.
final class NotifyOnce: NSObject, NSApplicationDelegate {
    let title: String
    let body: String
    init(title: String, body: String) { self.title = title; self.body = body }

    func applicationDidFinishLaunching(_ note: Notification) {
        post(title: title, body: body) { ok in
            if ok { FileHandle.standardError.write(Data("ccdeck: notification delivered\n".utf8)) }
            DispatchQueue.main.async { exit(ok ? 0 : 1) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { exit(1) }
    }
}

let app = NSApplication.shared
if args.count >= 4, args[1] == "--notify" {
    let once = NotifyOnce(title: args[2], body: args[3])
    app.delegate = once
    app.setActivationPolicy(.accessory)
    app.run()
}

let delegate = MenuBar()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
