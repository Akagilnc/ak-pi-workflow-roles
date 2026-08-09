/**
 * #109 cold-installed Public Coder production chain:
 * installed `ak-role coder apply` → real Pi child + explicit extension →
 * package Skill expansion/gates → shared Terminal + report/evidence refs.
 * Only the model provider is faux.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { SEALED_UNCHANGED_METHOD_PINS } from "../../src/package-resources/method-skill.ts";
import {
  installPackedArtifactIntoPiNpm,
  packageRoot,
  piCli,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "coder-chain@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Coder Chain"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

async function runAkRoleBin(
  bin: string,
  args: string[],
  options: {
    home: string;
    agentDir: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
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
      cwd: options.cwd,
      env: {
        ...mergedEnv,
        PATH: pathPrefix,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/**
 * Thin PI_BINARY wrapper: keeps every production argv from ak-role, injects only
 * the offline faux provider extension, then forwards to the real Pi binary.
 */
async function writeProviderForwardingPiShim(input: {
  home: string;
  realPi: string;
  providerPath: string;
  argvLogPath: string;
}): Promise<string> {
  const shimDir = resolve(input.home, "pi-provider-forward");
  await mkdir(shimDir, { recursive: true });
  const shimPath = resolve(shimDir, "pi");
  await writeFile(
    shimPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const providerPath = ${JSON.stringify(input.providerPath)};
const realPi = ${JSON.stringify(input.realPi)};
const argvLogPath = ${JSON.stringify(input.argvLogPath)};
const incoming = process.argv.slice(2);
const forwarded = [];
let injected = false;
for (let i = 0; i < incoming.length; i += 1) {
  const token = incoming[i];
  forwarded.push(token);
  if (token === "-e" && i + 1 < incoming.length) {
    forwarded.push(incoming[i + 1]);
    i += 1;
    if (!injected) {
      forwarded.push("-e", providerPath);
      injected = true;
    }
  }
}
writeFileSync(argvLogPath, JSON.stringify({ incoming, forwarded }, null, 2), "utf8");
const child = spawn(realPi, forwarded, {
  stdio: "inherit",
  env: process.env,
});
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
`,
    "utf8",
  );
  await chmod(shimPath, 0o755);
  return shimPath;
}

test(
  "cold-installed ak-role coder apply retains production chain to lawful Terminal artifacts",
  { timeout: 180_000 },
  async () => {
    await withHermeticHome(
      { prefix: "ak-public-cli-coder-chain-" },
      async ({ home }) => {
        const piAgentDir = resolve(home, ".pi", "agent");
        await mkdir(piAgentDir, { recursive: true });
        await writeFile(
          resolve(piAgentDir, "navigator-model.json"),
          JSON.stringify({ model: "ak-coder-offline/faux-1" }) + "\n",
          "utf8",
        );
        const installed = await installPackedArtifactIntoPiNpm(piAgentDir, home);
        const installedRoutebook = resolve(
          installed.installedRoot,
          "resources/navigator-route-playbook.md",
        );
        await writeFile(installedRoutebook, "COLD_INSTALLED_ROUTEBOOK_MARKER\n", "utf8");

        // Empty home: no ambient Skill discovery.
        await assert.rejects(
          () =>
            import("node:fs/promises").then((fs) =>
              fs.access(resolve(home, ".agents", "skills")),
            ),
          (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        );

        const project = resolve(home, "work");
        await mkdir(project, { recursive: true });
        seedGitProject(project);

        const providerPath = resolve(
          packageRoot,
          "test/fixtures/coder-success-provider.ts",
        );
        const argvLogPath = resolve(home, "coder-chain-pi-argv.json");
        const realPi = await import("node:fs/promises").then((fs) =>
          fs.realpath(piCli),
        );
        const shimPath = await writeProviderForwardingPiShim({
          home,
          realPi,
          providerPath,
          argvLogPath,
        });

        const instruction =
          "Implement the approved vertical slice with package TDD.";
        const result = await runAkRoleBin(
          installed.akRoleBin,
          [
            "coder",
            "--model",
            "ak-coder-offline/faux-1",
            "--thinking",
            "off",
            "--project",
            project,
            instruction,
          ],
          {
            home,
            agentDir: piAgentDir,
            cwd: project,
            env: {
              PI_BINARY: shimPath,
              PI_OFFLINE: "1",
            },
          },
        );

        assert.equal(
          result.code,
          0,
          `installed coder chain failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );

        // Production argv retained real explicit Internal load + package skill path.
        const argvRecord = JSON.parse(await readFile(argvLogPath, "utf8")) as {
          incoming: string[];
          forwarded: string[];
        };
        assert.equal(argvRecord.incoming.includes("--no-extensions"), true);
        assert.equal(argvRecord.incoming.includes("-e"), true);
        assert.equal(argvRecord.incoming.includes("--skill"), true);
        assert.equal(argvRecord.incoming.includes("--ak-role"), true);
        assert.equal(
          argvRecord.incoming[argvRecord.incoming.indexOf("--ak-role") + 1],
          "coder",
        );
        assert.equal(
          argvRecord.incoming[argvRecord.incoming.indexOf("--ak-coder-phase") + 1],
          "apply",
        );
        const skillPath =
          argvRecord.incoming[argvRecord.incoming.indexOf("--skill") + 1]!;
        assert.equal(skillPath.includes("resources/methods/tdd/SKILL.md"), true);
        assert.equal(skillPath.includes(".agents/skills"), false);
        // Only provider injection is extra; role-runtime load stays from installed package.
        const incomingE = argvRecord.incoming.filter((a) => a === "-e").length;
        const forwardedE = argvRecord.forwarded.filter((a) => a === "-e").length;
        assert.equal(incomingE, 1);
        assert.equal(forwardedE, 2);
        assert.equal(argvRecord.forwarded.includes(providerPath), true);

        // Recommendation proves the installed marker reached the real Navigator provider context.
        assert.match(result.stdout, /^navigator\trecommendation$/m);

        const bookKey = resolveBookKeyFromGit(project);
        const runsRoot = join(home, ".ak-roles", "books", bookKey, "runs");
        const { readdir } = await import("node:fs/promises");
        const runDirs = await readdir(runsRoot);
        const coderRun = runDirs.find((name) => name.endsWith("@coder"));
        assert.ok(coderRun, `expected coder run under ${runsRoot}, got ${runDirs.join(",")}`);
        const runDirectory = join(runsRoot, coderRun!);

        const reportPath = join(runDirectory, "artifacts", "report.json");
        const evidencePath = join(runDirectory, "artifacts", "evidence.json");
        const reportText = await readFile(reportPath, "utf8");
        assert.equal(reportText.includes("TDD red/green evidence"), true);
        const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
          methodProvenance?: {
            upstream: { commit: string; tag?: string; path: string };
            files: Record<string, { sha256: string; gitBlob: string }>;
          };
        };
        assert.ok(evidence.methodProvenance);
        assert.equal(
          evidence.methodProvenance!.upstream.commit,
          SEALED_UNCHANGED_METHOD_PINS.tdd.commit,
        );
        assert.equal(
          evidence.methodProvenance!.upstream.tag,
          SEALED_UNCHANGED_METHOD_PINS.tdd.tag,
        );
        assert.equal(
          evidence.methodProvenance!.upstream.path,
          SEALED_UNCHANGED_METHOD_PINS.tdd.path,
        );
        assert.equal(
          evidence.methodProvenance!.files["SKILL.md"]?.gitBlob,
          SEALED_UNCHANGED_METHOD_PINS.tdd.files["SKILL.md"]!.gitBlob,
        );
        assert.equal(JSON.stringify(evidence).includes(".agents/skills"), false);

        // Session retained accepted Coder receipt. completed is rejected without native
        // package TDD expansion, so acceptance is the gate proof on this production chain.
        const sessionFile = join(runDirectory, "session", "session.jsonl");
        const sessionText = await readFile(sessionFile, "utf8");
        assert.equal(sessionText.includes("ak_coder_output"), true);
        assert.equal(sessionText.includes('"status":"completed"'), true);
        assert.equal(sessionText.includes('"isError":true') &&
          !sessionText.includes('"isError":false'), false);

        // Installed package root owns the skill bytes used on this chain.
        const installedSkill = join(
          installed.installedRoot,
          "resources/methods/tdd/SKILL.md",
        );
        const { realpath } = await import("node:fs/promises");
        assert.equal(
          await realpath(skillPath),
          await realpath(installedSkill),
        );

        const roleReport = reportText;
        const roleReceiptBytes = JSON.stringify(
          (JSON.parse(roleReport) as { receipt: unknown }).receipt,
        );
        assert.equal(roleReport.includes("COLD_INSTALLED_ROUTEBOOK_MARKER"), false);

        await chmod(installedRoutebook, 0o000);
        const runWithUnreadableRoutebook = async (unavailable: boolean) =>
          runAkRoleBin(
            installed.akRoleBin,
            [
              "coder",
              "--model",
              "ak-coder-offline/faux-1",
              "--thinking",
              "off",
              "--project",
              project,
              instruction,
            ],
            {
              home,
              agentDir: piAgentDir,
              cwd: project,
              env: {
                PI_BINARY: shimPath,
                PI_OFFLINE: "1",
                AK_TEST_ROUTEBOOK_UNREADABLE: "1",
                ...(unavailable ? { AK_TEST_NAVIGATOR_UNAVAILABLE: "1" } : {}),
              },
            },
          );

        const continued = await runWithUnreadableRoutebook(false);
        assert.equal(continued.code, 0, continued.stderr);
        assert.match(continued.stdout, /^navigator\trecommendation$/m);
        assert.match(continued.stdout, /^navigator-advisory\t.*EACCES/m);

        const unavailable = await runWithUnreadableRoutebook(true);
        assert.equal(unavailable.code, 0, unavailable.stderr);
        assert.match(unavailable.stdout, /^navigator\tunavailable$/m);
        assert.match(unavailable.stdout, /^navigator-advisory\t.*EACCES/m);
        assert.match(unavailable.stdout, /^unavailable\t[^\t]+\t.+$/m);

        const allRuns = await readdir(runsRoot);
        const coderRuns = allRuns.filter((name) => name.endsWith("@coder"));
        assert.equal(coderRuns.length, 3);
        for (const name of coderRuns) {
          const receipt = await readFile(
            join(runsRoot, name, "artifacts", "report.json"),
            "utf8",
          );
          assert.equal(
            JSON.stringify((JSON.parse(receipt) as { receipt: unknown }).receipt),
            roleReceiptBytes,
          );
          assert.equal(receipt.includes("EACCES"), false);
        }
      },
    );
  },
);
