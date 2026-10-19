/**
 * Unit tests for ComicalTrackerContext.
 *
 * Run with: swift test  (from packages/host-ios/, after `bun run build:native` at the repo root).
 * CI runs them on a macOS runner from `.github/workflows/native.yml`.
 *
 * Mirrors `ComicalBridgeContextTests` — same synthetic-bundle, no-external-dependency approach,
 * just built against the `Tracker` contract (`getSettings`/`getLibrary`/`search`/`updateEntry`)
 * instead of the bridge one.
 */
import XCTest
@testable import ComicalHostIOS

// A minimal synthetic tracker bundle (CJS, no real AniList/MAL calls).
let MINIMAL_TRACKER_BUNDLE = """
module.exports = {
  default: function(host) {
    return {
      info: {
        id: "test-tracker-ios",
        name: "iOS Test Tracker",
        version: "0.0.0",
        contractVersion: "2.0.0",
        capabilities: ["library-sync", "search", "settings"]
      },
      getSettings: function() {
        return [{ type: "string", key: "token", label: "Token", required: true }];
      },
      // Paged reads take an optional `{ cursor? }` request and return `{ items, nextCursor? }`.
      getLibrary: async function(req) {
        return {
          items: [{ externalId: "1", title: "Series " + (host.settings.token || ""), status: "reading" }]
        };
      },
      search: async function(q, req) {
        return { items: [{ externalId: "s1", title: q }] };
      },
      updateEntry: async function(externalId, update) {
        return undefined;
      }
    };
  }
};
"""

final class ComicalTrackerContextTests: XCTestCase {
    var context: ComicalTrackerContext!

    override func setUpWithError() throws {
        context = try ComicalTrackerContext(
            trackerBundle: MINIMAL_TRACKER_BUNDLE,
            settings: ["token": "t1"]
        )
    }

    func testTrackerInfoIsPopulated() {
        let info = context.trackerInfo
        XCTAssertEqual(info?.id, "test-tracker-ios")
        XCTAssertEqual(info?.contractVersion, "2.0.0")
        XCTAssertEqual(info?.capabilities, ["library-sync", "search", "settings"])
    }

    func testGetLibrarySeesStoredSettings() async throws {
        // Proves the settings passed at init actually reach the sandboxed tracker context.
        // No cursor = first page. (A bare page number is rejected at the boundary — the paged
        // request is an object.)
        let result = try await context.call("getLibrary", args: [])
        let dict = result as? [String: Any]
        let items = dict?["items"] as? [[String: Any]]
        XCTAssertEqual(items?.first?["title"] as? String, "Series t1")
        XCTAssertNil(dict?["nextCursor"])
    }

    func testSearch() async throws {
        let result = try await context.call("search", args: ["naruto"])
        let dict = result as? [String: Any]
        let items = dict?["items"] as? [[String: Any]]
        XCTAssertEqual(items?.first?["title"] as? String, "naruto")
    }

    func testUpdateEntryVoidCallRoundTrips() async throws {
        // A void method must marshal cleanly (JSON "null", not the invalid literal "undefined") —
        // same contract as the bridge context's void methods.
        let result = try await context.call("updateEntry", args: ["1", ["status": "completed"]])
        XCTAssertTrue(result is NSNull)
    }

    func testDrainSettingsPatchIsNilWhenNothingRefreshed() {
        // No RefreshableNetwork refresh has occurred (no network calls made at all in this test) —
        // draining should yield nil, not an empty string or throw.
        XCTAssertNil(context.drainSettingsPatch())
    }

    func testInvalidBundleThrows() {
        XCTAssertThrowsError(
            try ComicalTrackerContext(trackerBundle: "not a module at all }{")
        )
    }

    // Core rejects a tracker that targets an incompatible contract version.
    func testIncompatibleContractVersionThrows() {
        let bundle = """
        module.exports = { default: function(host) { return {
          info: { id: "t", name: "T", version: "0", contractVersion: "999.0.0",
                  capabilities: ["search"] },
          search: async function() { return { items: [] }; },
        }; } };
        """
        XCTAssertThrowsError(try ComicalTrackerContext(trackerBundle: bundle))
    }
}
