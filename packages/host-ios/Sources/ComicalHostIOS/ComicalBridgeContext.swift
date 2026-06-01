/**
 * ComicalBridgeContext — the iOS JSC evaluator and host adapter.
 *
 * Wraps a JavaScriptCore `JSContext`, evaluates the harness.js runtime shim, then loads and
 * runs a bridge bundle. Injects native Swift callbacks for network (URLSession), storage
 * (FileManager), and logging (os.log) as JSC globals before calling `comical_init`.
 *
 * Usage:
 *   let ctx = try ComicalBridgeContext(bridgeBundle: bundleCode, settings: ["baseUrl": "https://…"])
 *   let info  = ctx.bridgeInfo                             // BridgeInfo (Decodable)
 *   let items = try await ctx.call("getSearchResults", args: ["naruto", 1])
 */
import Foundation
import JavaScriptCore
import os

// MARK: - Public types

public struct ComicalError: Error {
    public let message: String
}

// MARK: - Context

public final class ComicalBridgeContext {
    private let js: JSContext
    private let storageDir: URL
    private let log = Logger(subsystem: "dev.comical", category: "bridge")

    public init(bridgeBundle: String, settings: [String: Any] = [:], dataDir: URL? = nil) throws {
        guard let ctx = JSContext() else { throw ComicalError(message: "failed to create JSContext") }
        js = ctx
        storageDir = dataDir ?? FileManager.default.temporaryDirectory.appendingPathComponent("comical")

        // Surface JS exceptions as Swift errors.
        js.exceptionHandler = { [weak js] _, exception in
            js?.exception = exception
        }

        // Inject native callbacks before evaluating the harness.
        try injectNativeCallbacks()

        // Evaluate the harness shim (bundled resource).
        guard let harnessURL = Bundle.module.url(forResource: "harness", withExtension: "js"),
              let harnessCode = try? String(contentsOf: harnessURL, encoding: .utf8)
        else { throw ComicalError(message: "harness.js resource not found") }
        js.evaluateScript(harnessCode)
        try throwIfException()

        // Initialise the bridge.
        let settingsJSON = (try? JSONSerialization.data(withJSONObject: settings)).flatMap {
            String(data: $0, encoding: .utf8)
        } ?? "{}"
        js.evaluateScript("comical_init(\(jsString(bridgeBundle)), \(jsString(settingsJSON)))")
        try throwIfException()
    }

    // MARK: - Decoded bridge info

    public struct BridgeInfo: Decodable {
        public let id: String
        public let name: String
        public let version: String
        public let contractVersion: String
        public let languages: [String]
        public let nsfw: Bool
        public let capabilities: [String]
    }

    public var bridgeInfo: BridgeInfo? {
        guard let json = js.evaluateScript("JSON.stringify(comical_bridge?.info)")?.toString(),
              let data = json.data(using: .utf8)
        else { return nil }
        return try? JSONDecoder().decode(BridgeInfo.self, from: data)
    }

    // MARK: - Method dispatch

