/**
 * ComicalBridgeContext — the Android QuickJS evaluator and host adapter (quickjs-kt 1.x).
 *
 * The QuickJS context evaluates `comical_harness.js` — the bundled @comical/host-native runtime
 * (core + glue). `comical_init` runs the bridge through @comical/core's `loadBridge` +
 * NativeContextEvaluator, which calls `__comical_native_eval(code)` to evaluate the bundle.
 *
 * Isolation (current, same-context): `__comical_native_eval` is defined in JS and evaluates the
 * bundle in *this* QuickJS context via the `Function` constructor. QuickJS has no ambient app/DOM
 * globals and core is bundled as an IIFE (its internals aren't global), so a bridge can reach only
 * the curated globals + the host object — weaker than iOS's separate JSContext, stronger than the
 * browser's `new Function`. Full separate-context isolation (a second QuickJS context with the eval
 * intrinsic omitted) needs C-API access the quickjs-kt binding doesn't expose — tracked as a JNI
 * upgrade.
 *
 * Native capabilities are registered as quickjs-kt bindings; the bundled runtime's async adapter
 * wraps them into core's HostCapabilities.
 *
 * Usage (all suspend — call from a coroutine):
 *   val ctx = ComicalBridgeContext.create(context, bundleCode, mapOf("baseUrl" to "https://…"))
 *   val info = ctx.bridgeInfo()
 *   val results = ctx.call("getSearchResults", listOf("naruto", 1))
 *   ctx.close()
 */
package dev.comical.host

import android.content.Context
import android.util.Log
import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.binding.asyncFunction
import com.dokar.quickjs.binding.function
import com.dokar.quickjs.evaluate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

private const val TAG = "ComicalBridge"

class ComicalError(message: String) : Exception(message)

data class BridgeInfo(
    val id: String,
    val name: String,
    val version: String,
    val contractVersion: String,
    val languages: List<String>,
    val nsfw: Boolean,
    val capabilities: List<String>,
    val rateLimit: RateLimit? = null,
) {
    data class RateLimit(val maxConcurrent: Int?, val minIntervalMs: Int?)
}

