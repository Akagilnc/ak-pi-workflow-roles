/**
 * S1 single-ticket trajectory — external behavior at the unique seam
 * `(ledgerDir, ticketSnapshot, now) → HTML` and the page lifecycle entry.
 *
 * Fixtures are clipped real ledger session bytes (trust morphs from #127;
 * station-layer runs keep authentic home-ledger directory names + bytes).
 * Assertions read machine data-* keys / hrefs only (anchoring constitution).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, readdir, realpath, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_REFRESH_BOUNDARY_SECONDS,
  readLedgerSessionJsonl,
  renderTicketTrajectoryHtml,
  startTicketTrajectoryPage,
  writeTicketTrajectoryPage,
  type TicketSnapshot,
  type TrajectoryScheduler,
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
      else if (entry.isSymbolicLink()) h.update(`symlink:${entry.name}`);
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

  // Four-layer station chain on authentic home-ledger run shapes (not renamed props).
  // Layer 2 — invocation.json role, no terminating tool (real doctor-live-accept run).
  const invOnly = runById(html, "doctor-live-accept-001@ak-pi-workflow-roles-issue40");
  assert.equal(invOnly["data-station"], "doctor");
  assert.equal(invOnly["data-station-source"], "invocation");
  assert.equal(invOnly["data-has-result"], "false");

  // Layer 3 — name heuristic when no tool and no invocation role (real review-002s).
  const named = runById(html, "review-002s@ak-roles-127");
  assert.equal(named["data-station"], "reviewer");
  assert.equal(named["data-station-source"], "name");
  assert.equal(named["data-has-result"], "false");

  // Layer 4 — unknown station listed, count not dropped (real prerequisite-* run; inv has no role).
  const mystery = runById(html, "prerequisite-repaired-head-greens@ak-pi-workflow-roles-issue44");
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

test("each run evidence link resolves to the run ledger path, with typed data-ledger-coord", async () => {
  const html = await renderTicketTrajectoryHtml(fixtureLedger, { issueNumber: 127 }, new Date("2026-08-05T12:00:00.000Z"));
  const links = elementsWith(html, "data-ledger-link");
  assert.equal(links.length, 7);

  for (const link of links) {
    const coord = link["data-ledger-link"];
    assert.ok(coord, "data-ledger-link present");
    assert.match(coord!, /^issues\/127\/runs\//);
    // Must not be a dead in-page fragment.
    assert.ok(link.href, "href present");
    assert.notEqual(link.href![0], "#");
    assert.match(link.href!, /^file:/);

    const url = new URL(link.href!);
    assert.equal(url.protocol, "file:");
    const targetPath = fileURLToPath(url);
    const expected = await realpath(join(fixtureLedger, ...coord!.split("/")));
    assert.equal(await realpath(targetPath), expected);

    // Typed coordinate retained on the run article.
    const runId = coord!.split("/").at(-1)!;
    const article = runById(html, runId);
    assert.equal(article["data-ledger-coord"], coord);
  }
});

test("page lifecycle writes only outside the ledger and blocks symlink escapes", async () => {
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

    assert.equal(written.outputPath, await realpath(outputPath));
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /data-generated-at="2026-08-05T15:30:00\.000Z"/);
    assert.equal(await treeFingerprint(ledgerCopy), before);

    // Refuse writing into the ledger tree (lexical path).
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

    // Output path is a symlink into the ledger — must refuse; ledger bytes unchanged.
    const injected = join(ledgerCopy, "injected.html");
    const symlinkOut = join(workspace, "escape-link.html");
    await writeFile(injected, "BEFORE\n", "utf8");
    const beforeInjected = await readFile(injected, "utf8");
    const beforeLedger = await treeFingerprint(ledgerCopy);
    await symlink(injected, symlinkOut);
    await assert.rejects(
      () =>
        writeTicketTrajectoryPage({
          ledgerDir: ledgerCopy,
          ticketSnapshot: { issueNumber: 127 },
          now,
          outputPath: symlinkOut,
        }),
      /outside|ledger|output/i,
    );
    assert.equal(await readFile(injected, "utf8"), beforeInjected);
    assert.equal(await treeFingerprint(ledgerCopy), beforeLedger);

    // Parent directory symlink into the ledger — refuse missing-tail create.
    const parentLink = join(workspace, "parent-link");
    await symlink(join(ledgerCopy, "issues", "127"), parentLink);
    await assert.rejects(
      () =>
        writeTicketTrajectoryPage({
          ledgerDir: ledgerCopy,
          ticketSnapshot: { issueNumber: 127 },
          now,
          outputPath: join(parentLink, "via-parent.html"),
        }),
      /outside|ledger|output/i,
    );
    assert.equal(await treeFingerprint(ledgerCopy), beforeLedger);

    // Nested missing tail under a symlink parent still blocked.
    await assert.rejects(
      () =>
        writeTicketTrajectoryPage({
          ledgerDir: ledgerCopy,
          ticketSnapshot: { issueNumber: 127 },
          now,
          outputPath: join(parentLink, "nested", "deep.html"),
        }),
      /outside|ledger|output/i,
    );
    assert.equal(await treeFingerprint(ledgerCopy), beforeLedger);
    // Ensure no file was created inside ledger via the parent link.
    await assert.rejects(() => lstat(join(ledgerCopy, "issues", "127", "via-parent.html")), /ENOENT/);
    await assert.rejects(() => lstat(join(ledgerCopy, "issues", "127", "nested")), /ENOENT/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("production lifecycle regenerates within refresh boundary and stops", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ticket-trajectory-live-"));
  try {
    const ledgerCopy = join(workspace, "ledger");
    await cp(fixtureLedger, ledgerCopy, { recursive: true });
    const before = await treeFingerprint(ledgerCopy);
    const outputPath = join(workspace, "out", "live.html");

    let nowMs = Date.parse("2026-08-05T16:00:00.000Z");
    const ticks: Array<() => void> = [];
    const scheduler: TrajectoryScheduler = {
      every(_ms, tick) {
        ticks.push(tick);
        return () => {
          const idx = ticks.indexOf(tick);
          if (idx >= 0) ticks.splice(idx, 1);
        };
      },
    };

    const handle = startTicketTrajectoryPage({
      ledgerDir: ledgerCopy,
      ticketSnapshot: { issueNumber: 127 },
      outputPath,
      refreshBoundarySeconds: 1,
      clock: () => new Date(nowMs),
      scheduler,
    });

    const first = await handle.started;
    assert.equal(first.outputPath, await realpath(outputPath));
    let html = await readFile(outputPath, "utf8");
    assert.match(html, /data-generated-at="2026-08-05T16:00:00\.000Z"/);
    assert.equal(elementsWith(html, "data-run-id").length, 7);
    assert.match(html, /data-refresh-boundary-seconds="1"/);
    assert.equal(ticks.length, 1, "lifecycle arms a real scheduler tick");

    // New run arrives in the ledger (copy of an authentic accepted run under a new id).
    const srcRun = join(ledgerCopy, "issues/127/runs/coder-plan-001@ak-roles-127");
    const newRun = join(ledgerCopy, "issues/127/runs/coder-apply-001@ak-roles-127");
    await cp(srcRun, newRun, { recursive: true });
    const afterAdd = await treeFingerprint(ledgerCopy);

    // Advance clock and fire the production scheduler tick (not a manual second render call).
    nowMs = Date.parse("2026-08-05T16:00:10.000Z");
    ticks[0]!();
    // Allow queued async write to settle.
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 20; i += 1) {
      html = await readFile(outputPath, "utf8");
      if (html.includes('data-generated-at="2026-08-05T16:00:10.000Z"')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(html, /data-generated-at="2026-08-05T16:00:10\.000Z"/);
    assert.ok(elementsWith(html, "data-run-id").some((r) => r["data-run-id"] === "coder-apply-001@ak-roles-127"));
    assert.equal(elementsWith(html, "data-run-id").length, 8);

    // Stop — further ticks must not rewrite the page.
    await handle.stop();
    assert.equal(ticks.length, 0, "stop cancels scheduler");
    const frozen = await readFile(outputPath, "utf8");
    const frozenAt = frozen.match(/data-generated-at="([^"]+)"/)?.[1];
    assert.equal(frozenAt, "2026-08-05T16:00:10.000Z");

    nowMs = Date.parse("2026-08-05T16:00:20.000Z");
    // Even if a stale tick reference existed, stop gate blocks writes; fire nothing registered.
    assert.equal(ticks.length, 0);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(await readFile(outputPath, "utf8"), frozen);

    // Lifecycle only wrote outside; ledger changed only by the test's explicit run copy.
    assert.equal(await treeFingerprint(ledgerCopy), afterAdd);
    assert.notEqual(afterAdd, before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("JSONL middle corruption fails loudly; unfinished tail stays tolerable", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ticket-trajectory-jsonl-"));
  try {
    const good = join(workspace, "good.jsonl");
    const tail = join(workspace, "tail.jsonl");
    const middle = join(workspace, "middle.jsonl");

    const row = (n: number) =>
      JSON.stringify({
        type: "session",
        version: 3,
        id: `id-${n}`,
        timestamp: `2026-08-05T12:00:0${n}.000Z`,
        cwd: "/tmp",
      });

    await writeFile(good, `${row(1)}\n${row(2)}\n`, "utf8");
    assert.equal((await readLedgerSessionJsonl(good)).length, 2);

    // Truncated unfinished tail (no complete record after the broken line).
    await writeFile(tail, `${row(1)}\n{"type":"session","id":`, "utf8");
    const tailRows = await readLedgerSessionJsonl(tail);
    assert.equal(tailRows.length, 1);

    // Malformed middle with a valid accepted-looking suffix after it — must throw.
    await writeFile(middle, `${row(1)}\nNOT-JSON\n${row(3)}\n`, "utf8");
    await assert.rejects(() => readLedgerSessionJsonl(middle), /malformed JSONL record in middle/i);

    // End-to-end: middle corruption must not render as a quiet attempts-only page.
    const ledgerCopy = join(workspace, "ledger");
    await cp(fixtureLedger, ledgerCopy, { recursive: true });
    const planSessionDir = join(ledgerCopy, "issues/127/runs/plan-court-001@ak-roles-127/session");
    const [sessionFile] = await readdir(planSessionDir);
    assert.ok(sessionFile);
    const sessionPath = join(planSessionDir, sessionFile!);
    const original = await readFile(sessionPath, "utf8");
    const lines = original.split("\n");
    // Inject a broken line early, keep later real records (including the accepted toolResult).
    const broken = [lines[0], "THIS_IS_NOT_JSON", ...lines.slice(1)].join("\n");
    await writeFile(sessionPath, broken, "utf8");

    await assert.rejects(
      () => renderTicketTrajectoryHtml(ledgerCopy, { issueNumber: 127 }, new Date("2026-08-05T12:00:00.000Z")),
      /malformed JSONL record in middle/i,
    );
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
