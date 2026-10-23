/**
 * #1253: same-ticket auto-resume mints once after a typed session-id-missing
 * failure. Entry is runAkRole through the production host layer (no
 * roleTurnHost inject). Fake binaries live under the temp home; config
 * set-host switches the seat. Precedent: public-cli-host-axis.test.ts.
 *
 * The locked host layer (resume-missing-host-session-id.test.ts) returns
 * session-id-missing without delivering resume to the agent when this host
 * has no bound id. The seam does not pre-check that id; it calls resume,
 * reads the returned terminal, and mints. Host-B's first binary request is
 * therefore the new run's initial, not a resume argv.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { test } from "vitest";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { activationBookDirectory, resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { acquireRunWriterLease } from "../../src/public-cli/run-lifecycle.ts";
import { readRunTerminal } from "../../src/run-terminal-artifacts.ts";
import { isUnboundRunDirectory, listBookRunDirectories, parseRunLeaf } from "../../src/role-run-placement.ts";
import { updateSectionSync } from "../../src/run-dossier.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { packageRoot, withHermeticHome } from "../helpers/environment-fixtures.ts";
import { seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";
import {
  readHistoryRows,
  readRunLogRows,
  readStateRows,
  readCurrentSection,
} from "../helpers/run-dossier-fixture.ts";
import { payloadFacts, payloadStatusSequence } from "../helpers/terminal-payload.ts";

const credentials = { "openai-codex": true, xai: true } as const;
const silentIo = { stdout() {}, stderr() {} };
const MODEL = "openai-codex/gpt-5.6-sol:high";
const TICKET = 1253;

type Step = {
  readonly binary: "claude" | "codex";
  readonly receipt?: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
  readonly threadId?: string;
  readonly exitCode?: number;
  readonly stderr?: string;
};

type HostRequest = {
  readonly binary?: string;
  readonly kind?: string;
  readonly method?: string;
};

function fakeHostSource(logPath: string, controlPath: string, binary: string): string {
  return `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const logPath = ${JSON.stringify(logPath)};
const controlPath = ${JSON.stringify(controlPath)};
const binary = ${JSON.stringify(binary)};
const args = process.argv.slice(2);
function log(record) {
  appendFileSync(logPath, JSON.stringify(record) + "\\n");
}
function readControl() {
  return JSON.parse(readFileSync(controlPath, "utf8"));
}
function requestKind() {
  if (binary === "claude") return args.includes("--resume") ? "resume" : "initial";
  if (binary === "codex") return args.includes("resume") ? "resume" : "initial";
  return "acp";
}
if (binary === "hermes") {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg.method !== "string" || typeof msg.id !== "number") return;
    log({ binary, kind: requestKind(), method: msg.method, argv: args });
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
      return;
    }
    if (msg.method === "session/new" || msg.method === "session/load") {
      const omit = readControl().hermesOmitSessionId === true;
      const result = omit ? {} : { sessionId: "hermes-sess" };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
  });
  rl.on("close", () => process.exit(0));
} else {
  for await (const chunk of process.stdin) void chunk;
  const control = readControl();
  const steps = Array.isArray(control.steps) ? control.steps : [];
  const step = control.sticky === true
    ? steps.find((item) => item.binary === binary)
    : steps.shift();
  if (control.sticky !== true) {
    control.steps = steps;
    writeFileSync(controlPath, JSON.stringify(control));
  }
  log({ binary, kind: requestKind(), argv: args, stepBinary: step && step.binary });
  if (step === undefined || step.binary !== binary) {
    process.stderr.write("fake host step mismatch\\n");
    process.exit(97);
  }
  if (typeof step.exitCode === "number" && step.exitCode !== 0) {
    process.stderr.write(typeof step.stderr === "string" ? step.stderr : "host refused\\n");
    process.exit(step.exitCode);
  }
  const receipt = step.receipt ?? { status: "converged" };
  if (binary === "codex") {
    const threadId = step.threadId ?? "thread-b";
    for (const event of [
      { type: "thread.started", thread_id: threadId },
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(receipt) } },
      { type: "turn.completed" },
    ]) process.stdout.write(JSON.stringify(event) + "\\n");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: step.sessionId ?? "sess-a",
    structured_output: receipt,
  }) + "\\n");
  process.exit(0);
}
`;
}

async function installFakeHosts(home: string, logPath: string, controlPath: string): Promise<void> {
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  for (const name of ["claude", "codex", "hermes"] as const) {
    const path = join(bin, name);
    await writeFile(path, fakeHostSource(logPath, controlPath, name));
    await chmod(path, 0o755);
  }
}

async function setControl(
  controlPath: string,
  steps: readonly Step[],
  extra: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  await writeFile(controlPath, JSON.stringify({ steps, ...extra }));
}

async function readHostLog(logPath: string): Promise<HostRequest[]> {
  try {
    const text = await readFile(logPath, "utf8");
    if (text.trim() === "") return [];
    return text.trim().split("\n").map((line) => JSON.parse(line) as HostRequest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function callEnv(home: string, project: string, captured = captureIo()) {
  return {
    packageRoot,
    home,
    cwd: project,
    credentials,
    io: captured.io,
    captured,
  };
}

async function configureSeat(home: string, role: string, host: string): Promise<void> {
  const env = { packageRoot, home, credentials, io: silentIo };
  const model = await runAkRole(["config", "set", role, MODEL], env);
  assert.equal(model.exitCode, 0, role);
  const hostSet = await runAkRole(["config", "set-host", role, host], env);
  assert.equal(hostSet.exitCode, 0, `${role} ${host}`);
}

async function roleRuns(home: string, project: string, role: string): Promise<string[]> {
  const book = activationBookDirectory(resolveActivationLedgerHome(home), resolveBookKeyFromGit(project));
  const dirs = await listBookRunDirectories(book);
  return dirs.filter((dir) => parseRunLeaf(basename(dir))?.role === role);
}

function added(before: readonly string[], after: readonly string[]): string[] {
  const known = new Set(before);
  return after.filter((dir) => !known.has(dir));
}

function runIdOf(runDirectory: string): string {
  const parsed = parseRunLeaf(basename(runDirectory));
  assert.ok(parsed, runDirectory);
  return parsed.runId;
}

function durableErrorCode(runDirectory: string): unknown {
  const terminal = readRunTerminal(runDirectory);
  if (terminal.status !== "present" || terminal.face !== "error") return undefined;
  const identity = terminal.body.identity;
  if (typeof identity !== "object" || identity === null) return undefined;
  return (identity as { code?: unknown }).code;
}

function kindSet(rows: readonly Record<string, unknown>[]): string[] {
  return [...new Set(rows.map((row) => row.kind).filter((kind): kind is string => typeof kind === "string"))].sort();
}

function dossierKinds(runDirectory: string) {
  return {
    history: kindSet(readHistoryRows(runDirectory)),
    state: kindSet(readStateRows(runDirectory)),
    log: kindSet(readRunLogRows(runDirectory)),
  };
}

function admittedFacts(runDirectory: string) {
  const admitted = readCurrentSection(runDirectory, "admitted");
  return {
    sourceRunPath: admitted.sourceRunPath,
    ticketNumber: admitted.ticketNumber,
    instruction: admitted.instruction,
  };
}

function explain(captured: ReturnType<typeof captureIo>, log: readonly HostRequest[]): string {
  return `${captured.stdout.join("")}\n${captured.stderr.join("")}\n${JSON.stringify(log)}`;
}

async function withSeatHome(
  body: (home: string, project: string, source: string, logPath: string, controlPath: string) => Promise<void>,
): Promise<void> {
  await withHermeticHome({ prefix: "ak-1253-session-missing-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const source = await seedCanonicalSourceRun(home, project, { ticketNumber: TICKET });
    const logPath = join(home, "host-requests.jsonl");
    const controlPath = join(home, "host-control.json");
    await installFakeHosts(home, logPath, controlPath);
    await writeFile(logPath, "");
    await setControl(controlPath, []);
    await body(home, project, source, logPath, controlPath);
  });
}

test("#1253 direct summons mints once after session-id-missing and matches ak-role new", async () => {
  await withSeatHome(async (home, project, source, logPath, controlPath) => {
    await configureSeat(home, "notary", "claude");
    await setControl(controlPath, [{ binary: "claude", receipt: { status: "converged" }, sessionId: "sess-a" }]);
    const first = captureIo();
    const born = await runAkRole(
      ["notary", "--source-run", source],
      callEnv(home, project, first),
    );
    assert.equal(born.exitCode, 0, explain(first, await readHostLog(logPath)));
    const oldRuns = await roleRuns(home, project, "notary");
    assert.equal(oldRuns.length, 1);
    const oldRun = oldRuns[0]!;
    assert.equal((await readHostLog(logPath))[0]?.kind, "initial");

    await writeFile(logPath, "");
    await configureSeat(home, "notary", "codex");
    await setControl(controlPath, [{ binary: "codex", receipt: { status: "converged" }, threadId: "thread-b" }]);
    const again = captureIo();
    const minted = await runAkRole(
      ["notary", "--source-run", source],
      callEnv(home, project, again),
    );
    const mintedLog = await readHostLog(logPath);
    assert.equal(minted.exitCode, 0, explain(again, mintedLog));
    assert.equal(minted.terminal?.roleOutcome.kind, "accepted");
    assert.deepEqual(payloadStatusSequence(minted.terminal!.roleOutcome), ["converged"]);
    const after = await roleRuns(home, project, "notary");
    const created = added(oldRuns, after);
    assert.equal(created.length, 1);
    const newRun = created[0]!;
    assert.equal(minted.terminal?.runId, runIdOf(newRun));
    assert.notEqual(minted.terminal?.runId, runIdOf(oldRun));
    assert.equal(durableErrorCode(oldRun), "session-id-missing");
    assert.equal(mintedLog.length, 1);
    assert.equal(mintedLog[0]?.binary, "codex");
    assert.equal(mintedLog[0]?.kind, "initial");

    await writeFile(logPath, "");
    await setControl(controlPath, [{ binary: "codex", receipt: { status: "converged" }, threadId: "thread-c" }]);
    const explicit = captureIo();
    const fresh = await runAkRole(
      ["new", "notary", "--source-run", source],
      callEnv(home, project, explicit),
    );
    const freshLog = await readHostLog(logPath);
    assert.equal(fresh.exitCode, 0, explain(explicit, freshLog));
    const freshRuns = added(after, await roleRuns(home, project, "notary"));
    assert.equal(freshRuns.length, 1);
    assert.deepEqual(admittedFacts(newRun), admittedFacts(freshRuns[0]!));
    assert.equal(freshLog[0]?.kind, "initial");

    await writeFile(logPath, "");
    await configureSeat(home, "notary", "claude");
    const other = await seedCanonicalSourceRun(home, project, {
      runId: "01a1253-0000-7000-8000-0000000000b1",
      ticketNumber: TICKET,
    });
    await setControl(controlPath, [{ binary: "claude", receipt: { status: "converged" }, sessionId: "sess-manual" }]);
    const manualBirth = captureIo();
    const manualBorn = await runAkRole(
      ["notary", "--source-run", other],
      callEnv(home, project, manualBirth),
    );
    assert.equal(manualBorn.exitCode, 0, explain(manualBirth, await readHostLog(logPath)));
    const manualRuns = (await roleRuns(home, project, "notary")).filter((dir) =>
      dir !== oldRun && dir !== newRun && dir !== freshRuns[0]);
    assert.equal(manualRuns.length, 1);
    await writeFile(logPath, "");
    await configureSeat(home, "notary", "codex");
    await setControl(controlPath, []);
    const manual = captureIo();
    const manualResume = await runAkRole(
      ["resume", runIdOf(manualRuns[0]!)],
      callEnv(home, project, manual),
    );
    assert.notEqual(manualResume.exitCode, 0, explain(manual, await readHostLog(logPath)));
    assert.equal((await readHostLog(logPath)).length, 0);
    assert.equal(durableErrorCode(manualRuns[0]!), "session-id-missing");
    assert.deepEqual(dossierKinds(oldRun), dossierKinds(manualRuns[0]!));
    assert.deepEqual(dossierKinds(newRun), dossierKinds(freshRuns[0]!));
    assert.equal((await roleRuns(home, project, "notary")).filter((dir) =>
      admittedFacts(dir).sourceRunPath === admittedFacts(manualRuns[0]!).sourceRunPath).length, 1);
  });
}, 120_000);

test("#1253 gate summons mints once after the in-place loop returns session-id-missing", async () => {
  await withSeatHome(async (home, project, _source, logPath, controlPath) => {
    await configureSeat(home, "countersign", "claude");
    await configureSeat(home, "notary", "claude");
    await setControl(controlPath, [
      { binary: "claude", receipt: { status: "converged" }, sessionId: "sess-gate" },
    ], { sticky: true });
    const first = captureIo();
    const sealed = await runAkRole(
      ["countersign", "--project", project, "裁：本票是否足以开工。"],
      callEnv(home, project, first),
    );
    assert.equal(sealed.exitCode, 0, explain(first, await readHostLog(logPath)));
    const notaries = await roleRuns(home, project, "notary");
    const countersigns = await roleRuns(home, project, "countersign");
    assert.equal(notaries.length, 1, explain(first, await readHostLog(logPath)));
    assert.equal(countersigns.length, 1);

    await writeFile(logPath, "");
    await configureSeat(home, "notary", "codex");
    await setControl(controlPath, [
      { binary: "claude", receipt: { status: "converged" }, sessionId: "sess-gate" },
      { binary: "codex", receipt: { status: "escalate" }, threadId: "thread-gate" },
    ], { sticky: true });
    const resumed = captureIo();
    const result = await runAkRole(
      ["resume", runIdOf(countersigns[0]!), "再核这一轮。"],
      callEnv(home, project, resumed),
    );
    const log = await readHostLog(logPath);
    assert.equal(result.exitCode, 0, explain(resumed, log));
    assert.equal(result.terminal?.roleOutcome.role, "notary");
    assert.deepEqual(payloadStatusSequence(result.terminal!.roleOutcome), ["escalate"]);
    const created = added(notaries, await roleRuns(home, project, "notary"));
    assert.equal(created.length, 1, explain(resumed, log));
    assert.equal(result.terminal?.runId, runIdOf(created[0]!));
    assert.equal(durableErrorCode(notaries[0]!), "session-id-missing");
    const codex = log.filter((row) => row.binary === "codex");
    const codexInitial = codex.filter((row) => row.kind === "initial");
    assert.equal(codexInitial.length, 1, JSON.stringify(codex.map((row) => row.kind)));
    assert.equal(codex.every((row) => row.kind === "initial" || row.kind === "resume"), true);
    assert.equal(codex[0]?.kind, "initial");
    assert.equal(log.some((row) => row.binary === "claude" && row.kind === "resume"), true);

    const beforeNew = await roleRuns(home, project, "notary");
    await writeFile(logPath, "");
    await setControl(controlPath, [
      { binary: "codex", receipt: { status: "escalate" }, threadId: "thread-explicit" },
    ], { sticky: true });
    const sourcePath = admittedFacts(created[0]!).sourceRunPath;
    assert.equal(typeof sourcePath, "string");
    const explicit = captureIo();
    const fresh = await runAkRole(
      ["new", "notary", "--source-run", sourcePath as string],
      callEnv(home, project, explicit),
    );
    const freshLog = await readHostLog(logPath);
    assert.equal(fresh.exitCode, 0, explain(explicit, freshLog));
    const freshRuns = added(beforeNew, await roleRuns(home, project, "notary"));
    assert.equal(freshRuns.length, 1);
    assert.deepEqual(admittedFacts(created[0]!), admittedFacts(freshRuns[0]!));
    assert.equal(freshLog[0]?.kind, "initial");
  });
}, 120_000);

test("#1253 same-host resume continues and a nonzero host exit does not mint", async () => {
  await withSeatHome(async (home, project, source, logPath, controlPath) => {
    await configureSeat(home, "notary", "claude");
    await setControl(controlPath, [
      { binary: "claude", receipt: { status: "converged" }, sessionId: "sess-same" },
    ], { sticky: true });
    const born = await runAkRole(["notary", "--source-run", source], callEnv(home, project));
    assert.equal(born.exitCode, 0);
    const runs = await roleRuns(home, project, "notary");
    assert.equal(runs.length, 1);

    await writeFile(logPath, "");
    const continued = captureIo();
    const again = await runAkRole(
      ["notary", "--source-run", source],
      callEnv(home, project, continued),
    );
    const log = await readHostLog(logPath);
    assert.equal(again.exitCode, 0, explain(continued, log));
    assert.equal(again.terminal?.runId, runIdOf(runs[0]!));
    assert.equal(log.some((row) => row.kind === "resume"), true);
    assert.equal(log.some((row) => row.kind === "initial"), false);
    assert.equal((await roleRuns(home, project, "notary")).length, 1);

    await writeFile(logPath, "");
    await setControl(controlPath, [
      { binary: "claude", exitCode: 1, stderr: "host refused resume" },
    ], { sticky: true });
    const refused = captureIo();
    const failed = await runAkRole(
      ["notary", "--source-run", source],
      callEnv(home, project, refused),
    );
    const refusedLog = await readHostLog(logPath);
    assert.notEqual(failed.exitCode, 0, explain(refused, refusedLog));
    assert.equal(refusedLog.every((row) => row.kind === "resume"), true);
    assert.equal((await roleRuns(home, project, "notary")).length, 1);
    assert.notEqual(durableErrorCode(runs[0]!), "session-id-missing");
  });
}, 120_000);

test("#1253 a held writer lock does not mint", async () => {
  await withSeatHome(async (home, project, source, logPath, controlPath) => {
    await configureSeat(home, "notary", "claude");
    await setControl(controlPath, [
      { binary: "claude", receipt: { status: "converged" }, sessionId: "sess-lock" },
    ]);
    const born = await runAkRole(["notary", "--source-run", source], callEnv(home, project));
    assert.equal(born.exitCode, 0);
    const runs = await roleRuns(home, project, "notary");
    assert.equal(runs.length, 1);
    const lease = await acquireRunWriterLease(runs[0]!);
    try {
      await writeFile(logPath, "");
      await configureSeat(home, "notary", "codex");
      await setControl(controlPath, [
        { binary: "codex", receipt: { status: "converged" }, threadId: "thread-lock" },
      ]);
      const blocked = captureIo();
      const result = await runAkRole(
        ["notary", "--source-run", source],
        callEnv(home, project, blocked),
      );
      assert.notEqual(result.exitCode, 0, explain(blocked, await readHostLog(logPath)));
      assert.equal((await roleRuns(home, project, "notary")).length, 1);
      assert.equal((await readHostLog(logPath)).some((row) => row.kind === "initial"), false);
    } finally {
      await lease.release();
    }

    // Same exclusion after resume relocates an unbound run onto a later-bound source ticket.
    const unboundSource = await seedCanonicalSourceRun(home, project, {
      runId: "01a12530-0000-7000-8000-000000000253",
    });
    await configureSeat(home, "notary", "claude");
    await writeFile(logPath, "");
    await setControl(controlPath, [
      { binary: "claude", receipt: { status: "converged" }, sessionId: "sess-unbound-lock" },
    ], { sticky: true });
    const bornIo = captureIo();
    const bornUnbound = await runAkRole(
      ["notary", "--source-run", unboundSource],
      callEnv(home, project, bornIo),
    );
    assert.equal(bornUnbound.exitCode, 0, explain(bornIo, await readHostLog(logPath)));
    const beforeSummon = await roleRuns(home, project, "notary");
    const heldDirectory = beforeSummon.find((dir) => isUnboundRunDirectory(dir));
    assert.equal(typeof heldDirectory, "string");
    const heldRunId = runIdOf(heldDirectory!);
    updateSectionSync(unboundSource, "admitted", (page) => ({ ...page, ticketNumber: TICKET }));
    const movedLease = await acquireRunWriterLease(heldDirectory!);
    try {
      await writeFile(logPath, "");
      await configureSeat(home, "notary", "codex");
      await setControl(controlPath, [
        { binary: "codex", receipt: { status: "converged" }, threadId: "thread-moved-lock" },
      ]);
      const blocked = captureIo();
      const result = await runAkRole(
        ["notary", "--source-run", unboundSource],
        callEnv(home, project, blocked),
      );
      const log = await readHostLog(logPath);
      const after = await roleRuns(home, project, "notary");
      const live = after.find((dir) => runIdOf(dir) === heldRunId);
      assert.notEqual(result.exitCode, 0, explain(blocked, log));
      assert.equal(existsSync(heldDirectory!), false);
      assert.equal(after.length, beforeSummon.length);
      assert.equal(live === undefined, false);
      assert.equal(isUnboundRunDirectory(live!), false);
      assert.equal(durableErrorCode(live!), "session-id-missing");
      assert.equal(log.some((row) => row.kind === "initial"), false);
    } finally {
      const live = (await roleRuns(home, project, "notary")).find((dir) => runIdOf(dir) === heldRunId);
      if (live !== undefined) movedLease.relocate(live);
      await movedLease.release();
    }
  });
}, 120_000);

test("#1253 a new run's own session-id-missing is returned and does not mint again", async () => {
  await withSeatHome(async (home, project, source, logPath, controlPath) => {
    await configureSeat(home, "notary", "claude");
    await setControl(controlPath, [
      { binary: "claude", receipt: { status: "converged" }, sessionId: "sess-a" },
    ], { hermesOmitSessionId: true });
    const born = await runAkRole(["notary", "--source-run", source], callEnv(home, project));
    assert.equal(born.exitCode, 0);
    const before = await roleRuns(home, project, "notary");
    assert.equal(before.length, 1);

    await writeFile(logPath, "");
    await mkdir(join(home, ".hermes"), { recursive: true });
    await writeFile(
      join(home, ".hermes", "provider_models_cache.json"),
      JSON.stringify({ "openai-codex": { models: ["gpt-5.6-sol"] } }),
    );
    await configureSeat(home, "notary", "hermes");
    const failed = captureIo();
    const result = await runAkRole(
      ["notary", "--source-run", source],
      callEnv(home, project, failed),
    );
    const log = await readHostLog(logPath);
    assert.notEqual(result.exitCode, 0, explain(failed, log));
    const created = added(before, await roleRuns(home, project, "notary"));
    assert.equal(created.length, 1, explain(failed, log));
    assert.equal(result.terminal?.runId, runIdOf(created[0]!));
    assert.equal(payloadFacts(result.terminal!.roleOutcome).errorCode, "session-id-missing");
    assert.equal(durableErrorCode(created[0]!), "session-id-missing");
    assert.equal(durableErrorCode(before[0]!), "session-id-missing");
    assert.equal(log.some((row) => row.method === "session/new"), true);
    assert.equal(log.some((row) => row.method === "session/load"), false);
  });
}, 120_000);
