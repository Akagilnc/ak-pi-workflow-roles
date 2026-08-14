import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "../../src/activation-ledger-topology.ts";
import { admitJudgeInvocation } from "../../src/public-cli/invocation.ts";
import {
  parseTicketNumberFrontmatter,
  resolveTicketNumberFromAttachmentBodies,
} from "../../src/ticket-frontmatter.ts";
import {
  buildTicketTrajectoryBookIndex,
  loadTicketTrajectoryRuns,
  loadUnboundTrajectoryRuns,
} from "../../src/ticket-trajectory.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-ticket-"));
  try {
    return await scenario(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "ticket@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Ticket Test"], { cwd: root });
}

test("parseTicketNumberFrontmatter reads only typed frontmatter field", () => {
  assert.equal(
    parseTicketNumberFrontmatter("---\nticketNumber: 176\n---\n# free text 999\n"),
    176,
  );
  assert.equal(parseTicketNumberFrontmatter("# free text ticketNumber: 176\n"), undefined);
  assert.equal(parseTicketNumberFrontmatter("---\ntitle: x\n---\n"), undefined);
  assert.equal(parseTicketNumberFrontmatter("---\nticketNumber: 0\n---\n"), undefined);
  assert.equal(
    resolveTicketNumberFromAttachmentBodies([
      "---\nticketNumber: 176\n---\n",
      "---\nticketNumber: 177\n---\n",
    ]),
    undefined,
  );
  assert.equal(
    resolveTicketNumberFromAttachmentBodies([
      "plain",
      "---\nticketNumber: 176\n---\n",
    ]),
    176,
  );
});

test("admitJudgeInvocation without typed face still admits unbound", async () => {
  await withTempHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), "ak-ticket-repo-"));
    try {
      seedGitProject(cwd);
      const projectRoot = resolve(cwd);
      const plain = join(home, "note.txt");
      await writeFile(plain, "no frontmatter", "utf8");
      const admitted = await admitJudgeInvocation({
        home,
        cwd: projectRoot,
        instruction: "review this",
        attachmentPaths: [plain],
        createRunId: () => "run-no-ticket",
      });
      assert.equal(admitted.ticketNumber, undefined);
      assert.equal(admitted.correlationId, undefined);
      const ledgerHome = resolveActivationLedgerHome(() => home);
      const bookKey = resolveBookKeyFromGit(projectRoot);
      const bookDir = activationBookDirectory(ledgerHome, bookKey);
      const runDirectory = join(bookDir, "runs", "run-no-ticket@judge");
      assert.equal(admitted.runDirectory, runDirectory);
      assert.equal(existsSync(runDirectory), true);

      const invocation = JSON.parse(
        await readFile(join(runDirectory, "invocation.json"), "utf8"),
      ) as { ticketNumber?: number };
      assert.equal(invocation.ticketNumber, undefined);

      const index = await buildTicketTrajectoryBookIndex(bookDir);
      assert.equal(index.unboundRuns.some((r) => r.runFolder === "run-no-ticket@judge"), true);
      const ticketRuns = await loadTicketTrajectoryRuns(bookDir, 176, index);
      assert.equal(ticketRuns.some((r) => r.runId === "run-no-ticket@judge"), false);
      const unbound = await loadUnboundTrajectoryRuns(bookDir, index);
      assert.equal(unbound.some((r) => r.run.runId === "run-no-ticket@judge"), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("admit with typed ticket face freezes, persists, and boards to that ticket", async () => {
  await withTempHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), "ak-ticket-repo-"));
    try {
      seedGitProject(cwd);
      const projectRoot = resolve(cwd);
      const ticketFace = join(home, "ticket-176.md");
      await writeFile(
        ticketFace,
        "---\nticketNumber: 176\n---\n# #176 progress board\nprose must not bind\n",
        "utf8",
      );
      const admitted = await admitJudgeInvocation({
        home,
        cwd: projectRoot,
        instruction: "review this",
        attachmentPaths: [ticketFace],
        createRunId: () => "run-with-ticket",
      });
      assert.equal(admitted.ticketNumber, 176);
      assert.equal(admitted.correlationId, undefined);
      assert.equal(admitted.attachments.length, 1);

      const frozen = await readFile(admitted.attachments[0]!.frozenPath, "utf8");
      assert.equal(parseTicketNumberFrontmatter(frozen), 176);

      const ledgerHome = resolveActivationLedgerHome(() => home);
      const bookKey = resolveBookKeyFromGit(projectRoot);
      const bookDir = activationBookDirectory(ledgerHome, bookKey);
      const runDirectory = join(bookDir, "runs", "run-with-ticket@judge");
      assert.equal(admitted.runDirectory, runDirectory);

      const admittedRequest = JSON.parse(
        await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
      ) as { ticketNumber?: number };
      assert.equal(admittedRequest.ticketNumber, 176);

      const invocation = JSON.parse(
        await readFile(join(runDirectory, "invocation.json"), "utf8"),
      ) as { ticketNumber?: number };
      assert.equal(invocation.ticketNumber, 176);

      // No lease/claim sidecars or ticket-binding waiting facts.
      assert.equal(existsSync(join(bookDir, "dispatch-lease.json")), false);
      if (existsSync(join(bookDir, "waiting.jsonl"))) {
        const waiting = await readFile(join(bookDir, "waiting.jsonl"), "utf8");
        assert.equal(waiting.includes("ticket-binding"), false);
        assert.equal(waiting.includes("dispatch-lease"), false);
      }

      const index = await buildTicketTrajectoryBookIndex(bookDir);
      const ticketRuns = await loadTicketTrajectoryRuns(bookDir, 176, index);
      assert.equal(ticketRuns.some((r) => r.runId === "run-with-ticket@judge"), true);
      const other = await loadTicketTrajectoryRuns(bookDir, 177, index);
      assert.equal(other.some((r) => r.runId === "run-with-ticket@judge"), false);
      const unbound = await loadUnboundTrajectoryRuns(bookDir, index);
      assert.equal(unbound.some((r) => r.run.runId === "run-with-ticket@judge"), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
