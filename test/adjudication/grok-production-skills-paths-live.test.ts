/**
 * Bare live seam: only real Grok can prove skills.paths in controlled GROK_HOME
 * is discovered and classified under packageRoot (akActive). Ordinary tests must
 * not faux-parse config.toml (Probe lifecycle → adjudication).
 *
 * Uses prepareControlledGrokHome + writeProductionGrokPackageSkillPaths (the
 * production bind body) with a non-ak-grok-home temp prefix so parallel unit
 * isolation snapshots are not polluted.
 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeProductionGrokPackageSkillPaths } from "../../src/grok/production-host.ts";
import {
  controlledGrokChildEnv,
  inspectControlledGrok,
  prepareControlledGrokHome,
} from "../../src/grok/role-turn-host.ts";
import { realMachineHome } from "../helpers/test-agent-dir-guard.ts";

const hostBinary = join(realMachineHome(), ".grok", "bin", "grok");
const hostAuth = join(realMachineHome(), ".grok", "auth.json");

test("real Grok inspect observes package method skills only after production skills.paths write", async (t) => {
  try {
    await Promise.all([access(hostBinary), access(hostAuth)]);
  } catch {
    t.skip("installed authenticated Grok is unavailable");
    return;
  }

  const scratch = await mkdtemp(join(tmpdir(), "ak-adj-skills-"));
  const operatorHome = join(scratch, "operator");
  const packageRoot = join(scratch, "pkg");
  const cwd = join(scratch, "cwd");
  const bareHome = join(scratch, "bare-home");
  const boundHome = join(scratch, "bound-home");
  try {
    await mkdir(join(operatorHome, ".grok"), { recursive: true });
    await writeFile(join(operatorHome, ".grok", "auth.json"), await readFile(hostAuth));
    await mkdir(join(packageRoot, "resources", "methods", "tdd"), { recursive: true });
    await writeFile(
      join(packageRoot, "resources", "methods", "tdd", "SKILL.md"),
      "---\nname: tdd\ndescription: live-seam fixture for production skills.paths\n---\n# tdd\n",
      "utf8",
    );
    await mkdir(cwd, { recursive: true });

    await prepareControlledGrokHome(operatorHome, bareHome);
    const bare = await inspectControlledGrok({
      binary: hostBinary,
      cwd,
      env: {
        ...controlledGrokChildEnv(process.env, bareHome),
        AK_PACKAGE_ROOT: packageRoot,
      },
      packageRoot,
    });
    assert.equal(
      bare.akActive.some((id) => id.includes("tdd")),
      false,
      `without skills.paths, package tdd must not be akActive; got ${JSON.stringify(bare.akActive)}`,
    );

    await prepareControlledGrokHome(operatorHome, boundHome);
    await writeProductionGrokPackageSkillPaths(boundHome, packageRoot);
    const bound = await inspectControlledGrok({
      binary: hostBinary,
      cwd,
      env: {
        ...controlledGrokChildEnv(process.env, boundHome),
        AK_PACKAGE_ROOT: packageRoot,
      },
      packageRoot,
    });
    assert.ok(
      bound.akActive.includes("skills:tdd"),
      `expected skills:tdd after skills.paths write, got ${JSON.stringify(bound.akActive)}`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
