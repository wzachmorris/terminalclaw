import ExpoModulesCore
import UIKit

// Host view: attaches the (manager-owned) session's TerminalView while
// mounted; detaching leaves the session connected. React remounts a host per
// sessionKey, so update() runs once per mount in practice.
public class TCTerminalHostView: ExpoView {
    let onStatus = EventDispatcher()

    private var sessionKey = ""
    private var endpoint = ""
    private var fontSize: CGFloat = 13
    private var attached: TCSession?

    public required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        backgroundColor = .black
        clipsToBounds = true
    }

    func setSessionKey(_ k: String) { sessionKey = k; attachIfReady() }
    func setEndpoint(_ e: String) { endpoint = e; attachIfReady() }
    func setFontSize(_ f: Double) { fontSize = CGFloat(f) }

    private func attachIfReady() {
        guard !sessionKey.isEmpty, !endpoint.isEmpty,
              let url = URL(string: endpoint) else { return }
        if attached?.key == sessionKey { return }
        detach()
        let s = TCSessions.shared.session(key: sessionKey, url: url, fontSize: fontSize)
        attached = s
        s.statusHandler = { [weak self] st in
            DispatchQueue.main.async { self?.onStatus(["status": st]) }
        }
        s.view.frame = bounds
        addSubview(s.view)
        s.wake()
    }

    private func detach() {
        attached?.statusHandler = nil
        attached?.view.removeFromSuperview()
        attached = nil
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        attached?.view.frame = bounds
    }

    public override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        // Unmounted from React: detach the view, keep the session alive.
        if newWindow == nil { detach() }
        else if attached == nil { attachIfReady() }
    }
}

public class TCTerminalModule: Module {
    public func definition() -> ModuleDefinition {
        Name("TCTerminal")

        View(TCTerminalHostView.self) {
            Events("onStatus")
            Prop("sessionKey") { (view: TCTerminalHostView, key: String) in
                view.setSessionKey(key)
            }
            Prop("endpoint") { (view: TCTerminalHostView, endpoint: String) in
                view.setEndpoint(endpoint)
            }
            Prop("fontSize") { (view: TCTerminalHostView, size: Double) in
                view.setFontSize(size)
            }
        }

        Function("send") { (key: String, text: String) in
            TCSessions.shared.get(key)?.sendInput(text)
        }

        AsyncFunction("getSelection") { (key: String) -> String in
            return TCSessions.shared.get(key)?.view.getSelection() ?? ""
        }.runOnQueue(.main)

        Function("disconnect") { (key: String) in
            TCSessions.shared.close(key)
        }

        Function("disconnectAll") {
            TCSessions.shared.closeAll()
        }
    }
}
