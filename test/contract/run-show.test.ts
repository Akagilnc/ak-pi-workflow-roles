/**
 * #1064 — public read-only single-run view (`ak-role run show <run-dir>`).
 *
 * External contracts, driven through the real public CLI entry (runAkRole):
 *   1. codex-run tracer: each of the five source facts affects the terminal
 *      result (the decoy rollout proves the thread-id filter).
 *   2. pi-run carriers: each assistant turn contributes to the public result.
 *   3. missing-material honesty: a sparse run still exits 0; missing Claude
 *      host-session differs from an available zero, damaged seal JSONL differs
 *      from valid partial/full records, and Codex run-written usage affects the
 *      public result when native rollout usage is absent or damaged.
 *   4. read-only: two views leave the whole home tree byte-identical and add
 *      no run directories (the ledger is never written).
 *   5. usage rejects: wrong subcommand / missing or extra argv / nonexistent
 *      run directory exit 2 with one stderr diagnostic.
 *
 * Oracle: the fixture values the test itself writes (ground truth). Terminal
 * output is observed opaquely: changing a source fact must change the public
 * result, without asserting its prose or layout (ADR 0016).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runAkRole } from "../../src/public-cli/cli.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

const RUN_ID = "01aatest1-0001-7000-8000-000000000001";
const RUN_NAME = `${RUN_ID}@judge`;
const THREAD_ID = "01aatest1-0002-7000-8000-000000000002";
const DECOY_THREAD_ID = "01aatest1-0003-7000-8000-000000000003";
const ADDITIONAL_BINDING_ID = "01aatest1-0004-7000-8000-000000000004";

const FIRST_PAYLOAD = {
  status: "continue",
  findings: [{ severity: "p2", class: "round-one finding" }],
} as const;

const LAST_PAYLOAD = {
  status: "converged",
  findings: [{ severity: "p2", class: "round-two finding" }],
  fix: { summary: "seal the second round" },
} as const;

const SEALED_PAYLOAD_FIRST = { status: "continue", round: 1 } as const;
const SEALED_PAYLOAD_LAST = { status: "converged", round: 2 } as const;

const TOKEN_COUNT_INFO = {
  total_token_usage: {
    input_tokens: 147066,
    cached_input_tokens: 117376,
    cache_write_input_tokens: 0,
    output_tokens: 2360,
    reasoning_output_tokens: 724,
    total_tokens: 149426,
  },
  last_token_usage: {
    input_tokens: 28748,
    cached_input_tokens: 27904,
    cache_write_input_tokens: 0,
    output_tokens: 752,
    reasoning_output_tokens: 450,
    total_tokens: 29500,
  },
  model_context_window: 258400,
} as const;

/** Per-turn assistant usages written into the pi fixture (sum = whole-run usage). */
const PI_FIRST_USAGE = {
  input: 5599,
  output: 158,
  totalTokens: 6013,
} as const;
const PI_SECOND_USAGE = {
  input: 93527,
  output: 1795,
  cacheRead: 128,
  cacheWrite: 0,
  reasoning: 1754,
  totalTokens: 95450,
} as const;
const CODEX_HOST_TURN_USAGE = {
  input_tokens: 11,
  output_tokens: 7,
} as const;

function submissionLedgerRow(
  kind: "candidate" | "sealed",
  payload: unknown,
): string {
  return `${JSON.stringify({
    level: "event",
    kind,
    identity: `identity-${kind}`,
    timestamp: `2026-09-25T00:00:0${kind === "candidate" ? 1 : 2}Z`,
    payload,
  })}\n`;
}

