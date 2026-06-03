/**
 * ComicalBridgeContext — the Android QuickJS evaluator and host adapter.
 *
 * Context A evaluates `comical_harness.js` — the bundled @comical/host-native runtime (core +
 * glue). `comical_init` runs the bridge through @comical/core's `loadBridge` + NativeContextEvaluator,
 * which calls `__comical_native_eval(code)` to evaluate the bundle in a SEPARATE QuickJS context B
 * (its own global → a bridge's eval/Function can't reach the app; eval intrinsic omitted).
 *
 * Injects native Kotlin callbacks for network (OkHttp), storage (DataStore), and logging
 * (Android Log); the bundled runtime's async adapter wraps them into core's HostCapabilities.
 *
 * QuickJS is used rather than V8 or Hermes: at ~1 MB it adds the least to APK size and supports
 * ES2020.
 *
 * Usage:
 *   val ctx = ComicalBridgeContext(context, bundleCode, mapOf("baseUrl" to "https://…"))
 *   val info = ctx.bridgeInfo          // BridgeInfo (data class)
 *   val result = ctx.call("getSearchResults", listOf("naruto", 1))
 *
 * ⚠️ UNVERIFIED + INCOMPLETE: `__comical_native_eval` is a documented stub. The dokar/quickjs-kt
 * binding doesn't expose a second JSContext within the runtime, nor a way to return a JS object
 * (the bundle's exports, which hold functions) from a Kotlin function — both are required for the
 * separate-context evaluator. Per the "native-context only" decision (no `new Function` fallback),
 * loading a bridge currently throws until that binding support exists. See `injectBundleEvaluator`.
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
    val capabilities: List<String>,
    val rateLimit: RateLimit? = null
) {
    data class RateLimit(val maxConcurrent: Int?, val minIntervalMs: Int?)
}

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
        injectBundleEvaluator()

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
            },
            rateLimit = obj.optJSONObject("rateLimit")?.let { rl ->
                BridgeInfo.RateLimit(
                    maxConcurrent = if (rl.has("maxConcurrent")) rl.getInt("maxConcurrent") else null,
                    minIntervalMs = if (rl.has("minIntervalMs")) rl.getInt("minIntervalMs") else null
                )
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

    // MARK: - Separate-context bundle evaluator  ⚠️ UNVERIFIED + INCOMPLETE

    /**
     * Registers `__comical_native_eval(code)`, which @comical/core's NativeContextEvaluator calls to
     * evaluate a bridge bundle in an isolated context and return its `module.exports`.
     *
     * Intended implementation (pending QuickJS binding support):
     *   1. Create a SECOND JSContext within this JSRuntime, WITHOUT the eval intrinsic
     *      (`JS_AddIntrinsicEval` is opt-in) so bridges can't eval/Function-construct at runtime.
     *   2. Inject curated globals — mirror `buildBridgeGlobals` (packages/core/src/globals.ts):
     *      console→_native_log, setTimeout/clearTimeout (Handler-backed), atob/btoa, queueMicrotask,
     *      structuredClone, and polyfills for URL/URLSearchParams/TextEncoder/TextDecoder.
     *   3. Evaluate the CJS bundle in context B via the engine eval API and return its
     *      `module.exports` as a JS object handle usable from context A (same JSRuntime → values cross).
     *
     * The current dokar/quickjs-kt binding exposes neither a second context nor a way to return a JS
     * object (the exports hold functions) from a Kotlin function — so #1 and #3 need binding work.
     * Per the "native-context only" decision we deliberately do NOT add a same-context `new Function`
     * fallback; loading a bridge therefore throws until that support lands.
     */
    private fun injectBundleEvaluator() {
        js.function("__comical_native_eval") { _: Array<Any?> ->
            throw ComicalError(
                "Android separate-context evaluator not implemented: needs a second QuickJS context " +
                    "(eval intrinsic omitted) and a JS-object return from native. See class docs. " +
                    "(No new Function fallback, by design.)"
            )
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
