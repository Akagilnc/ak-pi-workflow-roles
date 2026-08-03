import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import test from "node:test";

const soulPath = new URL("../souls/navigator.md", import.meta.url);

test("Navigator whole-tree deletion census has no obsolete public surfaces", () => {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const obsoletePath = /(^|\/)(assisted|navigator-(?:output|snapshot|evidence|reader|ledger|audit)|subject-universe)(?:[-./]|$)/i;
  assert.deepEqual(paths.filter((path) => obsoletePath.test(path)), []);
  assert.equal(paths.includes("src/navigator-attendance.ts"), true);
  assert.equal(paths.includes("souls/navigator.md"), true);
});

test("Navigator Soul keeps route judgment and omits transport mechanics in both directions", async () => {
  const soul = await readFile(soulPath, "utf8");
  assert.match(soul, /工作大小/);
  assert.match(soul, /authority/);
  assert.match(soul, /路线/);
  assert.match(soul, /建议/);
  assert.doesNotMatch(soul, /schema|CLI|session|model|tool|failure|JSON/i);
});
