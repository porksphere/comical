package dev.comical.host

import android.content.Context
import android.webkit.WebSettings

/**
 * The platform User-Agent the contexts report as `getDefaultUserAgent()`: the system WebView's own
 * (`WebSettings.getDefaultUserAgent`), so a bridge that adopts it meets a site exactly as the app's
 * web check does. An anti-bot check passes only when the web view's User-Agent agrees with what its
 * engine reports about itself, and a User-Agent borrowed from another browser or OS makes it ask
 * again forever. Falls back to the JVM's `http.agent` if the WebView can't be reached.
 */
object PlatformUserAgent {
    @Volatile private var cached: String? = null

    fun of(context: Context): String {
        cached?.let { return it }
        val webView = try {
            WebSettings.getDefaultUserAgent(context.applicationContext)
        } catch (_: Throwable) {
            null
        }
        if (!webView.isNullOrBlank()) {
            cached = webView
            return webView
        }
        return System.getProperty("http.agent") ?: ""
    }
}
