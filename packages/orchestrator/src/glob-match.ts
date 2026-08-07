// Minimal glob matcher for repo-relative file paths.
//
// WHY A HAND-ROLLED MATCHER: `.magpie.toml`'s `review.ignore_paths` (see
// repo-config.ts) needs `*`/`**`/`?` glob matching against diff/changed-file
// paths. `packages/orchestrator/package.json` has no glob dependency today
// (grep it before adding one), and pulling one in for three wildcard forms is
// more surface than the feature needs — the implementation task explicitly
// calls for a small, well-tested internal matcher rather than a new runtime
// dependency. This module is deliberately narrow: three wildcards, POSIX-style
// `/`-separated paths (GitHub API paths always use `/`, never `\`), nothing
// else (no brace expansion, no character classes, no extglob).
//
// Wildcard semantics (matched against a `/`-separated path, anchored full-match):
//   `*`  — any run of characters EXCLUDING `/` (stays within one path segment).
//   `**` — any run of characters INCLUDING `/` (crosses segment boundaries).
//          A `**/` prefix additionally matches zero leading segments (so
//          `**/foo.js` matches both `foo.js` and `a/b/foo.js`).
//   `?`  — exactly one character EXCLUDING `/`.
//   anything else — matched literally (regex-escaped).
//
// The whole pattern is anchored (`^...$`): `ignore_paths` entries are meant to
// describe a specific path or subtree, not an arbitrary substring search,
// which would make it too easy to accidentally (or adversarially, from the
// repo-config side) suppress far more of the diff than intended.

/** Escapes every regex metacharacter EXCEPT the ones this module itself interprets (`*`, `?`). */
function escapeRegExpLiteral(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * Compiles one glob `pattern` into an anchored `RegExp` per the module doc
 * comment's wildcard semantics. Not exported — exercised indirectly via
 * {@link matchesGlob}'s tests.
 */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      // `**` — crosses `/` boundaries, matching zero or more characters
      // including `/`. A trailing `/` right after `**` is consumed into the
      // wildcard itself (rather than emitted as a literal `/`) so `dir/**`
      // matches `dir/x` (not just paths with a redundant double slash) and a
      // leading `**/` also matches zero leading segments (`**/foo.js`
      // matches bare `foo.js` as well as `a/b/foo.js`).
      i += 2;
      if (pattern[i] === "/") i += 1;
      re += ".*";
      continue;
    }
    if (c === "*") {
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    re += escapeRegExpLiteral(c);
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

/** Whether `path` matches glob `pattern` (see module doc comment for wildcard semantics). */
export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}

/** Whether `path` matches ANY of `patterns`. Empty `patterns` always returns `false`. */
export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}
