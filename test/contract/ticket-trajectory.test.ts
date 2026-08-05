/**
 * S1 single-ticket trajectory — external behavior at the unique seam
 * `(ledgerDir, ticketSnapshot, now) → HTML`.
 *
 * Fixtures are clipped real ledger session bytes from #127
 * (multi-reject-then-accepted + multi-attempt-zero-accept morphs).
 * Assertions read machine data-* keys only (anchoring constitution).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_REFRESH_BOUNDARY_SECONDS,
  renderTicketTrajectoryHtml,
  writeTicketTrajectoryPage,
  type TicketSnapshot,
} from "../../src/ticket-trajectory.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureLedger = join(packageRoot, "test/fixtures/ticket-trajectory/ledger");

async function treeFingerprint(root: string): Promise<string> {
  const h = createHash("sha256");
  async function walk(dir: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = path.slice(root.length + 1).split(sep).join("/");
      h.update(rel);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) h.update(await readFile(path));
    }
  }
  await walk(root);
  return h.digest("hex");
}

/** Collect elements that carry a given data attribute; return attr maps. */
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

function runById(html: string, runId: string): Record<string, string> {
  const hit = elementsWith(html, "data-run-id").find((el) => el["data-run-id"] === runId);
  assert.ok(hit, `missing run ${runId}`);
  return hit;
}

test("unique seam renders #127 fixture trajectory: stations, attempts, trusted results only", async () => {
  const before = await treeFingerprint(fixtureLedger);
  const now = new Date("2026-08-05T12:00:00.000Z");
  const snapshot: TicketSnapshot = { issueNumber: 127 };
  const html = await renderTicketTrajectoryHtml(fixtureLedger, snapshot, now);
  assert.equal(await treeFingerprint(fixtureLedger), before, "ledger fixture must stay byte-identical");

  // Generation time + refresh boundary (machine keys).
  assert.match(html, /data-generated-at="2026-08-05T12:00:00\.000Z"/);
  assert.match(html, new RegExp(`data-refresh-boundary-seconds="${DEFAULT_REFRESH_BOUNDARY_SECONDS}"`));
  assert.match(html, /data-issue="127"/);

  // Morph A: plan-court — 5 terminating attempts, only final accepted counts as result.
  const planCourt = runById(html, "plan-court-001@ak-roles-127");
  assert.equal(planCourt["data-station"], "judge");
  assert.equal(planCourt["data-station-source"], "tool");
  assert.equal(planCourt["data-attempt-count"], "5");
  assert.equal(planCourt["data-has-result"], "true");
  assert.equal(planCourt["data-result-status"], "converged");
  assert.equal(planCourt["data-provider"], "openai-codex");
  assert.equal(planCourt["data-model"], "gpt-5.6-sol");
  assert.equal(planCourt["data-thinking"], "medium");
  assert.equal(
    planCourt["data-ledger-coord"],
    "issues/127/runs/plan-court-001@ak-roles-127",
  );

  // Morph B: review-005s — 4 attempts, zero accepted → not a completed result.
  const zero = runById(html, "review-005s@ak-roles-127");
  assert.equal(zero["data-station"], "reviewer");
  assert.equal(zero["data-station-source"], "tool");
  assert.equal(zero["data-attempt-count"], "4");
  assert.equal(zero["data-has-result"], "false");
  assert.equal(zero["data-result-status"], "");

  // Coder accepted planned result via tool-name station layer.
  const coder = runById(html, "coder-plan-001@ak-roles-127");
  assert.equal(coder["data-station"], "coder");
  assert.equal(coder["data-has-result"], "true");
  assert.equal(coder["data-result-status"], "planned");
  assert.equal(coder["data-provider"], "openai-codex");
  assert.equal(coder["data-model"], "gpt-5.6-sol");
  assert.equal(coder["data-thinking"], "low");

  // Fixer leg carries real model/provider/thinking from session mechanical fields.
  const fixer = runById(html, "fixer-apply-001@ak-roles-127");
  assert.equal(fixer["data-station"], "fixer");
  assert.equal(fixer["data-provider"], "xai");
  assert.equal(fixer["data-model"], "grok-4.5");
  assert.equal(fixer["data-thinking"], "high");
  assert.equal(fixer["data-has-result"], "true");
  assert.equal(fixer["data-result-status"], "completed");

  // Four-layer station chain: invocation.json role when no terminating tool.
  const invOnly = runById(html, "manual-leg-001@ak-roles-127");
  assert.equal(invOnly["data-station"], "collector");
  assert.equal(invOnly["data-station-source"], "invocation");
  assert.equal(invOnly["data-has-result"], "false");

  // Name heuristic when no tool and no invocation role.
  const named = runById(html, "doctor-probe-001@ak-roles-127");
  assert.equal(named["data-station"], "doctor");
  assert.equal(named["data-station-source"], "name");

  // Unknown station listed, count not dropped.
  const mystery = runById(html, "odd-scratch-001@ak-roles-127");
  assert.equal(mystery["data-station"], "unknown");
  assert.equal(mystery["data-station-source"], "unknown");
  assert.equal(mystery["data-has-result"], "false");

  // Every fixture run appears exactly once.
  const runs = elementsWith(html, "data-run-id");
  assert.equal(runs.length, 7);
  const ids = new Set(runs.map((r) => r["data-run-id"]));
  assert.equal(ids.size, 7);

  // Responsive single-page foundation (viewport + single root document).
  assert.match(html, /name="viewport"/i);
  assert.match(html, /<html\b/i);
  assert.equal((html.match(/<html\b/gi) ?? []).length, 1);
});

