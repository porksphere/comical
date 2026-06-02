/**
 * ComicalServer — optional on-device HTTP server for Android.
 *
 * Equivalent to ComicalServer.swift — exposes the bridge runtime as a local HTTP API,
 * useful for hybrid apps where a WebView needs to call bridge methods via fetch().
 * Uses NanoHTTPD as a minimal embedded HTTP server (no Play Services dependency).
 *
 * For most apps, use ComicalBridgeContext.call() directly from Kotlin.
 */
package dev.comical.host

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

class ComicalServer(private val context: ComicalBridgeContext) {
    private var serverSocket: ServerSocket? = null
    var port: Int = 0
        private set

    fun start() {
        val ss = ServerSocket()
        ss.bind(InetSocketAddress("127.0.0.1", 0))
        port = ss.localPort
        serverSocket = ss
        thread(isDaemon = true) {
            while (!ss.isClosed) {
                try {
                    val conn = ss.accept()
                    thread(isDaemon = true) { handle(conn) }
                } catch (_: Exception) {}
            }
        }
    }

    fun stop() { serverSocket?.close() }

    private fun handle(conn: Socket) {
        try {
            val input = conn.getInputStream().bufferedReader()
            val firstLine = input.readLine() ?: return
            // Drain headers
            var line: String
            do { line = input.readLine() ?: break } while (line.isNotEmpty())

            val parts = firstLine.split(" ")
            val path = if (parts.size >= 2) parts[1] else "/"

            val (status, body) = runBlocking {
                try { 200 to route(path) }
                catch (e: Exception) { 500 to """{"error":"${e.message}"}""" }
            }

            val response = buildString {
                append("HTTP/1.1 $status OK\r\n")
                append("Content-Type: application/json\r\n")
                append("Access-Control-Allow-Origin: *\r\n")
                append("Content-Length: ${body.toByteArray().size}\r\n")
                append("\r\n")
                append(body)
            }
            conn.getOutputStream().write(response.toByteArray())
        } finally {
            conn.close()
        }
    }

    private suspend fun route(path: String): String {
        val idx = path.indexOf('?')
        val p = if (idx >= 0) path.substring(0, idx) else path
        val query = parseQuery(if (idx >= 0) path.substring(idx + 1) else "")

        return when {
            p == "/health" -> """{"ok":true}"""
            p == "/info" -> toJson(context.call("info"))
            p == "/search" -> toJson(context.call("getSearchResults", listOf(query["q"] ?: "", (query["page"] ?: "1").toInt())))
            p == "/lists" -> toJson(context.call("getLists"))
            Regex("^/lists/([^/]+)$").matches(p) ->
                toJson(context.call("getListItems", listOf(p.split("/")[2], (query["page"] ?: "1").toInt())))
            Regex("^/series/([^/]+)/chapters/([^/]+)/pages$").matches(p) -> {
                val parts = p.split("/")
                toJson(context.call("getChapterPages", listOf(parts[2], parts[4])))
            }
            Regex("^/series/([^/]+)/chapters$").matches(p) -> toJson(context.call("getChapters", listOf(p.split("/")[2])))
            Regex("^/series/([^/]+)$").matches(p) -> toJson(context.call("getSeriesDetails", listOf(p.split("/")[2])))
            else -> throw ComicalError("unknown route: $p")
        }
    }

    private fun toJson(value: Any): String = when (value) {
        is JSONObject -> value.toString()
        is JSONArray  -> value.toString()
        is String     -> value
        else          -> value.toString()
    }

    private fun parseQuery(query: String): Map<String, String> =
        query.split("&").mapNotNull {
            val eq = it.indexOf('=')
            if (eq < 0) null else it.substring(0, eq) to it.substring(eq + 1)
        }.toMap()
}