    /// Call a bridge method by name; `args` must be JSON-serialisable.
    public func call(_ method: String, args: [Any] = []) async throws -> Any {
        let argsJSON = (try? JSONSerialization.data(withJSONObject: args)).flatMap {
            String(data: $0, encoding: .utf8)
        } ?? "[]"

        return try await withCheckedThrowingContinuation { continuation in
            let script = "comical_call(\(jsString(method)), \(jsString(argsJSON)))"
            guard let promise = js.evaluateScript(script) else {
                continuation.resume(throwing: ComicalError(message: "evaluation returned nil for \(method)"))
                return
            }
            let thenFn: @convention(block) (JSValue) -> Void = { result in
                guard let str = result.toString(),
                      let data = str.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data)
                else {
                    continuation.resume(throwing: ComicalError(message: "failed to parse result for \(method)"))
                    return
                }
                continuation.resume(returning: obj)
            }
            let catchFn: @convention(block) (JSValue) -> Void = { err in
                continuation.resume(throwing: ComicalError(message: err.toString() ?? "bridge error in \(method)"))
            }
            promise.invokeMethod("then", withArguments: [JSValue(object: thenFn, in: self.js)!])
                   .invokeMethod("catch", withArguments: [JSValue(object: catchFn, in: self.js)!])
        }
    }

    // MARK: - Native callback injection

    private func injectNativeCallbacks() throws {
        let log = self.log

        // Logging
        let nativeLog: @convention(block) (String, String) -> Void = { level, msg in
            switch level {
            case "debug": log.debug("\(msg)")
            case "warn":  log.warning("\(msg)")
            case "error": log.error("\(msg)")
            default:      log.info("\(msg)")
            }
        }
        js.setObject(nativeLog, forKeyedSubscript: "_native_log" as NSString)

        // Network (URLSession)
        let nativeNet: @convention(block) (String, JSValue) -> Void = { [weak self] reqJSON, callback in
            guard let self else { return }
            guard let data = reqJSON.data(using: .utf8),
                  let req = try? JSONDecoder().decode(NativeRequest.self, from: data)
            else {
                callback.call(withArguments: ["invalid request JSON", JSValue(undefinedIn: self.js)!])
                return
            }
            Task { [weak self] in
                guard let self else { return }
                do {
                    let res = try await self.fetchURLSession(req)
                    let resJSON = String(data: try JSONEncoder().encode(res), encoding: .utf8) ?? "{}"
                    callback.call(withArguments: [JSValue(undefinedIn: self.js)!, resJSON])
                } catch {
                    callback.call(withArguments: [error.localizedDescription, JSValue(undefinedIn: self.js)!])
                }
            }
        }
        js.setObject(nativeNet, forKeyedSubscript: "_native_network_request" as NSString)

        // Storage (simple JSON file per bridge)
        let storageDir = self.storageDir
        let nativeGet: @convention(block) (String, JSValue) -> Void = { key, cb in
            Task {
                let val = Self.storageRead(dir: storageDir)[key]
                cb.call(withArguments: [JSValue(undefinedIn: cb.context)!, val as Any])
            }
        }
        let nativeSet: @convention(block) (String, String, JSValue) -> Void = { key, val, cb in
            Task {
                var store = Self.storageRead(dir: storageDir)
                store[key] = val
                Self.storageWrite(dir: storageDir, store: store)
                cb.call(withArguments: [JSValue(undefinedIn: cb.context)!])
            }
        }
        let nativeDel: @convention(block) (String, JSValue) -> Void = { key, cb in
            Task {
                var store = Self.storageRead(dir: storageDir)
                store.removeValue(forKey: key)
                Self.storageWrite(dir: storageDir, store: store)
                cb.call(withArguments: [JSValue(undefinedIn: cb.context)!])
            }
        }
        let nativeKeys: @convention(block) (JSValue) -> Void = { cb in
            Task {
                let keys = Array(Self.storageRead(dir: storageDir).keys)
                let json = (try? JSONSerialization.data(withJSONObject: keys)).flatMap {
                    String(data: $0, encoding: .utf8)
                } ?? "[]"
                cb.call(withArguments: [JSValue(undefinedIn: cb.context)!, json])
            }
        }
        js.setObject(nativeGet,  forKeyedSubscript: "_native_storage_get"    as NSString)
        js.setObject(nativeSet,  forKeyedSubscript: "_native_storage_set"    as NSString)
        js.setObject(nativeDel,  forKeyedSubscript: "_native_storage_delete" as NSString)
        js.setObject(nativeKeys, forKeyedSubscript: "_native_storage_keys"   as NSString)
    }

    // MARK: - URLSession

    private struct NativeRequest: Decodable {
        let url: String
        let method: String?
        let headers: [String: String]?
        let body: String?
    }

    private struct NativeResponse: Encodable {
        let url: String
        let status: Int
        let statusText: String
        let headers: [String: String]
        let body: String
    }

    private func fetchURLSession(_ req: NativeRequest) async throws -> NativeResponse {
        guard let url = URL(string: req.url) else {
            throw ComicalError(message: "invalid URL: \(req.url)")
        }
        var urlReq = URLRequest(url: url)
        urlReq.httpMethod = req.method ?? "GET"
        req.headers?.forEach { urlReq.setValue($1, forHTTPHeaderField: $0) }
        if let body = req.body { urlReq.httpBody = body.data(using: .utf8) }

        let (data, response) = try await URLSession.shared.data(for: urlReq)
        let http = response as! HTTPURLResponse
        let body = String(data: data, encoding: .utf8) ?? ""
        var headers: [String: String] = [:]
        http.allHeaderFields.forEach { k, v in
            if let ks = k as? String, let vs = v as? String { headers[ks.lowercased()] = vs }
        }
        return NativeResponse(
            url: http.url?.absoluteString ?? req.url,
            status: http.statusCode,
            statusText: HTTPURLResponse.localizedString(forStatusCode: http.statusCode),
            headers: headers,
            body: body
        )
    }

    // MARK: - File storage helpers

    private static func storageFile(dir: URL) -> URL {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("storage.json")
    }

    private static func storageRead(dir: URL) -> [String: String] {
        guard let data = try? Data(contentsOf: storageFile(dir: dir)),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String]
        else { return [:] }
        return obj
    }

    private static func storageWrite(dir: URL, store: [String: String]) {
        guard let data = try? JSONSerialization.data(withJSONObject: store) else { return }
        try? data.write(to: storageFile(dir: dir))
    }

    // MARK: - Utilities

    private func throwIfException() throws {
        if let exception = js.exception {
            js.exception = nil
            throw ComicalError(message: exception.toString() ?? "unknown JS exception")
        }
    }

    private func jsString(_ s: String) -> String {
        // Wrap in JSON.stringify-safe form.
        let escaped = s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
        return "\"\(escaped)\""
    }
}
