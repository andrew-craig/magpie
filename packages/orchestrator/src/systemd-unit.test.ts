// Guard: magpie.service keeps PrivateTmp=true AND resets rootless podman's
// per-user pause process on every start. A stale pause process holds an old
// service invocation's private /var/tmp, so every podman call fails with
// "open /var/tmp/NNN: no such file or directory" (exit 125). Dropping either
// line silently reintroduces that bug (or the hardening regression).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const unit = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../systemd/magpie.service"),
  "utf8",
);
const directives = unit.split("\n").filter((l) => !l.trimStart().startsWith("#"));

describe("systemd/magpie.service", () => {
  it("keeps PrivateTmp=true", () => {
    expect(directives).toContain("PrivateTmp=true");
  });

  it("resets the podman pause process before ExecStart", () => {
    const pre = directives.indexOf("ExecStartPre=-/usr/bin/podman system migrate");
    const start = directives.findIndex((l) => l.startsWith("ExecStart="));
    expect(pre).toBeGreaterThan(-1);
    expect(pre).toBeLessThan(start);
  });
});
