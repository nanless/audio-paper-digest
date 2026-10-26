import AppKit

extension PaperDigestApp {
    /// Match native window chrome, panels and menus to the same local preference as the reading views.
    /// Nil leaves macOS in charge when the user chooses to follow the system.
    func applyApplicationAppearance() {
        let preference=store?.setting("appearance") as? String ?? "system"
        NSApp?.appearance=preference=="dark" ? NSAppearance(named:.darkAqua):preference=="light" ? NSAppearance(named:.aqua):nil
    }
}
