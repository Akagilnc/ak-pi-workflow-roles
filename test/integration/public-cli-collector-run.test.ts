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

/**
 * Controlled gh fixture: authenticate, then 404 the configured nonexistent PR.
 * Real Collector transport calls `gh api`; no Collector-local transport fork.
 */
async function writeFakeGh(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const ghPath = join(binDir, "gh");
  const script = [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "const joined = args.join(' ');",
    "const pathArg = args.filter((a) => !a.startsWith('-') && a !== 'api').at(-1) ?? '';",
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
    "  respond(404, { message: 'Not Found' });",
    "}",
    "if (pathArg.includes('/reviews') || pathArg.includes('/comments')) {",
    "  respond(200, []);",
    "}",
    "process.stderr.write('unexpected gh invocation: ' + joined + '\\n');",
    "process.exit(2);",
    "",
  ].join("\n");
  await writeFile(ghPath, script, "utf8");
  await chmod(ghPath, 0o755);
}

test(
  "public collector admits nonexistent PR/author, activates shared envelope, and keeps #78 zero-content",
  { timeout: 120_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-public-cli-collector-e2e-"));
    try {
      const project = join(home, "work");
      await mkdir(project, { recursive: true });
      seedGitProject(project);

      const agentDir = join(home, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });

      const ghBinDir = join(home, "fake-bin");
      await writeFakeGh(ghBinDir);

      const providerPath = resolve(
        packageRoot,
        "test/fixtures/collector-observe-provider.ts",
      );
      const correlationId = "corr-112-collector-e2e";
      const runId = "run-e2e-collector-001";
      const instructionNote = "PUBLIC-COLLECTOR-CONTENT-MUST-NOT-ENTER-INDEX";

      const stdout: string[] = [];
      const stderr: string[] = [];

      const result = await runAkRole(
        [
          "collector",
          "--model",
          "ak-collector-offline/faux-1",
          "--thinking",
          "off",
          "--pr",
          "999999",
          "--leg",
          "codex:definitely-not-a-real-bot",
          "--project",
          project,
          instructionNote,
        ],
        {
          packageRoot,
          home,
          agentDir,
          cwd: project,
          correlationId,
          createRunId: () => runId,
          collectorExtraPiArgs: ["-e", providerPath],
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
            const pathWithFakeGh = `${ghBinDir}:${dirname(piCli)}:${options.env.PATH ?? process.env.PATH ?? ""}`;
            const subprocess = await runPiSubprocess([...args], {
              cwd: options.cwd,
              env: {
                ...options.env,
                PATH: pathWithFakeGh,
                PI_OFFLINE: "1",
                PI_BINARY: piCli,
              },
              timeoutMs: options.timeoutMs ?? 90_000,
            });
            return {
              code: subprocess.code,
              stdout: subprocess.stdout,
              stderr: subprocess.stderr,
              timedOut: subprocess.timedOut,
              args: [...args],
            };
          },
        },
      );

      // AC3: well-formed nonexistent PR/author is not a structural CLI reject.
      assert.notEqual(
        result.exitCode,
        2,
        stderr.join("") || "collector must not preflight-reject",
      );
      // Real Collector activation produced a typed Terminal (failure from observe 404).
      assert.ok(result.terminal, stderr.join("") || "missing terminal");
      assert.equal(result.terminal.roleOutcome.role, "collector");
      assert.equal(result.terminal.roleOutcome.kind, "failure");
      if (result.terminal.roleOutcome.kind === "failure") {
        assert.ok(
          result.terminal.roleOutcome.cause === "activation" ||
            result.terminal.roleOutcome.cause === "output" ||
            result.terminal.roleOutcome.cause === "provider" ||
            result.terminal.roleOutcome.cause === "session" ||
            result.terminal.roleOutcome.cause === "unrecognized" ||
            result.terminal.roleOutcome.cause === "timeout",
          `unexpected cause ${result.terminal.roleOutcome.cause}: ${result.terminal.roleOutcome.diagnostic}`,
        );
        // Diagnostic retains transport/observe identity rather than CLI usage prose.
        assert.equal(
          /usage:|not available in this install slice/i.test(
            result.terminal.roleOutcome.diagnostic,
          ),
          false,
        );
      }

      const bookKey = resolveBookKeyFromGit(project);
      const runDir = join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        `${runId}@collector`,
      );

      // AC5: accepted-activation + caller correlation on the real waiting index.
      const indexPath = join(home, ".ak-roles", "books", bookKey, "waiting.jsonl");
      const indexText = await readFile(indexPath, "utf8");
      assert.match(indexText, /"event":"accepted-activation"/);
      assert.match(indexText, /"role":"collector"/);
      assert.match(indexText, new RegExp(`"id":"${correlationId}"`));
      assert.match(indexText, /"kind":"session-file"/);

      // ADR 0049 zero-content: no instruction, manifest, receipt, or evidence body.
      assert.equal(indexText.includes(instructionNote), false);
      assert.equal(indexText.includes("definitely-not-a-real-bot"), false);
      assert.equal(indexText.includes("ak_collector_output"), false);
      assert.equal(indexText.includes("evidenceRecords"), false);
      assert.equal(indexText.includes("Start collection for the validated"), false);

      // Legs retained under the run dir (content outside the index).
      const legs = JSON.parse(
        await readFile(join(runDir, "legs.json"), "utf8"),
      ) as { legs: Array<{ id: string; expectedAuthors: string[] }> };
      assert.equal(legs.legs[0]?.id, "codex");
      assert.deepEqual(legs.legs[0]?.expectedAuthors, [
        "definitely-not-a-real-bot",
      ]);

      assert.equal(piCli.endsWith("/pi"), true);
      void stdout;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
