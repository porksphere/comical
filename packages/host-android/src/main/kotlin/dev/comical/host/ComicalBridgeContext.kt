/**
 * ComicalBridgeContext — the Android QuickJS evaluator and host adapter.
 *
 * Wraps a QuickJS runtime, evaluates the harness.js shim (bundled in assets), then loads and
 * runs a CJS bridge bundle. Injects native Kotlin callbacks for network (OkHttp), storage
 * (DataStore), and logging (Android Log) before calling `comical_init`.
 *
 * QuickJS is used rather than V8 or Hermes: at ~1 MB it adds the least to APK size, supports
 * ES2020, and runs our engine-agnostic bridge bundles without modification.
 *
 * Usage:
 *   val ctx = ComicalBridgeContext(context, bundleCode, mapOf("baseUrl" to "https://…"))
 *   val info = ctx.bridgeInfo          // BridgeInfo (data class)
 *   val result = ctx.call("getSearchResults", listOf("naruto", 1))
 */
package dev.comical.host

import android.content.Context
import android.util.Log
import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.binding.asyncFunction
import com.dokar.quickjs.binding.function
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

private const val TAG = "ComicalBridge"

// MARK: - Public types

data class BridgeInfo(
    val id: String,
    val name: String,
    val version: String,
    val contractVersion: String,
    val languages: List<String>,
    val nsfw: Boolean,
    val capabilities: List<String>
)

class ComicalError(message: String) : Exception(message)

// MARK: - Context

class ComicalBridgeContext(
    private val androidContext: Context,
    bundleCode: String,
    settings: Map<String, Any> = emptyMap(),
    dataDir: File? = null
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val storageFile: File
    private val http = OkHttpClient.Builder().followRedirects(true).build()
    private val js: QuickJs

    init {
        val dir = dataDir ?: File(androidContext.filesDir, "comical")
        dir.mkdirs()
        storageFile = File(dir, "storage.json")

        js = QuickJs.create()
        injectNativeCallbacks()

        // Evaluate the harness shim from assets.
        val harness = androidContext.assets.open("comical_harness.js").bufferedReader().readText()
        js.evaluate(harness, "harness.js")

        // Initialise the bridge.
        val settingsJson = JSONObject(settings).toString()
        js.evaluate(
            "comical_init(${jsonString(bundleCode)}, ${jsonString(settingsJson)})",
            "bridge_init"
        )
    }

    // MARK: - Bridge info

    val bridgeInfo: BridgeInfo? get() {
        val raw = js.evaluate("JSON.stringify(comical_bridge?.info)") as? String ?: return null
        val obj = JSONObject(raw)
        return BridgeInfo(
            id = obj.getString("id"),
            name = obj.getString("name"),
            version = obj.getString("version"),
            contractVersion = obj.getString("contractVersion"),
            languages = (0 until obj.getJSONArray("languages").length()).map {
                obj.getJSONArray("languages").getString(it)
            },
            nsfw = obj.getBoolean("nsfw"),
            capabilities = (0 until obj.getJSONArray("capabilities").length()).map {
                obj.getJSONArray("capabilities").getString(it)
            }
        )
    }

    // MARK: - Method dispatch

    suspend fun call(method: String, args: List<Any> = emptyList()): Any =
        withContext(Dispatchers.IO) {
            val argsJson = JSONArray(args).toString()
            val resultJson = js.evaluate(
                "comical_call(${jsonString(method)}, ${jsonString(argsJson)})",
                "bridge_call"
            ) as? String ?: throw ComicalError("null result from $method")
            // Parse the promise synchronously — QuickJs evaluates micro-tasks inline.
            parseJson(resultJson)
        }

    // MARK: - Native callback injection

    private fun injectNativeCallbacks() {
        // Logging
        js.function("_native_log") { args: Array<Any?> ->
            val level = args.getOrNull(0) as? String ?: "info"
            val msg = args.getOrNull(1) as? String ?: ""
            when (level) {
                "debug" -> Log.d(TAG, msg)
                "warn"  -> Log.w(TAG, msg)
                "error" -> Log.e(TAG, msg)
                else    -> Log.i(TAG, msg)
            }
        }

        // Network (OkHttp)
        js.asyncFunction("_native_network_request") { args: Array<Any?> ->
            val reqJson = args.getOrNull(0) as? String
                ?: throw ComicalError("_native_network_request: missing request JSON")
            val req = JSONObject(reqJson)
            val url = req.getString("url")
            val method = req.optString("method", "GET")
            val headers = req.optJSONObject("headers")
            val body = req.optString("body").takeIf { it.isNotEmpty() }

            val builder = Request.Builder().url(url)
            headers?.keys()?.forEach { k -> builder.header(k, headers.getString(k)) }

            val reqBody = body?.toRequestBody("application/octet-stream".toMediaType())
            builder.method(method, reqBody)

            val response = withContext(Dispatchers.IO) {
                http.newCall(builder.build()).execute()
            }
            val responseBody = response.body?.string() ?: ""
            val responseHeaders = JSONObject()
            response.headers.forEach { (k, v) -> responseHeaders.put(k.lowercase(), v) }

            JSONObject().apply {
                put("url", response.request.url.toString())
                put("status", response.code)
                put("statusText", response.message)
                put("headers", responseHeaders)
                put("body", responseBody)
            }.toString()
        }

        // Storage
        js.asyncFunction("_native_storage_get") { args: Array<Any?> ->
            val key = args.getOrNull(0) as? String ?: return@asyncFunction null
            readStorage()[key]
        }
        js.asyncFunction("_native_storage_set") { args: Array<Any?> ->
            val key = args.getOrNull(0) as? String ?: return@asyncFunction null
            val value = args.getOrNull(1) as? String ?: return@asyncFunction null
            val store = readStorage().toMutableMap()
            store[key] = value
            writeStorage(store)
            null
        }
        js.asyncFunction("_native_storage_delete") { args: Array<Any?> ->
            val key = args.getOrNull(0) as? String ?: return@asyncFunction null
            val store = readStorage().toMutableMap()
            store.remove(key)
            writeStorage(store)
            null
        }
        js.asyncFunction("_native_storage_keys") { _: Array<Any?> ->
            JSONArray(readStorage().keys.toList()).toString()
        }
    }

    // MARK: - Storage helpers

    private fun readStorage(): Map<String, String> {
        if (!storageFile.exists()) return emptyMap()
        return try {
            val obj = JSONObject(storageFile.readText())
            obj.keys().asSequence().associateWith { obj.getString(it) }
        } catch (_: Exception) { emptyMap() }
    }

    private fun writeStorage(store: Map<String, String>) {
        val obj = JSONObject(store as Map<*, *>)
        storageFile.writeText(obj.toString())
    }

    // MARK: - Utilities

    fun close() { js.close() }

    private fun jsonString(s: String): String {
        val escaped = s
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        return "\"$escaped\""
    }

    private fun parseJson(json: String): Any =
        when {
            json.startsWith("{") -> JSONObject(json)
            json.startsWith("[") -> JSONArray(json)
            else -> json
        }
}
