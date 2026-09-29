/**
 * #329 analyst-C1 — sweep mode + library index page tracer.
 *
 * Typed input = merged PR list + LOC → backfill issue pages (idempotent overwrite)
 * and maintain the library index (one self-sufficient row per issue).
 * LOC absent/0 → typed 空缺 for 耗时/千行 (never 0 or Infinity).
 * C1 fixture runs use exclusive runId segment 019ff000-1xxx.
 */
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runAnalyst } from "../../src/analyst-entry.ts";
import type { AnalystIssueMetricsPage } from "../../src/analyst-page.ts";
import { C1_ISSUE_ALPHA as ISSUE_ALPHA, C1_ALPHA_RUN, withTempHome } from "../helpers/analyst-fixture-kit.ts";

// 太史 C1 sweep——页与索引写路径家族（#420 整改拆分第二片）。

test("analyst changedLines rejects non-finite negatives at issue and sweep boundaries", async () => {
  await withTempHome(async (home) => {
    for (const changedLines of [-3, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () => runAnalyst({ mode: "issue", projectRoot: ISSUE_ALPHA, changedLines }, { home }),
        (error: unknown) => error instanceof Error && Object.getPrototypeOf(error) === Error.prototype,
      );
    }
    await assert.rejects(
      () => runAnalyst({ mode: "sweep", mergedPullRequests: [{ projectRoot: ISSUE_ALPHA, changedLines: -1 }] }, { home }),
      (error: unknown) => error instanceof Error && Object.getPrototypeOf(error) === Error.prototype,
    );
    // 0 remains lawful typed 空缺.
    const zero = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_ALPHA,
      changedLines: 0,
    }, { home });
    assert.deepEqual(zero.page.changedLines, { status: "absent" });
    assert.deepEqual(zero.page.msPerKLines, { status: "absent" });
  });
});
test("analyst session span with inverted timestamps is page-local unreadable", async () => {
  await withTempHome(async (home) => {
    const sessionPath = join(
      home,
      ".ak-roles",
      "books",
      "fixture-book-c1",
      "runs",
      `${C1_ALPHA_RUN}@coder`,
      "session",
      "session.jsonl",
    );
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "s-c1-a1-bad",
          timestamp: "2026-08-02T00:00:40.000Z",
          cwd: ISSUE_ALPHA,
        }),
        JSON.stringify({
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-08-02T00:00:40.000Z",
          message: {
            role: "assistant",
            timestamp: "2026-08-02T00:00:40.000Z",
            content: [],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "m2",
          parentId: "m1",
          timestamp: "2026-08-02T00:00:00.000Z",
          message: {
            role: "assistant",
            timestamp: "2026-08-02T00:00:00.000Z",
            content: [],
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_ALPHA,
    }, { home });
    assert.equal(result.page.legs.length, 0);
    assert.equal(result.page.totalElapsedMs, 0);
    assert.equal(result.page.unreadableCount, 1);
    const entry = result.page.unreadable[0]!;
    assert.equal(entry.runId, C1_ALPHA_RUN);
    assert.deepEqual(entry.missingSources, ["session-timeline"]);
    // Must not surface negative/NaN wall clocks on the page envelope.
    assert.equal(Number.isFinite(result.page.totalElapsedMs), true);
    assert.ok(result.page.totalElapsedMs >= 0);
  });
});
test("analyst live run-state is not classified as terminal no-receipt", async () => {
  await withTempHome(async (home) => {
    const runDir = join(
      home,
      ".ak-roles",
      "books",
      "fixture-book-c1",
      "runs",
      `${C1_ALPHA_RUN}@coder`,
    );
    // Drop prior artifacts so live run-state is not classified via leftover receipts.
    await rm(join(runDir, "artifacts"), { recursive: true, force: true });
    await writeFile(
      join(runDir, "run-state.json"),
      `${JSON.stringify({
        runId: C1_ALPHA_RUN,
        role: "coder",
        state: "running",
        bookKey: "fixture-book-c1",
        projectRoot: ISSUE_ALPHA,
        sessionDirectory: join(runDir, "session"),
        sessionFile: join(runDir, "session", "session.jsonl"),
        runDirectory: runDir,
        admittedRequestPath: join(runDir, "invocation.json"),
      }, null, 2)}\n`,
      "utf8",
    );

    const result = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_ALPHA,
    }, { home });
    // Live run is omitted entirely — not a leg, not unreadable death.
    assert.equal(
      result.page.legs.some((leg) => leg.runId === C1_ALPHA_RUN),
      false,
    );
    assert.equal(
      result.page.unreadable.some((entry) => entry.runId === C1_ALPHA_RUN),
      false,
    );
    assert.equal(result.page.totalElapsedMs, 0);
    const page = result.page as AnalystIssueMetricsPage & {
      acceptanceSuccessRework?: {
        byRole: readonly {
          role: string;
          noReceiptCount: number;
          appearanceLaneCount: number;
        }[];
      };
    };
    const coder = page.acceptanceSuccessRework?.byRole.find((r) => r.role === "coder");
    assert.equal(coder?.noReceiptCount ?? 0, 0);
    assert.equal(coder?.appearanceLaneCount ?? 0, 0);
  });
});
test("analyst reads publisher durable error.settlement fallback as terminal failure", async () => {
  await withTempHome(async (home) => {
    const runDir = join(
      home,
      ".ak-roles",
      "books",
      "fixture-book-c1",
      "runs",
      `${C1_ALPHA_RUN}@coder`,
    );
    // Drop prior artifacts so durable error.settlement is the sole terminal face.
    await rm(join(runDir, "artifacts"), { recursive: true, force: true });
    await writeFile(
      join(runDir, "error.settlement.json"),
      `${JSON.stringify({
        kind: "error",
        role: "coder",
        runId: C1_ALPHA_RUN,
        cause: "provider",
        diagnostic: "settled fallback failure",
      }, null, 2)}\n`,
      "utf8",
    );

    const result = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_ALPHA,
    }, { home });
    assert.equal(
      result.page.legs.some((leg) => leg.runId === C1_ALPHA_RUN),
      true,
      "run with durable fallback error must remain readable",
    );
    const page = result.page as AnalystIssueMetricsPage & {
      roundTimeline?: {
        lanes: readonly {
          lane: string;
          rows: readonly {
            kind: string;
            runId?: string;
            terminal?: { kind: string; channel?: string };
          }[];
        }[];
      };
    };
    const row = page.roundTimeline?.lanes
      .flatMap((lane) => lane.rows)
      .find((entry) => entry.kind === "run" && entry.runId === C1_ALPHA_RUN);
    assert.ok(row, "timeline must keep the fallback-error run");
    assert.equal(row.terminal?.kind, "death");
    assert.equal(row.terminal?.channel, "error");
  });
});
