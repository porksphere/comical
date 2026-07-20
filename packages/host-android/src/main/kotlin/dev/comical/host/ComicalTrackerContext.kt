/**
 * ComicalTrackerContext — the Android QuickJS evaluator and host adapter for trackers
 * (AniList/MAL-style), parallel to [ComicalBridgeContext] (quickjs-kt 1.x).
 *
 * Same isolation model as [ComicalBridgeContext] (see its doc comment) — `comical_init_tracker`/
 * `comical_call_tracker`/`comical_tracker` in place of the bridge globals, evaluated in a fresh
 * QuickJS context that loads the same bundled `comical_harness.js` (the harness installs both sets
 * of globals; each context instance holds exactly one bridge OR one tracker's worth of module
 * state).
 *
 * The one addition beyond mirroring the bridge shape is [drainSettingsPatch]: it polls
 * `comical_drain_tracker_patch()` for an OAuth token the tracker's most recent call(s) refreshed.
 * The sandboxed context has no other channel to write durable state, so the caller (the Expo
 * native module) is responsible for persisting a non-null result back through the app's settings
 * store — see `EmbeddedTrackerProvider`/`NativeTrackerRuntime` in `@comical/host-rn`.
 *
 * Usage (all suspend — call from a coroutine):
 *   val ctx = ComicalTrackerContext.create(context, bundleCode, mapOf("token" to "…"))
 *   val info = ctx.trackerInfo()
 *   val items = ctx.call("getLibrary", listOf(1))
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

private const val TRACKER_TAG = "ComicalTracker"

data class TrackerInfo(
    val id: String,
    val name: String,
    val version: String,
    val contractVersion: String,
    val capabilities: List<String>,
    val rateLimit: RateLimit? = null,
) {
    data class RateLimit(val maxConcurrent: Int?, val minIntervalMs: Int?)
}

class ComicalTrackerContext private constructor(
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
        val dir = dataDir ?: File(androidContext.filesDir, "comical-trackers")
        dir.mkdirs()
        storageFile = File(dir, "storage.json")
    }

    companion object {
        /** Load a tracker bundle and prepare it for calls. */
        suspend fun create(
            androidContext: Context,
            bundleCode: String,
            settings: Map<String, Any> = emptyMap(),
            dataDir: File? = null,
            networkOptionsJson: String? = null,
        ): ComicalTrackerContext {
            val ctx = ComicalTrackerContext(androidContext, dataDir)
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
        Log.d(TRACKER_TAG, "load: callbacks registered (+${ms()}ms)")
        registerRuntimeGlobals()
        Log.d(TRACKER_TAG, "load: runtime globals registered (+${ms()}ms)")

        val settingsJson = JSONObject(settings).toString()
        js.function("__comical_bundle") { _ -> bundleCode }
        js.function("__comical_settings") { _ -> settingsJson }
        if (networkOptionsJson != null) {
            js.function("__comical_network") { _ -> networkOptionsJson }
        }
        Log.d(TRACKER_TAG, "load: bindings registered (+${ms()}ms)")

        // Same bundled harness ComicalBridgeContext uses — it installs both the bridge and tracker
        // globals.
        val harness = androidContext.assets.open("comical_harness.js").bufferedReader().readText()
        Log.d(TRACKER_TAG, "load: harness read (${harness.length} chars, +${ms()}ms)")
        js.evaluate<Any?>(harness)
        Log.d(TRACKER_TAG, "load: harness evaluated (+${ms()}ms)")

        val initCall = if (networkOptionsJson != null)
            "comical_init_tracker(__comical_bundle(), __comical_settings(), __comical_network())"
        else
            "comical_init_tracker(__comical_bundle(), __comical_settings())"
        js.evaluate<Any?>(initCall)
        Log.d(TRACKER_TAG, "load: comical_init_tracker done (+${ms()}ms)")
    }

    suspend fun trackerInfo(): TrackerInfo? {
        val raw = js.evaluate<String?>(
            "comical_tracker ? JSON.stringify(comical_tracker.info) : null",
        ) ?: return null
        val obj = JSONObject(raw)
        return TrackerInfo(
            id = obj.getString("id"),
            name = obj.getString("name"),
            version = obj.getString("version"),
            contractVersion = obj.getString("contractVersion"),
            capabilities = obj.getJSONArray("capabilities").let { a -> (0 until a.length()).map { a.getString(it) } },
            rateLimit = obj.optJSONObject("rateLimit")?.let { rl ->
                TrackerInfo.RateLimit(
                    maxConcurrent = if (rl.has("maxConcurrent")) rl.getInt("maxConcurrent") else null,
                    minIntervalMs = if (rl.has("minIntervalMs")) rl.getInt("minIntervalMs") else null,
                )
            },
        )
    }

    /** Call a tracker method by name. `args` must be JSON-serialisable. Returns parsed JSON. */
    suspend fun call(method: String, args: List<Any?> = emptyList()): Any {
        val argsJson = JSONArray(args).toString()
        // comical_call_tracker returns a Promise<string>; `await` so evaluate resolves it to the
        // string.
        val resultJson = js.evaluate<String>(
            "await comical_call_tracker(${jsString(method)}, ${jsString(argsJson)})",
        )
        return parseJson(resultJson)
    }

    /**
     * Like [call] but returns the raw JSON string `comical_call_tracker` produced (not a parsed
     * JSONObject/Array/String). For JSON-boundary consumers such as the Expo native module, whose
     * React Native side re-parses it. `argsJson` is a JSON array string.
     */
    suspend fun callJson(method: String, argsJson: String): String =
        js.evaluate<String>("await comical_call_tracker(${jsString(method)}, ${jsString(argsJson)})")

    /**
     * `{ info, methods }` as JSON: the loaded tracker's self-description plus the names of the
     * methods it actually implements. `comical_tracker` is set by `comical_init_tracker`; call
     * after a successful load.
     */
    suspend fun describeJson(): String =
        js.evaluate<String>(
            "JSON.stringify({ info: comical_tracker.info, methods: Object.keys(comical_tracker)" +
                ".filter(function (k) { return typeof comical_tracker[k] === 'function'; }) })",
        )

    /**
     * Drains a refreshed OAuth token blob, if the tracker's most recent call(s) triggered one — as
     * JSON `{ key, blob }`, or `null` if nothing has refreshed since the last drain. The caller is
     * expected to persist a non-null result back through the app's settings store.
     */
    suspend fun drainSettingsPatch(): String? =
        js.evaluate<String?>("comical_drain_tracker_patch()")

    fun close() = js.close()

    // ── Native capability bindings (read by the runtime's async adapter as _native_*) ─────────

    private fun registerNativeCallbacks() {
        js.function("_native_log") { args ->
            val level = args.getOrNull(0) as? String ?: "info"
            val msg = args.getOrNull(1) as? String ?: ""
            when (level) {
                "debug" -> Log.d(TRACKER_TAG, msg)
                "warn" -> Log.w(TRACKER_TAG, msg)
                "error" -> Log.e(TRACKER_TAG, msg)
                else -> Log.i(TRACKER_TAG, msg)
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
                put(
                    "body",
                    response.body?.let { rb ->
                        if (req.optString("responseType") == "base64") {
                            android.util.Base64.encodeToString(rb.bytes(), android.util.Base64.NO_WRAP)
                        } else {
                            rb.string()
                        }
                    } ?: "",
                )
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
     * Runtime globals QuickJS doesn't provide but @comical/core needs — identical to
     * [ComicalBridgeContext]'s copy; keep the two in lockstep.
     */
    private suspend fun registerRuntimeGlobals() {
        js.asyncFunction("__comical_delay") { args ->
            delay((args.getOrNull(0) as? Number)?.toLong() ?: 0L)
            null
        }
        js.evaluate<Any?>(
            """
            (function () {
              globalThis.__comical_disable_call_timeout = true;
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
