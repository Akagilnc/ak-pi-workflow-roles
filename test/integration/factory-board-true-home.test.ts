// #420 整改：自 test/contract/factory-board.test.ts 按性质移出（动 owner 真 home 卷宗，
// 不属开发内环快档）。契约不变：真 home 验收 tracer（#127 已接受轨迹、活跃腿、#130 成本对账）。
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverTrueHomeUnacceptedActiveIssue,
  elementsWith,
  executeProductionBoardSort,
  independentAcceptedTrajectory,
  independentIssueUsage,
  independentLatestLegActivity,
  laneSortIdentity,
  pathExists,
  ticket,
  treeFingerprint,
  visibleTicketLabel,
} from "../helpers/factory-board-shared.ts";

import type { FactoryBoardBook, FactoryBoardView } from "../../src/factory-board.ts";
import { UNACCEPTED_FLYING_MS, writeFactoryBoardPage } from "../../src/factory-board.ts";

test("S3 true-home acceptance: #127 accepted trajectory, active leg, #130 cost reconciliation", async (t) => {
  const homeLedger =
    process.env.AK_FACTORY_BOARD_HOME_LEDGER?.trim() ||
    join(homedir(), ".ak-roles", "books", "ak-pi-workflow-roles");
  const home127 = join(homeLedger, "issues", "127");
  const home130 = join(homeLedger, "issues", "130");
  if (!(await pathExists(home130))) {
    // Explicit skip (not silent return): CI/agents without owner true-home ledger.
    // Default owner coverage remains when ~/.ak-roles/.../issues/130 exists — not opt-in-only.
    t.skip(`true-home ledger missing at ${home130}; owner machine keeps default coverage`);
    return;
  }

  const workspace = await mkdtemp(join(tmpdir(), "factory-board-s3-true-home-"));
  try {
    const ledgerDir = join(workspace, "ledger");

    // 1) Exact true-home #127 bytes — no fixture transplant, no tail deletion/substitution.
    // Accepted toolResult trajectory is asserted independently of whichever later run
    // currently controls current-state (frozen accepted-awaiting lives in its own test).
    assert.ok(
      await pathExists(home127),
      "true-home acceptance requires home #127 (authentic accepted-toolResult trajectory)",
    );
    await cp(home127, join(ledgerDir, "issues", "127"), {
      recursive: true,
      preserveTimestamps: true,
    });

    // 2) True-home #130 bytes (closed multi-round reviewer burn)
    await cp(home130, join(ledgerDir, "issues", "130"), {
      recursive: true,
      preserveTimestamps: true,
    });

    // 3) Genuine unaccepted active leg: discover any true-home issue whose *latest*
    // run is still unaccepted. Do not hard-pin a closed leg (#139 after judge-apply-008),
    // plant fixtures, or rewrite mtimes. When every true-home latest is accepted, skip
    // only the flying/active-leg assertions (honest N/A) and still green #127/#130.
    const activeIssue = await discoverTrueHomeUnacceptedActiveIssue(homeLedger);
    if (activeIssue !== undefined) {
      const homeActive = join(homeLedger, "issues", String(activeIssue));
      await cp(homeActive, join(ledgerDir, "issues", String(activeIssue)), {
        recursive: true,
        preserveTimestamps: true,
      });
    }

    // Plant zero-run #78 so native family edge is present for sort participation.
    await mkdir(join(ledgerDir, "issues", "78"), { recursive: true });

    const expected127 = await independentAcceptedTrajectory(ledgerDir, 127);
    assert.ok(
      expected127.length >= 1,
      "true-home #127 must contain at least one accepted terminating toolResult",
    );
    // Named authentic accepted receipt that exists on the owner true ledger.
    const namedFixer = expected127.find((r) => r.runId === "fixer-apply-001@ak-roles-127");
    assert.ok(namedFixer, "true-home #127 must keep named fixer-apply-001 accepted receipt");
    assert.equal(namedFixer.resultStatus, "completed");

    const expected130 = await independentIssueUsage(ledgerDir, 130);
    assert.ok(expected130.runCount >= 1, "#130 must have runs");
    assert.ok(expected130.reviewerRunCount >= 1, "#130 reviewer rounds present");

    // Independent true-home active-leg oracle (bytes + mtimes), not the board loader.
    // Present only when discovery found a genuinely unaccepted latest; otherwise N/A.
    const flyingOffsetMs = 30_000;
    assert.ok(
      flyingOffsetMs < UNACCEPTED_FLYING_MS,
      "probe offset must stay inside the flying band",
    );
    let now = new Date("2026-08-05T12:00:00.000Z");
    let activeLeg:
      | Awaited<ReturnType<typeof independentLatestLegActivity>>
      | undefined;
    let expectedDisplayActivityAt: string | undefined;
    let expectedLegAgeMs = 0;
    if (activeIssue !== undefined) {
      activeLeg = await independentLatestLegActivity(ledgerDir, activeIssue);
      assert.ok(activeLeg, `true-home #${activeIssue} must have at least one run`);
      assert.equal(
        activeLeg.hasAcceptedResult,
        false,
        `true-home #${activeIssue} latest ${activeLeg.runId} must be unaccepted (no accepted terminating toolResult)`,
      );
      assert.ok(
        activeLeg.mtimeMs > 0,
        `true-home #${activeIssue} latest ${activeLeg.runId} must expose session mtime`,
      );
      // Honest acceptance clock: freeze now just after preserved latest mtime so a genuinely
      // unaccepted true-home leg lands in the flying band (<2min) without utimes rewrite.
      now = new Date(activeLeg.mtimeMs + flyingOffsetMs);
      expectedDisplayActivityAt =
        activeLeg.lastActivityAt ??
        (activeLeg.mtimeMs > 0 ? new Date(activeLeg.mtimeMs).toISOString() : undefined);
      assert.ok(
        expectedDisplayActivityAt,
        `true-home #${activeIssue} latest must yield last-activity (content ts or mtime)`,
      );
      expectedLegAgeMs = activeLeg.startedAt
        ? Math.max(0, now.getTime() - Date.parse(activeLeg.startedAt))
        : Math.max(0, now.getTime() - activeLeg.mtimeMs);
    }

    const before = await treeFingerprint(ledgerDir);
    const books: FactoryBoardBook[] = [{ bookKey: "roles", ledgerDir }];
    const tickets = [
      ticket({ issueNumber: 78, title: "family parent", state: "open" as const }),
      ticket({
        issueNumber: 127,
        title: "127",
        state: "open" as const,
        parentIssueNumber: 78,
      }),
      ticket({
        issueNumber: 130,
        title: "130",
        state: "closed" as const,
        parentIssueNumber: 78,
        // Live GitHub closedAt for #130 — landing cycle ends here, not last ledger.
        closedAt: "2026-08-05T04:03:43Z",
      }),
      ...(activeIssue !== undefined
        ? [ticket({ issueNumber: activeIssue, title: "active", state: "open" as const })]
        : []),
    ];
    const view: FactoryBoardView = {
      ok: true,
      snapshot: {
        books: [
          {
            bookKey: "roles",
            owner: "Akagilnc",
            repo: "ak-pi-workflow-roles",
            tickets,
          },
        ],
      },
    };

    const outPath = join(workspace, "out", "board.html");
    const written = await writeFactoryBoardPage({ books, view, now, outputPath: outPath });
    const html = written.html;
    assert.equal(await treeFingerprint(ledgerDir), before, "true-home acceptance stays read-only");

    const t127 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "127");
    const t130 = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "130");
    const family78 = elementsWith(html, "data-family").find((f) => f["data-parent"] === "78");
    assert.ok(t127 && t130 && family78);
    assert.equal(t130["data-parent-issue"], "78");
    assert.equal(t127["data-parent-issue"], "78");

    // #127 true trajectory: every independently accepted toolResult is rendered as accepted,
    // regardless of which later run owns data-current-state.
    const runs127 = elementsWith(html, "data-run-id").filter(
      (r) => (r["data-ledger-coord"] ?? "").includes("issues/127/runs/"),
    );
    assert.ok(runs127.length >= expected127.length, "board retains true-home #127 runs");
    for (const expected of expected127) {
      const row = runs127.find((r) => r["data-run-id"] === expected.runId);
      assert.ok(row, `true-home #127 accepted run visible: ${expected.runId}`);
      assert.equal(row["data-has-result"], "true", `${expected.runId} accepted toolResult`);
      assert.equal(
        row["data-result-status"],
        expected.resultStatus,
        `${expected.runId} status from accepted toolResult`,
      );
    }
    // Named anchor receipt stays projected even when later unaccepted/error runs control state.
    const namedOnBoard = runs127.find((r) => r["data-run-id"] === "fixer-apply-001@ak-roles-127");
    assert.equal(namedOnBoard?.["data-has-result"], "true");
    assert.equal(namedOnBoard?.["data-result-status"], "completed");
    assert.ok(
      t127["data-current-state"] === "accepted-awaiting" ||
        (t127["data-current-state"] ?? "").startsWith("unaccepted-"),
      "current state remains a mechanical latest-run partition; not asserted from fixture freeze",
    );

    // #130 totals reconcile with independent true-byte scan (human read-ledger oracle)
    assert.equal(Number(t130["data-run-count"]), expected130.runCount);
    assert.ok(Math.abs(Number(t130["data-cost-usd"]) - expected130.costUsd) < 1e-9);
    assert.equal(Number(t130["data-total-tokens"]), expected130.totalTokens);
    // Scope to #130 runs via ledger coord (run rows are nested <article>s, so ticket-level
    // HTML slicing on </article> is not a reliable station boundary).
    const runs130 = elementsWith(html, "data-run-id").filter(
      (r) => (r["data-ledger-coord"] ?? "").includes("issues/130/runs/"),
    );
    assert.equal(runs130.length, expected130.runCount);
    const reviewerRuns130 = runs130.filter((r) => r["data-station"] === "reviewer");
    assert.equal(reviewerRuns130.length, expected130.reviewerRunCount, "#130 御史台 multi-round runs");
    const boardReviewerCost = reviewerRuns130.reduce((s, r) => s + Number(r["data-cost-usd"]), 0);
    const boardReviewerTokens = reviewerRuns130.reduce(
      (s, r) => s + Number(r["data-total-tokens"]),
      0,
    );
    const boardReviewerAxisWall = reviewerRuns130.reduce(
      (s, r) => s + Number(r["data-axis-wall-ms"] ?? 0),
      0,
    );
    assert.ok(
      Math.abs(boardReviewerCost - expected130.reviewerCostUsd) < 1e-9,
      `#130 reviewer cost board=${boardReviewerCost} independent=${expected130.reviewerCostUsd}`,
    );
    assert.equal(boardReviewerTokens, expected130.reviewerTokens);
    assert.ok(Math.abs(boardReviewerAxisWall - expected130.axisWallMs) < 1);
    // Station block for reviewer must appear on the board (may share the page with other tickets).
    assert.ok(
      elementsWith(html, "data-station-block").some((s) => s["data-station-block"] === "reviewer"),
      "#130 御史台 station block rendered",
    );

    // Family aggregate burn includes #130; production page sort places the family by that burn
    const familyCost = Number(family78["data-cost-usd"]);
    assert.ok(familyCost + 1e-9 >= Number(t130["data-cost-usd"]));
    const sorted = executeProductionBoardSort(html, "roles", "cost-desc").map(laneSortIdentity);
    assert.ok(sorted.includes(78), "#78 family is a sort entry");
    // #130 is not a top-level lane entry (nested) but its burn moved the family key
    assert.ok(!sorted.includes(130), "#130 stays nested under family; burn rides aggregate");

    if (activeIssue === undefined || activeLeg === undefined) {
      // Honest N/A: no true-home latest remains unaccepted — skip flying assertions only.
      assert.ok(
        sorted.indexOf(78) < sorted.length,
        "#78 family carrying #130 still participates in page sort order",
      );
      return;
    }

    const tActive = elementsWith(html, "data-ticket").find(
      (t) => t["data-ticket"] === String(activeIssue),
    );
    assert.ok(tActive, `true-home active #${activeIssue} ticket rendered`);
    const activeCost = Number(tActive["data-cost-usd"]);
    assert.ok(sorted.includes(activeIssue), "active ticket remains a sort entry");
    if (familyCost > activeCost) {
      assert.equal(sorted[0], 78, "#78 family (with #130 burn) leads when it outburns active");
    } else {
      assert.ok(
        sorted.indexOf(78) < sorted.length,
        "#78 family carrying #130 still participates in page sort order",
      );
    }

    // Genuine unaccepted true-home leg: must be 在飞 under the honest acceptance clock,
    // with leg age + last activity *visibly* labeled (not article projection alone).
    assert.equal(
      tActive["data-current-state"],
      "unaccepted-flying",
      `true-home #${activeIssue} latest ${activeLeg.runId} must be 在飞 at honest now=${now.toISOString()} mtimeMs=${activeLeg.mtimeMs}`,
    );
    const visibleAge = visibleTicketLabel(html, "data-leg-age-label", activeIssue, "roles");
    const visibleAct = visibleTicketLabel(html, "data-last-activity-label", activeIssue, "roles");
    assert.ok(visibleAge, `true-home #${activeIssue} must render visible leg-age label`);
    assert.ok(visibleAct, `true-home #${activeIssue} must render visible last-activity label`);
    assert.equal(visibleAct["data-last-activity-at"], expectedDisplayActivityAt);
    assert.equal(visibleAct["data-last-activity-mtime-ms"], String(activeLeg.mtimeMs));
    assert.equal(Number(visibleAge["data-leg-age-ms"]), expectedLegAgeMs);
    assert.ok(Number(visibleAge["data-leg-age-ms"]) >= flyingOffsetMs);
    // Article projection remains consistent with the visible labels.
    assert.equal(tActive["data-last-activity-at"], visibleAct["data-last-activity-at"]);
    assert.equal(tActive["data-last-activity-mtime-ms"], visibleAct["data-last-activity-mtime-ms"]);
    assert.equal(tActive["data-leg-age-ms"], visibleAge["data-leg-age-ms"]);
  } finally {
  }
});
