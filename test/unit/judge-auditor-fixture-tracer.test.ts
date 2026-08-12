import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { packageRoot, runPiSubprocess, withColdInstalledPackage } from "../helpers/pi-test-harness.ts";

function seedProject(project: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: project });
  execFileSync("git", ["config", "user.email", "tracer@test.local"], { cwd: project });
  execFileSync("git", ["config", "user.name", "Dossier Tracer"], { cwd: project });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: project });
}

/**
 * #286 real failure call shape: tarball-cold-installed public package root
 * (Ming freezes a packed artifact under a private consumer, then runs judge
 * with that root as packageRoot / bin target). One shortest tracer.
 */
async function runPackagedTracer(marker: string): Promise<{
  runDirectory: string;
  installedRoot: string;
  trace: any[];
}> {
  const home = await mkdtemp(join(tmpdir(), `ak-dossier-${marker}-`));
  try {
    return await withColdInstalledPackage(home, async ({ installedRoot: rawRoot }) => {
      const installedRoot = await realpath(rawRoot);
      const project = join(home, "work");
      await mkdir(project, { recursive: true });
      seedProject(project);
      const attachment = join(home, "evidence.txt");
      await writeFile(attachment, `attachment-${marker}\n`);
      const agentDir = join(home, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "navigator-model.json"), JSON.stringify({ model: "ak-dossier-tracer/faux-1" }));
      // Public CLI of the installed package root — same packageRoot the bin derives.
      const { runAkRole } = await import(resolve(installedRoot, "src/public-cli/cli.ts"));
      const provider = resolve(packageRoot, "test/fixtures/auditor-dossier-tracer-provider.ts");
      const tracePath = join(home, "auditor-trace.jsonl");
      const runId = `run-${marker}`;
      const errors: string[] = [];
      const result = await runAkRole([
        "judge", "--model", "ak-dossier-tracer/faux-1", "--thinking", "off",
        "--attach", attachment, "--project", project, `request-${marker}`,
      ], {
        packageRoot: installedRoot,
        home,
        agentDir,
        cwd: project,
        createRunId: () => runId,
        judgeExtraPiArgs: ["-e", provider],
        judgeTimeoutMs: 90_000,
        io: { stdout() {}, stderr(text: string) { errors.push(text); } },
        piRunner: async (args: string[], options: any) => {
          const child = await runPiSubprocess(args, {
            cwd: options.cwd,
            timeoutMs: options.timeoutMs,
            env: {
              ...options.env,
              HOME: home,
              PI_CODING_AGENT_DIR: agentDir,
              PI_OFFLINE: "1",
              AK_DOSSIER_TRACER_MARKER: marker,
              AK_DOSSIER_TRACER_TRACE: tracePath,
            },
          });
          return { ...child, args: [...args] };
        },
      });
      assert.equal(result.exitCode, 0, errors.join(""));
      const runDirectory = join(home, ".ak-roles", "books", resolveBookKeyFromGit(project), "runs", `${runId}@judge`);
      const invocation = JSON.parse(
        await readFile(join(runDirectory, "invocation.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(invocation.entryMode, "public-cli", "public CLI launch must ledger entry mode");
      assert.equal(invocation.rolePackageRoot, installedRoot);
      assert.equal(
        invocation.roleEntry,
        await realpath(join(installedRoot, "extensions", "role-runtime.ts")),
      );
      assert.equal(
        invocation.rolePackageVersion,
        JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")).version,
      );
      const trace = (await readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(trace[0]?.tool, "ak_get_run_dossier", "auditor must call the run-bound locator first");
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

test("tarball-installed public judge auditor locates and reads its real run dossier", { timeout: 120_000 }, async () => {
  await runPackagedTracer("single");
});

test("two independent packaged Pi processes cannot cross auditor dossiers", { timeout: 180_000 }, async () => {
  const [a, b] = await Promise.all([runPackagedTracer("parallel-a"), runPackagedTracer("parallel-b")]);
  assert.equal(JSON.stringify(a.trace).includes(b.runDirectory), false);
  assert.equal(JSON.stringify(b.trace).includes(a.runDirectory), false);
  assert.notEqual(a.installedRoot, b.installedRoot);
});
