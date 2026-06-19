/**
 * Schema tests for `tagGroupSchema` — focused on `tagQueries`, the additive parallel-to-`tags` array
 * carrying a ready-to-run search query per tag (for backends whose tags aren't a filterable id set but
 * whose search box accepts tag syntax). The field is optional and additive — older bridges that omit
 * it must still parse.
 */
import { describe, expect, test } from "bun:test";
import { tagGroupSchema } from "../src/models.ts";

describe("tagGroupSchema tagQueries", () => {
  test("parses a group carrying per-tag search queries", () => {
    const grp = tagGroupSchema.parse({
      label: "Female Tags",
      kind: "theme",
      tags: ["big breasts", "sole female"],
      tagQueries: ['female:"big breasts$"', 'female:"sole female$"'],
    });
    expect(grp.tagQueries).toEqual(['female:"big breasts$"', 'female:"sole female$"']);
  });

  test("tagQueries is optional (backward-compatible)", () => {
    const grp = tagGroupSchema.parse({ label: "Tags", tags: ["a", "b"] });
    expect(grp.tagQueries).toBeUndefined();
  });

  test("coexists independently with tagIds", () => {
    const grp = tagGroupSchema.parse({
      label: "Tags",
      tags: ["a"],
      tagIds: ["1"],
      tagQueries: ['tag:"a$"'],
    });
    expect(grp.tagIds).toEqual(["1"]);
    expect(grp.tagQueries).toEqual(['tag:"a$"']);
  });

  test("rejects a non-string entry in tagQueries", () => {
    expect(() => tagGroupSchema.parse({ label: "Tags", tags: ["a"], tagQueries: [42] })).toThrow();
  });
});
