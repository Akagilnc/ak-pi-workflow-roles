/**
 * #418 mechanical regression: when the platform lacks O_NOFOLLOW/O_NONBLOCK
 * (Windows — nodejs/node#41590), the audit-evidence publication open seam must
 * refuse fail-closed BEFORE any lstat/open of the destination, never silently
 * drop the flag via JS bitwise-or. The refusal flows through the existing
 * publication-failure / auditResidual channel with its true identity, the
 * complete attempt result stays in appended history (史必追加), and no evidence
 * file is ever created unprotected.
 *
 * Own file because the ESM customization hook that strips the constants is
 * process-global (node:test runs one process per file), and the hook must be
 * registered BEFORE the production module graph resolves its node:fs bindings
 * — hence dynamic import, never a static one. Same tracer-bullet pattern as
 * the #419 race seam test; no production test hooks.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";
import test from "node:test";

import { JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "race@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Race Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

/** Same retained-residual fixture shape as the settlement suite's audit rows. */
function auditIncompleteSessionRows(callId: string, candidate: unknown): string {
  return [
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: JUDGE_OUTPUT_TOOL_NAME, arguments: { judgeStatus: "converged" } }],
      },
    }),
    JSON.stringify({
      type: "custom",
      customType: "ak_compliance_response",
      data: { response: { content: [{ type: "toolCall", name: JUDGE_AUDIT_TOOL_NAME, arguments: candidate }] } },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        isError: false,
        details: { status: "audit-incomplete", observation: { kind: "non-object-arguments", type: "array" }, candidate: ["ignored"] },
      },
    }),
  ].join("\n") + "\n";
}

test("#418 publication refuses fail-closed when O_NOFOLLOW/O_NONBLOCK are unavailable", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-audit-nofollow-418-"));
  try {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Shim node:fs so production sees a platform without O_NOFOLLOW/O_NONBLOCK
    // (exactly the Windows shape): the constants object simply lacks both keys.
    const hooksSource = [
      "const SHIM_SOURCE = `",
      "export * from \"node:fs\";",
      "import * as origFs from \"node:fs\";",
      "const strippedConstants = { ...origFs.constants };",
      "delete strippedConstants.O_NOFOLLOW;",
      "delete strippedConstants.O_NONBLOCK;",
      "export const constants = Object.freeze(strippedConstants);`;",
      "export function resolve(specifier, context, nextResolve) {",
      "  if (specifier === \"node:fs\" && !String(context.parentURL ?? \"\").startsWith(\"ak418-nofollow-shim:\")) {",
      "    return { url: \"ak418-nofollow-shim:///node_fs\", shortCircuit: true };",
      "  }",
      "  return nextResolve(specifier, context);",
      "}",
      "export function load(url, context, nextLoad) {",
      "  if (url.startsWith(\"ak418-nofollow-shim:\")) {",
      "    return { format: \"module\", source: SHIM_SOURCE, shortCircuit: true };",
      "  }",
      "  return nextLoad(url, context);",
      "}",
    ].join("\n");
    const hooksPath = join(home, "ak418-nofollow-hooks.mjs");
    await writeFile(hooksPath, hooksSource, "utf8");

    register(pathToFileURL(hooksPath));
    const { runAkRole } = await import(`${pathToFileURL(join(packageRoot, "src/public-cli/cli.ts")).href}`);

    let runDirectory: string | undefined;
    let sessionFile: string | undefined;
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "audit evidence nofollow missing"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-audit-nofollow-missing-001",
        io,
        piRunner: async (args: string[]) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          runDirectory = join(sessionDir, "..");
          sessionFile = join(sessionDir, "session.jsonl");
          await mkdir(sessionDir, { recursive: true });
          await writeFile(sessionFile, auditIncompleteSessionRows("role-1", ["retained"]), "utf8");
          return { code: 0, stdout: "", stderr: "", timedOut: false, args: [...args] };
        },
      },
    );

    assert.ok(runDirectory);
    assert.equal(result.exitCode, 1);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 1);
    assert.ok(result.terminal);
    const outcome = result.terminal!.roleOutcome;
    assert.equal(outcome.kind, "failure");
    if (outcome.kind !== "failure") throw new Error("expected publication failure");
    assert.equal(outcome.cause, "unrecognized");
    // True identity of the typed refusal — not a borrowed errno label.
    assert.equal(outcome.decisiveFacts.errorName, "ArtifactPublicationError");
    assert.equal(outcome.decisiveFacts.errorCode, "ENOSYS");
    const diagnostic = String(outcome.diagnostic);
    assert.ok(diagnostic.includes("O_NOFOLLOW"), diagnostic);
    assert.ok(diagnostic.includes("publication failed"), diagnostic);
    // Residual preserved through the existing auditResidual channel.
    assert.equal(outcome.auditResidual?.acceptedReceipt, false);
    assert.deepEqual(outcome.auditResidual?.roleCandidate, { judgeStatus: "converged" });
    assert.deepEqual(outcome.auditResidual?.audit.candidate, ["retained"]);
    // Fail-closed: the destination was never created, so nothing was written
    // without the anti-symlink/anti-planted protection.
    const evidencePath = join(runDirectory, "artifacts", "audit-incomplete.json");
    await assert.rejects(
      () => stat(evidencePath),
      (error: unknown) => (error as { code?: unknown }).code === "ENOENT",
    );
    // 史必追加: the complete attempt result is in appended history before refusal.
    const session = await readFile(sessionFile!, "utf8");
    assert.ok(
      session.includes("ak_run_attempt_history"),
      "attempt history must be appended before the fail-closed refusal",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
