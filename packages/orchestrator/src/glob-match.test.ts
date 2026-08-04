import { describe, expect, it } from "vitest";
import { matchesAnyGlob, matchesGlob } from "./glob-match.js";

describe("matchesGlob", () => {
  it("matches a literal path exactly", () => {
    expect(matchesGlob("src/index.ts", "src/index.ts")).toBe(true);
    expect(matchesGlob("src/index.ts", "src/other.ts")).toBe(false);
  });

  it("`*` matches within one path segment only", () => {
    expect(matchesGlob("app.min.js", "*.min.js")).toBe(true);
    expect(matchesGlob("src/app.min.js", "*.min.js")).toBe(false);
    expect(matchesGlob("src/app.min.js", "src/*.min.js")).toBe(true);
    expect(matchesGlob("src/a/app.min.js", "src/*.min.js")).toBe(false);
  });

  it("`**` crosses path segment boundaries", () => {
    expect(matchesGlob("vendor/foo.js", "vendor/**")).toBe(true);
    expect(matchesGlob("vendor/a/b/foo.js", "vendor/**")).toBe(true);
    expect(matchesGlob("vendor", "vendor/**")).toBe(false);
    expect(matchesGlob("src/vendor/foo.js", "vendor/**")).toBe(false);
  });

  it("a leading `**/` also matches zero leading segments", () => {
    expect(matchesGlob("foo.js", "**/foo.js")).toBe(true);
    expect(matchesGlob("a/b/foo.js", "**/foo.js")).toBe(true);
    expect(matchesGlob("a/b/bar.js", "**/foo.js")).toBe(false);
  });

  it("`?` matches exactly one non-slash character", () => {
    expect(matchesGlob("a.ts", "?.ts")).toBe(true);
    expect(matchesGlob("ab.ts", "?.ts")).toBe(false);
    expect(matchesGlob("a/.ts", "?.ts")).toBe(false);
  });

  it("regex metacharacters in the pattern are treated literally", () => {
    expect(matchesGlob("src/a+b.ts", "src/a+b.ts")).toBe(true);
    expect(matchesGlob("src/aXb.ts", "src/a+b.ts")).toBe(false);
    expect(matchesGlob("src/(x).ts", "src/(x).ts")).toBe(true);
  });

  it("is fully anchored, not a substring search", () => {
    expect(matchesGlob("src/vendor/thing.js", "vendor")).toBe(false);
    expect(matchesGlob("vendor", "vendor")).toBe(true);
  });

  it("empty pattern only matches an empty path", () => {
    expect(matchesGlob("", "")).toBe(true);
    expect(matchesGlob("x", "")).toBe(false);
  });
});

describe("matchesAnyGlob", () => {
  it("returns true if any pattern matches", () => {
    expect(matchesAnyGlob("vendor/x.js", ["*.md", "vendor/**"])).toBe(true);
  });

  it("returns false when no pattern matches", () => {
    expect(matchesAnyGlob("src/x.js", ["*.md", "vendor/**"])).toBe(false);
  });

  it("returns false for an empty pattern list", () => {
    expect(matchesAnyGlob("src/x.js", [])).toBe(false);
  });
});
