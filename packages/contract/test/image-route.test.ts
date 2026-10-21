import { describe, expect, test } from "bun:test";
import { bridgeImagePath, parseBridgeImagePath } from "../src/index.ts";

describe("bridgeImagePath", () => {
  test("round-trips a URL carrying its own query and fragment", () => {
    const url = "https://cdn.example.test/a b/0.jpg?sig=x&y=1#f";
    const path = bridgeImagePath("scope/name", url);
    expect(path.startsWith("/bridges/scope%2Fname/image?url=")).toBe(true);
    expect(parseBridgeImagePath(path)).toEqual({ bridgeId: "scope/name", url });
    expect(parseBridgeImagePath(`https://host.test:3100${path}`)).toEqual({ bridgeId: "scope/name", url });
  });

  test("doesn't parse other bridge routes or a missing url", () => {
    expect(parseBridgeImagePath("/bridges/x/series/1/page-image/a/b")).toBeUndefined();
    expect(parseBridgeImagePath("/bridges/x/image")).toBeUndefined();
    expect(parseBridgeImagePath("/img-proxy?url=https%3A%2F%2Fa.test%2F")).toBeUndefined();
  });

  test("rejects a malformed escape instead of throwing", () => {
    expect(parseBridgeImagePath("/bridges/x/image?url=%E0%A4%A")).toBeUndefined();
  });
});
