/**
 * S1 single-ticket trajectory — external behavior at the unique seam
 * `(ledgerDir, ticketSnapshot, now) → HTML` and the page lifecycle entry.
 *
 * Fixtures under issues/127 are clipped authentic #127 home-ledger bytes.
 * issues/40 and issues/44 hold auxiliary authentic counterexamples at their
 * real coordinates (not smuggled under 127). Assertions read machine data-*
 * keys / hrefs only (anchoring constitution).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile, rm } from "node:fs/promises";
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
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";

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

function manualScheduler(): { scheduler: TrajectoryScheduler; ticks: Array<() => void> } {
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
  return { scheduler, ticks };
}

test("unique seam renders #127 fixture trajectory: stations, attempts, trusted results only", async () => {
  const before = await treeFingerprint(fixtureLedger);
  const now = new Date("2026-08-05T12:00:00.000Z");
  const snapshot: TicketSnapshot = { issueNumber: 127 };
  const html = await renderTicketTrajectoryHtml(fixtureLedger, snapshot, now);
  assert.equal(await treeFingerprint(fixtureLedger), before, "ledger fixture must stay byte-identical");

  // Generation time + one-shot lifecycle (unique seam does not advertise refresh).
  assert.match(html, /data-generated-at="2026-08-05T12:00:00\.000Z"/);
  assert.equal(elementsWith(html, "data-lifecycle")[0]?.["data-lifecycle"], "oneshot");
  assert.equal(elementsWith(html, "data-refresh-boundary-seconds").length, 0);
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

  // Four-layer station chain on authentic coordinates.
  // Layer 1 — terminating tool (above: plan-court / coder / fixer / review-005s).
  // Layer 2 — invocation.json role, no terminating tool (authentic review-026).
  const invOnly = runById(html, "review-026@ak-roles-127");
  assert.equal(invOnly["data-station"], "reviewer");
  assert.equal(invOnly["data-station-source"], "invocation");
  assert.equal(invOnly["data-has-result"], "false");

  // Layer 3 — name heuristic when no tool and no invocation role (authentic review-002s).
  const named = runById(html, "review-002s@ak-roles-127");
  assert.equal(named["data-station"], "reviewer");
  assert.equal(named["data-station-source"], "name");
  assert.equal(named["data-has-result"], "false");

  // Every #127 fixture run appears exactly once.
  const runs = elementsWith(html, "data-run-id");
  assert.equal(runs.length, 6);
  const ids = new Set(runs.map((r) => r["data-run-id"]));
  assert.equal(ids.size, 6);

  // Per-station round total is user-visible and agrees with data-round-count.
  // #127: judge=1, coder=1, fixer=1, reviewer=3 (005s + 026 + 002s).
  const stations = elementsWith(html, "data-station-block");
  assert.ok(stations.length >= 4);
  const expectedRounds: Record<string, string> = {
    judge: "1",
    coder: "1",
    fixer: "1",
    reviewer: "3",
  };
  for (const st of stations) {
    const name = st["data-station-block"]!;
    const count = st["data-round-count"]!;
    if (expectedRounds[name] !== undefined) {
      assert.equal(count, expectedRounds[name], `round total for ${name}`);
    }
    const marker = `data-station-block="${name}"`;
    const sectionAt = html.indexOf(marker);
    assert.ok(sectionAt >= 0, `station block for ${name}`);
  }
});

test("auxiliary fixtures at authentic issue coords cover invocation-unknown station layers", async () => {
  // Layer 2 auxiliary (issue 40 doctor) — real home path, not smuggled under 127.
  const doctorHtml = await renderTicketTrajectoryHtml(
    fixtureLedger,
    { issueNumber: 40 },
    new Date("2026-08-05T12:00:00.000Z"),
  );
  const doctor = runById(doctorHtml, "doctor-live-accept-001@ak-pi-workflow-roles-issue40");
  assert.equal(doctor["data-station"], "doctor");
  assert.equal(doctor["data-station-source"], "invocation");
  assert.equal(doctor["data-has-result"], "false");
  assert.equal(
    doctor["data-ledger-coord"],
    "issues/40/runs/doctor-live-accept-001@ak-pi-workflow-roles-issue40",
  );

  // Layer 4 — unknown station listed, count not dropped (issue 44; inv has no role).
  const unknownHtml = await renderTicketTrajectoryHtml(
    fixtureLedger,
    { issueNumber: 44 },
    new Date("2026-08-05T12:00:00.000Z"),
  );
  const mystery = runById(
    unknownHtml,
    "prerequisite-repaired-head-greens@ak-pi-workflow-roles-issue44",
  );
  assert.equal(mystery["data-station"], "unknown");
  assert.equal(mystery["data-station-source"], "unknown");
  assert.equal(mystery["data-has-result"], "false");
  assert.equal(
    mystery["data-ledger-coord"],
    "issues/44/runs/prerequisite-repaired-head-greens@ak-pi-workflow-roles-issue44",
  );
});

test("each run evidence link resolves to the run ledger path, with typed data-ledger-coord", async () => {
  const html = await renderTicketTrajectoryHtml(fixtureLedger, { issueNumber: 127 }, new Date("2026-08-05T12:00:00.000Z"));
  const links = elementsWith(html, "data-ledger-link");
  assert.equal(links.length, 6);

  for (const linkEl of links) {
    const coord = linkEl["data-ledger-link"];
    assert.ok(coord, "data-ledger-link present");
    assert.match(coord!, /^issues\/127\/runs\//);
    // Must not be a dead in-page fragment.
    assert.ok(linkEl.href, "href present");
    assert.notEqual(linkEl.href![0], "#");
    assert.match(linkEl.href!, /^file:/);

    const url = new URL(linkEl.href!);
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

test("page lifecycle writes only outside the ledger; hard link cannot smuggle bytes back", async () => {
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
    // One-shot write path does not declare a refresh bound.
    assert.equal(elementsWith(html, "data-lifecycle")[0]?.["data-lifecycle"], "oneshot");
    assert.equal(elementsWith(html, "data-refresh-boundary-seconds").length, 0);
    assert.equal(await treeFingerprint(ledgerCopy), before);

    // Hard link: external outputPath shares an inode with a ledger file.
    // Write must replace the external dirent without mutating ledger bytes.
    const ledgerTwin = join(ledgerCopy, "issues", "127", "hardlink-twin.html");
    const hardOut = join(workspace, "hard-out.html");
    await writeFile(ledgerTwin, "LEDGER-PROTECTED\n", "utf8");
    await link(ledgerTwin, hardOut);
    const beforeTwin = await readFile(ledgerTwin, "utf8");
    const beforeIno = (await lstat(ledgerTwin)).ino;
    assert.equal((await lstat(hardOut)).ino, beforeIno);
    const beforeLedger = await treeFingerprint(ledgerCopy);

    const hardWritten = await writeTicketTrajectoryPage({
      ledgerDir: ledgerCopy,
      ticketSnapshot: { issueNumber: 127 },
      now,
      outputPath: hardOut,
    });
    assert.equal(hardWritten.outputPath, await realpath(hardOut));
    const externalHtml = await readFile(hardOut, "utf8");
    assert.match(externalHtml, /data-issue="127"/);
    assert.notEqual(externalHtml, beforeTwin);
    // Ledger twin keeps original bytes and inode; external dirent is a new inode.
    assert.equal(await readFile(ledgerTwin, "utf8"), beforeTwin);
    assert.equal((await lstat(ledgerTwin)).ino, beforeIno);
    assert.notEqual((await lstat(hardOut)).ino, beforeIno);
    // Fingerprint excludes only the twin we added before the write — recompute without twin change.
    assert.equal(await readFile(ledgerTwin, "utf8"), "LEDGER-PROTECTED\n");
    // Full tree fingerprint: twin content unchanged; no other ledger writes.
    assert.equal(await treeFingerprint(ledgerCopy), beforeLedger);

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

    // Output path is a symlink into the ledger — must refuse; ledger bytes unchanged.
    const injected = join(ledgerCopy, "injected.html");
    const symlinkOut = join(workspace, "escape-link.html");
    await writeFile(injected, "BEFORE\n", "utf8");
    const beforeInjected = await readFile(injected, "utf8");
    const beforeLedger2 = await treeFingerprint(ledgerCopy);
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
    assert.equal(await treeFingerprint(ledgerCopy), beforeLedger2);

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
    assert.equal(await treeFingerprint(ledgerCopy), beforeLedger2);

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
    assert.equal(await treeFingerprint(ledgerCopy), beforeLedger2);
    await assert.rejects(() => lstat(join(ledgerCopy, "issues", "127", "via-parent.html")), /ENOENT/);
    await assert.rejects(() => lstat(join(ledgerCopy, "issues", "127", "nested")), /ENOENT/);
  } finally {
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
    const { scheduler, ticks } = manualScheduler();

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
    // Keyed lifecycle facts (one place): refresh bound is declared and backed by a scheduler.
    assert.equal(elementsWith(html, "data-lifecycle")[0]?.["data-lifecycle"], "refresh");
    assert.equal(
      elementsWith(html, "data-refresh-boundary-seconds")[0]?.["data-refresh-boundary-seconds"],
      "1",
    );
    assert.equal(elementsWith(html, "data-generated-at")[0]?.["data-generated-at"], "2026-08-05T16:00:00.000Z");
    assert.equal(elementsWith(html, "data-run-id").length, 6);
    assert.equal(ticks.length, 1, "lifecycle arms a real scheduler tick");

    // New run arrives in the ledger (copy of an authentic accepted run under a new id).
    const srcRun = join(ledgerCopy, "issues/127/runs/coder-plan-001@ak-roles-127");
    const newRun = join(ledgerCopy, "issues/127/runs/coder-apply-001@ak-roles-127");
    await cp(srcRun, newRun, { recursive: true });
    const afterAdd = await treeFingerprint(ledgerCopy);

    // Advance clock and fire the production scheduler tick (not a manual second render call).
    nowMs = Date.parse("2026-08-05T16:00:10.000Z");
    ticks[0]!();
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 20; i += 1) {
      html = await readFile(outputPath, "utf8");
      if (html.includes('data-generated-at="2026-08-05T16:00:10.000Z"')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(elementsWith(html, "data-generated-at")[0]?.["data-generated-at"], "2026-08-05T16:00:10.000Z");
    assert.ok(elementsWith(html, "data-run-id").some((r) => r["data-run-id"] === "coder-apply-001@ak-roles-127"));
    assert.equal(elementsWith(html, "data-run-id").length, 7);

    // Stop — further ticks must not rewrite the page.
    await handle.stop();
    assert.equal(ticks.length, 0, "stop cancels scheduler");
    const frozen = await readFile(outputPath, "utf8");
    const frozenAt = elementsWith(frozen, "data-generated-at")[0]?.["data-generated-at"];
    assert.equal(frozenAt, "2026-08-05T16:00:10.000Z");

    nowMs = Date.parse("2026-08-05T16:00:20.000Z");
    assert.equal(ticks.length, 0);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(await readFile(outputPath, "utf8"), frozen);

    // Lifecycle only wrote outside; ledger changed only by the test's explicit run copy.
    assert.equal(await treeFingerprint(ledgerCopy), afterAdd);
    assert.notEqual(afterAdd, before);

    // Default boundary constant remains the production default (no second lifecycle tracer).
    assert.equal(DEFAULT_REFRESH_BOUNDARY_SECONDS, 30);
  } finally {
  }
});

test("JSONL completed malformed lines fail loudly; unfinished tail stays tolerable", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ticket-trajectory-jsonl-"));
  try {
    const good = join(workspace, "good.jsonl");
    const tail = join(workspace, "tail.jsonl");
    const middle = join(workspace, "middle.jsonl");
    const completedFinal = join(workspace, "completed-final.jsonl");

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

    // Truncated unfinished tail (no record terminator after the broken fragment).
    await writeFile(tail, `${row(1)}\n{"type":"session","id":`, "utf8");
    const tailRows = await readLedgerSessionJsonl(tail);
    assert.equal(tailRows.length, 1);

    // Malformed middle with a valid accepted-looking suffix after it — must throw.
    await writeFile(middle, `${row(1)}\nNOT-JSON\n${row(3)}\n`, "utf8");
    await assert.rejects(
      () => readLedgerSessionJsonl(middle),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /malformed JSONL record/i);
        assert.match(err.message, /at line 2/);
        assert.ok(err.message.includes(middle), "error must carry file context");
        return true;
      },
    );

    // Completed-by-terminator final malformed line with nothing after — must throw.
    // Prior heuristic ("no non-empty line follows") would silently return [].
    await writeFile(completedFinal, "NOT-JSON\n", "utf8");
    await assert.rejects(
      () => readLedgerSessionJsonl(completedFinal),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /malformed JSONL record/i);
        assert.match(err.message, /at line 1/);
        assert.ok(err.message.includes(completedFinal), "error must carry file context");
        return true;
      },
    );
    await writeFile(completedFinal, `${row(1)}\nNOT-JSON\n`, "utf8");
    await assert.rejects(
      () => readLedgerSessionJsonl(completedFinal),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /malformed JSONL record/i);
        assert.match(err.message, /at line 2/);
        assert.ok(err.message.includes(completedFinal), "error must carry file context");
        return true;
      },
    );

    // End-to-end: middle corruption must not render as a quiet attempts-only page.
    const ledgerCopy = join(workspace, "ledger");
    await cp(fixtureLedger, ledgerCopy, { recursive: true });
    const planSessionDir = join(ledgerCopy, "issues/127/runs/plan-court-001@ak-roles-127/session");
    const [sessionFile] = await readdir(planSessionDir);
    assert.ok(sessionFile);
    const sessionPath = join(planSessionDir, sessionFile!);
    const original = await readFile(sessionPath, "utf8");
    const lines = original.split("\n");
    const broken = [lines[0], "THIS_IS_NOT_JSON", ...lines.slice(1)].join("\n");
    await writeFile(sessionPath, broken, "utf8");

    await assert.rejects(
      () => renderTicketTrajectoryHtml(ledgerCopy, { issueNumber: 127 }, new Date("2026-08-05T12:00:00.000Z")),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /malformed JSONL record/i);
        assert.match(err.message, /at line 2/);
        assert.ok(
          err.message.includes(sessionPath) || err.message.includes("plan-court-001"),
          "error must carry file context",
        );
        return true;
      },
    );

    // End-to-end: completed final malformed line (terminator, nothing after) must also
    // fail through the production render seam — never a quiet empty/under-count page.
    const originalLines = original.endsWith("\n") ? original.slice(0, -1).split("\n") : original.split("\n");
    const withCompletedFinalJunk = `${originalLines.join("\n")}\nNOT-JSON\n`;
    await writeFile(sessionPath, withCompletedFinalJunk, "utf8");
    const expectedFinalLine = originalLines.length + 1;
    await assert.rejects(
      () => renderTicketTrajectoryHtml(ledgerCopy, { issueNumber: 127 }, new Date("2026-08-05T12:00:00.000Z")),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /malformed JSONL record/i);
        assert.match(err.message, new RegExp(`at line ${expectedFinalLine}`));
        assert.ok(
          err.message.includes(sessionPath) || err.message.includes("plan-court-001"),
          "error must carry file context",
        );
        return true;
      },
    );

    // Complete non-object JSONL (null/array/primitive) must fail cause-preservingly
    // through the production render seam — never silently under-count.
    // Unfinished-tail tolerance above remains lawful (syntax error only).
    await writeFile(sessionPath, original, "utf8");
    const nonObjectLine = "null";
    const withNonObject = [lines[0], nonObjectLine, ...lines.slice(1)].join("\n");
    await writeFile(sessionPath, withNonObject, "utf8");
    await assert.rejects(
      () => renderTicketTrajectoryHtml(ledgerCopy, { issueNumber: 127 }, new Date("2026-08-05T12:00:00.000Z")),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /complete non-object JSONL record/i);
        assert.match(err.message, /at line 2/);
        assert.match(err.message, /expected object, got null/);
        assert.ok(
          err.message.includes(sessionPath) || err.message.includes("plan-court-001"),
          "error must carry file context",
        );
        return true;
      },
    );
  } finally {
  }
});

test("empty/minimal ticket snapshot still requires issueNumber for S1 single-ticket seam", async () => {
  await assert.rejects(
    () => renderTicketTrajectoryHtml(fixtureLedger, {} as TicketSnapshot, new Date()),
    /issueNumber/,
  );
});

test("post-start regeneration failure faults the lifecycle with the original cause", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ticket-trajectory-fault-"));
  try {
    const ledgerCopy = join(workspace, "ledger");
    await cp(fixtureLedger, ledgerCopy, { recursive: true });
    const outputPath = join(workspace, "out", "live.html");

    let nowMs = Date.parse("2026-08-05T18:00:00.000Z");
    const { scheduler, ticks } = manualScheduler();

    const handle = startTicketTrajectoryPage({
      ledgerDir: ledgerCopy,
      ticketSnapshot: { issueNumber: 127 },
      outputPath,
      refreshBoundarySeconds: 1,
      clock: () => new Date(nowMs),
      scheduler,
    });

    await handle.started;
    assert.equal(ticks.length, 1);

    // Force a post-start write failure: replace the output path with a directory.
    await rm(outputPath, { force: true });
    await mkdir(outputPath);

    nowMs = Date.parse("2026-08-05T18:00:10.000Z");
    ticks[0]!();

    // closed must reject with the original cause (not hang / not resolve clean).
    const closedError = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("closed did not settle after fault")), 1000);
      handle.closed.then(
        () => {
          clearTimeout(timer);
          reject(new Error("closed resolved after regeneration fault"));
        },
        (error) => {
          clearTimeout(timer);
          resolve(error);
        },
      );
    });
    assert.ok(closedError instanceof Error, "fault retains an Error cause");
    assert.equal(ticks.length, 0, "fault cancels further regeneration");

    // stop surfaces the same original cause — no silent success.
    await assert.rejects(() => handle.stop(), (error: unknown) => error === closedError);
  } finally {
  }
});

test("malformed invocation.json and unexpected path resolution retain their causes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ticket-trajectory-evidence-"));
  try {
    const ledgerCopy = join(workspace, "ledger");
    await cp(fixtureLedger, ledgerCopy, { recursive: true });

    // Malformed existing invocation.json must fail with parse cause — not fall back to name/unknown.
    const invPath = join(
      ledgerCopy,
      "issues/127/runs/review-026@ak-roles-127/invocation.json",
    );
    await writeFile(invPath, "{not-json", "utf8");
    await assert.rejects(
      () => renderTicketTrajectoryHtml(ledgerCopy, { issueNumber: 127 }, new Date("2026-08-05T12:00:00.000Z")),
      (error: unknown) => error instanceof SyntaxError,
    );

    // Unexpected realpath failure (symlink cycle on ledger root) must not be
    // relabeled as a lexical path at the write/output gate.
    const cycleA = join(workspace, "cycle-a");
    const cycleB = join(workspace, "cycle-b");
    const loopLedger = join(workspace, "loop-ledger");
    await symlink(cycleB, cycleA);
    await symlink(cycleA, cycleB);
    await symlink(cycleA, loopLedger);

    await assert.rejects(
      () =>
        writeTicketTrajectoryPage({
          ledgerDir: loopLedger,
          ticketSnapshot: { issueNumber: 127 },
          now: new Date("2026-08-05T12:00:00.000Z"),
          outputPath: join(workspace, "out", "loop.html"),
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ELOOP",
    );
  } finally {
  }
});
