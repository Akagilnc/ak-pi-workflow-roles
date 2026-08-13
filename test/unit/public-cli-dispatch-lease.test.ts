import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { activationBookDirectory, resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import { admitJudgeInvocation } from "../../src/public-cli/invocation.ts";
import { offerTicketDispatchLease, TICKET_BINDING_EVENT } from "../../src/ticket-dispatch-lease.ts";
import { DISPATCH_STUB_EVENT } from "../../src/activation-reconciliation.ts";

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

test("admitJudgeInvocation without offer still admits unbound", async () => {
  await withTempHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), "ak-lease-repo-"));
    try {
      seedGitProject(cwd);
      const projectRoot = resolve(cwd);
      const admitted = await admitJudgeInvocation({
        home,
        cwd: projectRoot,
        instruction: "review this",
        attachmentPaths: [],
        createRunId: () => "run-no-lease",
      });
      assert.equal(admitted.correlationId, undefined);
      assert.equal(admitted.ticketNumber, undefined);
      const ledgerHome = resolveActivationLedgerHome(() => home);
      const bookKey = resolveBookKeyFromGit(projectRoot);
      const runDirectory = join(
        activationBookDirectory(ledgerHome, bookKey),
        "runs",
        "run-no-lease@judge",
      );
      assert.equal(admitted.runDirectory, runDirectory);
      assert.equal(existsSync(runDirectory), true);
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
      const stub = rows.find((row) => row.event === DISPATCH_STUB_EVENT);
      assert.ok(binding);
      assert.ok(stub);
      assert.equal(binding?.ticketNumber, 176);
      const bindingCorr = binding?.correlation as { id?: string } | undefined;
      const stubCorr = stub?.correlation as { id?: string } | undefined;
      assert.equal(bindingCorr?.id, admitted.correlationId ?? "");
      assert.equal(stubCorr?.id, admitted.correlationId ?? "");
      assert.notEqual(bindingCorr?.id, "176");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("bad attachment does not consume pending lease", async () => {
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
      const pendingPath = join(
        activationBookDirectory(ledgerHome, bookKey),
        "dispatch-lease.json",
      );
      assert.equal(existsSync(pendingPath), true);
      await assert.rejects(
        () =>
          admitJudgeInvocation({
            home,
            cwd: projectRoot,
            instruction: "review this",
            attachmentPaths: [join(projectRoot, "missing-attachment.txt")],
            createRunId: () => "run-bad-attach",
          }),
      );
      // Lease must still be pending so a later good admit can bind.
      assert.equal(existsSync(pendingPath), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
