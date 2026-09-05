/**
 * #319 Batch 2 (M3/R5): install-surface seam.
 *
 * - Shared tarball via installPackedArtifactIntoPiNpm → getSharedIsolatedPack (R5).
 * - Discovery case owns the real `pi install` + settings write path (including
 *   repeated install) and the pi-invocation identity contract.
 * - Admits/negatives matrix moved to public-cli-cold-matrix t1 (#420: one cold
 *   install hosts all seven roles plus the install-unique grammar).
 * - Full-role argv smoke is owned by public-cli-cold-matrix (M2).
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
import {
  PUBLIC_CONFIGURABLE_SEATS,
} from "../../src/public-cli/registry.ts";
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
    // #675: avoid navigator attendance hanging on default openai-codex auth during
    // activation-failure identity traces (no credentials on this install surface).
    await writeFile(
      resolve(piAgentDir, "navigator-model.json"),
      `${JSON.stringify({ model: "offline-none/none" })}\n`,
      "utf8",
    );
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
          env: {
            PI_OFFLINE: "1",
            // #675: nested public officer summons need offline faux provider if gate fires.
            AK_ROLE_NESTED_EXTRA_PI_ARGS: JSON.stringify([
              "-e",
              resolve(packageRoot, "test/fixtures/nested-public-officer-pass-provider.ts"),
            ]),
          },
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

    const roles = await runAkRoleBin(installed.akRoleBin, ["roles"], {
      home,
      agentDir: piAgentDir,
    });
    assert.equal(roles.localTimeout, false, roles.stderr);
    assert.equal(roles.code, 0, roles.stderr);
    for (const seat of PUBLIC_CONFIGURABLE_SEATS) {
      assert.match(roles.stdout, new RegExp(`^${seat}\\t`, "m"));
    }
    assert.match(roles.stdout, /^navigator\tstartup\t/m);
    assert.match(roles.stdout, /^auditor\t/m);
    assert.match(roles.stdout, /^evidence-child\t/m);

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
    const again = await runAkRoleBin(installed.akRoleBin, ["roles"], {
      home,
      agentDir: piAgentDir,
      env: {
        // xai credential absent → persistent still wins for coder
      },
    });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /^coder\tpersistent\txai\/grok-4\.5:high$/m);

    const before = await readFile(configPath, "utf8");
    const overridden = await runAkRoleBin(
      installed.akRoleBin,
      ["roles", "--model", "openai-codex/gpt-5.6-luna", "--thinking", "high"],
      { home, agentDir: piAgentDir },
    );
    assert.equal(overridden.code, 0, overridden.stderr);
    assert.match(
      overridden.stdout,
      /^coder\tinvocation\topenai-codex\/gpt-5\.6-luna:high$/m,
    );
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
