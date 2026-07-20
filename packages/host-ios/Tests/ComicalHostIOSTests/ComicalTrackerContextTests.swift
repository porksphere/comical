/**
 * Unit tests for ComicalTrackerContext.
 *
 * NOTE: These tests cannot run on this machine (no Swift toolchain / iOS SDK here).
 * They document the expected behaviour and serve as a test spec for CI on a Mac runner.
 * Run with: swift test  (from packages/host-ios/)
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
        contractVersion: "1.0.0",
        capabilities: ["library-sync", "search", "settings"]
      },
      getSettings: function() {
        return [{ type: "string", key: "token", label: "Token", required: true }];
      },
      getLibrary: async function(page) {
        return {
          items: [{ externalId: "1", title: "Series " + (host.settings.token || ""), status: "reading" }],
          page: page,
          hasNextPage: false
        };
      },
      search: async function(q, p) {
        return { items: [{ externalId: "s1", title: q }], page: p, hasNextPage: false };
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
        XCTAssertEqual(info?.contractVersion, "1.0.0")
        XCTAssertEqual(info?.capabilities, ["library-sync", "search", "settings"])
    }

    func testGetLibrarySeesStoredSettings() async throws {
        // Proves the settings passed at init actually reach the sandboxed tracker context.
        let result = try await context.call("getLibrary", args: [1])
        let dict = result as? [String: Any]
        let items = dict?["items"] as? [[String: Any]]
        XCTAssertEqual(items?.first?["title"] as? String, "Series t1")
        XCTAssertEqual(dict?["page"] as? Int, 1)
    }

    func testSearch() async throws {
        let result = try await context.call("search", args: ["naruto", 1])
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
          search: async function() { return { items: [], page: 1, hasNextPage: false }; },
        }; } };
        """
        XCTAssertThrowsError(try ComicalTrackerContext(trackerBundle: bundle))
    }
}
