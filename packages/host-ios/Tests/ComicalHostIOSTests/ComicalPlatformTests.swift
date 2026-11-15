import XCTest
@testable import ComicalHostIOS

final class ComicalPlatformTests: XCTestCase {
    override func tearDown() {
        ComicalPlatform.webViewUserAgent = nil
        super.tearDown()
    }

    func testWebViewUserAgentIsKeptAndEmptyClearsIt() {
        XCTAssertNil(ComicalPlatform.webViewUserAgent)
        let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
        ComicalPlatform.webViewUserAgent = ua
        XCTAssertEqual(ComicalPlatform.webViewUserAgent, ua)
        ComicalPlatform.webViewUserAgent = ""
        XCTAssertNil(ComicalPlatform.webViewUserAgent)
    }
}
