/**
 * Unit tests for ComicalBridgeContext.
 *
 * Run with: swift test  (from packages/host-ios/, after `bun run build:native` at the repo root).
 * CI runs them on a macOS runner from `.github/workflows/native.yml`.
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
        contractVersion: "2.0.0",
        languages: ["en"],
        nsfw: false,
        capabilities: ["lists", "search"]
      },
      getSeriesDetails: async function(id) {
        return { id: id, title: "Title " + id };
      },
      getChapters: async function() { return [{ id: "c1", name: "Chapter 1", number: 1 }]; },
      getChapterPages: async function() { return [{ index: 0, imageUrl: "https://img.example.test/0.png" }]; },
      // Paged reads take one request object (`{ text, cursor?, filters?, sort? }`) and return
      // `{ items, nextCursor? }` — cursor paging, not page numbers.
      getSearchResults: async function(req) {
        return { items: [{ id: "m1", title: req.text }] };
      },
      getLists: async function() {
        return [{ id: "popular", name: "Popular", layout: "carousel", featured: true }];
      },
      getListItems: async function(listId, req) {
        return { items: [{ id: "m1", title: "Item" }] };
      }
    };
  }
};
"""

final class ComicalBridgeContextTests: XCTestCase {
    var context: ComicalBridgeContext!

    override func setUp() async throws {
        context = try await ComicalBridgeContext(
            bridgeBundle: MINIMAL_BUNDLE,
            settings: ["baseUrl": "https://test.example"]
        )
    }

    func testBridgeInfoIsPopulated() {
        let info = context.bridgeInfo
        XCTAssertEqual(info?.id, "test-ios")
        XCTAssertEqual(info?.contractVersion, "2.0.0")
        XCTAssertEqual(info?.capabilities, ["lists", "search"])
    }

    func testGetSeriesDetails() async throws {
        let result = try await context.call("getSeriesDetails", args: ["alice"])
        let dict = result as? [String: Any]
        XCTAssertEqual(dict?["id"] as? String, "alice")
        XCTAssertEqual(dict?["title"] as? String, "Title alice")
    }

    func testGetSearchResults() async throws {
        // Core validates the request at the boundary: a bare string is rejected before the bridge
        // runs, so the args must carry a `SearchRequest` object.
        let result = try await context.call("getSearchResults", args: [["text": "naruto"]])
        let dict = result as? [String: Any]
        let items = dict?["items"] as? [[String: Any]]
        XCTAssertEqual(items?.first?["title"] as? String, "naruto")
        XCTAssertNil(dict?["nextCursor"])
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
          info: { id: "t", name: "T", version: "0", contractVersion: "2.0.0",
                  languages: ["en"], nsfw: false, capabilities: ["search"] },
          getSeriesDetails: async function(id) {
            var u = new URL("https://user@example.test:8443/api/favorites?page=1#frag");
            return { id: id, title: [u.host, u.hostname, u.pathname, u.origin].join("|") };
          },
          getChapters: async function() { return []; },
          getChapterPages: async function() { return []; },
          getSearchResults: async function() { return { items: [] }; },
        }; } };
        """
        let ctx = try await ComicalBridgeContext(bridgeBundle: bundle)
        let result = try await ctx.call("getSeriesDetails", args: ["x"])
        let dict = result as? [String: Any]
        XCTAssertEqual(dict?["title"] as? String, "example.test:8443|example.test|/api/favorites|https://example.test:8443")
    }

    func testFetchIsUnavailableToBridgeCode() async throws {
        // A bridge that tries to use fetch() directly must get undefined.
        let bundle = """
        module.exports = { default: function(host) { return {
          info: { id: "t", name: "T", version: "0", contractVersion: "2.0.0",
                  languages: ["en"], nsfw: false, capabilities: ["search"] },
          getSeriesDetails: async function(id) { return { id: id, title: String(typeof fetch) }; },
          getChapters: async function() { return []; },
          getChapterPages: async function() { return []; },
          getSearchResults: async function() { return { items: [] }; },
        }; } };
        """
        let ctx = try await ComicalBridgeContext(bridgeBundle: bundle)
        let result = try await ctx.call("getSeriesDetails", args: ["x"])
        let dict = result as? [String: Any]
        XCTAssertEqual(dict?["title"] as? String, "undefined")
    }

    func testStorageSecureIsIsolatedFromPlainStorage() async throws {
        // storage.secure is Keychain-backed; the plain store is the JSON file. A value written to
        // one must not be visible through the other.
        let bundle = """
        module.exports = { default: function(host) { return {
          info: { id: "t", name: "T", version: "0", contractVersion: "2.0.0",
                  languages: ["en"], nsfw: false, capabilities: ["search"] },
          getSeriesDetails: async function(id) {
            await host.storage.secure.set("token", "s3cr3t");
            await host.storage.set("plain", "visible");
            var fromSecure = await host.storage.secure.get("token");
            var fromPlain = await host.storage.get("token");
            return { id: id, title: fromSecure + "|" + String(fromPlain) };
          },
          getChapters: async function() { return []; },
          getChapterPages: async function() { return []; },
          getSearchResults: async function() { return { items: [] }; },
        }; } };
        """
        let ctx = try await ComicalBridgeContext(bridgeBundle: bundle)
        let result = try await ctx.call("getSeriesDetails", args: ["x"])
        let dict = result as? [String: Any]
        XCTAssertEqual(dict?["title"] as? String, "s3cr3t|undefined")
    }

    func testInvalidBundleThrows() async {
        do {
            _ = try await ComicalBridgeContext(bridgeBundle: "not a module at all }{")
            XCTFail("expected ComicalBridgeContext init to throw")
        } catch {
            // expected
        }
    }

    // Core rejects a bridge that targets an incompatible contract version (enforced at load now
    // that the context routes through @comical/core).
    func testIncompatibleContractVersionThrows() async {
        let bundle = """
        module.exports = { default: function(host) { return {
          info: { id: "t", name: "T", version: "0", contractVersion: "999.0.0",
                  languages: ["en"], nsfw: false, capabilities: ["search"] },
          getSeriesDetails: async function(id) { return { id: id, title: id }; },
          getChapters: async function() { return []; },
          getChapterPages: async function() { return []; },
          getSearchResults: async function() { return { items: [] }; },
        }; } };
        """
        do {
            _ = try await ComicalBridgeContext(bridgeBundle: bundle)
            XCTFail("expected ComicalBridgeContext init to throw")
        } catch {
            // expected
        }
    }
}
