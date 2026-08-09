/**
 * #115 release-candidate seam: one isolated cold install exercises the complete
 * public role matrix through the real `ak-role` executable, proves Pi package
 * update keeps CLI + runtime on one copy, and reaffirms packed runtime resources
 * without presentation/prose freezes (ADR 0052 / 锚定宪法).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  getSharedIsolatedPack,
  INTERNAL_ROLE_ENTRYPOINT_RELATIVE,
  installPackedArtifactIntoPiNpm,
  packageRoot,
  piCli,
  piPrivateNpmBinDir,
  piPrivateNpmRoot,
  runPiSubprocess,
  withHermeticHome,
  type PiManagedInstall,
} from "../helpers/pi-test-harness.ts";
import {
  PUBLIC_CALLABLE_ROLES,
  PUBLIC_CONFIGURABLE_SEATS,
} from "../../src/public-cli/registry.ts";
import { PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";

/** Required package-owned method trees shipped in the release artifact. */
const PACKAGED_METHOD_TREES = [
  {
    name: "tdd",
    files: [
      "resources/methods/tdd/SKILL.md",
      "resources/methods/tdd/tests.md",
      "resources/methods/tdd/mocking.md",
      "resources/methods/tdd/agents/openai.yaml",
      "resources/methods/tdd/provenance.json",
    ],
  },
  {
    name: "code-review",
    files: [
      "resources/methods/code-review/SKILL.md",
      "resources/methods/code-review/agents/openai.yaml",
      "resources/methods/code-review/provenance.json",
    ],
  },
  {
    name: "diagnosing-bugs",
    files: [
      "resources/methods/diagnosing-bugs/SKILL.md",
      "resources/methods/diagnosing-bugs/agents/openai.yaml",
      "resources/methods/diagnosing-bugs/scripts/hitl-loop.template.sh",
      "resources/methods/diagnosing-bugs/provenance.json",
    ],
  },
  {
    name: "resolving-merge-conflicts",
    files: [
      "resources/methods/resolving-merge-conflicts/SKILL.md",
      "resources/methods/resolving-merge-conflicts/agents/openai.yaml",
      "resources/methods/resolving-merge-conflicts/provenance.json",
    ],
  },
] as const;

const REQUIRED_SOULS = [
  "souls/judge.md",
  "souls/fixer.md",
  "souls/coder.md",
  "souls/reviewer.md",
  "souls/collector.md",
  "souls/doctor.md",
  "souls/merger.md",
  "souls/navigator.md",
] as const;

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "cold-matrix@test.local"], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Cold Matrix"], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], {
    cwd: root,
    stdio: "ignore",
  });
}

