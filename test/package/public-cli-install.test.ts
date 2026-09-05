/**
 * #319 Batch 2 (M3/R5): install-surface seam.
 *
 * - Shared tarball via installPackedArtifactIntoPiNpm → getSharedIsolatedPack (R5).
 * - Discovery case owns the real `pi install` + settings write path (including
 *   repeated install) and the pi-invocation identity contract.
 * - Admits/negatives + full-role argv smoke + pi update: public-cli-cold-matrix (heavy, #685).
 * - This file keeps install-surface shortest tracer (pi install, repeat, bin, identity).
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  INTERNAL_ROLE_ENTRYPOINT_RELATIVE,
  installPackedArtifactIntoPiNpm,
  machineLedgerHome,
  packageRoot,
  piCli,
  runPiSubprocess,
  withHermeticHome,
  type PiManagedInstall,
} from "../helpers/pi-test-harness.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { loadCredentialProviders } from "../../src/public-cli/config.ts";
import { PUBLIC_CONFIGURABLE_SEATS } from "../../src/public-cli/registry.ts";
import { runPublicCliSubprocess as runAkRoleBin } from "../helpers/public-cli-subprocess.ts";
import { TEST_PI_VERSION_BRANCH } from "../helpers/test-process-fixtures.ts";

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "coder-install@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Coder Install"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

test("isolated Pi home installs packed artifact and discovers ak-role via private npm bin", async () => {
  await withHermeticHome({ prefix: "ak-public-cli-bin-" }, async ({ home, agentDir }) => {
    // #604: runPublicCliSubprocess points packageMachineHome at this hermetic
    // home via test user-profile preload — seats/ledger never touch real home.
    const ledgerHome = machineLedgerHome(home);
    const configPath = resolve(ledgerHome, "public-cli.json");
    // Use a Pi-shaped agent dir under the hermetic home (not the harness default .pi-agent label).
    const piAgentDir = resolve(home, ".pi", "agent");
    await mkdir(piAgentDir, { recursive: true });
    // R5: shared HEAD-keyed tarball inside installPackedArtifactIntoPiNpm; this
    // case alone owns the live pi install → settings.packages write path.
    const installed = await installPackedArtifactIntoPiNpm(piAgentDir, home);

    const assertHostPeersAbsent = async (): Promise<void> => {
      for (const name of ["pi-ai", "pi-coding-agent"]) {
        await assert.rejects(
          () => access(resolve(installed.npmRoot, "node_modules", "@earendil-works", name)),
          (error: NodeJS.ErrnoException) => error.code === "ENOENT",
          `${name} must be supplied by the real Pi host, not its package npm root`,
        );
      }
      const listed = spawnSync("npm", ["ls", "--json", "--depth=0"], {
        cwd: installed.npmRoot,
        encoding: "utf8",
      });
      assert.notEqual(listed.stdout, "", listed.stderr);
      const tree = JSON.parse(listed.stdout) as { dependencies?: Record<string, unknown> };
      assert.ok(tree.dependencies?.["@akagilnc/pi-workflow-roles"]);
      assert.equal(tree.dependencies?.["@earendil-works/pi-ai"], undefined);
      assert.equal(tree.dependencies?.["@earendil-works/pi-coding-agent"], undefined);
    };
    await assertHostPeersAbsent();

    // Book key = project basename under hermetic package home.
    const bookKey = `identity-work-604-${Date.now().toString(36)}`;
    const project = resolve(home, bookKey);
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const machinePiOnPath = execFileSync("sh", ["-c", "command -v pi"], {
      encoding: "utf8",
    }).trim();
    const hostPiExecutable = await realpath(machinePiOnPath);
    const hostPiVersion = execFileSync(hostPiExecutable, ["--version"], { encoding: "utf8" }).trim();
    const traceInvocationIdentity = async (): Promise<void> => {
      // Coder with no credentials reaches its documented activation-failure
      // terminal without consulting a model provider. Install-surface identity
      // only — production coder deep chain is coder-installed-run 🔒 (M3).
      const run = await runAkRoleBin(
        installed.akRoleBin,
        ["coder", "plan", "--project", project, "Trace the selected Pi identity."],
        {
          home,
          agentDir: piAgentDir,
          env: { PI_OFFLINE: "1" },
        },
      );
      assert.equal(run.localTimeout, false, run.stderr);
      assert.equal(run.code, 1, run.stderr);
      const runsRoot = resolve(ledgerHome, "books", bookKey, "runs");
      const names = (await readdir(runsRoot)).filter((name) => name.endsWith("@coder")).sort();
      const runRoot = resolve(runsRoot, names.at(-1)!);
      const invocation = JSON.parse(
        await readFile(resolve(runRoot, "invocation.json"), "utf8"),
      ) as { piExecutable?: string; piVersion?: string };
      assert.equal(invocation.piExecutable, hostPiExecutable);
      assert.equal(invocation.piVersion, hostPiVersion);
      const errorArtifact = JSON.parse(
        await readFile(resolve(runRoot, "artifacts", "error.json"), "utf8"),
      ) as { kind?: string; role?: string; cause?: string };
      assert.equal(errorArtifact.kind, "error");
      assert.equal(errorArtifact.role, "coder");
      assert.equal(errorArtifact.cause, "activation");
    };
    await traceInvocationIdentity();

    const source = `npm:@akagilnc/pi-workflow-roles@file:${installed.pack.tarball}`;
    const repeated = await runPiSubprocess(["install", source], {
      cwd: home,
      timeoutMs: 120_000,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: piAgentDir,
        PI_OFFLINE: "1",
      },
    });
    assert.equal(repeated.localTimeout, false, repeated.stderr);
    assert.equal(repeated.code, 0, repeated.stderr);
    await assertHostPeersAbsent();
    await traceInvocationIdentity();
    await assertHostPeersAbsent();

    await access(installed.akRoleBin);
    const realBin = await realpath(installed.akRoleBin);
    assert.equal(realBin.includes("@akagilnc/pi-workflow-roles"), true);
    assert.equal(realBin.endsWith(join("dist", "public-cli", "main.js")), true);

    // pi install owner persists the package into user settings (not a raw npm root hack).
    const settings = JSON.parse(
      await readFile(resolve(piAgentDir, "settings.json"), "utf8"),
    ) as { packages?: unknown[] };
    assert.equal(Array.isArray(settings.packages), true);
    assert.equal(
      (settings.packages ?? []).some(
        (entry) =>
          typeof entry === "string" &&
          entry.startsWith("npm:@akagilnc/pi-workflow-roles@file:"),
      ),
      true,
    );

    // Seed codex-only credentials for effective model resolution.
    await writeFile(
      resolve(piAgentDir, "auth.json"),
      JSON.stringify({ "openai-codex": { type: "oauth", access: "test" } }),
      "utf8",
    );

    // Installed bin smoke: real entry exits 0 after pi install.
    const rolesBin = await runAkRoleBin(installed.akRoleBin, ["roles"], {
      home,
      agentDir: piAgentDir,
    });
    assert.equal(rolesBin.localTimeout, false, rolesBin.stderr);
    assert.equal(rolesBin.code, 0, rolesBin.stderr);
    // Seat/source/model from public CLI typed product (CliResult.seats) — ADR 0052;
    // never bite renderRoles TSV. Same home/agentDir/credentials the bin used.
    const credentials = await loadCredentialProviders(piAgentDir);
    const roles = await runAkRole(["roles"], {
      packageRoot,
      home,
      agentDir: piAgentDir,
      credentials,
      io: { stdout() {}, stderr() {} },
    });
    assert.equal(roles.exitCode, 0);
    assert.ok(roles.seats, "roles CLI product must carry typed seats");
    assert.deepEqual(
      roles.seats.map((row) => row.seat),
      [...PUBLIC_CONFIGURABLE_SEATS],
    );
    assert.equal(
      roles.seats.some((row) => (row.seat as string) === "auditor"),
      false,
      "CLI seats product must not enumerate auditor",
    );
    const navigatorSeat = roles.seats.find((row) => row.seat === "navigator");
    assert.ok(navigatorSeat, "navigator must enumerate as a configurable seat");
    assert.equal(navigatorSeat.source, "startup");

    // Help is loud smoke only (exit 0 + non-empty). Capability membership is a
    // typed contract (listHelpCapabilities / helpDocument); do not stare at help
    // free text (#125 / 锚定宪法).
    const help = await runAkRoleBin(installed.akRoleBin, ["help"], {
      home,
      agentDir: piAgentDir,
    });
    assert.equal(help.code, 0, help.stderr);
    assert.ok(help.stdout.trim().length > 0, "help stdout must be non-empty");

    // Bulk config survives a new process.
    const set = await runAkRoleBin(
      installed.akRoleBin,
      ["config", "set", "coder", "xai/grok-4.5:high"],
      { home, agentDir: piAgentDir },
    );
    assert.equal(set.code, 0, set.stderr);
    const againBin = await runAkRoleBin(installed.akRoleBin, ["roles"], {
      home,
      agentDir: piAgentDir,
      env: {
        // xai credential absent → persistent still wins for coder
      },
    });
    assert.equal(againBin.code, 0, againBin.stderr);
    const againCredentials = await loadCredentialProviders(piAgentDir);
    const again = await runAkRole(["roles"], {
      packageRoot,
      home,
      agentDir: piAgentDir,
      credentials: againCredentials,
      io: { stdout() {}, stderr() {} },
    });
    assert.equal(again.exitCode, 0);
    assert.ok(again.seats);
    const coderPersistent = again.seats.find((row) => row.seat === "coder");
    assert.ok(coderPersistent);
    assert.equal(coderPersistent.source, "persistent");
    assert.deepEqual(coderPersistent.selection, {
      provider: "xai",
      model: "grok-4.5",
      thinking: "high",
    });

    const before = await readFile(configPath, "utf8");
    const overriddenBin = await runAkRoleBin(
      installed.akRoleBin,
      ["roles", "--model", "openai-codex/gpt-5.6-luna", "--thinking", "high"],
      { home, agentDir: piAgentDir },
    );
    assert.equal(overriddenBin.code, 0, overriddenBin.stderr);
    const overridden = await runAkRole(
      ["roles", "--model", "openai-codex/gpt-5.6-luna", "--thinking", "high"],
      {
        packageRoot,
        home,
        agentDir: piAgentDir,
        credentials: againCredentials,
        io: { stdout() {}, stderr() {} },
      },
    );
    assert.equal(overridden.exitCode, 0);
    assert.ok(overridden.seats);
    const coderInvocation = overridden.seats.find((row) => row.seat === "coder");
    assert.ok(coderInvocation);
    assert.equal(coderInvocation.source, "invocation");
    assert.deepEqual(coderInvocation.selection, {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinking: "high",
    });
    const after = await readFile(configPath, "utf8");
    assert.equal(after, before);

    // Internal entrypoint remains on the same installed package copy.
    const internal = resolve(installed.installedRoot, INTERNAL_ROLE_ENTRYPOINT_RELATIVE);
    await access(internal);
  });
});

// Keep a reference so tree-shaking/lint does not drop harness symbols used by peers.
void packageRoot;
void piCli;
