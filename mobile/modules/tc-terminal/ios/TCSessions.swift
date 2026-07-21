// Native terminal sessions for TerminalClaw.
//
// Each session = one SwiftTerm TerminalView + one websocket speaking ttyd's
// protocol ('0'+bytes = I/O, '1'+JSON = resize, initial JSON hello). Sessions
// live in the manager, NOT in the React view — unmounting a view leaves the
// session connected with its scrollback, so switching tabs is instant and
// nothing is lost. Plain UIViews don't get suspended the way hidden WKWebViews
// do, which is the whole reason this module exists.

import Foundation
import UIKit

final class TCSession: NSObject {
    let key: String
    let url: URL
    let view: TerminalView

    private var task: URLSessionWebSocketTask?
    private let urlSession = URLSession(configuration: .default)
    private var tries = 0
    private var closedByUser = false

    /// "up" | "connecting" | "down" — wired to whichever host view is showing us.
    var statusHandler: ((String) -> Void)?

    var isOpen: Bool { task?.state == .running }

    init(key: String, url: URL, fontSize: CGFloat) {
        self.key = key
        self.url = url
        let font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        view = TerminalView(frame: CGRect(x: 0, y: 0, width: 390, height: 700), font: font)
        super.init()
        view.terminalDelegate = self
        view.backgroundColor = .black
        connect()
    }

    func connect() {
        statusHandler?("connecting")
        let t = urlSession.webSocketTask(with: url, protocols: ["tty"])
        task = t
        t.resume()
        let term = view.getTerminal()
        let hello = "{\"AuthToken\":\"\",\"columns\":\(term.cols),\"rows\":\(term.rows)}"
        t.send(.string(hello)) { [weak self] err in
            if err == nil {
                self?.tries = 0
                self?.statusHandler?("up")
            }
        }
        receiveLoop(t)
    }

    private func receiveLoop(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self = self, self.task === t else { return }
            switch result {
            case .success(let msg):
                var bytes: [UInt8]
                switch msg {
                case .data(let d): bytes = [UInt8](d)
                case .string(let s): bytes = Array(s.utf8)
                @unknown default: bytes = []
                }
                // ttyd frames: first byte '0' = terminal output; '1' (title)
                // and '2' (prefs) are ignored here.
                if bytes.first == 0x30 {
                    let payload = Array(bytes.dropFirst())
                    DispatchQueue.main.async {
                        self.view.feed(byteArray: payload[...])
                    }
                }
                self.receiveLoop(t)
            case .failure:
                self.handleClose()
            }
        }
    }

    private func handleClose() {
        guard !closedByUser else { return }
        tries += 1
        if tries > 6 {
            statusHandler?("down")
            return
        }
        statusHandler?("connecting")
        let delayMs = min(1200 * tries, 5000)
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(delayMs)) { [weak self] in
            guard let self = self, !self.closedByUser else { return }
            self.connect()
        }
    }

    /// Revive a dead socket when a host view re-shows this session.
    func wake() {
        if task == nil || task?.state != .running {
            tries = 0
            connect()
        } else {
            statusHandler?("up")
        }
    }

    func sendInput(_ text: String) {
        var bytes: [UInt8] = [0x30]  // '0' INPUT
        bytes.append(contentsOf: Array(text.utf8))
        task?.send(.data(Data(bytes))) { _ in }
    }

    func close() {
        closedByUser = true
        statusHandler = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }
}

extension TCSession: TerminalViewDelegate {
    public func send(source: TerminalView, data: ArraySlice<UInt8>) {
        var bytes: [UInt8] = [0x30]
        bytes.append(contentsOf: data)
        task?.send(.data(Data(bytes))) { _ in }
    }

    public func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        let msg = "1{\"columns\":\(newCols),\"rows\":\(newRows)}"
        task?.send(.string(msg)) { _ in }
    }

    public func setTerminalTitle(source: TerminalView, title: String) {}

    public func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    public func scrolled(source: TerminalView, position: Double) {}

    public func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        if let url = URL(string: link) {
            DispatchQueue.main.async { UIApplication.shared.open(url) }
        }
    }

    public func clipboardCopy(source: TerminalView, content: Data) {
        // OSC-52 from tmux/vim lands straight on the system clipboard.
        if let s = String(data: content, encoding: .utf8) {
            DispatchQueue.main.async { UIPasteboard.general.string = s }
        }
    }

    public func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

final class TCSessions {
    static let shared = TCSessions()
    private var sessions: [String: TCSession] = [:]

    func session(key: String, url: URL, fontSize: CGFloat) -> TCSession {
        if let s = sessions[key] { return s }
        let s = TCSession(key: key, url: url, fontSize: fontSize)
        sessions[key] = s
        return s
    }

    func get(_ key: String) -> TCSession? { sessions[key] }

    func close(_ key: String) {
        sessions[key]?.close()
        sessions[key] = nil
    }

    func closeAll() {
        sessions.values.forEach { $0.close() }
        sessions.removeAll()
    }
}
