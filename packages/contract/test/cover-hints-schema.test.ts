/**
 * Schema tests for the cover hints — `coverForm` and `readingDirection` — on `seriesEntrySchema`,
 * `seriesInfoSchema` and `bridgeInfoSchema`. Both are optional and additive. On a series they are a
 * layout hint like `thumbnailAspect`, so a malformed value is dropped instead of failing the whole
 * response; on `BridgeInfo` they are declared once by the bridge author, so a bad value is an error.
 */
import { describe, expect, test } from "bun:test";
import {
  bridgeInfoSchema,
  coverFormSchema,
  readingDirectionSchema,
  seriesEntrySchema,
  seriesInfoSchema,
} from "../src/models.ts";

const BRIDGE = {
  id: "example",
  name: "Example",
  version: "0.1.0",
  contractVersion: "2.1.0",
  languages: ["en"],
  nsfw: false,
  capabilities: [],
};

describe("coverFormSchema / readingDirectionSchema", () => {
  test("name every form and direction", () => {
    expect(coverFormSchema.options).toEqual(["volume", "issue", "scroll", "sheets"]);
    expect(readingDirectionSchema.options).toEqual(["ltr", "rtl", "vertical"]);
  });
});

describe.each([
  ["seriesEntrySchema", seriesEntrySchema],
  ["seriesInfoSchema", seriesInfoSchema],
] as const)("%s cover hints", (_, schema) => {
  test("carry every form and direction", () => {
    for (const coverForm of coverFormSchema.options) {
      expect(schema.parse({ id: "1", title: "T", coverForm }).coverForm).toBe(coverForm);
    }
    for (const readingDirection of readingDirectionSchema.options) {
      expect(schema.parse({ id: "1", title: "T", readingDirection }).readingDirection).toBe(readingDirection);
    }
  });

  test("parse when omitted (backward-compatible with existing bridges)", () => {
    const parsed = schema.parse({ id: "1", title: "T" });
    expect(parsed.coverForm).toBeUndefined();
    expect(parsed.readingDirection).toBeUndefined();
  });

  test("drop a malformed hint instead of failing the series", () => {
    const parsed = schema.parse({ id: "1", title: "T", coverForm: "scroll-of-doom", readingDirection: 3 });
    expect(parsed.id).toBe("1");
    expect(parsed.coverForm).toBeUndefined();
    expect(parsed.readingDirection).toBeUndefined();
  });
});

describe("bridgeInfoSchema cover hints", () => {
  test("carry a bridge-wide default", () => {
    const info = bridgeInfoSchema.parse({ ...BRIDGE, coverForm: "sheets", readingDirection: "rtl" });
    expect(info.coverForm).toBe("sheets");
    expect(info.readingDirection).toBe("rtl");
  });

  test("parse when omitted", () => {
    const info = bridgeInfoSchema.parse(BRIDGE);
    expect(info.coverForm).toBeUndefined();
    expect(info.readingDirection).toBeUndefined();
  });

  test("reject a malformed default, which is the bridge author's to fix", () => {
    expect(() => bridgeInfoSchema.parse({ ...BRIDGE, coverForm: "tankobon" })).toThrow();
    expect(() => bridgeInfoSchema.parse({ ...BRIDGE, readingDirection: "up" })).toThrow();
  });
});
