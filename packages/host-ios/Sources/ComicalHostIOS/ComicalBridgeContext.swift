/**
 * ComicalBridgeContext — the iOS JSC evaluator and host adapter.
 *
 * The host context A evaluates `harness.js` — the bundled @comical/host-native runtime (core +
 * glue). `comical_init` runs the bridge through @comical/core's `loadBridge`, which uses the
 * NativeContextEvaluator: it calls back into `__comical_native_eval(code)` (injected below), which
 * evaluates the bridge bundle in a SEPARATE child `JSContext` (context B) sharing this VM. Because
 * B has its own fresh global object holding only the curated allow-list + the host object, a
 * bridge's `eval`/`Function` can only reach B — never the app. This is real realm isolation,
 * stronger than the old `new Function` shim.
 *
 * Injects native Swift callbacks for network (URLSession), storage (FileManager), and logging
 * (os.log) into context A; the bundled runtime wraps them into core's HostCapabilities.
 *
 * Usage:
 *   let ctx = try ComicalBridgeContext(bridgeBundle: bundleCode, settings: ["baseUrl": "https://…"])
 *   let info  = ctx.bridgeInfo                             // BridgeInfo (Decodable)
 *   let items = try await ctx.call("getSearchResults", args: ["naruto", 1])
 *
 * ⚠️ UNVERIFIED: the separate-context evaluator and curated-global polyfills below have NOT been
 * compiled or run on a device/simulator yet. See `// TODO(device)` markers. The JS layer
 * (@comical/host-native) is tested under Bun; the native wiring is validated on-device later.
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

        // Inject the separate-context bundle evaluator (`__comical_native_eval`) that
        // @comical/core's NativeContextEvaluator calls. Must exist before `comical_init`.
        injectBundleEvaluator()

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
        public let rateLimit: RateLimit?

        public struct RateLimit: Decodable {
            public let maxConcurrent: Int?
            public let minIntervalMs: Int?
        }
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

    // MARK: - Separate-context bundle evaluator  ⚠️ UNVERIFIED (device test pending)

    // Live timers for the curated `setTimeout`, retained until they fire or are cleared.
    private var timers: [Int: JSValue] = [:]
    private var timerSeq = 0

    /// Injects `__comical_native_eval(code)` into context A. It evaluates a CJS bridge bundle in a
    /// fresh child `JSContext` (context B) sharing this `JSVirtualMachine`, so B has its own global
    /// object (no app globals — a bridge's eval/Function reach only B). Returns the bundle's
    /// `module.exports` as a JSValue, usable from context A because they share the VM.
    private func injectBundleEvaluator() {
        let vm = js.virtualMachine
        let nativeEval: @convention(block) (String) -> JSValue? = { [weak self] code in
            guard let self, let b = JSContext(virtualMachine: vm) else { return nil }
            b.exceptionHandler = { [weak self] _, exc in
                self?.log.error("bridge context: \(exc?.toString() ?? "unknown")")
            }
            self.bootstrapCuratedGlobals(in: b)
            // CJS shim: provide module/exports, evaluate the bundle, return module.exports.
            let wrapped = "(function(){var module={exports:{}};var exports=module.exports;\n"
                + code + "\n;return module.exports;})()"
            return b.evaluateScript(wrapped)
        }
        js.setObject(nativeEval, forKeyedSubscript: "__comical_native_eval" as NSString)
    }

    /// Curated globals for a bridge context B. Mirrors `buildBridgeGlobals`
    /// (packages/core/src/globals.ts) — keep this allow-list in lockstep with that file.
    private func bootstrapCuratedGlobals(in ctx: JSContext) {
        let log = self.log

        // console → host log
        let consoleLog: @convention(block) (String, String) -> Void = { level, msg in
            switch level {
            case "debug": log.debug("\(msg)")
            case "warn":  log.warning("\(msg)")
            case "error": log.error("\(msg)")
            default:      log.info("\(msg)")
            }
        }
        ctx.setObject(consoleLog, forKeyedSubscript: "__comical_log" as NSString)

        // setTimeout / clearTimeout backed by the run loop (the rate limiter needs real timers).
        let setTimeoutBlock: @convention(block) (JSValue, Double) -> Int = { [weak self] fn, ms in
            guard let self else { return 0 }
            self.timerSeq += 1
            let id = self.timerSeq
            self.timers[id] = fn
            DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000.0) { [weak self] in
                guard let self, self.timers[id] != nil else { return }
                self.timers[id] = nil
                fn.call(withArguments: [])
            }
            return id
        }
        let clearTimeoutBlock: @convention(block) (Int) -> Void = { [weak self] id in
            self?.timers[id] = nil
        }
        ctx.setObject(setTimeoutBlock, forKeyedSubscript: "setTimeout" as NSString)
        ctx.setObject(clearTimeoutBlock, forKeyedSubscript: "clearTimeout" as NSString)

        // atob / btoa
        let atobBlock: @convention(block) (String) -> String = { s in
            guard let d = Data(base64Encoded: s) else { return "" }
            return String(data: d, encoding: .utf8) ?? ""
        }
        let btoaBlock: @convention(block) (String) -> String = { s in
            (s.data(using: .utf8) ?? Data()).base64EncodedString()
        }
        ctx.setObject(atobBlock, forKeyedSubscript: "atob" as NSString)
        ctx.setObject(btoaBlock, forKeyedSubscript: "btoa" as NSString)

        // JS-implementable globals + the console wrapper.
        // TODO(device): URL, URLSearchParams, TextEncoder, TextDecoder are NOT built into JSC —
        // bundle real polyfills and evaluate them here, or bridges using them throw ReferenceError.
        ctx.evaluateScript("""
        var console = {
          log:   (...a) => __comical_log("info",  a.join(" ")),
          info:  (...a) => __comical_log("info",  a.join(" ")),
          debug: (...a) => __comical_log("debug", a.join(" ")),
          warn:  (...a) => __comical_log("warn",  a.join(" ")),
          error: (...a) => __comical_log("error", a.join(" ")),
        };
        var queueMicrotask = (cb) => { Promise.resolve().then(cb); };
        var structuredClone = (v) => JSON.parse(JSON.stringify(v));
        """)
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
