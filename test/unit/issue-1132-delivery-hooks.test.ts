import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { dispatchPostAdmissionTurn } from "../../src/public-cli/post-admission.ts";
import type { PostAdmissionEnv } from "../../src/public-cli/post-admission.ts";

/**
 * #1132: a 没交卷催交 turn is a real host turn on the same run/session, but the
 * turn-BEFORE concerns belong to the OUTERMOST dispatch exactly once.
 *
 * This drives `dispatchPostAdmissionTurn` directly (the public entry cannot
 * observe adapter hook counts) with an external host, so a delivery turn is
 * actually taken, and asserts the admission hooks ran once for the whole run.
 */
test("#1132: 催交 turns re-run neither admission nor dispatch-finalization hooks", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-1132-hooks-"));
  // Workflow activation resolves the book key from git; seed a repository.
  execFileSync("git", ["init", "-b", "main"], { cwd: home });
  execFileSync("git", ["config", "user.email", "1132@test.local"], { cwd: home });
  execFileSync("git", ["config", "user.name", "1132"], { cwd: home });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: home });
  // Ledger topology: the run must sit under <home>/.ak-roles/books/... or the
  // settlement seam cannot resolve its home (homeFromRunDirectory, no fallback).
  const runDirectory = join(home, ".ak-roles", "books", "ak-test", "unbound", "runs", "1132-hooks-001@judge");
  const coordinates = piDurablePrincipalAuthority.issue({
    cwd: home,
    runId: "1132-hooks-001",
    role: "judge",
    home,
  });
  await mkdir(join(runDirectory, "session"), { recursive: true });
  await writeFile(join(runDirectory, "run-state.json"), JSON.stringify({
    runId: "1132-hooks-001",
    role: "judge",
    bookKey: "ak-test",
    projectRoot: home,
    sessionDirectory: join(runDirectory, "session"),
    sessionFile: join(runDirectory, "session", "session.jsonl"),
    runDirectory,
    admittedRequestPath: join(runDirectory, "admitted-request.json"),
    state: "admitted",
  }), "utf8");
  // markRunRunning records the effective invocation model beside the run.
  await writeFile(join(runDirectory, "invocation.json"), JSON.stringify({
    version: 1,
    role: "judge",
    runId: "1132-hooks-001",
    bookKey: "ak-test",
    argv: ["judge", "go"],
    cwd: home,
  }), "utf8");

  let turns = 0;
  const env = {
    home,
    agentDir: join(home, ".pi"),
    packageRoot: home,
    cwd: home,
    principalAuthority: piDurablePrincipalAuthority,
    sessionAppender: async () => {},
    // An external host: pi delivers to itself in-process (ADR 0082), so the AK
    // execution seam owns催交 only for these.
    host: "grok-build",
    roleTurnHost: {
      async executeTurn(request: { principal: unknown }) {
        turns += 1;
        const { sessionDirectory, sessionFile } = piDurablePrincipalAuthority.decode(
          request.principal as never,
        );
        await mkdir(sessionDirectory, { recursive: true });
        await writeFile(
          sessionFile,
          `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`,
          "utf8",
        );
        return { code: 0, stderr: "", timedOut: false };
      },
    },
    autoResumeLimit: 2,
  } as unknown as PostAdmissionEnv;

  let beforeDispatchCalls = 0;
  let afterDispatchCalls = 0;
  const admitted = {
    principal: coordinates,
    runDirectory,
    runId: "1132-hooks-001",
    role: "judge",
    projectRoot: home,
  } as never;

  const result = await dispatchPostAdmissionTurn({
    admitted,
    env,
    io: { stdout() {}, stderr() {} },
    request: {
      principal: coordinates,
      activation: { role: "judge" },
      methods: [],
      continuation: { kind: "initial", prompt: "go" },
      cwd: home,
      home,
      agentDir: join(home, ".pi"),
      runDirectory,
    } as never,
    adapters: {
      trySettle: async () => undefined,
      beforeDispatch: async () => {
        beforeDispatchCalls += 1;
      },
      afterDispatch: async () => {
        afterDispatchCalls += 1;
      },
    } as never,
  });

  // First turn plus two催交 turns (configured limit 2).
  assert.equal(turns, 3, "first turn plus two催交 turns");
  // The turn-BEFORE / turn-AFTER hooks run ONCE for the whole run, not per turn.
  assert.equal(beforeDispatchCalls, 1, "beforeDispatch must run once per run, not per催交 turn");
  assert.equal(afterDispatchCalls, 1, "afterDispatch must run once per run, not per催交 turn");
  // Exhausted budget with no receipt is a lawful no_receipt counting real sends.
  assert.equal(result.terminal?.roleOutcome.kind, "no_receipt");
  if (result.terminal?.roleOutcome.kind === "no_receipt") {
    assert.equal(result.terminal.roleOutcome.deliveryTurns, 2);
  }
  // And the run ends terminal only once, at the outermost settle.
  const runState = JSON.parse(await readFile(join(runDirectory, "run-state.json"), "utf8")) as { state: string };
  assert.equal(runState.state, "terminal");
});
