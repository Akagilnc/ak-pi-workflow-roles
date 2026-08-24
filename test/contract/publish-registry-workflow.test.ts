import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { packageRoot } from "../helpers/pi-test-harness.ts";

const workflowPath = resolve(packageRoot, ".github/workflows/publish-registry.yml");

test("publish-registry channel arrives via step env, not shell source interpolation", () => {
  const source = readFileSync(workflowPath, "utf8");
  // Structural: expression may only appear in env map, never inside run: body.
  assert.match(source, /^\s+env:\s*$/m);
  assert.match(source, /^\s+CHANNEL:\s*\$\{\{\s*github\.event\.inputs\.channel/m);
  const runBodies = [...source.matchAll(/^\s+run:\s*\|\s*\n([\s\S]*?)(?=^\s+[A-Za-z-]+:|\s*$)/gm)].map((match) => match[1] ?? "");
  assert.ok(runBodies.length >= 1, "expected at least one run block");
  for (const body of runBodies) {
    assert.equal(
      body.includes("github.event.inputs.channel"),
      false,
      "channel expression must not be expanded into shell source",
    );
  }
});

test("channel env values with metacharacters stay data under the workflow shell pattern", () => {
  const malicious = 'x$(echo pwned)y; echo injected" `touch /tmp/pwn` ';
  const stamped = execFileSync(
    "bash",
    [
      "-c",
      // Mirrors publish-registry: CHANNEL from env/arg, only quoted expansions.
      `CHANNEL="$1"
VERSION="0.1.9-$CHANNEL.abc1234"
printf '%s\\n' "$VERSION"
printf '%s\\n' "$CHANNEL"`,
      "channel-env-pattern",
      malicious,
    ],
    { encoding: "utf8" },
  ).split("\n");
  assert.equal(stamped[0], `0.1.9-${malicious}.abc1234`);
  assert.equal(stamped[1], malicious);
});

test("prerelease version stamp includes commit short sha, not a fixed .0 suffix", () => {
  const source = readFileSync(workflowPath, "utf8");
  assert.match(source, /VERSION="\$VERSION-\$CHANNEL\.\$\(git rev-parse --short=7 HEAD\)"/);
  assert.equal(source.includes('VERSION="$VERSION-$CHANNEL.0"'), false);
  assert.match(source, /npm dist-tag add "\$PACKAGE_NAME@\$VERSION" "\$CHANNEL"/);
});
