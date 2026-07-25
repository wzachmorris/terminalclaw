import ExpoModulesCore
import UIKit

// A read-only UITextView the chat bubbles render into: real native text
// selection (drag handles on the phone, mouse drag + Cmd-C on the Mac)
// inside React-managed layout. RN's <Text> is not a real text view and only
// offers copy-whole-block, which is why this exists.
//
// Self-sizing: Yoga can't measure a native subview, so the view measures its
// text at the current width and reports the height through onSize; the JS
// wrapper applies it as the style height.
public final class TCSelTextView: ExpoView {
    let onSize = EventDispatcher()
    private let tv = UITextView()
    private var lastReported: CGFloat = -1
    private var fontSize: CGFloat = 12
    private var colorHex = "#e6edf3"

    public required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        tv.isEditable = false
        tv.isSelectable = true
        tv.isScrollEnabled = false          // selection without inner scrolling
        tv.backgroundColor = .clear
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        addSubview(tv)
        applyStyle()
    }

    func setText(_ t: String) {
        tv.text = t
        setNeedsLayout()
    }

    func setFontSize(_ s: Double) {
        fontSize = CGFloat(s)
        applyStyle()
    }

    func setColor(_ hex: String) {
        colorHex = hex
        applyStyle()
    }

    private func applyStyle() {
        tv.font = UIFont(name: "Menlo", size: fontSize)
            ?? .monospacedSystemFont(ofSize: fontSize, weight: .regular)
        tv.textColor = Self.color(fromHex: colorHex) ?? .white
        setNeedsLayout()
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        tv.frame = bounds
        let w = bounds.width
        guard w > 0 else { return }
        let h = tv.sizeThatFits(
            CGSize(width: w, height: .greatestFiniteMagnitude)).height
        if abs(h - lastReported) > 0.5 {
            lastReported = h
            onSize(["height": Double(h)])
        }
    }

    private static func color(fromHex hex: String) -> UIColor? {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        return UIColor(red: CGFloat((v >> 16) & 0xff) / 255,
                       green: CGFloat((v >> 8) & 0xff) / 255,
                       blue: CGFloat(v & 0xff) / 255,
                       alpha: 1)
    }
}

public class TCSelTextModule: Module {
    public func definition() -> ModuleDefinition {
        Name("TCSelText")

        View(TCSelTextView.self) {
            Events("onSize")
            Prop("text") { (view: TCSelTextView, text: String) in
                view.setText(text)
            }
            Prop("fontSize") { (view: TCSelTextView, size: Double) in
                view.setFontSize(size)
            }
            Prop("color") { (view: TCSelTextView, hex: String) in
                view.setColor(hex)
            }
        }
    }
}
