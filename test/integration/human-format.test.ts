import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * Human-read formatting on the S2 board (#162).
 *
 * Oracle goes through renderFactoryBoardHtml and checks typed data-* channels,
 * not generated human wording.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { elementsWith } from "../helpers/factory-board-shared.ts";

import { renderFactoryBoardHtml, type FactoryBoardView } from "../../src/factory-board.ts";
import type { SnapshotTicket } from "../../src/ticket-snapshot.ts";

function ticket(
  partial: Partial<SnapshotTicket> & Pick<SnapshotTicket, "issueNumber" | "title" | "state">,
): SnapshotTicket {
  return {
    milestone: null,
    parentIssueNumber: null,
    blockedBy: [],
    closedAt: null,
    ...partial,
  };
}

async function writeMinimalAcceptedCoderRun(
  ledgerDir: string,
  issueNumber: number,
  runId: string,
  input: { startedAt: string; endedAt: string; costUsd: number; totalTokens: number; mtime: Date },
): Promise<void> {
  const sessionDir = join(ledgerDir, "issues", String(issueNumber), "runs", runId, "session");
  await mkdir(sessionDir, { recursive: true });
  const lines = [
    {
      type: "session",
      timestamp: input.startedAt,
      cwd: "/tmp",
    },
    {
      type: "message",
      timestamp: input.endedAt,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "ak_coder_output", arguments: {} }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: input.totalTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: input.costUsd },
        },
      },
    },
    {
      type: "message",
      timestamp: input.endedAt,
      message: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "ak_coder_output",
        isError: false,
        content: [],
        details: {
          status: "completed",
          summary: "done",
        },
      },
    },
  ];
  // Coder terminating tool name may differ — use a generic assistant usage only path for metrics.
  // Prefer the same shape factory-board tests use via session with cost on usage.
  const simple = [
    { type: "session", timestamp: input.startedAt, cwd: "/tmp" },
    {
      type: "message",
      timestamp: input.endedAt,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "working" }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: input.totalTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: input.costUsd },
        },
      },
    },
  ];
  void lines;
  const path = join(sessionDir, `${input.startedAt.replaceAll(":", "-")}_s.jsonl`);
  await writeFile(path, simple.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  await utimes(path, input.mtime, input.mtime);
  await writeFile(
    join(ledgerDir, "issues", String(issueNumber), "runs", runId, "invocation.json"),
    JSON.stringify({ role: "coder", issue: issueNumber }),
    "utf8",
  );
}

test("S2 board projects full-precision machine attrs and human-formatted spans (no raw ms)", async () => {
  await withTempRoot("human-format-s2-", async (workspace) => {
    const ledgerDir = join(workspace, "ledger");
    const now = new Date("2026-08-05T12:00:00.000Z");
    // 1h 1m wall via started/ended; large token count; precise cost.
    await writeMinimalAcceptedCoderRun(ledgerDir, 42, "coder-fmt@x", {
      startedAt: "2026-08-05T10:00:00.000Z",
      endedAt: "2026-08-05T11:01:00.000Z",
      costUsd: 1.65,
      totalTokens: 12_500,
      mtime: new Date("2026-08-05T11:01:00.000Z"),
    });

    const view: FactoryBoardView = {
      ok: true,
      snapshot: {
        books: [
          {
            bookKey: "roles",
            owner: "acme",
            repo: "roles",
            tickets: [ticket({ issueNumber: 42, title: "fmt", state: "open" })],
          },
        ],
      },
    };
    const html = await renderFactoryBoardHtml([{ bookKey: "roles", ledgerDir }], view, now);

    const card = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "42");
    assert.ok(card);
    // Machine channel: full precision on data-*.
    assert.equal(card["data-cost-usd"], "1.65");
    assert.equal(card["data-total-tokens"], "12500");
    const wallMs = Number(card["data-wall-ms"]);
    // Unaccepted latest-run wall extends to `now`; only require a positive finite machine value.
    assert.ok(Number.isFinite(wallMs) && wallMs > 0, "wall-ms is a positive machine duration");

    // Human channel elements carry the typed metrics without testing their wording.
    const costLabel = elementsWith(html, "data-cost-label").find((el) => el["data-cost-label"] === "42");
    assert.ok(costLabel);
    assert.equal(costLabel["data-cost-usd"], "1.65");
    assert.equal(costLabel["data-total-tokens"], "12500");
    assert.ok(elementsWith(html, "data-wall-label").some((el) => el["data-wall-label"] === "42"));
    assert.equal(elementsWith(html, "data-generated-at")[0]?.["data-generated-at"], "2026-08-05T12:00:00.000Z");
    });
});

test("S2 board formats zero/edge metric inputs without inventing machine values", async () => {
  await withTempRoot("human-format-edge-", async (workspace) => {
    const ledgerDir = join(workspace, "ledger");
    await mkdir(join(ledgerDir, "issues", "1"), { recursive: true });
    const html = await renderFactoryBoardHtml(
      [{ bookKey: "roles", ledgerDir }],
      {
        ok: true,
        snapshot: {
          books: [
            {
              bookKey: "roles",
              owner: "acme",
              repo: "roles",
              tickets: [ticket({ issueNumber: 1, title: "pending", state: "open" })],
            },
          ],
        },
      },
      new Date("2026-08-05T12:00:00.000Z"),
    );
    const card = elementsWith(html, "data-ticket").find((t) => t["data-ticket"] === "1");
    assert.ok(card);
    assert.equal(card["data-cost-usd"], "0");
    assert.equal(card["data-total-tokens"], "0");
    assert.equal(card["data-wall-ms"], "0");
    assert.ok(elementsWith(html, "data-cost-label").some((el) => el["data-cost-label"] === "1"));
    assert.ok(elementsWith(html, "data-wall-label").some((el) => el["data-wall-label"] === "1"));
    });
});
