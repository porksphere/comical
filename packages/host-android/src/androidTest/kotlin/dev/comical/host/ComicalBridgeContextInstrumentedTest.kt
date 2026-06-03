/**
 * Instrumented tests — run on a device/emulator against the REAL shipping artifact
 * (quickjs-kt-android) and the bundled comical_harness.js.
 *
 *   ./gradlew :host-android:connectedAndroidTest
 *
 * These exercise the full path: QuickJS → bundled @comical/core (loadBridge + same-context
 * evaluator) → capability bindings. The bundles are tiny inline CJS (no real network), so the
 * assertions are deterministic and don't depend on a backend.
 */
package dev.comical.host

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

private const val GOOD_BUNDLE = """
module.exports = { default: function (host) { return {
  info: { id: "test-android", name: "Android Test", version: "0.0.0", contractVersion: "1.0.0",
          languages: ["en"], nsfw: false, capabilities: ["search"],
          rateLimit: { maxConcurrent: 1, minIntervalMs: 50 } },
  getSeriesDetails: async function (id) { return { id: id, title: "Title " + id }; },
  getChapters: async function () { return []; },
  getChapterPages: async function () { return []; },
  getSearchResults: async function (q, p) { return { items: [{ id: "m1", title: q }], page: p, hasNextPage: false }; }
}; } };
"""

private const val BAD_CONTRACT_BUNDLE = """
module.exports = { default: function (host) { return {
  info: { id: "test-android", name: "T", version: "0", contractVersion: "999.0.0",
          languages: ["en"], nsfw: false, capabilities: ["search"] },
  getSeriesDetails: async function (id) { return { id: id, title: id }; },
  getChapters: async function () { return []; },
  getChapterPages: async function () { return []; },
  getSearchResults: async function () { return { items: [], page: 1, hasNextPage: false }; }
}; } };
"""

@RunWith(AndroidJUnit4::class)
class ComicalBridgeContextInstrumentedTest {
    private val appContext = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun loadsBridgeAndReadsInfo() = runTest {
        val ctx = ComicalBridgeContext.create(appContext, GOOD_BUNDLE, mapOf("baseUrl" to "https://x"))
        val info = ctx.bridgeInfo()
        assertEquals("test-android", info?.id)
        assertEquals("1.0.0", info?.contractVersion)
        assertEquals(1, info?.rateLimit?.maxConcurrent)
        ctx.close()
    }

    @Test
    fun callRoundTripsThroughCore() = runTest {
        val ctx = ComicalBridgeContext.create(appContext, GOOD_BUNDLE)
        val result = ctx.call("getSearchResults", listOf("naruto", 1)) as JSONObject
        val first = result.getJSONArray("items").getJSONObject(0)
        assertEquals("naruto", first.getString("title"))
        assertEquals(1, result.getInt("page"))
        ctx.close()
    }

    @Test
    fun rejectsIncompatibleContractVersion() = runTest {
        var threw = false
        try {
            ComicalBridgeContext.create(appContext, BAD_CONTRACT_BUNDLE)
        } catch (e: Exception) {
            threw = true
        }
        assertTrue("loading a 999.0.0 contract bridge should throw", threw)
    }
}
