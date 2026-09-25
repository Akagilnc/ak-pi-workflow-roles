/**
 * #1064 — public read-only single-run view (`ak-role run show <run-dir>`).
 *
 * External contracts, driven through the real public CLI entry (runAkRole):
 *   1. codex-run tracer: terminal output carries the last verdict payload,
 *      every sealed row, the host thread id, the rollout compaction count,
 *      and the rollout token usage — each equal to a direct raw read of the
 *      same fixture material (the decoy rollout proves the thread-id filter).
 *   2. pi-run carriers: compaction rows + summed assistant message usage on the
 *      run's own session volume (session-assistant-usage); pi session header id
 *      as the host session id.
 *   3. missing-material honesty: a sparse run prints every fact as
 *      unavailable and still exits 0 — no crash, no index error. Missing Claude
 *      host-session is unavailable (not a known zero); damaged seal JSONL is
 *      unavailable (not a silent partial); Codex turn.completed.usage is read
 *      when the native rollout is absent.
 *   4. read-only: two views leave the whole home tree byte-identical and add
 *      no run directories (the ledger is never written).
 *   5. usage rejects: wrong subcommand / missing or extra argv / nonexistent
 *      run directory exit 2 with one stderr diagnostic.
 *
 * Oracles: the fixture values the test itself writes (ground truth), and the
 * production projection (projectRunShowFacts) for structural facts. Rendered
 * label prose is never asserted (ADR 0016); compact JSON fact substrings are
 * material content, not layout.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  projectRunShowFacts,
  type RunShowFacts,
} from "../../src/public-cli/run-show.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

const RUN_ID = "01aatest1-0001-7000-8000-000000000001";
const RUN_NAME = `${RUN_ID}@judge`;
const THREAD_ID = "01aatest1-0002-7000-8000-000000000002";
const DECOY_THREAD_ID = "01aatest1-0003-7000-8000-000000000003";

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
/** Whole-run sum via session-assistant-usage (reasoning is not accumulated there). */
const PI_RUN_USAGE = {
  input: 99126,
  output: 1953,
  cacheRead: 128,
  cacheWrite: 0,
  totalTokens: 101463,
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
        payload: { type: "turn.completed", usage: CODEX_HOST_TURN_USAGE },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

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

test("run show: codex run — five fact kinds equal direct raw reads", async () => {
  await withTempRoot("ak-run-show-codex-", async (machineHome) => {
    const runDirectory = await writeCodexRunFixture(machineHome);
    const { io, stdout } = captureIo();

    const result = await runAkRole(["run", "show", runDirectory], {
      packageRoot,
      home: machineHome,
      io,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(stdout.length, 1);
    const output = stdout[0]!;

    // Terminal output carries each fact as the compact JSON of the raw material.
    assert.equal(output.includes(JSON.stringify(LAST_PAYLOAD)), true);
    assert.equal(output.includes(JSON.stringify(FIRST_PAYLOAD)), false);
    assert.equal(output.includes(JSON.stringify(SEALED_PAYLOAD_FIRST)), true);
    assert.equal(output.includes(JSON.stringify(SEALED_PAYLOAD_LAST)), true);
    assert.equal(output.includes(JSON.stringify(TOKEN_COUNT_INFO)), true);
    assert.equal(output.includes(THREAD_ID), true);

    // Structural facts equal direct raw reads of the same materials.
    const facts = await projectRunShowFacts(runDirectory, { machineHome });
    assert.deepEqual(facts.lastVerdictPayload, {
      payload: LAST_PAYLOAD,
      source: "artifacts/report.json",
    });
    assert.ok(!("unavailable" in facts.sealRecords));
    assert.deepEqual(facts.sealRecords.records, [
      { timestamp: "2026-09-25T00:00:02Z", payload: SEALED_PAYLOAD_FIRST },
      { timestamp: "2026-09-25T00:00:02Z", payload: SEALED_PAYLOAD_LAST },
    ]);
    assert.ok(!("unavailable" in facts.hostThreadIds));
    assert.deepEqual(facts.hostThreadIds.ids, [
      { id: THREAD_ID, source: "session/codex-headless-session.json" },
    ]);
    assert.deepEqual(facts.compactionCount, {
      count: 2,
      source: join(
        machineHome,
        ".codex",
        "sessions",
        "2026",
        "09",
        "25",
        `rollout-2026-09-25T00-00-00-${THREAD_ID}.jsonl`,
      ),
    });
    assert.deepEqual(facts.tokenUsage, {
      usage: TOKEN_COUNT_INFO,
      source: facts.compactionCount.source,
    });
  });
});

test("run show: pi run — carriers on the run's own session volume", async () => {
  await withTempRoot("ak-run-show-pi-", async (machineHome) => {
    const runDirectory = await writePiRunFixture(machineHome);
    const { io, stdout } = captureIo();

    const result = await runAkRole(["run", "show", runDirectory], {
      packageRoot,
      home: machineHome,
      io,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(stdout[0]!.includes(JSON.stringify(PI_RUN_USAGE)), true);
    assert.equal(stdout[0]!.includes(JSON.stringify(PI_SECOND_USAGE)), false);

    const facts = await projectRunShowFacts(runDirectory, { machineHome });
    assert.deepEqual(facts.compactionCount, {
      count: 3,
      source: "session/session.jsonl",
    });
    assert.deepEqual(facts.tokenUsage, {
      usage: PI_RUN_USAGE,
      source: "session/session.jsonl",
    });
    assert.ok(!("unavailable" in facts.hostThreadIds));
    assert.deepEqual(facts.hostThreadIds.ids, [
      { id: `${RUN_ID}@diarist`, source: "session/session.jsonl" },
    ]);
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
    const missingIo = captureIo();
    const missingResult = await runAkRole(["run", "show", runDirectory], {
      packageRoot,
      home: machineHome,
      io: missingIo.io,
    });
    assert.equal(missingResult.exitCode, 0);
    assert.equal(missingIo.stdout.length, 1);
    assert.equal(
      missingIo.stdout[0]!.includes(JSON.stringify(CODEX_HOST_TURN_USAGE)),
      true,
    );
    const missingFacts = await projectRunShowFacts(runDirectory, { machineHome });
    assert.deepEqual(missingFacts.tokenUsage, {
      usage: CODEX_HOST_TURN_USAGE,
      source: "session/host-session/records.jsonl",
    });

    // A damaged rollout must not hide the same readable usage.
    await writeFile(rolloutPath, "{not-json\n", "utf8");
    const damagedIo = captureIo();
    const damagedResult = await runAkRole(["run", "show", runDirectory], {
      packageRoot,
      home: machineHome,
      io: damagedIo.io,
    });
    assert.equal(damagedResult.exitCode, 0);
    assert.equal(damagedIo.stdout.length, 1);
    assert.equal(
      damagedIo.stdout[0]!.includes(JSON.stringify(CODEX_HOST_TURN_USAGE)),
      true,
    );
    const damagedFacts = await projectRunShowFacts(runDirectory, { machineHome });
    assert.deepEqual(damagedFacts.tokenUsage, missingFacts.tokenUsage);
    assert.ok("unavailable" in damagedFacts.compactionCount);

    // A well-formed rollout without token_count follows the same fallback.
    await writeFile(
      rolloutPath,
      `${JSON.stringify({ type: "compacted", payload: { message: "" } })}\n`,
      "utf8",
    );
    const noUsageIo = captureIo();
    const noUsageResult = await runAkRole(["run", "show", runDirectory], {
      packageRoot,
      home: machineHome,
      io: noUsageIo.io,
    });
    assert.equal(noUsageResult.exitCode, 0);
    assert.equal(noUsageIo.stdout.length, 1);
    assert.equal(
      noUsageIo.stdout[0]!.includes(JSON.stringify(CODEX_HOST_TURN_USAGE)),
      true,
    );
    const noUsageFacts = await projectRunShowFacts(runDirectory, { machineHome });
    assert.deepEqual(noUsageFacts.tokenUsage, missingFacts.tokenUsage);
    assert.deepEqual(noUsageFacts.compactionCount, {
      count: 1,
      source: rolloutPath,
    });
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

    const { io, stdout } = captureIo();
    const result = await runAkRole(["run", "show", runDirectory], {
      packageRoot,
      home: machineHome,
      io,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0]!.length > 0);
    const facts = await projectRunShowFacts(runDirectory, { machineHome });
    assert.ok("unavailable" in facts.compactionCount);
    assert.ok("unavailable" in facts.tokenUsage);
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

    const { io, stdout } = captureIo();
    const result = await runAkRole(["run", "show", runDirectory], {
      packageRoot,
      home: machineHome,
      io,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0]!.length > 0);
    const facts = await projectRunShowFacts(runDirectory, { machineHome });
    assert.ok("unavailable" in facts.sealRecords);
  });
});

test("run show: sparse run — every missing material prints unavailable, no crash", async () => {
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
    const { io, stdout } = captureIo();

    const result = await runAkRole(["run", "show", runDirectory], {
      packageRoot,
      home: machineHome,
      io,
    });

    assert.equal(result.exitCode, 0);
    const facts: RunShowFacts = await projectRunShowFacts(runDirectory, {
      machineHome,
    });
    assert.ok("unavailable" in facts.lastVerdictPayload);
    assert.ok("unavailable" in facts.sealRecords);
    assert.ok("unavailable" in facts.hostThreadIds);
    assert.ok("unavailable" in facts.compactionCount);
    assert.ok("unavailable" in facts.tokenUsage);
    // Each unavailable reason names the missing material, not an index error.
    assert.equal(facts.lastVerdictPayload.unavailable.includes("report.json"), true);
    assert.equal(stdout[0]!.length > 0, true);
  });
});

test("run show: two views leave the ledger byte-identical and add no runs", async () => {
  await withTempRoot("ak-run-show-readonly-", async (machineHome) => {
    const runDirectory = await writeCodexRunFixture(machineHome);
    const before = await snapshotTree(machineHome);

    const first = captureIo();
    await runAkRole(["run", "show", runDirectory], {
      packageRoot,
      home: machineHome,
      io: first.io,
    });
    const second = captureIo();
    await runAkRole(["run", "show", runDirectory], {
      packageRoot,
      home: machineHome,
      io: second.io,
    });

    assert.deepEqual(first.stdout[0], second.stdout[0]);
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
