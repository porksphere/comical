/**
 * Unit tests for ComicalBridgeContext (Robolectric — runs on JVM, no device needed).
 * Run with: ./gradlew :host-android:test
 *
 * ⚠️ CURRENTLY EXPECTED TO FAIL AT LOAD: the context now routes through @comical/core via
 * `__comical_native_eval`, which is an unimplemented stub on Android (the dokar/quickjs-kt binding
 * can't yet create a second context or return a JS object from native — see ComicalBridgeContext).
 * Once that binding support lands, these tests should pass and also gain a contract-version
 * rejection case (mirroring the iOS spec). Until then, constructing the context throws by design.
 */
package dev.comical.host

import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ComicalBridgeContextTest {
    private lateinit var ctx: ComicalBridgeContext

    companion object {
        private val MINIMAL_BUNDLE = """
            module.exports = {
              default: function(host) {
                return {
                  info: { id: "test-android", name: "Test", version: "0", contractVersion: "1.0.0",
                          languages: ["en"], nsfw: false, capabilities: ["search"] },
                  getSeriesDetails: async function(id) { return { id: id, title: "Title " + id }; },
                  getChapters: async function() { return [{ id: "c1", name: "Chapter 1", number: 1 }]; },
                  getChapterPages: async function() { return [{ index: 0, imageUrl: "https://img.test/0.png" }]; },
                  getSearchResults: async function(q, p) {
                    return { items: [{ id: "m1", title: q }], page: p, hasNextPage: false };
                  },
                };
              }
            };
        """.trimIndent()
    }

    @Before
    fun setUp() {
        ctx = ComicalBridgeContext(
            androidContext = RuntimeEnvironment.getApplication(),
            bundleCode = MINIMAL_BUNDLE,
            settings = mapOf("baseUrl" to "https://test.example")
        )
    }

    @Test
    fun `bridge info is populated`() {
        val info = ctx.bridgeInfo
        assertNotNull(info)
        assertEquals("test-android", info?.id)
        assertEquals("1.0.0", info?.contractVersion)
        assertTrue(info?.capabilities?.contains("search") == true)
    }

    @Test
    fun `getSearchResults returns paged results`() = runTest {
        val result = ctx.call("getSearchResults", listOf("naruto", 1))
        val obj = result as JSONObject
        val items = obj.getJSONArray("items")
        assertEquals("naruto", items.getJSONObject(0).getString("title"))
        assertEquals(1, obj.getInt("page"))
    }

    @Test
    fun `getSeriesDetails round-trips the series id`() = runTest {
        val result = ctx.call("getSeriesDetails", listOf("alice")) as JSONObject
        assertEquals("alice", result.getString("id"))
        assertEquals("Title alice", result.getString("title"))
    }

    @Test
    fun `getChapters returns ordered list`() = runTest {
        val result = ctx.call("getChapters", listOf("m1")) as JSONArray
        assertEquals("c1", result.getJSONObject(0).getString("id"))
    }

    @Test
    fun `getChapterPages returns absolute image urls`() = runTest {
        val result = ctx.call("getChapterPages", listOf("m1", "c1")) as JSONArray
        val url = result.getJSONObject(0).getString("imageUrl")
        assertTrue(url.startsWith("https://"))
    }

    @Test
    fun `fetch is shadowed in bridge scope`() = runTest {
        val bundle = """
            module.exports = { default: function(host) { return {
              info: { id: "t", name: "T", version: "0", contractVersion: "1.0.0",
                      languages: ["en"], nsfw: false, capabilities: ["search"] },
              getSeriesDetails: async function(id) { return { id: id, title: String(typeof fetch) }; },
              getChapters: async function() { return []; },
              getChapterPages: async function() { return []; },
              getSearchResults: async function() { return { items: [], page: 1, hasNextPage: false }; },
            }; } };
        """.trimIndent()
        val testCtx = ComicalBridgeContext(
            androidContext = RuntimeEnvironment.getApplication(),
            bundleCode = bundle
        )
        val result = testCtx.call("getSeriesDetails", listOf("x")) as JSONObject
        assertEquals("undefined", result.getString("title"))
        testCtx.close()
    }
}
