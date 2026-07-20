/**
 * Instrumented tests — run on a device/emulator against the REAL shipping artifact
 * (quickjs-kt-android) and the bundled comical_harness.js.
 *
 *   ./gradlew :host-android:connectedAndroidTest
 *
 * Mirrors `ComicalBridgeContextInstrumentedTest` — exercises the full path: QuickJS → bundled
 * @comical/core (loadTracker + same-context evaluator) → capability bindings — but against the
 * `Tracker` contract instead of the bridge one. The bundles are tiny inline CJS (no real
 * AniList/MAL calls), so the assertions are deterministic and don't depend on a backend.
 */
package dev.comical.host

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

private const val GOOD_TRACKER_BUNDLE = """
module.exports = { default: function (host) { return {
  info: { id: "test-tracker-android", name: "Android Test Tracker", version: "0.0.0", contractVersion: "1.0.0",
          capabilities: ["library-sync", "search", "settings"],
          rateLimit: { maxConcurrent: 1, minIntervalMs: 50 } },
  getSettings: function () { return [{ type: "string", key: "token", label: "Token", required: true }]; },
  getLibrary: async function (page) {
    return { items: [{ externalId: "1", title: "Series " + (host.settings.token || ""), status: "reading" }], page: page, hasNextPage: false };
  },
  search: async function (q, p) { return { items: [{ externalId: "s1", title: q }], page: p, hasNextPage: false }; },
  updateEntry: async function (externalId, update) { return undefined; }
}; } };
"""

private const val BAD_CONTRACT_TRACKER_BUNDLE = """
module.exports = { default: function (host) { return {
  info: { id: "test-tracker-android", name: "T", version: "0", contractVersion: "999.0.0",
          capabilities: ["search"] },
  search: async function () { return { items: [], page: 1, hasNextPage: false }; }
}; } };
"""

@RunWith(AndroidJUnit4::class)
class ComicalTrackerContextInstrumentedTest {
    private val appContext = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun loadsTrackerAndReadsInfo() = runTest {
        val ctx = ComicalTrackerContext.create(appContext, GOOD_TRACKER_BUNDLE, mapOf("token" to "t1"))
        val info = ctx.trackerInfo()
        assertEquals("test-tracker-android", info?.id)
        assertEquals("1.0.0", info?.contractVersion)
        assertEquals(1, info?.rateLimit?.maxConcurrent)
        ctx.close()
    }

    @Test
    fun getLibrarySeesStoredSettings() = runTest {
        // Proves the settings passed at create() actually reach the sandboxed tracker context.
        val ctx = ComicalTrackerContext.create(appContext, GOOD_TRACKER_BUNDLE, mapOf("token" to "t1"))
        val result = ctx.call("getLibrary", listOf(1)) as JSONObject
        val first = result.getJSONArray("items").getJSONObject(0)
        assertEquals("Series t1", first.getString("title"))
        ctx.close()
    }

    @Test
    fun callRoundTripsThroughCore() = runTest {
        val ctx = ComicalTrackerContext.create(appContext, GOOD_TRACKER_BUNDLE)
        val result = ctx.call("search", listOf("naruto", 1)) as JSONObject
        val first = result.getJSONArray("items").getJSONObject(0)
        assertEquals("naruto", first.getString("title"))
        assertEquals(1, result.getInt("page"))
        ctx.close()
    }

    @Test
    fun drainSettingsPatchIsNullWhenNothingRefreshed() = runTest {
        val ctx = ComicalTrackerContext.create(appContext, GOOD_TRACKER_BUNDLE, mapOf("token" to "t1"))
        assertNull(ctx.drainSettingsPatch())
        ctx.close()
    }

    @Test
    fun rejectsIncompatibleContractVersion() = runTest {
        var threw = false
        try {
            ComicalTrackerContext.create(appContext, BAD_CONTRACT_TRACKER_BUNDLE)
        } catch (e: Exception) {
            threw = true
        }
        assertTrue("loading a 999.0.0 contract tracker should throw", threw)
    }
}
