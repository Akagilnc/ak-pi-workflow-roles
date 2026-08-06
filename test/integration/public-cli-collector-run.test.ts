/**
 * #112 public Collector production seam:
 * ak-role collector → real Pi + shared role-runtime envelope → Collector observe
 * under a controlled GitHub fixture → typed Terminal + actual #78 waiting index.
 * Model provider and `gh` are fixtures; activation/settlement/index are production.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { INTERNAL_ROLE_ENTRYPOINT_RELATIVE } from "../../src/public-cli/registry.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  packageRoot,
  piCli,
  runPiSubprocess,
} from "../helpers/pi-test-harness.ts";

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "collector-e2e@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Collector E2E"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://github.com/acme/widgets.git"],
    { cwd: root },
  );
}

type GhMode = "pr-404" | "open-pr-empty";

/**
 * Controlled gh fixture.
 * - pr-404: authenticate, then 404 the configured PR (domain counterexample 1).
 * - open-pr-empty: OPEN PR with no reviews/comments (domain counterexample 2).
 */
async function writeFakeGh(binDir: string, mode: GhMode): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const ghPath = join(binDir, "gh");
  const openPrBody = JSON.stringify({
    number: 42,
    state: "open",
    head: { sha: "b".repeat(40) },
    updated_at: "2026-01-01T00:00:00Z",
    html_url: "https://github.com/acme/widgets/pull/42",
  });
  const script = [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "const joined = args.join(' ');",
    "const pathArg = args.filter((a) => !a.startsWith('-') && a !== 'api').at(-1) ?? '';",
    "const mode = process.env.AK_COLLECTOR_GH_MODE || 'pr-404';",
    "function respond(status, body) {",
    "  process.stdout.write('HTTP/1.1 ' + status + '\\r\\n');",
    "  process.stdout.write('content-type: application/json\\r\\n');",
    "  process.stdout.write('\\r\\n');",
    "  process.stdout.write(typeof body === 'string' ? body : JSON.stringify(body));",
    "  process.exit(0);",
    "}",
    "if (pathArg === '/user' || pathArg.endsWith('/user')) {",
    "  respond(200, { login: 'collector-fixture-user' });",
    "}",
    "if (/\\/pulls\\/\\d+/.test(pathArg) && !pathArg.includes('/comments') && !pathArg.includes('/reviews')) {",
    "  if (mode === 'open-pr-empty') {",
    `    respond(200, ${JSON.stringify(openPrBody)});`,
    "  }",
    "  respond(404, { message: 'Not Found' });",
    "}",
    "if (pathArg.includes('/reviews') || pathArg.includes('/comments') || /\\/issues\\/\\d+/.test(pathArg)) {",
    "  respond(200, []);",
    "}",
    "process.stderr.write('unexpected gh invocation: ' + joined + '\\n');",
    "process.exit(2);",
    "",
  ].join("\n");
  await writeFile(ghPath, script, "utf8");
  await chmod(ghPath, 0o755);
  void mode;
}

function productionRoleRuntimePath(): string {
  return resolve(packageRoot, INTERNAL_ROLE_ENTRYPOINT_RELATIVE);
}

