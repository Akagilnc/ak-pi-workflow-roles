import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import {
  machineLedgerHome,
  packageRoot,
  piCli,
  withColdInstalledPackage,
} from "../helpers/pi-test-harness.ts";
import { runPublicCliSubprocess } from "../helpers/public-cli-subprocess.ts";

function seedProject(project: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: project });
  execFileSync("git", ["config", "user.email", "tracer@test.local"], { cwd: project });
  execFileSync("git", ["config", "user.name", "Dossier Tracer"], { cwd: project });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: project });
}

/** #286 shortest real-entry tracer: cold tarball .bin → dist main → auditor dossier read. */
async function runPackagedTracer(marker: string): Promise<{
  runDirectory: string;
  installedRoot: string;
  trace: any[];
}> {
  const home = await mkdtemp(join(tmpdir(), `ak-dossier-${marker}-`));
  try {
    // #604: hermetic home is package user profile via runPublicCliSubprocess preload.
    return await withColdInstalledPackage(home, async ({ fixture, installedRoot: rawRoot }) => {
      const installedRoot = await realpath(rawRoot);
      const ledgerHome = machineLedgerHome(home);
      // Unique book key per tracer so parallel A/B cannot cross-adopt runs.
      const project = join(home, `work-${marker}`);
      await mkdir(project, { recursive: true });
      seedProject(project);
      const bookKey = resolveBookKeyFromGit(project);
      const attachment = join(home, "evidence.txt");
      await writeFile(attachment, `attachment-${marker}\n`);
      const agentDir = join(home, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "navigator-model.json"), JSON.stringify({ model: "ak-dossier-tracer/faux-1" }));

      const provider = resolve(packageRoot, "test/fixtures/auditor-dossier-tracer-provider.ts");
      const tracePath = join(home, "auditor-trace.jsonl");
      const launchArgsPath = join(home, "pi-launch-args.json");
      // PI_BINARY remains the production selection seam; this fixture wrapper only
      // loads the faux provider while preserving --version and the real Pi process.
      const piWrapper = join(home, "pi-with-tracer-provider.mjs");
      await writeFile(piWrapper, `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nif (!(args.length === 1 && args[0] === "--version")) writeFileSync(${JSON.stringify(launchArgsPath)}, JSON.stringify(args));\nconst forwarded = args.length === 1 && args[0] === "--version" ? args : ["-e", ${JSON.stringify(provider)}, ...args];\nconst result = spawnSync(${JSON.stringify(piCli)}, forwarded, { stdio: "inherit", env: process.env });\nif (result.error) throw result.error;\nprocess.exit(result.status ?? 1);\n`);
      await chmod(piWrapper, 0o755);

      const bin = join(fixture, "node_modules", ".bin", "ak-role");
      // cp preserves the shared fixture's absolute npm symlink; restore npm's
      // relative link so this invocation executes its private cold-install copy.
      await rm(bin);
      await symlink("../@akagilnc/pi-workflow-roles/dist/public-cli/main.js", bin);
      assert.equal(
        await realpath(bin),
        join(installedRoot, "dist", "public-cli", "main.js"),
        "tracer must execute the cold-installed package bin",
      );
      const result = await runPublicCliSubprocess(bin, [
        "judge", "--model", "ak-dossier-tracer/faux-1", "--thinking", "off",
        "--attach", attachment, "--project", project, `request-${marker}`,
      ], {
        home,
        agentDir,
        cwd: project,
        timeoutMs: 90_000,
        env: {
          PI_BINARY: piWrapper,
          PI_OFFLINE: "1",
          AK_DOSSIER_TRACER_MARKER: marker,
          AK_DOSSIER_TRACER_TRACE: tracePath,
          // #675: nested public auditor summons reuse the same faux tracer provider.
          AK_ROLE_NESTED_EXTRA_PI_ARGS: JSON.stringify(["-e", provider]),
        },
      });
      assert.equal(result.localTimeout, false, result.stderr);
      assert.equal(result.code, 0, result.stderr);

      const runsRoot = join(ledgerHome, "books", bookKey, "runs");
      const runName = (await readdir(runsRoot)).find((name) => name.endsWith("@judge"));
      assert.ok(runName, `expected @judge run under ${runsRoot}`);
      const runDirectory = join(runsRoot, runName);
      const invocation = JSON.parse(await readFile(join(runDirectory, "invocation.json"), "utf8")) as Record<string, unknown>;
      const launchArgs = JSON.parse(await readFile(launchArgsPath, "utf8")) as string[];
      assert.equal(
        invocation.roleEntry,
        launchArgs[launchArgs.indexOf("-e") + 1],
        "ledger roleEntry must be the exact selected entry passed to Pi",
      );
      assert.deepEqual(
        {
          roleEntry: invocation.roleEntry,
          rolePackageRoot: invocation.rolePackageRoot,
          rolePackageVersion: invocation.rolePackageVersion,
          entryMode: invocation.entryMode,
        },
        {
          roleEntry: await realpath(join(installedRoot, "extensions", "role-runtime.ts")),
          rolePackageRoot: installedRoot,
          rolePackageVersion: JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")).version,
          entryMode: "public-cli",
        },
      );
      const trace = (await readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(trace[0]?.tool, "ak_get_run_dossier");
      const readPaths = trace.filter((entry) => entry.tool === "read").map((entry) => entry.path);
      assert.deepEqual(readPaths.slice(0, 2), [
        join(runDirectory, "admitted-request.json"),
        join(runDirectory, "session", "session.jsonl"),
      ]);
      assert.equal(readPaths.length, 3);
      assert.ok(readPaths[2].startsWith(`${join(runDirectory, "attachments")}/`));
      return { runDirectory, installedRoot, trace };
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// Single-tracer case deleted: each half of the dual isolation case already runs
// the full packaged .bin → dossier read helper (Batch 1 R4 / court missedDeletion).

test("two independent packaged Pi processes cannot cross auditor dossiers", { timeout: 180_000 }, async () => {
  const [a, b] = await Promise.all([runPackagedTracer("parallel-a"), runPackagedTracer("parallel-b")]);
  assert.equal(JSON.stringify(a.trace).includes(b.runDirectory), false);
  assert.equal(JSON.stringify(b.trace).includes(a.runDirectory), false);
  assert.notEqual(a.installedRoot, b.installedRoot);
});
