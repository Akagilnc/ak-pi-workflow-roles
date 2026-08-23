/**
 * #419 race regression: a symlink swapped into the audit evidence destination
 * between the publication lstat and open must be rejected atomically by
 * O_NOFOLLOW at the open seam itself — never followed, never written through.
 *
 * Lives in its own file because node:test runs one process per file: this file
 * deliberately does not import the production CLI statically, so the test can
 * register an ESM customization hook BEFORE dynamically importing it. The hook
 * redirects node:fs/promises to a wrapper shim whose lstat delegates to the
 * real syscall and — only for the audit evidence destination — deterministically
 * swaps the regular file it just observed for a symlink to the victim.
 * Production then reaches its open with a stale regular-file stat, so only
 * O_NOFOLLOW at that open seam can refuse the swap; the lstat fast-path branch
 * is provably bypassed (it saw a regular file). Zero production test hooks,
 * real IO end to end.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("#419 symlink swapped in between publication lstat and open is rejected atomically by O_NOFOLLOW", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-audit-race-419-"));
  try {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const victimPath = join(home, "victim-audit-incomplete-race.json");
    const victimSentinel = `${JSON.stringify({ sentinel: "race-target-must-stay-intact" })}\n`;
    await writeFile(victimPath, victimSentinel, "utf8");

    // The kernel observes the destination through the real lstat syscall; after
    // it returns we deterministically swap in the symlink. Production's open
    // is pure pass-through observation: the real open runs against the real
    // kernel and we only record whether IT refused the swapped-in symlink.
    const hooksSource = [
      "const SHIM_SOURCE = `",
      "export * from \"node:fs/promises\";",
      "import { lstat as origLstat, open as origOpen } from \"node:fs/promises\";",
      "const state = globalThis.__ak419RaceHookState ??= { publicationLstatSawRegularFile: false, swappedToSymlink: false, openRejectedSwappedSymlinkWithEloop: false };",
      "let swapped = false;",
      "export const lstat = Object.assign(async (...args) => {",
      "  const result = await origLstat(...args);",
      "  if (!swapped && typeof args[0] === \"string\" && args[0].endsWith(\"/artifacts/audit-incomplete.json\")) {",
      "    state.publicationLstatSawRegularFile = result.isFile();",
      "    const { unlink, symlink } = await import(\"node:fs/promises\");",
      "    await unlink(args[0]);",
      "    await symlink(process.env.AK_419_RACE_VICTIM, args[0]);",
      "    swapped = true;",
      "    state.swappedToSymlink = true;",
      "  }",
      "  return result;",
      "}, origLstat);",
      "export const open = Object.assign(async (...args) => {",
      "  if (swapped && typeof args[0] === \"string\" && args[0].endsWith(\"/artifacts/audit-incomplete.json\")) {",
      "    try {",
      "      return await origOpen(...args);",
      "    } catch (error) {",
      "      if ((error ?? {}).code === \"ELOOP\") state.openRejectedSwappedSymlinkWithEloop = true;",
      "      throw error;",
      "    }",
      "  }",
      "  return origOpen(...args);",
      "}, origOpen);`;",
      "export function resolve(specifier, context, nextResolve) {",
      "  if (specifier === \"node:fs/promises\" && !String(context.parentURL ?? \"\").startsWith(\"ak419-shim:\")) {",
      "    return { url: \"ak419-shim:///node_fs_promises\", shortCircuit: true };",
      "  }",
      "  return nextResolve(specifier, context);",
      "}",
      "export function load(url, context, nextLoad) {",
      "  if (url.startsWith(\"ak419-shim:\")) {",
      "    return { format: \"module\", source: SHIM_SOURCE, shortCircuit: true };",
      "  }",
      "  return nextLoad(url, context);",
      "}",
    ].join("\n");
    const hooksPath = join(home, "ak419-race-hooks.mjs");
    await writeFile(hooksPath, hooksSource, "utf8");

    // The shim reads the victim path from the environment at swap time.
    process.env.AK_419_RACE_VICTIM = victimPath;

    // Hooks must be installed before the production module graph resolves its
    // node:fs/promises bindings — hence dynamic import, never a static one.
    register(pathToFileURL(hooksPath));
    const { runAkRole } = await import(`${pathToFileURL(join(packageRoot, "src/public-cli/cli.ts")).href}`);

    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "audit evidence lstat-open race"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-audit-lstat-open-race-001",
        io,
        piRunner: async (args: string[]) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          const runDir = join(sessionDir, "..");
          await mkdir(join(runDir, "artifacts"), { recursive: true });
          // Plant the regular-file placeholder only while the destination is
          // absent; once the race hook has swapped in the symlink this stub
          // must never touch it again (a plain writeFile would follow the link).
          const dest = join(runDir, "artifacts", "audit-incomplete.json");
          let destExists = true;
          try {
            await lstat(dest);
          } catch (error) {
            // Only a genuinely absent destination means "plant placeholder";
            // any other lstat failure must keep its true identity (failure-
            // honesty constitution: unrecognized errors never borrow labels).
            if ((error as { code?: unknown }).code !== "ENOENT") throw error;
            destExists = false;
          }
          if (!destExists) await writeFile(dest, "placeholder\n", "utf8");
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), auditIncompleteSessionRows("role-1", ["retained"]), "utf8");
          return { code: 0, stdout: "", stderr: "", timedOut: false, args: [...args] };
        },
      },
    );

    // The swap provably landed inside the lstat→open window and the no-follow
    // open seam itself refused it:
    // 1. production's real lstat syscall observed the placeholder REGULAR file
    //    (the lstat fast-path branch is provably bypassed),
    // 2. the hook then swapped in the symlink to the victim,
    // 3. production's real open syscall — same path, O_NOFOLLOW — rejected the
    //    swapped symlink with ELOOP, so nothing was written through.
    assert.deepEqual(
      (globalThis as { __ak419RaceHookState?: unknown }).__ak419RaceHookState,
      {
      publicationLstatSawRegularFile: true,
      swappedToSymlink: true,
      openRejectedSwappedSymlinkWithEloop: true,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 1);
    assert.ok(result.terminal);
    const outcome = result.terminal!.roleOutcome;
    assert.equal(outcome.kind, "failure");
    if (outcome.kind !== "failure") throw new Error("expected publication failure");
    assert.equal(outcome.cause, "unrecognized");
    assert.equal(outcome.decisiveFacts.errorCode, "ELOOP");
    assert.equal(outcome.auditResidual?.acceptedReceipt, false);
    assert.deepEqual(outcome.auditResidual?.roleCandidate, { judgeStatus: "converged" });
    assert.equal(result.terminal!.artifacts.length, 0);
    // The race must never write through the link: target byte-identical.
    assert.equal(await readFile(victimPath, "utf8"), victimSentinel);

    delete (globalThis as { __ak419RaceHookState?: unknown }).__ak419RaceHookState;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