async function writeCodexHostSessionRecords(
  runDirectory: string,
  usage: Readonly<{ input_tokens: number; output_tokens: number }>,
): Promise<void> {
  await writeFile(
    join(runDirectory, "session", "host-session", "records.jsonl"),
    [
      JSON.stringify({
        level: "event",
        kind: "host-session",
        host: "codex",
        source: "headless-host",
        timestamp: "2026-09-25T00:00:00.000Z",
        payload: { type: "thread.started", thread_id: THREAD_ID },
      }),
      JSON.stringify({
        level: "event",
        kind: "host-session",
        host: "codex",
        source: "headless-host",
        timestamp: "2026-09-25T00:00:01.000Z",
        payload: { type: "turn.completed", usage },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
}

async function writeCodexRunFixture(machineHome: string): Promise<string> {
  const runDirectory = join(
    machineHome,
    ".ak-roles",
    "books",
    "testbook",
    "42",
    "runs",
    RUN_NAME,
  );
  await mkdir(join(runDirectory, "artifacts"), { recursive: true });
  await mkdir(join(runDirectory, "session", "submission-ledger"), {
    recursive: true,
  });
  await mkdir(join(runDirectory, "session", "host-session"), { recursive: true });
  await mkdir(join(machineHome, ".codex", "sessions", "2026", "09", "25"), {
    recursive: true,
  });

  await writeFile(
    join(runDirectory, "artifacts", "report.json"),
    `${JSON.stringify({
      role: "judge",
      runId: RUN_ID,
      outcome: {
        kind: "accepted",
        role: "judge",
        payloads: [FIRST_PAYLOAD, LAST_PAYLOAD],
      },
    })}\n`,
    "utf8",
  );

  await writeFile(
    join(runDirectory, "session", "submission-ledger", "records.jsonl"),
    [
      submissionLedgerRow("candidate", { status: "candidate" }),
      submissionLedgerRow("sealed", SEALED_PAYLOAD_FIRST),
      submissionLedgerRow("sealed", SEALED_PAYLOAD_LAST),
      `${JSON.stringify({ level: "event", kind: "roundContext", payload: {} })}\n`,
    ].join(""),
    "utf8",
  );

  await writeFile(
    join(runDirectory, "session", "codex-headless-session.json"),
    `${JSON.stringify({ sessionId: THREAD_ID })}\n`,
    "utf8",
  );

  await writeCodexHostSessionRecords(runDirectory, CODEX_HOST_TURN_USAGE);

  // External-host runs keep a header-only session volume (ADR 0077 DK-4).
  await writeFile(
    join(runDirectory, "session", "session.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, id: RUN_NAME }),
      JSON.stringify({
        type: "custom",
        customType: "ak-role-submission-closure",
        data: { status: "converged" },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const rolloutPath = join(
    machineHome,
    ".codex",
    "sessions",
    "2026",
    "09",
    "25",
    `rollout-2026-09-25T00-00-00-${THREAD_ID}.jsonl`,
  );
  await writeFile(
    rolloutPath,
    [
      JSON.stringify({ type: "session_meta", payload: { originator: "ak-role" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100 } } } }),
      JSON.stringify({ type: "compacted", payload: { message: "" } }),
      JSON.stringify({ type: "compacted", payload: { message: "" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: TOKEN_COUNT_INFO } }),
    ].join("\n") + "\n",
    "utf8",
  );

  // Decoy rollout for another thread: must not leak into this run's facts.
  await writeFile(
    join(
      machineHome,
      ".codex",
      "sessions",
      "2026",
      "09",
      "25",
      `rollout-2026-09-25T00-00-00-${DECOY_THREAD_ID}.jsonl`,
    ),
    [
      JSON.stringify({ type: "compacted", payload: { message: "" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 9 } } } }),
    ].join("\n") + "\n",
    "utf8",
  );

  return runDirectory;
}

async function writePiRunFixture(machineHome: string): Promise<string> {
  const runDirectory = join(
    machineHome,
    ".ak-roles",
    "books",
    "testbook",
    "43",
    "runs",
    `${RUN_ID}@diarist`,
  );
  await mkdir(join(runDirectory, "session", "submission-ledger"), {
    recursive: true,
  });
  await writeFile(
    join(runDirectory, "session", "session.jsonl"),
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: `${RUN_ID}@diarist`,
        timestamp: "2026-09-25T00:00:00.000Z",
      }),
      JSON.stringify({
        type: "message",
        id: "m1",
        message: { role: "assistant", usage: PI_FIRST_USAGE },
      }),
      "   ",
      JSON.stringify({ type: "compaction", id: "c1", summary: "one" }),
      JSON.stringify({ type: "compaction", id: "c2", summary: "two" }),
      JSON.stringify({ type: "compaction", id: "c3", summary: "three" }),
      JSON.stringify({
        type: "message",
        id: "m2",
        message: { role: "assistant", usage: PI_SECOND_USAGE },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    join(runDirectory, "session", "submission-ledger", "records.jsonl"),
    submissionLedgerRow("sealed", SEALED_PAYLOAD_LAST),
    "utf8",
  );
  return runDirectory;
}

async function runPublicRunShow(
  runDirectory: string,
  machineHome: string,
): Promise<string> {
  const { io, stdout } = captureIo();
  const result = await runAkRole(["run", "show", runDirectory], {
    packageRoot,
    home: machineHome,
    io,
  });
  assert.equal(result.exitCode, 0);
  const output = stdout.join("");
  assert.notEqual(output, "");
  return output;
}

/** Recursive snapshot: every file path → sha256 of its bytes. */
async function snapshotTree(root: string): Promise<readonly string[]> {
  const rows: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      rows.push(`${path} ${createHash("sha256").update(await readFile(path)).digest("hex")}`);
    }
  };
  await walk(root);
  return rows;
}

test("run show: codex run — all five fact kinds reach the public result", async () => {
  await withTempRoot("ak-run-show-codex-", async (machineHome) => {
    const runDirectory = await writeCodexRunFixture(machineHome);
    const initial = await runPublicRunShow(runDirectory, machineHome);

    const decoyRolloutPath = join(
      machineHome,
      ".codex",
      "sessions",
      "2026",
      "09",
      "25",
      `rollout-2026-09-25T00-00-00-${DECOY_THREAD_ID}.jsonl`,
    );
    await writeFile(
      decoyRolloutPath,
      [
        JSON.stringify({ type: "compacted", payload: { message: "" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_tokens: 1 } } }),
      ].join("\n") + "\n",
      "utf8",
    );
    const changedDecoy = await runPublicRunShow(runDirectory, machineHome);
    assert.equal(changedDecoy, initial);

    // Verify each source fact reaches the public result without pinning its
    // terminal representation. Each invocation changes only one carrier.
    const reportPath = join(runDirectory, "artifacts", "report.json");
    await writeFile(
      reportPath,
      `${JSON.stringify({
        role: "judge",
        runId: RUN_ID,
        outcome: {
          kind: "accepted",
          role: "judge",
          payloads: [FIRST_PAYLOAD, { ...LAST_PAYLOAD, fix: { summary: "changed" } }],
        },
      })}\n`,
      "utf8",
    );
    const changedVerdict = await runPublicRunShow(runDirectory, machineHome);
    assert.notEqual(changedVerdict, initial);

    await writeFile(
      join(runDirectory, "session", "submission-ledger", "records.jsonl"),
      [
        submissionLedgerRow("candidate", { status: "candidate" }),
        submissionLedgerRow("sealed", SEALED_PAYLOAD_FIRST),
        submissionLedgerRow("sealed", { status: "converged", round: 3 }),
        `${JSON.stringify({ level: "event", kind: "roundContext", payload: {} })}\n`,
      ].join(""),
      "utf8",
    );
    const changedSeals = await runPublicRunShow(runDirectory, machineHome);
    assert.notEqual(changedSeals, changedVerdict);

    // Host-session keeps THREAD_ID, so its rollout remains selected; only the
    // run binding's additional id changes in this public-output comparison.
    await writeFile(
      join(runDirectory, "session", "codex-headless-session.json"),
      `${JSON.stringify({ sessionId: ADDITIONAL_BINDING_ID })}\n`,
      "utf8",
    );
    const changedThread = await runPublicRunShow(runDirectory, machineHome);
    assert.notEqual(changedThread, changedSeals);

    const rolloutPath = join(
      machineHome,
      ".codex",
      "sessions",
      "2026",
      "09",
      "25",
      `rollout-2026-09-25T00-00-00-${THREAD_ID}.jsonl`,
    );
    const originalRollout = await readFile(rolloutPath, "utf8");
    await writeFile(
      rolloutPath,
      `${originalRollout}${JSON.stringify({ type: "compacted", payload: { message: "" } })}\n`,
      "utf8",
    );
    const changedCompaction = await runPublicRunShow(runDirectory, machineHome);
    assert.notEqual(changedCompaction, changedThread);

    const changedTokenRollout = originalRollout.replace(
      JSON.stringify(TOKEN_COUNT_INFO),
      JSON.stringify({
        ...TOKEN_COUNT_INFO,
        total_token_usage: {
          ...TOKEN_COUNT_INFO.total_token_usage,
          input_tokens: TOKEN_COUNT_INFO.total_token_usage.input_tokens + 1,
          total_tokens: TOKEN_COUNT_INFO.total_token_usage.total_tokens + 1,
        },
      }),
    );
    await writeFile(
      rolloutPath,
      `${changedTokenRollout}${JSON.stringify({ type: "compacted", payload: { message: "" } })}\n`,
      "utf8",
    );
    const changedUsage = await runPublicRunShow(runDirectory, machineHome);
    assert.notEqual(changedUsage, changedCompaction);
  });
});

test("run show: pi run — carriers on the run's own session volume", async () => {
  await withTempRoot("ak-run-show-pi-", async (machineHome) => {
    const runDirectory = await writePiRunFixture(machineHome);
    const initial = await runPublicRunShow(runDirectory, machineHome);

    const sessionPath = join(runDirectory, "session", "session.jsonl");
    const originalSession = await readFile(sessionPath, "utf8");
    const oneTurnSession = originalSession.replace(
      `${JSON.stringify({
        type: "message",
        id: "m1",
        message: { role: "assistant", usage: PI_FIRST_USAGE },
      })}\n`,
      "",
    );
    await writeFile(sessionPath, oneTurnSession, "utf8");
    const withoutFirstTurn = await runPublicRunShow(runDirectory, machineHome);
    assert.notEqual(withoutFirstTurn, initial);

    const changedSecondTurn = originalSession.replace(
      JSON.stringify(PI_SECOND_USAGE),
      JSON.stringify({ ...PI_SECOND_USAGE, totalTokens: PI_SECOND_USAGE.totalTokens + 1 }),
    );
    await writeFile(sessionPath, changedSecondTurn, "utf8");
    const changedLastTurn = await runPublicRunShow(runDirectory, machineHome);
    assert.notEqual(changedLastTurn, initial);
  });
});

test("run show: Codex falls back to run-written usage when rollout usage is unavailable", async () => {
  await withTempRoot("ak-run-show-codex-host-usage-", async (machineHome) => {
    const runDirectory = await writeCodexRunFixture(machineHome);
    const rolloutPath = join(
      machineHome,
      ".codex",
      "sessions",
      "2026",
      "09",
      "25",
      `rollout-2026-09-25T00-00-00-${THREAD_ID}.jsonl`,
    );

    // A missing rollout already falls back to the run's direct-write usage.
    await unlink(rolloutPath);
    const missing = await runPublicRunShow(runDirectory, machineHome);

    await writeCodexHostSessionRecords(runDirectory, { input_tokens: 12, output_tokens: 7 });
    const missingWithChangedUsage = await runPublicRunShow(runDirectory, machineHome);
    assert.notEqual(missingWithChangedUsage, missing);

    // A damaged rollout must not hide the same readable usage.
    await writeFile(rolloutPath, "{not-json\n", "utf8");
    const damaged = await runPublicRunShow(runDirectory, machineHome);
    assert.notEqual(damaged, missingWithChangedUsage);

    await writeCodexHostSessionRecords(runDirectory, { input_tokens: 13, output_tokens: 7 });
    const damagedWithChangedUsage = await runPublicRunShow(runDirectory, machineHome);
    assert.notEqual(damagedWithChangedUsage, damaged);

    // A well-formed rollout without token_count follows the same fallback.
    await writeFile(
      rolloutPath,
      `${JSON.stringify({ type: "compacted", payload: { message: "" } })}\n`,
      "utf8",
    );
    const noUsage = await runPublicRunShow(runDirectory, machineHome);
    assert.notEqual(noUsage, damagedWithChangedUsage);

    await writeCodexHostSessionRecords(runDirectory, { input_tokens: 14, output_tokens: 7 });
    const changedFallback = await runPublicRunShow(runDirectory, machineHome);
    assert.notEqual(changedFallback, noUsage);
  });
});

test("run show: Claude binding without host-session is unavailable, not zero", async () => {
  await withTempRoot("ak-run-show-claude-missing-hs-", async (machineHome) => {
    const runDirectory = join(
      machineHome,
      ".ak-roles",
      "books",
      "testbook",
      "45",
      "runs",
      `${RUN_ID}@reviewer`,
    );
    await mkdir(join(runDirectory, "session"), { recursive: true });
    await writeFile(
      join(runDirectory, "session", "claude-headless-session.json"),
      `${JSON.stringify({ sessionId: THREAD_ID })}\n`,
      "utf8",
    );

    const missing = await runPublicRunShow(runDirectory, machineHome);

    await mkdir(join(runDirectory, "session", "host-session"), { recursive: true });
    await writeFile(join(runDirectory, "session", "host-session", "records.jsonl"), "", "utf8");
    const knownZero = await runPublicRunShow(runDirectory, machineHome);
    assert.notEqual(missing, knownZero);
  });
});

test("run show: damaged seal JSONL is unavailable, not a silent partial", async () => {
  await withTempRoot("ak-run-show-damaged-seal-", async (machineHome) => {
    const runDirectory = join(
      machineHome,
      ".ak-roles",
      "books",
      "testbook",
      "46",
      "runs",
      `${RUN_ID}@notary`,
    );
    await mkdir(join(runDirectory, "session", "submission-ledger"), {
      recursive: true,
    });
    await writeFile(
      join(runDirectory, "session", "submission-ledger", "records.jsonl"),
      [
        submissionLedgerRow("sealed", SEALED_PAYLOAD_FIRST),
        "{not-json\n",
        submissionLedgerRow("sealed", SEALED_PAYLOAD_LAST),
      ].join(""),
      "utf8",
    );

    const damaged = await runPublicRunShow(runDirectory, machineHome);

    const ledgerPath = join(runDirectory, "session", "submission-ledger", "records.jsonl");
    await writeFile(ledgerPath, submissionLedgerRow("sealed", SEALED_PAYLOAD_LAST), "utf8");
    const validPartial = await runPublicRunShow(runDirectory, machineHome);
    await writeFile(
      ledgerPath,
      [
        submissionLedgerRow("sealed", SEALED_PAYLOAD_FIRST),
        submissionLedgerRow("sealed", SEALED_PAYLOAD_LAST),
      ].join(""),
      "utf8",
    );
    const validComplete = await runPublicRunShow(runDirectory, machineHome);
    assert.notEqual(damaged, validPartial);
    assert.notEqual(damaged, validComplete);
  });
});

test("run show: sparse run — missing materials do not prevent a view", async () => {
  await withTempRoot("ak-run-show-sparse-", async (machineHome) => {
    const runDirectory = join(
      machineHome,
      ".ak-roles",
      "books",
      "testbook",
      "44",
      "runs",
      `${RUN_ID}@notary`,
    );
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "run-state.json"),
      `${JSON.stringify({ runId: RUN_ID, role: "notary", state: "admitted" })}\n`,
      "utf8",
    );
    await runPublicRunShow(runDirectory, machineHome);
  });
});