test("page lifecycle writes only outside the ledger and leaves the ledger unread-write", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ticket-trajectory-out-"));
  try {
    const ledgerCopy = join(workspace, "ledger");
    await cp(fixtureLedger, ledgerCopy, { recursive: true });
    const before = await treeFingerprint(ledgerCopy);
    const outputPath = join(workspace, "out", "issue-127.html");
    const now = new Date("2026-08-05T15:30:00.000Z");

    const written = await writeTicketTrajectoryPage({
      ledgerDir: ledgerCopy,
      ticketSnapshot: { issueNumber: 127 },
      now,
      outputPath,
    });

    assert.equal(written.outputPath, await realpath(outputPath).catch(async () => resolve(outputPath)));
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /data-generated-at="2026-08-05T15:30:00\.000Z"/);
    assert.equal(await treeFingerprint(ledgerCopy), before);

    // Refuse writing into the ledger tree.
    await assert.rejects(
      () =>
        writeTicketTrajectoryPage({
          ledgerDir: ledgerCopy,
          ticketSnapshot: { issueNumber: 127 },
          now,
          outputPath: join(ledgerCopy, "issues", "127", "board.html"),
        }),
      /outside|ledger|output/i,
    );
    assert.equal(await treeFingerprint(ledgerCopy), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("re-render after a new run appears updates generated-at and trajectory within refresh boundary", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ticket-trajectory-refresh-"));
  try {
    const ledgerCopy = join(workspace, "ledger");
    await cp(fixtureLedger, ledgerCopy, { recursive: true });
    const t1 = new Date("2026-08-05T16:00:00.000Z");
    const first = await renderTicketTrajectoryHtml(ledgerCopy, { issueNumber: 127 }, t1);
    assert.match(first, /data-generated-at="2026-08-05T16:00:00\.000Z"/);
    assert.equal(elementsWith(first, "data-run-id").length, 7);

    // Append a new accepted coder apply run (clipped real header + synthetic accepted receipt is NOT allowed;
    // copy an existing accepted run under a new name to simulate a newly arrived leg).
    const srcRun = join(ledgerCopy, "issues/127/runs/coder-plan-001@ak-roles-127");
    const newRun = join(ledgerCopy, "issues/127/runs/coder-apply-001@ak-roles-127");
    await cp(srcRun, newRun, { recursive: true });

    const t2 = new Date("2026-08-05T16:00:10.000Z");
    const second = await renderTicketTrajectoryHtml(ledgerCopy, { issueNumber: 127 }, t2);
    assert.match(second, /data-generated-at="2026-08-05T16:00:10\.000Z"/);
    assert.ok(elementsWith(second, "data-run-id").some((r) => r["data-run-id"] === "coder-apply-001@ak-roles-127"));
    assert.equal(elementsWith(second, "data-run-id").length, 8);
    // Page declares the refresh boundary so the same viewing surface can pick up new data.
    assert.match(second, new RegExp(`data-refresh-boundary-seconds="${DEFAULT_REFRESH_BOUNDARY_SECONDS}"`));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("empty/minimal ticket snapshot still requires issueNumber for S1 single-ticket seam", async () => {
  await assert.rejects(
    () => renderTicketTrajectoryHtml(fixtureLedger, {} as TicketSnapshot, new Date()),
    /issueNumber/,
  );
});