class ComicalBridgeContext private constructor(
    androidContext: Context,
    dataDir: File?,
) {
    private val js = QuickJs.create(Dispatchers.Default)
    private val http = OkHttpClient.Builder()
        .followRedirects(true)
        .connectTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
        .writeTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
        .build()
    private val storageFile: File

    init {
        val dir = dataDir ?: File(androidContext.filesDir, "comical")
        dir.mkdirs()
        storageFile = File(dir, "storage.json")
    }

    companion object {
        /** Load a bridge bundle and prepare it for calls. */
        suspend fun create(
            androidContext: Context,
            bundleCode: String,
            settings: Map<String, Any> = emptyMap(),
            dataDir: File? = null,
            networkOptionsJson: String? = null,
        ): ComicalBridgeContext {
            val ctx = ComicalBridgeContext(androidContext, dataDir)
            ctx.load(androidContext, bundleCode, settings, networkOptionsJson)
            return ctx
        }
    }

    private suspend fun load(
        androidContext: Context,
        bundleCode: String,
        settings: Map<String, Any>,
        networkOptionsJson: String?,
    ) {
        val t0 = System.currentTimeMillis()
        fun ms() = System.currentTimeMillis() - t0

        registerNativeCallbacks()
        Log.d(TAG, "load: callbacks registered (+${ms()}ms)")
        registerRuntimeGlobals()
        Log.d(TAG, "load: runtime globals registered (+${ms()}ms)")

        val settingsJson = JSONObject(settings).toString()
        js.function("__comical_bundle") { _ -> bundleCode }
        js.function("__comical_settings") { _ -> settingsJson }
        if (networkOptionsJson != null) {
            js.function("__comical_network") { _ -> networkOptionsJson }
        }
        Log.d(TAG, "load: bindings registered (+${ms()}ms)")

        val harness = androidContext.assets.open("comical_harness.js").bufferedReader().readText()
        Log.d(TAG, "load: harness read (${harness.length} chars, +${ms()}ms)")
        js.evaluate<Any?>(harness)
        Log.d(TAG, "load: harness evaluated (+${ms()}ms)")

        val initCall = if (networkOptionsJson != null)
            "comical_init(__comical_bundle(), __comical_settings(), __comical_network())"
        else
            "comical_init(__comical_bundle(), __comical_settings())"
        js.evaluate<Any?>(initCall)
        Log.d(TAG, "load: comical_init done (+${ms()}ms)")
    }

    suspend fun bridgeInfo(): BridgeInfo? {
        val raw = js.evaluate<String?>(
            "comical_bridge ? JSON.stringify(comical_bridge.info) : null",
        ) ?: return null
        val obj = JSONObject(raw)
        return BridgeInfo(
            id = obj.getString("id"),
            name = obj.getString("name"),
            version = obj.getString("version"),
            contractVersion = obj.getString("contractVersion"),
            languages = obj.getJSONArray("languages").let { a -> (0 until a.length()).map { a.getString(it) } },
            nsfw = obj.getBoolean("nsfw"),
            capabilities = obj.getJSONArray("capabilities").let { a -> (0 until a.length()).map { a.getString(it) } },
            rateLimit = obj.optJSONObject("rateLimit")?.let { rl ->
                BridgeInfo.RateLimit(
                    maxConcurrent = if (rl.has("maxConcurrent")) rl.getInt("maxConcurrent") else null,
                    minIntervalMs = if (rl.has("minIntervalMs")) rl.getInt("minIntervalMs") else null,
                )
            },
        )
    }

    /** Call a bridge method by name. `args` must be JSON-serialisable. Returns parsed JSON. */
    suspend fun call(method: String, args: List<Any?> = emptyList()): Any {
        val argsJson = JSONArray(args).toString()
        // comical_call returns a Promise<string>; `await` so evaluate resolves it to the string.
        val resultJson = js.evaluate<String>(
            "await comical_call(${jsString(method)}, ${jsString(argsJson)})",
        )
        return parseJson(resultJson)
    }

    /**
     * Like [call] but returns the raw JSON string `comical_call` produced (not a parsed
     * JSONObject/Array/String). For JSON-boundary consumers such as the Expo native module, whose
     * React Native side re-parses it — avoids a parse-then-reserialize round-trip that would mangle
     * primitive results (e.g. `resolvePage`'s bare-string URL). `argsJson` is a JSON array string.
     */
    suspend fun callJson(method: String, argsJson: String): String =
        js.evaluate<String>("await comical_call(${jsString(method)}, ${jsString(argsJson)})")

    /**
     * `{ info, methods }` as JSON: the loaded bridge's self-description plus the names of the methods
     * it actually implements (so a host can expose exactly those). `comical_bridge` is set by
     * `comical_init`; call after a successful load.
     */
    suspend fun describeJson(): String =
        js.evaluate<String>(
            "JSON.stringify({ info: comical_bridge.info, methods: Object.keys(comical_bridge)" +
                ".filter(function (k) { return typeof comical_bridge[k] === 'function'; }) })",
        )

    fun close() = js.close()

    // ── Native capability bindings (read by the runtime's async adapter as _native_*) ─────────

    private fun registerNativeCallbacks() {
        js.function("_native_log") { args ->
            val level = args.getOrNull(0) as? String ?: "info"
            val msg = args.getOrNull(1) as? String ?: ""
            when (level) {
                "debug" -> Log.d(TAG, msg)
                "warn" -> Log.w(TAG, msg)
                "error" -> Log.e(TAG, msg)
                else -> Log.i(TAG, msg)
            }
            null
        }

        js.asyncFunction("_native_network_request") { args ->
            val reqJson = args.getOrNull(0) as? String
                ?: throw ComicalError("_native_network_request: missing request JSON")
            val req = JSONObject(reqJson)
            val builder = Request.Builder().url(req.getString("url"))
            req.optJSONObject("headers")?.let { h ->
                h.keys().forEach { k -> builder.header(k, h.getString(k)) }
            }
            val body = req.optString("body").takeIf { it.isNotEmpty() }
                ?.toRequestBody("application/octet-stream".toMediaType())
            builder.method(req.optString("method", "GET"), body)

            val response = withContext(Dispatchers.IO) { http.newCall(builder.build()).execute() }
            val responseHeaders = JSONObject()
            response.headers.forEach { (k, v) -> responseHeaders.put(k.lowercase(), v) }
            // OkHttp keeps no CookieJar by default, so core's gated network owns the session;
            // surface Set-Cookie for it to store.
            val setCookies = response.headers("Set-Cookie")
            JSONObject().apply {
                put("url", response.request.url.toString())
                put("status", response.code)
                put("statusText", response.message)
                put("headers", responseHeaders)
                if (setCookies.isNotEmpty()) put("setCookies", JSONArray(setCookies))
                put("body", response.body?.string() ?: "")
            }.toString()
        }

        js.asyncFunction("_native_storage_get") { args ->
            val key = args.getOrNull(0) as? String ?: return@asyncFunction null
            readStorage()[key]
        }
        js.asyncFunction("_native_storage_set") { args ->
            val key = args.getOrNull(0) as? String ?: return@asyncFunction null
            val value = args.getOrNull(1) as? String ?: return@asyncFunction null
            writeStorage(readStorage().toMutableMap().apply { put(key, value) })
            null
        }
        js.asyncFunction("_native_storage_delete") { args ->
            val key = args.getOrNull(0) as? String ?: return@asyncFunction null
            writeStorage(readStorage().toMutableMap().apply { remove(key) })
            null
        }
        js.asyncFunction("_native_storage_keys") { _ ->
            JSONArray(readStorage().keys.toList()).toString()
        }
    }

    /**
     * Runtime globals QuickJS doesn't provide but @comical/core needs:
     *  - `setTimeout`/`clearTimeout` (core's per-call timeout wrapper and rate limiter), backed by a
     *    coroutine `delay` via the `__comical_delay` binding.
     *  - `queueMicrotask` (fallback).
     *  - `__comical_native_eval` — the same-context bundle evaluator (see class doc). Defined in JS so
     *    the returned `module.exports` is a live object in this context (a Kotlin function can't
     *    return JS functions).
     */
    private suspend fun registerRuntimeGlobals() {
        js.asyncFunction("__comical_delay") { args ->
            delay((args.getOrNull(0) as? Number)?.toLong() ?: 0L)
            null
        }
        js.evaluate<Any?>(
            """
            (function () {
              var timers = Object.create(null); var seq = 0;
              globalThis.setTimeout = function (cb, ms) {
                var id = ++seq; timers[id] = true;
                __comical_delay(ms || 0).then(function () { if (timers[id]) { delete timers[id]; cb(); } });
                return id;
              };
              globalThis.clearTimeout = function (id) { delete timers[id]; };
              if (!globalThis.queueMicrotask) {
                globalThis.queueMicrotask = function (cb) { Promise.resolve().then(cb); };
              }
              globalThis.__comical_native_eval = function (code) {
                var module = { exports: {} };
                (new Function('module', 'exports', code))(module, module.exports);
                return module.exports;
              };
            })();
            """.trimIndent(),
        )
    }

    // ── Storage helpers ───────────────────────────────────────────────────────────────────────

    private fun readStorage(): Map<String, String> {
        if (!storageFile.exists()) return emptyMap()
        return try {
            val obj = JSONObject(storageFile.readText())
            obj.keys().asSequence().associateWith { obj.getString(it) }
        } catch (_: Exception) {
            emptyMap()
        }
    }

    private fun writeStorage(store: Map<String, String>) {
        storageFile.writeText(JSONObject(store as Map<*, *>).toString())
    }

    private fun jsString(s: String): String =
        "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r") + "\""

    private fun parseJson(json: String): Any = when {
        json.startsWith("{") -> JSONObject(json)
        json.startsWith("[") -> JSONArray(json)
        else -> json
    }
}
