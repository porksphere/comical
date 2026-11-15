import Foundation

/// What the host knows about the platform that the contexts can't find out for themselves.
///
/// `webViewUserAgent` is the User-Agent of the platform's web view (WKWebView's `navigator.userAgent`),
/// set by the app at launch, since reading it needs the main thread and a live web view. The contexts
/// report it as `getDefaultUserAgent()`, so a bridge that adopts it meets a site exactly as the app's
/// web check does: an anti-bot check passes only when the web view's User-Agent agrees with what its
/// engine reports about itself, and a User-Agent borrowed from another browser or OS makes it ask
/// again forever. Until it's set, the contexts fall back to their bundle-and-OS string.
public enum ComicalPlatform {
    private static let lock = NSLock()
    private static var storedUserAgent: String?

    public static var webViewUserAgent: String? {
        get {
            lock.lock(); defer { lock.unlock() }
            return storedUserAgent
        }
        set {
            lock.lock(); defer { lock.unlock() }
            storedUserAgent = newValue?.isEmpty == true ? nil : newValue
        }
    }
}
