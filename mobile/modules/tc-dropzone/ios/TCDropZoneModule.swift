import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

// A container view that accepts drag-and-drop (UIDropInteraction): drop a
// screenshot from Finder or Photos onto the chat (iPad apps on Apple-silicon
// Macs get cross-app drops) and it lands as an onDrop event. The dropped
// item's provider file only lives for the duration of the load callback, so
// it is copied into our own tmp dir and the path handed to JS, which reads
// it and rides the existing /api/upload pipeline.
public final class TCDropZoneView: ExpoView, UIDropInteractionDelegate {
    let onDrop = EventDispatcher()

    public required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        addInteraction(UIDropInteraction(delegate: self))
    }

    public func dropInteraction(_ interaction: UIDropInteraction,
                                canHandle session: UIDropSession) -> Bool {
        return session.hasItemsConforming(toTypeIdentifiers:
            [UTType.image.identifier, UTType.fileURL.identifier])
    }

    public func dropInteraction(_ interaction: UIDropInteraction,
                                sessionDidUpdate session: UIDropSession) -> UIDropProposal {
        return UIDropProposal(operation: .copy)
    }

    public func dropInteraction(_ interaction: UIDropInteraction,
                                performDrop session: UIDropSession) {
        for item in session.items {
            let provider = item.itemProvider
            let suggested = provider.suggestedName ?? ""
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                provider.loadFileRepresentation(
                    forTypeIdentifier: UTType.image.identifier
                ) { [weak self] url, _ in
                    guard let self, let url else { return }
                    self.stash(url: url, suggested: suggested)
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                _ = provider.loadObject(ofClass: URL.self) { [weak self] url, _ in
                    guard let self, let url else { return }
                    let scoped = url.startAccessingSecurityScopedResource()
                    self.stash(url: url, suggested: suggested)
                    if scoped { url.stopAccessingSecurityScopedResource() }
                }
            }
        }
    }

    private func stash(url: URL, suggested: String) {
        let ext = url.pathExtension
        var name = suggested.isEmpty ? url.lastPathComponent : suggested
        if !ext.isEmpty && !name.lowercased().hasSuffix(".\(ext.lowercased())") {
            name += ".\(ext)"
        }
        let dest = FileManager.default.temporaryDirectory
            .appendingPathComponent("tc-drop-\(UUID().uuidString)-\(name)")
        do {
            try FileManager.default.copyItem(at: url, to: dest)
        } catch {
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.onDrop(["name": name, "path": dest.path])
        }
    }
}

public class TCDropZoneModule: Module {
    public func definition() -> ModuleDefinition {
        Name("TCDropZone")

        View(TCDropZoneView.self) {
            Events("onDrop")
        }
    }
}
