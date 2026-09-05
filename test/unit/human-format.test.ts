/**
 * Human-read formatting on the S2 board (#162).
 *
 * Machines bite full-precision data-* values; humans see formatted spans.
 * Oracle goes through renderFactoryBoardHtml — no direct helper contracts,
 * no exact Chinese wording locks.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderFactoryBoardHtml, type FactoryBoardView } from "../../src/factory-board.ts";
import type { SnapshotTicket } from "../../src/ticket-snapshot.ts";
import { testTmpdir } from "../helpers/worktree-temp.ts";

function elementsWith(html: string, dataAttr: string): Record<string, string>[] {
  const re = new RegExp(`<[^>]+\\b${dataAttr}="[^"]*"[^>]*>`, "g");
  const out: Record<string, string>[] = [];
  for (const tag of html.match(re) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/\b(data-[a-z0-9-]+|href)="([^"]*)"/g)) {
      attrs[m[1]!] = m[2]!;
    }
    out.push(attrs);
  }
  return out;
}

/** Inner text of the first element carrying attr=value (stops at nested tag). */
function labeledText(html: string, attr: string, value: string): string {
  const re = new RegExp(`<[^>]+\\b${attr}="${value}"[^>]*>([^<]*)`);
  const m = html.match(re);
  assert.ok(m, `missing labeled element ${attr}=${value}`);
  return m[1] ?? "";
}

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
  const workspace = await mkdtemp(join(testTmpdir(), "human-format-s2-"));
  try {
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

    // Human channel: cost/token/wall labels exist and are not the raw machine spelling.
    const costLabel = elementsWith(html, "data-cost-label").find((el) => el["data-cost-label"] === "42");
    assert.ok(costLabel);
    assert.equal(costLabel["data-cost-usd"], "1.65");
    assert.equal(costLabel["data-total-tokens"], "12500");
    const costText = labeledText(html, "data-cost-label", "42");
    assert.ok(costText.includes("1.65") || /\$/.test(costText), "cost span shows a currency amount");
    // Compact tokens: large counts are not left as the full integer alone in the human span.
    assert.ok(!/^\s*\$?1\.65\s*·\s*12500\s*tok\s*$/.test(costText), "tokens should be compacted for humans");
    assert.match(costText, /k|M/i, "compact token category (k/M) for ≥1000");

    const wallText = labeledText(html, "data-wall-label", "42");
    assert.ok(wallText.length > 0, "wall label present");
    assert.ok(!wallText.includes("3660000"), "human wall span must not echo raw ms");
    // Duration category: contains a unit marker (Chinese or latin), not only digits.
    assert.ok(/\D/.test(wallText.replace(/\s/g, "")), "duration text carries unit category, not bare number");

    // Generated-at human local time sits on <time datetime=ISO>…formatted…</time>
    assert.match(html, /data-generated-at="2026-08-05T12:00:00\.000Z"/);
    assert.match(html, /datetime="2026-08-05T12:00:00\.000Z"/);
    const timeText = html.match(/<time[^>]*datetime="2026-08-05T12:00:00\.000Z"[^>]*>([^<]*)<\/time>/);
    assert.ok(timeText?.[1]);
    assert.notEqual(timeText[1], "2026-08-05T12:00:00.000Z", "local wall clock differs from raw ISO");
    assert.match(timeText[1]!, /\d{4}-\d{2}-\d{2}/, "local time keeps a calendar date shape");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("S2 board formats zero/edge metric inputs without inventing machine values", async () => {
  const workspace = await mkdtemp(join(testTmpdir(), "human-format-edge-"));
  try {
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
    const costText = labeledText(html, "data-cost-label", "1");
    assert.ok(costText.includes("0"), "zero cost remains visibly zero");
    const wallText = labeledText(html, "data-wall-label", "1");
    assert.ok(!wallText.includes("NaN") && !wallText.includes("Infinity"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
