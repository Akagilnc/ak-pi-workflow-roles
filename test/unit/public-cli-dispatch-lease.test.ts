import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { activationBookDirectory, resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import { admitJudgeInvocation } from "../../src/public-cli/invocation.ts";
import { offerTicketDispatchLease, TICKET_BINDING_EVENT } from "../../src/ticket-dispatch-lease.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-lease-"));
  try {
    return await scenario(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "lease@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Lease Test"], { cwd: root });
}

test("admitJudgeInvocation without offer is CliUsageError and creates no run directory", async () => {
  await withTempHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), "ak-lease-repo-"));
    try {
      seedGitProject(cwd);
      const projectRoot = resolve(cwd);
      await assert.rejects(
        () =>
          admitJudgeInvocation({
            home,
            cwd: projectRoot,
            instruction: "review this",
            attachmentPaths: [],
            createRunId: () => "run-no-lease",
          }),
        (error: unknown) => error instanceof CliUsageError,
      );
      const ledgerHome = resolveActivationLedgerHome(() => home);
      const bookKey = resolveBookKeyFromGit(projectRoot);
      const runDirectory = join(
        activationBookDirectory(ledgerHome, bookKey),
        "runs",
        "run-no-lease@judge",
      );
      assert.equal(existsSync(runDirectory), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("offer then admitJudgeInvocation writes flat run and opaque ticket-binding", async () => {
  await withTempHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), "ak-lease-repo-"));
    try {
      seedGitProject(cwd);
      const projectRoot = resolve(cwd);
      const ledgerHome = resolveActivationLedgerHome(() => home);
      const bookKey = resolveBookKeyFromGit(projectRoot);
      offerTicketDispatchLease({
        ledgerHome,
        bookKey,
        siteIdentity: projectRoot,
        ticketNumber: 176,
      });
      const admitted = await admitJudgeInvocation({
        home,
        cwd: projectRoot,
        instruction: "review this",
        attachmentPaths: [],
        createRunId: () => "run-with-lease",
      });
      assert.equal(typeof admitted.correlationId, "string");
      assert.ok((admitted.correlationId ?? "").length > 0);
      assert.notEqual(admitted.correlationId ?? "", "176");
      assert.equal(admitted.ticketNumber, 176);
      const expectedRun = join(
        activationBookDirectory(ledgerHome, bookKey),
        "runs",
        "run-with-lease@judge",
      );
      assert.equal(admitted.runDirectory, expectedRun);
      assert.equal(existsSync(expectedRun), true);

      const waiting = await readFile(
        join(activationBookDirectory(ledgerHome, bookKey), "waiting.jsonl"),
        "utf8",
      );
      const rows = waiting
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const binding = rows.find((row) => row.event === TICKET_BINDING_EVENT);
      assert.ok(binding);
      assert.equal(binding?.ticketNumber, 176);
      const correlation = binding?.correlation as { id?: string } | undefined;
      assert.equal(correlation?.id, admitted.correlationId ?? "");
      assert.notEqual(correlation?.id, "176");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
