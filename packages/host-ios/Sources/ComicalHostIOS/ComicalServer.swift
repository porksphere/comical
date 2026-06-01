/**
 * ComicalServer — optional on-device HTTP server for iOS.
 *
 * For apps that want to expose the bridge runtime as a local API (so a WKWebView or other
 * client on the same device can call it), this wraps ComicalBridgeContext in a minimal
 * HTTP server using Network.framework. Port is dynamically assigned; the app can pass it to
 * a WKWebView via a custom URL scheme or injected JS.
 *
 * This is equivalent to comical-server (the Bun host-server), but running entirely on-device
 * with no external infrastructure.
 *
 * NOTE: for most iOS apps the better model is to use ComicalBridgeContext directly from Swift
 * code via the `call(_:args:)` API. ComicalServer is for hybrid apps with a web UI.
 */
import Foundation
import Network
import os

public final class ComicalServer {
    private let context: ComicalBridgeContext
    private var listener: NWListener?
    private let log = Logger(subsystem: "dev.comical", category: "server")
    public private(set) var port: UInt16 = 0

    public init(context: ComicalBridgeContext) {
        self.context = context
    }

    public func start() throws {
        let params = NWParameters.tcp
        listener = try NWListener(using: params, on: 0)
        listener?.newConnectionHandler = { [weak self] conn in
            self?.handleConnection(conn)
        }
        listener?.stateUpdateHandler = { [weak self] state in
            if case .ready = state {
                self?.port = self?.listener?.port?.rawValue ?? 0
                self?.log.info("comical on-device server on :\(self?.port ?? 0)")
            }
        }
        listener?.start(queue: .global(qos: .utility))
    }

    public func stop() {
        listener?.cancel()
        listener = nil
    }

    // MARK: - Request handling

    private func handleConnection(_ conn: NWConnection) {
        conn.start(queue: .global(qos: .utility))
        receiveRequest(on: conn)
    }

    private func receiveRequest(on conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self, let data, !data.isEmpty else { conn.cancel(); return }
            Task {
                let response = await self.handleHTTP(data: data)
                conn.send(content: response, completion: .contentProcessed { _ in conn.cancel() })
            }
        }
    }

    private func handleHTTP(data: Data) async -> Data {
        guard let req = String(data: data, encoding: .utf8) else {
            return httpResponse(status: 400, body: #"{"error":"invalid request"}"#)
        }

        let lines = req.components(separatedBy: "\r\n")
        guard let firstLine = lines.first else {
            return httpResponse(status: 400, body: #"{"error":"empty request"}"#)
        }
        let parts = firstLine.components(separatedBy: " ")
        guard parts.count >= 2 else {
            return httpResponse(status: 400, body: #"{"error":"malformed request line"}"#)
        }
        let path = parts[1]

        do {
            let result = try await route(path: path)
            return httpResponse(status: 200, body: result)
        } catch {
            return httpResponse(status: 500, body: #"{"error":"\#(error.localizedDescription)"}"#)
        }
    }

    private func route(path: String) async throws -> String {
        let url = URL(string: "http://localhost\(path)")!
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let p = url.path

        if p == "/health" { return #"{"ok":true}"# }

        if p == "/info" {
            guard let info = context.bridgeInfo,
                  let data = try? JSONEncoder().encode(info),
                  let json = String(data: data, encoding: .utf8)
            else { throw ComicalError(message: "bridge info unavailable") }
            return json
        }

        if p == "/search" {
            let q = query.first(where: { $0.name == "q" })?.value ?? ""
            let page = Int(query.first(where: { $0.name == "page" })?.value ?? "1") ?? 1
            return try await callBridge("getSearchResults", args: [q, page])
        }

        if p == "/home" { return try await callBridge("getHomeSections") }
        if p == "/popular" {
            let page = Int(query.first(where: { $0.name == "page" })?.value ?? "1") ?? 1
            return try await callBridge("getPopular", args: [page])
        }

        // /series/:id
        if let m = p.range(of: #"^/series/([^/]+)/chapters/([^/]+)/pages$"#, options: .regularExpression) {
            let comps = String(p[m]).components(separatedBy: "/").filter { !$0.isEmpty }
            return try await callBridge("getChapterPages", args: [comps[1], comps[3]])
        }
        if let m = p.range(of: #"^/series/([^/]+)/chapters$"#, options: .regularExpression) {
            let id = String(p[m]).components(separatedBy: "/")[2]
            return try await callBridge("getChapters", args: [id])
        }
        if let m = p.range(of: #"^/series/([^/]+)$"#, options: .regularExpression) {
            let id = String(p[m]).components(separatedBy: "/")[2]
            return try await callBridge("getSeriesDetails", args: [id])
        }

        throw ComicalError(message: "unknown route: \(p)")
    }

    private func callBridge(_ method: String, args: [Any] = []) async throws -> String {
        let result = try await context.call(method, args: args)
        guard let data = try? JSONSerialization.data(withJSONObject: result),
              let json = String(data: data, encoding: .utf8)
        else { throw ComicalError(message: "failed to serialise result of \(method)") }
        return json
    }

    private func httpResponse(status: Int, body: String) -> Data {
        let bodyData = body.data(using: .utf8) ?? Data()
        let header = "HTTP/1.1 \(status) OK\r\nContent-Type: application/json\r\nContent-Length: \(bodyData.count)\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
        return (header.data(using: .utf8) ?? Data()) + bodyData
    }
}
