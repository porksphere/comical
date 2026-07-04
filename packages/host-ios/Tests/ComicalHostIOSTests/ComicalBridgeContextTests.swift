/**
 * Unit tests for ComicalBridgeContext.
 *
 * NOTE: These tests cannot run on this machine (no Swift toolchain / iOS SDK here).
 * They document the expected behaviour and serve as a test spec for CI on a Mac runner.
 * Run with: swift test  (from packages/host-ios/)
 *
 * The bridge bundle used here is a minimal synthetic CJS bundle (not the real example-bridge)
 * so these tests have no external dependencies.
 *
 * The context now drives @comical/core (loadBridge + the separate-context evaluator), so loading
 * also enforces contract-version compatibility, settings, call timeouts, and rate limiting —
 * `testFetchIsUnavailableToBridgeCode` is satisfied by context B's fresh global; the new
 * `testIncompatibleContractVersionThrows` covers the contract check core adds.
 */
import XCTest
@testable import ComicalHostIOS

// A minimal synthetic bridge bundle (CJS, no actual scraping).
let MINIMAL_BUNDLE = """
module.exports = {
  default: function(host) {
    return {
      info: {
        id: "test-ios",
        name: "iOS Test Bridge",
        version: "0.0.0",
        contractVersion: "1.0.0",
        languages: ["en"],
        nsfw: false,
        capabilities: ["lists", "search"]
      },
      getSeriesDetails: async function(id) {
        return { id: id, title: "Title " + id };
      },
      getChapters: async function() { return [{ id: "c1", name: "Chapter 1", number: 1 }]; },
      getChapterPages: async function() { return [{ index: 0, imageUrl: "https://img.example.test/0.png" }]; },
      getSearchResults: async function(q, p) {
        return { items: [{ id: "m1", title: q }], page: p, hasNextPage: false };
      },
      getLists: async function() {
        return [{ id: "popular", name: "Popular", layout: "carousel", featured: true }];
      },
      getListItems: async function(listId, p) {
        return { items: [{ id: "m1", title: "Item" }], page: p, hasNextPage: false };
      }
    };
  }
};
"""

final class ComicalBridgeContextTests: XCTestCase {
    var context: ComicalBridgeContext!

    override func setUpWithError() throws {
        context = try ComicalBridgeContext(
            bridgeBundle: MINIMAL_BUNDLE,
            settings: ["baseUrl": "https://test.example"]
        )
    }

    func testBridgeInfoIsPopulated() {
        let info = context.bridgeInfo
        XCTAssertEqual(info?.id, "test-ios")
        XCTAssertEqual(info?.contractVersion, "1.0.0")
        XCTAssertEqual(info?.capabilities, ["search"])
    }

    func testGetSeriesDetails() async throws {
        let result = try await context.call("getSeriesDetails", args: ["alice"])
        let dict = result as? [String: Any]
        XCTAssertEqual(dict?["id"] as? String, "alice")
        XCTAssertEqual(dict?["title"] as? String, "Title alice")
    }

    func testGetSearchResults() async throws {
        let result = try await context.call("getSearchResults", args: ["naruto", 1])
        let dict = result as? [String: Any]
        let items = dict?["items"] as? [[String: Any]]
        XCTAssertEqual(items?.first?["title"] as? String, "naruto")
        XCTAssertEqual(dict?["page"] as? Int, 1)
    }

    func testGetChapters() async throws {
        let result = try await context.call("getChapters", args: ["m1"])
        let chapters = result as? [[String: Any]]
        XCTAssertEqual(chapters?.first?["id"] as? String, "c1")
    }

    func testGetChapterPages() async throws {
        let result = try await context.call("getChapterPages", args: ["m1", "c1"])
        let pages = result as? [[String: Any]]
        XCTAssertEqual(pages?.first?["imageUrl"] as? String, "https://img.example.test/0.png")
    }

    func testUrlPolyfillParsesComponents() async throws {
        // core's CookieJar keys session cookies on `new URL(url).host`; the injected URL polyfill
        // must expose real components, not just .href. An href-only stub silently broke authenticated
        // calls (favorites → 401) because cookies could neither be stored nor replayed.
        let bundle = """
        module.exports = { default: function(host) { return {
          info: { id: "t", name: "T", version: "0", contractVersion: "1.0.0",
                  languages: ["en"], nsfw: false, capabilities: ["search"] },
          getSeriesDetails: async function(id) {
            var u = new URL("https://user@example.test:8443/api/favorites?page=1#frag");
            return { id: id, title: [u.host, u.hostname, u.pathname, u.origin].join("|") };
          },
          getChapters: async function() { return []; },
          getChapterPages: async function() { return []; },
          getSearchResults: async function() { return { items: [], page: 1, hasNextPage: false }; },
        }; } };
        """
        let ctx = try ComicalBridgeContext(bridgeBundle: bundle)
        let result = try await ctx.call("getSeriesDetails", args: ["x"])
        let dict = result as? [String: Any]
        XCTAssertEqual(dict?["title"] as? String, "example.test:8443|example.test|/api/favorites|https://example.test:8443")
    }

    func testFetchIsUnavailableToBridgeCode() async throws {
        // A bridge that tries to use fetch() directly must get undefined.
        let bundle = """
        module.exports = { default: function(host) { return {
          info: { id: "t", name: "T", version: "0", contractVersion: "1.0.0",
                  languages: ["en"], nsfw: false, capabilities: ["search"] },
          getSeriesDetails: async function(id) { return { id: id, title: String(typeof fetch) }; },
          getChapters: async function() { return []; },
          getChapterPages: async function() { return []; },
          getSearchResults: async function() { return { items: [], page: 1, hasNextPage: false }; },
        }; } };
        """
        let ctx = try ComicalBridgeContext(bridgeBundle: bundle)
        let result = try await ctx.call("getSeriesDetails", args: ["x"])
        let dict = result as? [String: Any]
        XCTAssertEqual(dict?["title"] as? String, "undefined")
    }

    func testInvalidBundleThrows() {
        XCTAssertThrowsError(
            try ComicalBridgeContext(bridgeBundle: "not a module at all }{")
        )
    }

    // Core rejects a bridge that targets an incompatible contract version (enforced at load now
    // that the context routes through @comical/core).
    func testIncompatibleContractVersionThrows() {
        let bundle = """
        module.exports = { default: function(host) { return {
          info: { id: "t", name: "T", version: "0", contractVersion: "999.0.0",
                  languages: ["en"], nsfw: false, capabilities: ["search"] },
          getSeriesDetails: async function(id) { return { id: id, title: id }; },
          getChapters: async function() { return []; },
          getChapterPages: async function() { return []; },
          getSearchResults: async function() { return { items: [], page: 1, hasNextPage: false }; },
        }; } };
        """
        XCTAssertThrowsError(try ComicalBridgeContext(bridgeBundle: bundle))
    }
}
