/**
 * #109 cold-installed Public Coder production chain (#526 spec-A):
 * Single cold install → auto-resume limit=0 → first process real Pi child
 * returns typed 429 provider stop → second process executes `ak-role resume <same runId>`
 * and completes with accepted typed Coder terminal + frozen materials + artifacts.
 *
 * Deletes §3.A.4 named argv logs/indices, report prose locks, and raw JSONL text checks.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { readSealedSubmission } from "../../src/submission-ledger.ts";
import {
  installPackedArtifactIntoPiNpm,
  packageRoot,
  piCli,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";
import { runPublicCliSubprocess } from "../helpers/public-cli-subprocess.ts";
import { withPackageMachineHomeGuard } from "../helpers/package-machine-home-guard.ts";

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "coder-chain@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Coder Chain"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

type NavigatorAttendanceDetails = {
  disposition?: string;
  invocationId?: string;
  role?: string;
  routePlaybookReadFailure?: string;
  unavailableReason?: string;
  unavailableSource?: string;
  unavailableCause?: string;
};

async function readNavigatorAttendance(runDirectory: string): Promise<NavigatorAttendanceDetails> {
  const text = await readFile(join(runDirectory, "session", "session.jsonl"), "utf8");
  const entries = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    type?: string;
    customType?: string;
    data?: { invocationId?: string };
    details?: NavigatorAttendanceDetails;
    message?: { details?: NavigatorAttendanceDetails };
  });
  const attendance = entries.filter((entry) =>
    entry.type === "custom_message" && entry.customType === "ak-navigator-attendance"
  );
  assert.equal(attendance.length, 1, "each role run emits one typed Navigator attendance");
  const details = attendance[0]!.message?.details ?? attendance[0]!.details;
  assert.ok(details, "typed Navigator attendance carries details");
  assert.equal(details.role, "coder");
  assert.equal(typeof details.invocationId, "string");
  assert.equal(entries.some((entry) =>
    entry.type === "custom" &&
    entry.customType === "ak-navigator-invocation" &&
    entry.data?.invocationId === details.invocationId
  ), true, "attendance correlates with its run's invocation principal");
  return details;
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
) {
  return runPublicCliSubprocess(bin, args, {
    home: options.home,
    agentDir: options.agentDir,
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    timeoutMs: null,
  });
}

/**
 * Thin PI_BINARY wrapper: forwards real Pi argv, injects offline faux provider
 * extension, and runs the real Pi child without argv inspection logs.
 */