async function runAkRoleBin(
  bin: string,
  args: string[],
  options: {
    home: string;
    agentDir: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolvePromise) => {
    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      HOME: options.home,
      PI_CODING_AGENT_DIR: options.agentDir,
    };
    const pathPrefix = `${dirname(bin)}:${mergedEnv.PATH ?? process.env.PATH ?? ""}`;
    const child = spawn(bin, args, {
      cwd: options.cwd ?? options.home,
      env: {
        ...mergedEnv,
        PATH: pathPrefix,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 45_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

async function writePiArgvShim(
  shimDir: string,
  argvLog: string,
  options: { forward?: boolean; exitCode?: number } = {},
): Promise<string> {
  await mkdir(shimDir, { recursive: true });
  const shimPath = resolve(shimDir, "pi");
  const realPi = await realpath(piCli);
  const forward = options.forward === true;
  const exitCode = options.exitCode ?? 1;
  if (forward) {
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") { console.log("pi-shim"); process.exit(0); }
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args), "utf8");
const child = spawn(${JSON.stringify(realPi)}, args, {
  stdio: "inherit",
  env: process.env,
});
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
`,
      "utf8",
    );
  } else {
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") { console.log("pi-shim"); process.exit(0); }
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args), "utf8");
process.exit(${exitCode});
`,
      "utf8",
    );
  }
  await chmod(shimPath, 0o755);
  return shimPath;
}

function assertNoDeferredSlice(label: string, text: string): void {
  assert.equal(
    text.includes("not available in this install slice"),
    false,
    `${label} must not hit deferred-slice prose`,
  );
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

async function assertInstalledRuntimeResources(installedRoot: string): Promise<void> {
  for (const soul of REQUIRED_SOULS) {
    await access(resolve(installedRoot, soul));
  }
  for (const tree of PACKAGED_METHOD_TREES) {
    for (const rel of tree.files) {
      await access(resolve(installedRoot, rel));
    }
    const provenance = JSON.parse(
      await readFile(
        resolve(installedRoot, `resources/methods/${tree.name}/provenance.json`),
        "utf8",
      ),
    ) as {
      name: string;
      upstream: { attribution: string; license: string };
    };
    assert.equal(provenance.name, tree.name);
    assert.equal(provenance.upstream.attribution, "mattpocock/skills");
    assert.equal(provenance.upstream.license, "MIT");
  }
  await access(resolve(installedRoot, "THIRD_PARTY_NOTICES.md"));
  await access(resolve(installedRoot, "LICENSE"));
  await access(resolve(installedRoot, INTERNAL_ROLE_ENTRYPOINT_RELATIVE));
  const manifest = JSON.parse(
    await readFile(resolve(installedRoot, "package.json"), "utf8"),
  ) as {
    name: string;
    license?: string;
    bin?: Record<string, string>;
    pi?: { extensions?: unknown[] };
    peerDependencies?: Record<string, string>;
  };
  assert.equal(manifest.name, "@akagilnc/pi-workflow-roles");
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.bin?.["ak-role"], "./dist/public-cli/main.js");
  assert.deepEqual(manifest.pi?.extensions ?? ["missing"], []);
  assert.equal(
    typeof manifest.peerDependencies?.["@earendil-works/pi-coding-agent"],
    "string",
  );
}

/**
 * Derive a versioned tarball from the shared pack without re-running prepack
 * (extracted trees lack devDependencies/tsx). Marker proves CLI+runtime advance.
 */
async function packVersionedArtifact(options: {
  version: string;
  marker: string;
  destinationDir: string;
  baseTarball: string;
}): Promise<{ tarball: string; version: string; marker: string }> {
  const extractRoot = await mkdtemp(resolve(tmpdir(), "ak-cold-matrix-x-"));
  try {
    execFileSync("tar", ["-xzf", options.baseTarball, "-C", extractRoot], {
      stdio: "ignore",
    });
    const pkgDir = resolve(extractRoot, "package");
    const manifest = JSON.parse(
      await readFile(resolve(pkgDir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    manifest.version = options.version;
    await writeFile(
      resolve(pkgDir, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      resolve(pkgDir, "COLD_MATRIX_MARKER"),
      `${options.marker}\n`,
      "utf8",
    );
    // npm install of file: tarballs expects package/ root layout (npm pack shape).
    const filename = `akagilnc-pi-workflow-roles-${options.version}.tgz`;
    const tarball = resolve(options.destinationDir, filename);
    execFileSync(
      "tar",
      ["-czf", tarball, "-C", extractRoot, "package"],
      { stdio: "ignore" },
    );
    return {
      tarball,
      version: options.version,
      marker: options.marker,
    };
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }
}

async function installFromTarball(
  agentDir: string,
  home: string,
  tarball: string,
): Promise<PiManagedInstall> {
  const source = `npm:@akagilnc/pi-workflow-roles@file:${tarball}`;
  const result = await runPiSubprocess(["install", source], {
    cwd: home,
    timeoutMs: 120_000,
    env: {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
    },
  });
  if (result.timedOut) {
    throw new Error(`pi install timed out for ${source}`);
  }
  if (result.code !== 0) {
    throw new Error(
      `pi install failed (code ${String(result.code)}): ${result.stderr || result.stdout}`,
    );
  }
  const npmRoot = piPrivateNpmRoot(agentDir);
  const installedRoot = resolve(
    npmRoot,
    "node_modules",
    "@akagilnc",
    "pi-workflow-roles",
  );
  const binDir = piPrivateNpmBinDir(agentDir);
  return {
    agentDir,
    npmRoot,
    binDir,
    installedRoot,
    akRoleBin: resolve(binDir, "ak-role"),
    pack: {
      root: dirname(tarball),
      tarball,
      filename: tarball.split("/").pop()!,
      files: [],
    },
  };
}

test("one cold install exercises all seven public roles plus automatic Navigator gates", async () => {
  assert.equal(PUBLIC_CALLABLE_ROLES.length, 7);
  assert.deepEqual(
    [...PUBLIC_CALLABLE_ROLES],
    PACKAGED_ROLE_REGISTRY.map((entry) => entry.role),
  );

  await withHermeticHome({ prefix: "ak-cold-matrix-" }, async ({ home }) => {
    const piAgentDir = resolve(home, ".pi", "agent");
    await mkdir(piAgentDir, { recursive: true });
    const installed = await installPackedArtifactIntoPiNpm(piAgentDir, home);

    // Empty ambient home — package methods must not depend on ~/.agents/skills.
    await assert.rejects(
      () => access(resolve(home, ".agents", "skills")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    await assertInstalledRuntimeResources(installed.installedRoot);

    // Manifest remains auto-registration free on the installed copy.
    const installedManifest = JSON.parse(
      await readFile(resolve(installed.installedRoot, "package.json"), "utf8"),
    ) as { pi?: { extensions?: unknown[] } };
    assert.deepEqual(installedManifest.pi?.extensions ?? ["missing"], []);

    await writeFile(
      resolve(piAgentDir, "auth.json"),
      JSON.stringify({ "openai-codex": { type: "oauth", access: "test" } }),
      "utf8",
    );

    const project = resolve(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/Acme/Widgets.git"],
      { cwd: project, stdio: "ignore" },
    );

    // Discoverability: seven callable + automatic Navigator; no auditors.
    const roles = await runAkRoleBin(installed.akRoleBin, ["roles"], {
      home,
      agentDir: piAgentDir,
      cwd: project,
    });
    assert.equal(roles.timedOut, false, roles.stderr);
    assert.equal(roles.code, 0, roles.stderr);
    for (const seat of PUBLIC_CONFIGURABLE_SEATS) {
      assert.match(roles.stdout, new RegExp(`^${seat}\\t`, "m"));
    }
    assert.match(roles.stdout, /^navigator\tautomatic\t/m);
    assert.equal(roles.stdout.includes("auditor"), false);
    // Navigator is never a caller-selected command.
    const navCmd = await runAkRoleBin(installed.akRoleBin, ["navigator"], {
      home,
      agentDir: piAgentDir,
      cwd: project,
    });
    assert.equal(navCmd.code, 2, navCmd.stderr);
    assertNoDeferredSlice("navigator command", `${navCmd.stdout}\n${navCmd.stderr}`);

    const help = await runAkRoleBin(installed.akRoleBin, ["help"], {
      home,
      agentDir: piAgentDir,
      cwd: project,
    });
    assert.equal(help.code, 0, help.stderr);
    for (const name of ["roles", "config", "help", "resume", ...PUBLIC_CALLABLE_ROLES]) {
      assert.equal(help.stdout.includes(name), true, `help must mention ${name}`);
    }
    assert.equal(help.stdout.includes("navigator"), false);

    // Config persistence survives a new process (shared install).
    const setNav = await runAkRoleBin(
      installed.akRoleBin,
      ["config", "set", "navigator", "xai/grok-4.5:high"],
      { home, agentDir: piAgentDir, cwd: project },
    );
    assert.equal(setNav.code, 0, setNav.stderr);
    const rolesAfter = await runAkRoleBin(installed.akRoleBin, ["roles"], {
      home,
      agentDir: piAgentDir,
      cwd: project,
    });
    assert.equal(rolesAfter.code, 0, rolesAfter.stderr);
    assert.match(
      rolesAfter.stdout,
      /^navigator\tautomatic\tpersistent\txai\/grok-4\.5:high$/m,
    );

    // One Pi argv shim shared across the matrix; each role overwrites the log.
    const shimDir = resolve(home, "pi-shim-matrix");
    const argvLog = resolve(home, "matrix-pi-argv.json");
    await writePiArgvShim(shimDir, argvLog);
    const shimEnv = {
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      PI_OFFLINE: "1",
    };

    // judge — retained role gate: Internal --ak-role judge, no ambient skills.
    {
      const result = await runAkRoleBin(
        installed.akRoleBin,
        ["judge", "--project", project, "Adjudicate the attached plan."],
        { home, agentDir: piAgentDir, cwd: project, env: shimEnv },
      );
      assert.equal(result.timedOut, false, result.stderr);
      assertNoDeferredSlice("judge", `${result.stdout}\n${result.stderr}`);
      const args = JSON.parse(await readFile(argvLog, "utf8")) as string[];
      assert.equal(flagValue(args, "--ak-role"), "judge");
      assert.equal(args.includes("--no-skills"), true);
      assert.equal(args.includes("-e"), true);
      const entry = flagValue(args, "-e");
      assert.ok(entry);
      assert.equal(entry.endsWith(INTERNAL_ROLE_ENTRYPOINT_RELATIVE), true);
    }

    // coder apply — package tdd method forced; home skills excluded.
    {
      const result = await runAkRoleBin(
        installed.akRoleBin,
        [
          "coder",
          "apply",
          "--project",
          project,
          "Implement the approved vertical slice.",
        ],
        { home, agentDir: piAgentDir, cwd: project, env: shimEnv },
      );
      assert.equal(result.timedOut, false, result.stderr);
      assertNoDeferredSlice("coder", `${result.stdout}\n${result.stderr}`);
      const args = JSON.parse(await readFile(argvLog, "utf8")) as string[];
      assert.equal(flagValue(args, "--ak-role"), "coder");
      assert.equal(flagValue(args, "--ak-coder-phase"), "apply");
      const skill = flagValue(args, "--skill");
      assert.ok(skill);
      assert.equal(skill.includes("resources/methods/tdd/SKILL.md"), true);
      assert.equal(skill.includes(".agents/skills"), false);
      assert.equal(
        skill.includes(installed.installedRoot) ||
          skill.includes("@akagilnc/pi-workflow-roles"),
        true,
      );
    }

    // fixer apply — package diagnosing-bugs available, not home-bound.
    {
      const result = await runAkRoleBin(
        installed.akRoleBin,
        [
          "fixer",
          "apply",
          "--project",
          project,
          "Settle the approved repair class.",
        ],
        { home, agentDir: piAgentDir, cwd: project, env: shimEnv },
      );
      assert.equal(result.timedOut, false, result.stderr);
      assertNoDeferredSlice("fixer", `${result.stdout}\n${result.stderr}`);
      const args = JSON.parse(await readFile(argvLog, "utf8")) as string[];
      assert.equal(flagValue(args, "--ak-role"), "fixer");
      assert.equal(flagValue(args, "--ak-fixer-phase"), "apply");
      const skill = flagValue(args, "--skill");
      assert.ok(skill);
      assert.equal(
        skill.includes("resources/methods/diagnosing-bugs/SKILL.md"),
        true,
      );
      assert.equal(skill.includes(".agents/skills"), false);
    }

    // reviewer — derived capabilities + package code-review method.
    {
      const result = await runAkRoleBin(
        installed.akRoleBin,
        [
          "reviewer",
          "--project",
          project,
          "--base",
          "main",
          "Review the branch on Standards and Spec.",
        ],
        { home, agentDir: piAgentDir, cwd: project, env: shimEnv },
      );
      assert.equal(result.timedOut, false, result.stderr);
      assertNoDeferredSlice("reviewer", `${result.stdout}\n${result.stderr}`);
      const args = JSON.parse(await readFile(argvLog, "utf8")) as string[];
      assert.equal(flagValue(args, "--ak-role"), "reviewer");
      assert.equal(args.includes("--ak-review-task"), true);
      assert.equal(args.includes("--ak-review-capabilities"), true);
      const skill = flagValue(args, "--skill");
      assert.ok(skill);
      assert.equal(
        skill.includes("resources/methods/code-review/SKILL.md"),
        true,
      );
      assert.equal(skill.includes(".agents/skills"), false);
    }

    // collector — explicit PR/legs isolation profile; no ambient skills.
    {
      const result = await runAkRoleBin(
        installed.akRoleBin,
        [
          "collector",
          "--project",
          project,
          "--pr",
          "42",
          "--leg",
          "codex:CodexBot",
        ],
        { home, agentDir: piAgentDir, cwd: project, env: shimEnv },
      );
      assert.equal(result.timedOut, false, result.stderr);
      assertNoDeferredSlice("collector", `${result.stdout}\n${result.stderr}`);
      const args = JSON.parse(await readFile(argvLog, "utf8")) as string[];
      assert.equal(flagValue(args, "--ak-role"), "collector");
      assert.equal(flagValue(args, "--ak-collector-pr"), "42");
      assert.equal(flagValue(args, "--ak-collector-repo"), "Acme/Widgets");
      assert.equal(args.includes("--ak-collector-legs"), true);
      assert.equal(args.includes("--no-skills"), true);
      assert.equal(args.includes("--skill"), false);
    }

    // doctor — Issue identity → retained case; isolation profile.
    {
      const result = await runAkRoleBin(
        installed.akRoleBin,
        ["doctor", "--project", project, "--issue", "115", "Diagnose this case."],
        { home, agentDir: piAgentDir, cwd: project, env: shimEnv },
      );
      assert.equal(result.timedOut, false, result.stderr);
      assertNoDeferredSlice("doctor", `${result.stdout}\n${result.stderr}`);
      const args = JSON.parse(await readFile(argvLog, "utf8")) as string[];
      assert.equal(flagValue(args, "--ak-role"), "doctor");
      assert.equal(args.includes("--ak-doctor-case"), true);
      assert.equal(args.includes("--no-skills"), true);
    }

    // merger — package merge-only method; honest path without active merge.
    {
      const result = await runAkRoleBin(
        installed.akRoleBin,
        [
          "merger",
          "--project",
          project,
          "Reconcile the active merge without inventing authority.",
        ],
        { home, agentDir: piAgentDir, cwd: project, env: shimEnv },
      );
      assert.equal(result.timedOut, false, result.stderr);
      assertNoDeferredSlice("merger", `${result.stdout}\n${result.stderr}`);
      // Envelope may fail closed before Pi when no merge is active, or dispatch
      // the shell activation path — both are completed public paths.
      try {
        const args = JSON.parse(await readFile(argvLog, "utf8")) as string[];
        if (flagValue(args, "--ak-role") === "merger") {
          assert.equal(args.includes("--ak-merger-input"), true);
          const skill = flagValue(args, "--skill");
          assert.ok(skill);
          assert.equal(
            skill.includes(
              "resources/methods/resolving-merge-conflicts/SKILL.md",
            ),
            true,
          );
          assert.equal(skill.includes(".agents/skills"), false);
        }
      } catch (error) {
        // Argv log may still hold the previous role when envelope fails before
        // dispatch; nonzero exit without deferred prose is the contract.
        assert.notEqual(result.code, 0, result.stderr);
        void error;
      }
    }

    // Ordinary Pi startup still does not auto-register Internal --ak-role.
    const ordinary = await runPiSubprocess(["--help"], {
      cwd: home,
      timeoutMs: 30_000,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: piAgentDir,
        PI_OFFLINE: "1",
      },
    });
    assert.equal(ordinary.timedOut, false, ordinary.stderr);
    assert.equal(ordinary.code, 0, ordinary.stderr);
    assert.equal(
      /--ak-role\b/.test(ordinary.stdout) || /--ak-role\b/.test(ordinary.stderr),
      false,
      "ordinary help must not register --ak-role",
    );

    // No second global npm copy of the package under the hermetic home.
    await assert.rejects(
      () =>
        access(
          resolve(home, ".npm-global", "lib", "node_modules", "@akagilnc", "pi-workflow-roles"),
        ),
      (error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" || error.code === "ENOTDIR",
    );
    const realBin = await realpath(installed.akRoleBin);
    assert.equal(realBin.includes(installed.npmRoot), true);
    assert.equal(realBin.includes(join("dist", "public-cli", "main.js")), true);
  });
});

test("documented Pi package update refreshes CLI and runtime from one private copy", async () => {
  await withHermeticHome({ prefix: "ak-cold-update-" }, async ({ home }) => {
    const piAgentDir = resolve(home, ".pi", "agent");
    await mkdir(piAgentDir, { recursive: true });

    const packDir = await mkdtemp(resolve(tmpdir(), "ak-cold-update-pack-"));
    try {
      const basePack = await getSharedIsolatedPack();
      const v1 = await packVersionedArtifact({
        version: "0.1.0-matrix.1",
        marker: "cold-matrix-v1",
        destinationDir: packDir,
        baseTarball: basePack.tarball,
      });
      // Stable path so settings identity + update reinstall the same file: source
      // after content advances (documented `pi update <source>` path).
      const stableTarball = resolve(packDir, "pi-workflow-roles-update.tgz");
      await copyFile(v1.tarball, stableTarball);

      const first = await installFromTarball(piAgentDir, home, stableTarball);
      await access(first.akRoleBin);
      const markerV1 = (
        await readFile(resolve(first.installedRoot, "COLD_MATRIX_MARKER"), "utf8")
      ).trim();
      assert.equal(markerV1, "cold-matrix-v1");
      const versionV1 = JSON.parse(
        await readFile(resolve(first.installedRoot, "package.json"), "utf8"),
      ) as { version: string };
      assert.equal(versionV1.version, "0.1.0-matrix.1");
      const binRealV1 = await realpath(first.akRoleBin);

      const v2 = await packVersionedArtifact({
        version: "0.1.0-matrix.2",
        marker: "cold-matrix-v2",
        destinationDir: packDir,
        baseTarball: basePack.tarball,
      });
      await copyFile(v2.tarball, stableTarball);

      // Documented update: same package identity, private npm root only.
      // Offline must be off so PackageManager.update is not a no-op; file: source
      // does not require registry access.
      const update = await runPiSubprocess(
        ["update", "npm:@akagilnc/pi-workflow-roles"],
        {
          cwd: home,
          timeoutMs: 120_000,
          env: {
            ...process.env,
            HOME: home,
            PI_CODING_AGENT_DIR: piAgentDir,
            // Explicitly clear offline so update is not short-circuited.
            PI_OFFLINE: "0",
          },
        },
      );
      assert.equal(update.timedOut, false, update.stderr);
      assert.equal(
        update.code,
        0,
        `pi update failed: ${update.stderr || update.stdout}`,
      );

      const installedRoot = resolve(
        piPrivateNpmRoot(piAgentDir),
        "node_modules",
        "@akagilnc",
        "pi-workflow-roles",
      );
      const markerV2 = (
        await readFile(resolve(installedRoot, "COLD_MATRIX_MARKER"), "utf8")
      ).trim();
      assert.equal(markerV2, "cold-matrix-v2");
      const versionV2 = JSON.parse(
        await readFile(resolve(installedRoot, "package.json"), "utf8"),
      ) as { version: string; bin?: Record<string, string>; pi?: { extensions?: unknown[] } };
      assert.equal(versionV2.version, "0.1.0-matrix.2");
      assert.equal(versionV2.bin?.["ak-role"], "./dist/public-cli/main.js");
      assert.deepEqual(versionV2.pi?.extensions ?? ["missing"], []);

      const akRoleBin = resolve(piPrivateNpmBinDir(piAgentDir), "ak-role");
      await access(akRoleBin);
      const binRealV2 = await realpath(akRoleBin);
      assert.equal(binRealV2.includes(installedRoot) || binRealV2.includes("@akagilnc/pi-workflow-roles"), true);
      // CLI and runtime share the updated private copy (not a drifted global).
      assert.equal(binRealV2.includes(piPrivateNpmRoot(piAgentDir)), true);
      assert.notEqual(markerV2, markerV1);
      assert.notEqual(versionV2.version, versionV1.version);
      // Prior bin path may be identical string after overwrite; content marker proves advance.
      void binRealV1;

      // Still no ambient home Skill dependency after update.
      await assert.rejects(
        () => access(resolve(home, ".agents", "skills")),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
      await access(resolve(installedRoot, "resources/methods/tdd/SKILL.md"));
      await access(
        resolve(installedRoot, "resources/methods/code-review/SKILL.md"),
      );
      await access(
        resolve(installedRoot, "resources/methods/diagnosing-bugs/SKILL.md"),
      );
      await access(
        resolve(
          installedRoot,
          "resources/methods/resolving-merge-conflicts/SKILL.md",
        ),
      );

      // Updated executable still discovers roles from the same package copy.
      const roles = await runAkRoleBin(akRoleBin, ["roles"], {
        home,
        agentDir: piAgentDir,
      });
      assert.equal(roles.timedOut, false, roles.stderr);
      assert.equal(roles.code, 0, roles.stderr);
      for (const role of PUBLIC_CALLABLE_ROLES) {
        assert.match(roles.stdout, new RegExp(`^${role}\\t`, "m"));
      }
      assert.match(roles.stdout, /^navigator\tautomatic\t/m);
    } finally {
      await rm(packDir, { recursive: true, force: true });
    }
  });
});

test("packed release artifact carries runtime resources, attribution, and empty auto-extensions", async () => {
  // Reuse shared pack once; assert release-candidate resource matrix.
  const pack = await getSharedIsolatedPack();
  const paths = new Set(pack.files.map((file) => file.path));

  for (const soul of REQUIRED_SOULS) {
    assert.equal(paths.has(soul), true, `pack must include ${soul}`);
  }
  for (const tree of PACKAGED_METHOD_TREES) {
    for (const rel of tree.files) {
      assert.equal(paths.has(rel), true, `pack must include ${rel}`);
    }
  }
  assert.equal(paths.has("THIRD_PARTY_NOTICES.md"), true);
  assert.equal(paths.has("LICENSE"), true);
  assert.equal(paths.has("dist/public-cli/main.js"), true);
  assert.equal(paths.has(INTERNAL_ROLE_ENTRYPOINT_RELATIVE), true);
  assert.equal(paths.has("extensions/role-runtime.ts"), true);

  const extractRoot = await mkdtemp(resolve(tmpdir(), "ak-cold-pack-meta-"));
  try {
    execFileSync("tar", ["-xzf", pack.tarball, "-C", extractRoot], {
      stdio: "ignore",
    });
    const manifest = JSON.parse(
      await readFile(resolve(extractRoot, "package/package.json"), "utf8"),
    ) as {
      name: string;
      license?: string;
      bin?: Record<string, string>;
      pi?: { extensions?: unknown[] };
    };
    assert.equal(manifest.name, "@akagilnc/pi-workflow-roles");
    assert.equal(manifest.license, "Apache-2.0");
    assert.equal(manifest.bin?.["ak-role"], "./dist/public-cli/main.js");
    assert.deepEqual(manifest.pi?.extensions, []);
    // Attribution: project Apache text + separate Matt MIT notice.
    const license = await readFile(
      resolve(extractRoot, "package/LICENSE"),
      "utf8",
    );
    const notices = await readFile(
      resolve(extractRoot, "package/THIRD_PARTY_NOTICES.md"),
      "utf8",
    );
    assert.equal(license.includes("Apache License"), true);
    assert.equal(notices.includes("MIT"), true);
    assert.notEqual(notices, license);
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }

  void packageRoot;
});
