import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { packageRoot } from "../helpers/pi-test-harness.ts";

const probeRelativePath = "resources/construction-tracer/nested/artifact.txt";

function coldInstallInFreshProcess(root: string): {
  artifact: string;
  installedRoot: string;
  stderr: string;
} {
  const script = `
    import { readFile } from "node:fs/promises";
    import { resolve } from "node:path";
    import { getSharedColdInstalledPackage } from "./test/helpers/pi-test-harness.ts";
    const cold = await getSharedColdInstalledPackage();
    const artifact = await readFile(resolve(cold.installedRoot, ${JSON.stringify(probeRelativePath)}), "utf8");
    process.stdout.write(JSON.stringify({ artifact, installedRoot: cold.installedRoot }));
  `;
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { cwd: root, encoding: "utf8", timeout: 240_000 },
  );
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout) as { artifact: string; installedRoot: string };
  return { ...result, stderr: run.stderr };
}

test("shared cold install rebuilds when nested untracked package bytes change", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "ak-cold-construction-tracer-"));
  const checkout = join(scratch, "checkout");
  execFileSync("git", ["-C", packageRoot, "worktree", "add", "--detach", checkout, "HEAD"]);
  try {
    // Before this test's commit exists, overlay the construction fix under test.
    await cp(
      join(packageRoot, "test/helpers/pi-test-harness.ts"),
      join(checkout, "test/helpers/pi-test-harness.ts"),
    );
    await symlink(join(packageRoot, "node_modules"), join(checkout, "node_modules"), "dir");
    const probePath = join(checkout, probeRelativePath);
    await mkdir(dirname(probePath), { recursive: true });

    await writeFile(probePath, "cold-install-first\n");
    const first = coldInstallInFreshProcess(checkout);

    await writeFile(probePath, "cold-install-second\n");
    const second = coldInstallInFreshProcess(checkout);

    assert.equal(first.artifact, "cold-install-first\n");
    assert.equal(second.artifact, "cold-install-second\n");
    assert.notEqual(second.installedRoot, first.installedRoot);
    assert.doesNotMatch(first.stderr + second.stderr, /fatal: Unable to hash/i);
  } finally {
    execFileSync("git", ["-C", packageRoot, "worktree", "remove", "--force", checkout]);
    await rm(scratch, { recursive: true, force: true });
  }
});
