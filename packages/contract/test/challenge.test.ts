import { describe, expect, test } from "bun:test";
import { challengeMessage, parseChallenge } from "../src/index.ts";

describe("challenge marker", () => {
  test("round-trips a URL and User-Agent, wherever the marker sits in the message", () => {
    const msg = `getListItems threw: ${challengeMessage({ url: "https://x.test/a?b=1&c=[2]", userAgent: "Mozilla/5.0 (X; Y) Z/1|2", reason: "check" })}`;
    expect(parseChallenge(msg)).toEqual({ url: "https://x.test/a?b=1&c=[2]", userAgent: "Mozilla/5.0 (X; Y) Z/1|2", reason: "check" });
  });

  test("the User-Agent is optional, and a reason defaults", () => {
    expect(parseChallenge(challengeMessage({ url: "https://x.test/" }))).toEqual({ url: "https://x.test/", reason: "the site wants to check this is a person" });
  });

  test("anything else is not a challenge", () => {
    expect(parseChallenge("plain error")).toBeNull();
    expect(parseChallenge("[challenge:notaurl] x")).toBeNull();
    expect(parseChallenge("[challenge:%E0%A4%A] x")).toBeNull();
    expect(parseChallenge("[challenge:https%3A%2F%2Fx")).toBeNull();
  });
});