test("run show: two views leave the ledger byte-identical and add no runs", async () => {
  await withTempRoot("ak-run-show-readonly-", async (machineHome) => {
    const runDirectory = await writeCodexRunFixture(machineHome);
    const before = await snapshotTree(machineHome);

    await runPublicRunShow(runDirectory, machineHome);
    await runPublicRunShow(runDirectory, machineHome);
    const after = await snapshotTree(machineHome);
    assert.deepEqual(after, before);
  });
});

test("run show: usage rejects exit 2 with one stderr diagnostic", async () => {
  await withTempRoot("ak-run-show-usage-", async (machineHome) => {
    const runDirectory = await writeCodexRunFixture(machineHome);
    const cases: readonly string[][] = [
      ["run"],
      ["run", "show"],
      ["run", "show", runDirectory, "extra"],
      ["run", "glance", runDirectory],
      ["run", "show", join(machineHome, "no-such-run")],
    ];
    for (const argv of cases) {
      const { io, stderr } = captureIo();
      const result = await runAkRole(argv, {
        packageRoot,
        home: machineHome,
        io,
      });
      assert.equal(result.exitCode, 2, JSON.stringify(argv));
      assert.equal(stderr.length, 1, JSON.stringify(argv));
      assert.equal(stderr[0]!.length > 0, true);
    }
  });
});

test("run show: host axis flags stay refused for the read-only support command", async () => {
  await withTempRoot("ak-run-show-axes-", async (machineHome) => {
    const runDirectory = await writeCodexRunFixture(machineHome);
    const { io, stderr } = captureIo();
    const result = await runAkRole(
      ["--host", "grok-build", "run", "show", runDirectory],
      { packageRoot, home: machineHome, io },
    );
    assert.equal(result.exitCode, 2);
    assert.equal(stderr.length, 1);
  });
});
