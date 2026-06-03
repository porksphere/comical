/**
 * Proxy-backed NetworkCapability for the browser host.
 *
 * Browsers block cross-origin requests (CORS) and cannot reach backends that send no CORS
 * headers. All bridge network requests are forwarded through a user-supplied COMICAL proxy
 * instance (`@comical/proxy`), which fetches server-side and returns the result.
 */
import type { HttpRequest, HttpResponse, NetworkCapability } from "@comical/contract";

/** Shape of the JSON body POSTed to the proxy's /proxy endpoint. */
interface ForwardedRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Shape of the JSON response from the proxy's /proxy endpoint. */
interface ForwardedResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  setCookies?: string[];
  body: string;
}

export interface ProxyNetworkOptions {
  /** Base URL of the user's comical-proxy instance, e.g. https://proxy.example.com */
  proxyUrl: string;
  /** Optional bearer token matching COMICAL_PROXY_TOKEN on the proxy. */
  proxyToken?: string;
}

export function createProxyNetwork(opts: ProxyNetworkOptions): NetworkCapability {
  const { proxyUrl, proxyToken } = opts;
  const endpoint = `${proxyUrl.replace(/\/+$/, "")}/proxy`;

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const forwarded: ForwardedRequest = {
        url: req.url,
        method: req.method ?? "GET",
        headers: req.headers ?? {},
      };
      if (req.body !== undefined) forwarded.body = req.body;

      const headers: Record<string, string> = { "content-type": "application/json" };
      if (proxyToken) headers.authorization = `Bearer ${proxyToken}`;

      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(forwarded),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`proxy error ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const data = (await res.json()) as ForwardedResponse;
      const response: HttpResponse = {
        url: data.url,
        status: data.status,
        statusText: data.statusText,
        headers: data.headers,
        body: data.body,
      };
      if (data.setCookies && data.setCookies.length > 0) response.setCookies = data.setCookies;
      return response;
    },
  };
}