async function writeProviderForwardingPiShim(input: {
  home: string;
  realPi: string;
  providerPath: string;
}): Promise<string> {
  const shimDir = resolve(input.home, "pi-provider-forward");
  await mkdir(shimDir, { recursive: true });
  const shimPath = resolve(shimDir, "pi");
  await writeFile(
    shimPath,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
const providerPath = ${JSON.stringify(input.providerPath)};
const realPi = ${JSON.stringify(input.realPi)};
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
  "cold-installed ak-role coder: provider-stop then resume reaches accepted terminal",
  { timeout: 180_000 },
  async () => {
    await withHermeticHome(
      { prefix: "ak-public-cli-coder-chain-" },
      async ({ home }) => {
      await withPackageMachineHomeGuard(async (guard) => {
        const piAgentDir = resolve(home, ".pi", "agent");
        await mkdir(piAgentDir, { recursive: true });
        await writeFile(
          resolve(piAgentDir, "navigator-model.json"),
          JSON.stringify({ model: "openai-codex/faux-1" }) + "\n",
          "utf8",
        );
        await writeFile(
          resolve(piAgentDir, "auth.json"),
          JSON.stringify({ "openai-codex": { type: "api_key", key: "test" } }) + "\n",
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

        const bookDirName = `work-604-${Date.now().toString(36)}`;
        const project = resolve(home, bookDirName);
        await mkdir(project, { recursive: true });
        seedGitProject(project);
        const trackedBookKey = resolveBookKeyFromGit(project);
        guard.trackBook(trackedBookKey);

        const providerPath = resolve(
          packageRoot,
          "test/fixtures/coder-success-provider.ts",
        );
        const realPi = await import("node:fs/promises").then((fs) =>
          fs.realpath(piCli),
        );
        const shimPath = await writeProviderForwardingPiShim({
          home,
          realPi,
          providerPath,
        });

        // Set auto-resume limit to 0 so the first dispatch exits on typed provider stop
        const limitResult = await runAkRoleBin(
          installed.akRoleBin,
          ["config", "set-auto-resume-limit", "0"],
          {
            home,
            agentDir: piAgentDir,
            cwd: project,
          },
        );
        assert.equal(limitResult.code, 0);

        const instruction =
          "Implement the approved vertical slice with package TDD.";

        // Process 1: Real Pi child encounters typed provider stop (429)
        const firstResult = await runAkRoleBin(
          installed.akRoleBin,
          [
            "coder",
            "--model",
            "openai-codex/faux-1",
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
              AK_TEST_PROVIDER_STOP: "1",
            },
          },
        );

        assert.notEqual(
          firstResult.code,
          0,
          "first process must exit nonzero on typed provider stop",
        );

        const bookKey = resolveBookKeyFromGit(project);
        const runsRoot = join(guard.ledgerHome, "books", bookKey, "runs");
        const { readdir } = await import("node:fs/promises");
        const runDirs = await readdir(runsRoot);
        const coderRun = runDirs.find((name) => name.endsWith("@coder"));
        assert.ok(coderRun, `expected coder run under ${runsRoot}, got ${runDirs.join(",")}`);
        const runDirectory = join(runsRoot, coderRun!);

        const firstState = JSON.parse(
          await readFile(join(runDirectory, "run-state.json"), "utf8"),
        ) as {
          runId: string;
          state: string;
          sessionFile: string;
          sessionDirectory: string;
          resumable?: { httpStatus: number };
        };
        assert.equal(firstState.state, "resumable", "first process must settle as resumable");
        assert.equal(firstState.resumable?.httpStatus, 429, "resumable state must record HTTP 429");
        const runId = firstState.runId;
        const frozenSessionFile = firstState.sessionFile;

        // Mutate source material between processes to prove frozen snapshot is not reread (#526 §3.A.3)
        await writeFile(
          installedRoutebook,
          "MUTATED_BETWEEN_PROCESSES_DO_NOT_REREAD\n",
          "utf8",
        );

        // Process 2: ak-role resume <same runId> completes lawfully
        const secondResult = await runAkRoleBin(
          installed.akRoleBin,
          [
            "resume",
            runId,
          ],
          {
            home,
            agentDir: piAgentDir,
            cwd: project,
            env: {
              PI_BINARY: shimPath,
              PI_OFFLINE: "1",
              AK_TEST_PROVIDER_STOP: "0",
            },
          },
        );

        assert.equal(
          secondResult.code,
          0,
          `installed coder resume failed\nstdout:\n${secondResult.stdout}\nstderr:\n${secondResult.stderr}`,
        );

        // Verification: same runId, exact frozen principal/sessionFile, typed terminal/artifacts
        const secondState = JSON.parse(
          await readFile(join(runDirectory, "run-state.json"), "utf8"),
        ) as {
          runId: string;
          state: string;
          sessionFile: string;
          sessionDirectory: string;
        };
        assert.equal(secondState.runId, runId, "resume must keep exact same runId");
        assert.equal(secondState.state, "terminal", "resumed run must settle as terminal");
        assert.equal(
          secondState.sessionFile,
          frozenSessionFile,
          "exact frozen sessionFile",
        );

        const reportPath = join(runDirectory, "artifacts", "report.json");
        const evidencePath = join(runDirectory, "artifacts", "evidence.json");
        const report = JSON.parse(await readFile(reportPath, "utf8")) as {
          role: string;
          outcome?: { kind: string };
        };
        assert.equal(report.role, "coder");
        assert.equal(report.outcome?.kind, "accepted");

        const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
          methodProvenance?: {
            upstream: { commit: string; tag?: string; path: string };
            files: Record<string, { sha256: string; gitBlob: string }>;
          };
        };
        assert.ok(evidence.methodProvenance);
        assert.equal(
          evidence.methodProvenance!.upstream.commit,
          "8b36d4fb2635b3c21998dcd8144439c9e5ba7302",
        );
        assert.equal(
          evidence.methodProvenance!.upstream.tag,
          "v1.2.2",
        );
        assert.equal(
          evidence.methodProvenance!.upstream.path,
          "skills/engineering/tdd",
        );
        assert.equal(
          evidence.methodProvenance!.files["SKILL.md"]?.gitBlob,
          "d6b6bebaa1d1fed58812f8809b9ebc1ff9a5d1e4",
        );

        // Attendance remains valid
        const recommendationAttendance = await readNavigatorAttendance(runDirectory);
        assert.equal(recommendationAttendance.disposition, "recommendation");
        assert.equal(recommendationAttendance.routePlaybookReadFailure, undefined);

        // Session retained accepted Coder receipt without raw string-include checking
        const sessionFile = join(runDirectory, "session", "session.jsonl");
        const sessionLines = (await readFile(sessionFile, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as {
            type?: string;
            message?: {
              role?: string;
              toolName?: string;
              isError?: boolean;
              details?: { status?: string };
            };
          });

        const coderReceipt = [...sessionLines].reverse().find(
          (entry) =>
            entry.type === "message" &&
            entry.message?.role === "toolResult" &&
            entry.message.toolName === "ak_coder_output",
        );
        assert.ok(coderReceipt, "session must retain accepted Coder receipt");
        assert.equal(coderReceipt.message?.isError, false);
        const closureEntry = sessionLines.find(
          (entry) => (entry as any).type === "custom" && (entry as any).customType === "ak-role-submission-closure",
        );
        assert.ok(closureEntry, "session must retain accepted Coder closure");
        assert.equal((closureEntry as any).data?.details?.status, "completed");
        const sealed = await readSealedSubmission(project, runId, guard.packageHome);
        assert.ok(sealed, "sealed submission must be recorded");
        assert.equal(sealed.status, "completed");
      });
      },
    );
  },
);
