/**
 * Bun server entry point for `@comical/proxy`.
 *
 * Usage:
 *   COMICAL_PROXY_TOKEN=secret bun run packages/proxy/src/index.ts
 *
 * For Cloudflare Workers, import `createProxyApp` from `./app.ts` directly and export its
 * `fetch` handler — Hono apps are CF Worker-compatible without modification.
 */
import { createProxyApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3100);
const app = createProxyApp(process.env as Record<string, string>);

const server = Bun.serve({ port, fetch: app.fetch });
console.log(`comical-proxy running on http://localhost:${server.port}`);
if (!process.env.COMICAL_PROXY_TOKEN) {
  console.warn("COMICAL_PROXY_TOKEN is not set — proxy is unauthenticated (dev only)");
}

export default app;