async function runPublicCollectorTracer(input: {
  home: string;
  project: string;
  pr: string;
  leg: string;
  runId: string;
  correlationId: string;
  instructionNote: string;
  ghMode: GhMode;
  providerPath: string;
  /** When set, replace the production role-runtime -e load with this fixture. */
  runtimePath?: string;
}): Promise<{
  exitCode: number;
  terminal: NonNullable<Awaited<ReturnType<typeof runAkRole>>["terminal"]> | undefined;
  stdout: string[];
  stderr: string[];
}> {
  const agentDir = join(input.home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  const ghBinDir = join(input.home, "fake-bin");
  await writeFakeGh(ghBinDir, input.ghMode);

  const stdout: string[] = [];
  const stderr: string[] = [];
  const productionRuntime = productionRoleRuntimePath();

  const result = await runAkRole(
    [
      "collector",
      "--model",
      input.ghMode === "open-pr-empty"
        ? "ak-collector-missing-offline/faux-1"
        : "ak-collector-offline/faux-1",
      "--thinking",
      "off",
      "--pr",
      input.pr,
      "--leg",
      input.leg,
      "--project",
      input.project,
      input.instructionNote,
    ],
    {
      packageRoot,
      home: input.home,
      agentDir,
      cwd: input.project,
      correlationId: input.correlationId,
      createRunId: () => input.runId,
      collectorExtraPiArgs: ["-e", input.providerPath],
      collectorTimeoutMs: 90_000,
      credentials: { "openai-codex": true, xai: false },
      io: {
        stdout: (text) => {
          stdout.push(text);
        },
        stderr: (text) => {
          stderr.push(text);
        },
      },
      piRunner: async (args, options) => {
        const rewritten = args.flatMap((arg) => {
          if (
            input.runtimePath !== undefined &&
            (arg === productionRuntime || arg.endsWith(`/${INTERNAL_ROLE_ENTRYPOINT_RELATIVE}`) || arg.endsWith(`\\${INTERNAL_ROLE_ENTRYPOINT_RELATIVE}`))
          ) {
            return [input.runtimePath];
          }
          return [arg];
        });
        const pathWithFakeGh = `${ghBinDir}:${dirname(piCli)}:${options.env.PATH ?? process.env.PATH ?? ""}`;
        const subprocess = await runPiSubprocess([...rewritten], {
          cwd: options.cwd,
          env: {
            ...options.env,
            PATH: pathWithFakeGh,
            PI_OFFLINE: "1",
            PI_BINARY: piCli,
            AK_COLLECTOR_GH_MODE: input.ghMode,
          },
          timeoutMs: options.timeoutMs ?? 90_000,
        });
        return {
          code: subprocess.code,
          stdout: subprocess.stdout,
          stderr: subprocess.stderr,
          timedOut: subprocess.timedOut,
          args: [...rewritten],
        };
      },
    },
  );

  return {
    exitCode: result.exitCode,
    terminal: result.terminal,
    stdout,
    stderr,
  };
}

async function assertWaitingIndexZeroContent(input: {
  home: string;
  project: string;
  correlationId: string;
  instructionNote: string;
  authorToken: string;
}): Promise<void> {
  const bookKey = resolveBookKeyFromGit(input.project);
  const indexPath = join(input.home, ".ak-roles", "books", bookKey, "waiting.jsonl");
  const indexText = await readFile(indexPath, "utf8");
  assert.match(indexText, /"event":"accepted-activation"/);
  assert.match(indexText, /"role":"collector"/);
  assert.match(indexText, new RegExp(`"id":"${input.correlationId}"`));
  assert.match(indexText, /"kind":"session-file"/);

  // ADR 0049 zero-content: no instruction, manifest, receipt, or evidence body.
  assert.equal(indexText.includes(input.instructionNote), false);
  assert.equal(indexText.includes(input.authorToken), false);
  assert.equal(indexText.includes("ak_collector_output"), false);
  assert.equal(indexText.includes("evidenceRecords"), false);
  assert.equal(indexText.includes("Start collection for the validated"), false);
}

test(
  "public collector PR 404 locks typed activation failure with HTTP 404 identity",
  { timeout: 120_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-public-cli-collector-404-"));
    try {
      const project = join(home, "work");
      await mkdir(project, { recursive: true });
      seedGitProject(project);

      const providerPath = resolve(
        packageRoot,
        "test/fixtures/collector-observe-provider.ts",
      );
      const correlationId = "corr-112-collector-404";
      const runId = "run-e2e-collector-404";
      const instructionNote = "PUBLIC-COLLECTOR-404-MUST-NOT-ENTER-INDEX";
      const authorToken = "definitely-not-a-real-bot";

      const { exitCode, terminal, stderr } = await runPublicCollectorTracer({
        home,
        project,
        pr: "999999",
        leg: `codex:${authorToken}`,
        runId,
        correlationId,
        instructionNote,
        ghMode: "pr-404",
        providerPath,
      });

      // Well-formed nonexistent PR is not a structural CLI reject.
      assert.notEqual(
        exitCode,
        2,
        stderr.join("") || "collector must not preflight-reject",
      );
      assert.ok(terminal, stderr.join("") || "missing terminal");
      assert.equal(terminal.roleOutcome.role, "collector");
      assert.equal(terminal.roleOutcome.kind, "failure");
      if (terminal.roleOutcome.kind !== "failure") {
        assert.fail("expected failure outcome");
      }
      // Lock the real typed cause — not "any of six causes".
      assert.equal(
        terminal.roleOutcome.cause,
        "activation",
        terminal.roleOutcome.diagnostic,
      );
      assert.match(terminal.roleOutcome.diagnostic, /HTTP 404/);
      assert.match(terminal.roleOutcome.diagnostic, /pulls\/999999/);
      assert.equal(
        /usage:|not available in this install slice|No more faux responses/i.test(
          terminal.roleOutcome.diagnostic,
        ),
        false,
      );

      await assertWaitingIndexZeroContent({
        home,
        project,
        correlationId,
        instructionNote,
        authorToken,
      });

      const bookKey = resolveBookKeyFromGit(project);
      const runDir = join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        `${runId}@collector`,
      );
      const legs = JSON.parse(
        await readFile(join(runDir, "legs.json"), "utf8"),
      ) as { legs: Array<{ id: string; expectedAuthors: string[] }> };
      assert.equal(legs.legs[0]?.id, "codex");
      assert.deepEqual(legs.legs[0]?.expectedAuthors, [authorToken]);
      assert.equal(piCli.endsWith("/pi"), true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "public collector OPEN PR + nonexistent author reaches missing leg Terminal fact",
  { timeout: 120_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-public-cli-collector-missing-"));
    try {
      const project = join(home, "work");
      await mkdir(project, { recursive: true });
      seedGitProject(project);

      const providerPath = resolve(
        packageRoot,
        "test/fixtures/collector-missing-provider.ts",
      );
      const runtimePath = resolve(
        packageRoot,
        "test/fixtures/collector-missing-runtime.ts",
      );
      const correlationId = "corr-112-collector-missing";
      const runId = "run-e2e-collector-missing";
      const instructionNote = "PUBLIC-COLLECTOR-MISSING-MUST-NOT-ENTER-INDEX";
      const authorToken = "definitely-not-a-real-bot";

      const { exitCode, terminal, stderr } = await runPublicCollectorTracer({
        home,
        project,
        pr: "42",
        leg: `codex:${authorToken}`,
        runId,
        correlationId,
        instructionNote,
        ghMode: "open-pr-empty",
        providerPath,
        runtimePath,
      });

      assert.notEqual(
        exitCode,
        2,
        stderr.join("") || "collector must not preflight-reject",
      );
      assert.ok(terminal, stderr.join("") || "missing terminal");
      assert.equal(terminal.roleOutcome.role, "collector");
      assert.equal(terminal.roleOutcome.kind, "accepted");
      assert.equal(terminal.roleOutcome.status, "collected");
      assert.equal(
        terminal.roleOutcome.decisiveFacts.legStatuses,
        "codex:missing",
        JSON.stringify(terminal.roleOutcome.decisiveFacts),
      );
      assert.equal(terminal.roleOutcome.decisiveFacts.prNumber, 42);
      assert.equal(
        terminal.roleOutcome.decisiveFacts.repository,
        "acme/widgets",
      );

      await assertWaitingIndexZeroContent({
        home,
        project,
        correlationId,
        instructionNote,
        authorToken,
      });

      // Success artifact carries the receipt; waiting index stays zero-content.
      const bookKey = resolveBookKeyFromGit(project);
      const reportPath = join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        `${runId}@collector`,
        "artifacts",
        "report.json",
      );
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        receipt?: { legs?: Array<{ status: string; legId: string }> };
      };
      assert.equal(report.receipt?.legs?.[0]?.legId, "codex");
      assert.equal(report.receipt?.legs?.[0]?.status, "missing");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
